"""Assemble the whole scene, bake its lighting and write the web assets.

    blender -b --factory-startup --python tools/blender/build_scene.py -- [flags]

One run regenerates everything in src/assets/:
    scene.glb              geometry only, meshopt compressed, two UV sets
    lm_hero_room.webp      terminal + keyboard + cable, room light
    lm_hero_screen.webp    same texels, light from the lit picture only
    lm_env_room.webp       desk, walls, props, lamp, room light
    lm_env_screen.webp     same texels, light from the lit picture only
    reflect.webp           what the convex glass mirrors (see README.md)

Flags (all optional):
    --samples N        bake samples per texel, hero atlas (default 1024)
    --env-samples N    same for the env atlas (default 4 x --samples)
    --size N           atlas size in pixels (default 2048)
    --skip-bake        reuse the EXR masters from the bake directory
    --preview DIR      also render the check images into DIR
    --preview-samples N  samples of the beauty renders (default 256)
    --no-beauty        with --preview: skip the slow path-traced beauty renders
    --out DIR          asset directory (default <repo>/src/assets)
    --bake-dir DIR     where the EXR masters live (default <system temp>/vt_bake)
    --no-smooth        do not filter bake grain before encoding
    --no-export        stop before writing scene.glb
    --blend            save the assembled scene as scene.blend in the bake dir

Stages, in order: build the three modules, place the keyboard and its cable,
check for intersections, find the faces a viewer can ever see, lay out the
two lightmap atlases, bake "room" and "screen" light into each, encode the
maps, render the reflection image, strip unseen faces and export.
"""
import ctypes
import json
import math
import os
import struct
import sys
import tempfile
import time

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vt_common as vc      # noqa: E402
import vt_terminal          # noqa: E402
import vt_keyboard          # noqa: E402
import vt_room              # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))

# ---------------------------------------------------------------- placement
KB_LOC = (-0.012, -0.300, 0.0)      # keyboard origin: centre of its front edge
KB_YAW = math.radians(2.0)

# The lit picture is the centre 88% x 84% of the 4 x 3 unit opening.
PICTURE_HALF = (2.0 * 0.88, 1.5 * 0.84)
# Mean linear radiance of the picture used for the check renders only.
PICTURE_RGB = (0.10, 1.0, 0.20)
PICTURE_LEVEL = 0.25

RANGE_SKIP = ("Lamp_Shade",)        # objects ignored when choosing a map's range
LM_NAME = "Lightmap"
DILATE_PX = 12                      # margin grown around every island
PACK_MARGIN_PX = 10.0               # gap the packer leaves around islands

# Noise filter applied to the baked maps before encoding: a Gaussian of this
# sigma (texels), normalised by the object's own texel mask so nothing crosses
# from one object to another (first matching name prefix wins).  Only objects
# whose baked detail is lighting, not printed or grained colour.  The radius
# (3 sigma) must stay below PACK_MARGIN_PX so islands of one object stay apart.
SMOOTH = (
    ("NameplateText", 0.0), ("Nameplate", 0.0), ("Wall_Note", 0.0),
    ("Key_", 1.0), ("Collar", 1.0), ("Keyboard", 1.0), ("Housing", 1.0), ("Plinth", 1.0),
    ("SideControls", 1.0), ("PowerButton", 1.0), ("Kbd_Cable", 1.0),
    ("Wall_Desk", 2.5), ("Floor", 2.5), ("Skirting", 1.5), ("Desk_Body", 1.5), ("Lamp_", 1.0),
)
BACKING_MM = 2.0                    # ScreenBacking sits this far behind the glass

# ---------------------------------------------------------------- viewing
SEAT = Vector(vt_room.CAM_SEAT)
TARGET = Vector(vt_room.CAM_TARGET)

# name: (camera, target, lens mm, (width, height)).  Sensor 36 mm on the long side.
VIEWS = {
    "seat35": (SEAT, TARGET, 35.0, (1280, 720)),
    "seat28": (SEAT, TARGET, 28.0, (1280, 720)),
}
EXTREMES = {
    "ultrawide": (SEAT, TARGET, 24.0, (1680, 720)),
    "portrait": (Vector((0.0, -1.62, 0.77)), Vector((0.0, -0.05, 0.10)), 35.0, (540, 1170)),
    "lookdown": (Vector((0.0, -0.60, 0.58)), Vector((0.0, -0.20, 0.02)), 35.0, (1280, 720)),
    "left": (Vector((-0.30, -0.62, 0.40)), TARGET, 28.0, (1280, 720)),
    "right": (Vector((0.30, -0.62, 0.40)), TARGET, 28.0, (1280, 720)),
    "lowright": (Vector((0.32, -0.62, 0.24)), TARGET, 24.0, (1280, 720)),
}
CLOSEUPS = {
    "close_recess_chin": (Vector((0.07, -0.33, 0.22)), Vector((0.03, 0.03, 0.10)), 50.0, (1280, 720)),
    "close_keys": (Vector((-0.06, -0.50, 0.20)), Vector((-0.06, -0.225, 0.03)), 70.0, (1280, 720)),
    "close_desk_lamp": (Vector((0.22, -0.55, 0.33)), Vector((0.30, -0.03, 0.0)), 50.0, (1280, 720)),
    "close_seam": (Vector((-0.27, -0.36, 0.33)), Vector((-0.145, 0.01, 0.275)), 100.0, (1280, 720)),
}

# Eye positions a visitor's camera can take (parallax, pulled back for a
# portrait phone, raised to look down at the keys).  A face that none of them
# can see is never shipped.
def viewpoints():
    pts = [SEAT.copy()]
    for y, z in ((-0.62, 0.40), (-0.50, 0.30), (-0.50, 0.55), (-0.62, 0.24), (-0.70, 0.66),
                 (-0.95, 0.50), (-1.30, 0.62), (-1.62, 0.77), (-1.62, 0.45), (-0.45, 0.75),
                 (-0.60, 0.58)):
        for x in (-0.32, -0.16, 0.0, 0.16, 0.32):
            pts.append(Vector((x, y, z)))
    return pts


# Linear texel-density multipliers, by object-name prefix (first match wins).
DENSITY = (
    ("NameplateText", 2.0), ("Nameplate", 2.0), ("Collar", 1.2), ("PowerButton", 1.2),
    ("Housing", 0.8), ("Plinth", 0.8), ("SideControls", 0.8), ("RearDetails", 0.5),
    ("Key_", 1.25), ("LegendStrip", 1.3), ("Kbd_Feet", 0.5), ("Kbd_Cable", 0.7), ("Kbd_", 1.0),
    ("Keyboard", 1.0),
    ("Desk_Body", 0.45), ("Desk_Top", 0.5), ("Wall_Left", 0.06), ("Wall_Right", 0.06), ("Floor", 0.06),
    ("Ceiling", 0.06), ("Skirting", 0.15), ("Lamp_Cord", 0.5), ("Lamp_", 1.0),
    ("Wall_Note", 1.7), ("Mug", 1.3), ("Floppy", 1.3), ("Notepad", 1.3), ("Pen", 1.3), ("Binder", 1.3),
)

# Big flat faces get a continuous, piecewise-linear lightmap mapping instead
# of a uniform one: (object, axis u, axis v, constant axis, u breaks, u
# densities, v breaks, v densities).  Density 1 = one UV unit per metre.
WARPS = {
    "Desk_Top": dict(u=0, v=1, breaks_u=(-0.75, -0.56, 0.62, 0.75), dens_u=(0.45, 1.0, 0.45),
                     breaks_v=(-0.42, 0.14, 0.45), dens_v=(1.0, 0.45)),
    "Wall_Desk": dict(u=0, v=2, breaks_u=(-1.9, -1.0, 1.0, 1.7), dens_u=(0.10, 0.40, 0.10),
                      breaks_v=(-0.74, -0.04, 1.05, 1.86), dens_v=(0.10, 0.40, 0.10)),
}


def log(*a):
    print("[build_scene]", *a)
    sys.stdout.flush()


def arg(args, name, default=None, cast=str):
    if name in args:
        return cast(args[args.index(name) + 1])
    return default


# =========================================================================
# assembly
# =========================================================================
def build_cable(col, notch, out_dir, jack):
    """Coiled keyboard cord from the keyboard's right notch, round the right
    of the terminal, to the jack on its rear panel.  It lies on the desk."""
    rw, rc, pitch = 0.0019, 0.0040, 0.0056
    ctrl = [notch.xy, notch.xy + out_dir.xy * 0.035,
            (0.318, -0.142), (0.327, -0.105), (0.305, -0.050), (0.262, 0.010), (0.222, 0.085),
            (0.207, 0.180), (0.208, 0.290), (0.195, 0.385), (0.130, 0.428), (0.020, 0.436),
            (-0.055, 0.425), (-0.080, 0.398), (jack.x, jack.y + 0.016)]
    dense = vt_room.catmull([Vector((p[0], p[1], 0.0)) for p in ctrl], 40)
    seg = [0.0]
    for a, b in zip(dense, dense[1:]):
        seg.append(seg[-1] + (b - a).length)
    total = seg[-1]

    def at(s):
        s = min(max(s, 0.0), total)
        lo, hi = 0, len(seg) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if seg[mid] <= s:
                lo = mid
            else:
                hi = mid
        t = (s - seg[lo]) / max(seg[hi] - seg[lo], 1e-9)
        return dense[lo].lerp(dense[hi], t), (dense[hi] - dense[lo]).normalized()

    def sstep(x):
        x = min(max(x, 0.0), 1.0)
        return x * x * (3 - 2 * x)

    lead_in, lead_out, ramp = 0.045, 0.075, 0.02

    def radius(s):
        return rc * sstep((s - lead_in) / ramp) * sstep((total - lead_out - s) / ramp)

    def height(s):
        base = rw + radius(s)
        z = notch.z + (base - notch.z) * sstep(s / 0.03)
        return z + (jack.z - z) * sstep((s - (total - 0.060)) / 0.050)

    pts = []
    s, phi = 0.0, 0.0
    up = Vector((0, 0, 1))
    while s < total:
        c, t = at(s)
        r = radius(s)
        n = up.cross(t).normalized()
        p = Vector((c.x, c.y, height(s))) + r * (math.cos(phi) * n + math.sin(phi) * up)
        pts.append(p)
        if r > 1e-5:
            per = 8 if c.y < 0.20 else 5
            ds = pitch / per
            phi += 2 * math.pi / per
        else:
            ds = 0.006
        s += ds
    c, _ = at(total)
    pts.append(Vector((c.x, c.y, jack.z)))

    cord = vc.material("KbdCable", vc.srgb("#B4AFA0"), roughness=0.55)
    plug = vc.material("KbdCablePlug", vc.srgb("#C6C1B2"), roughness=0.45)
    m = vt_room.Mesh()
    m.add(vt_room.p_tube(pts, rw, 4, caps=True), cord)
    yaw = math.atan2(out_dir.y, out_dir.x)
    m.add(vt_room.p_box((0.013, 0.0085, 0.0056), 0.0008, 1), plug,
          Matrix.Translation(notch + out_dir * 0.0035) @ Matrix.Rotation(yaw, 4, "Z"))
    m.add(vt_room.p_box((0.011, 0.016, 0.008), 0.0008, 1), plug,
          Matrix.Translation((jack.x, jack.y + 0.008, jack.z)))
    obj = m.finish("Kbd_Cable", col, angle=100.0)

    # Lightmap mapping for the wire: straightened strips (length along the
    # wire x its circumference), cut every `chunk` rings.  A projection would
    # give one island as large as the whole cable run.
    sides, chunk, dens = 4, 48, 0.55
    ring_s = [0.0]
    for a, b in zip(pts, pts[1:]):
        ring_s.append(ring_s[-1] + (b - a).length)
    side_w = 2 * rw * math.sin(math.pi / sides)
    me = obj.data
    uv = np.zeros((len(me.loops), 2))
    strip = np.zeros(len(me.polygons), bool)
    nv = len(pts) * sides
    for p in me.polygons:
        vs = list(p.vertices)
        if len(vs) != 4 or max(vs) >= nv:
            continue
        rings = sorted(set(v // sides for v in vs))
        sset = set(v % sides for v in vs)
        if len(rings) != 2 or rings[1] - rings[0] != 1 or len(sset) != 2:
            continue
        wrap = sset == {0, sides - 1}
        c = rings[0] // chunk
        for li, v in zip(p.loop_indices, vs):
            r_, s_ = v // sides, v % sides
            if wrap and s_ == 0:
                s_ = sides
            uv[li] = ((ring_s[r_] + c * 0.03) * dens, s_ * side_w * dens)
        strip[p.index] = True
    return obj, uv, strip


def world_arrays(obj):
    """World-space vertices (n,3) and polygons as index lists."""
    me = obj.data
    co = np.empty(len(me.vertices) * 3, np.float64)
    me.vertices.foreach_get("co", co)
    M = np.array(obj.matrix_world)
    co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    polys = [tuple(p.vertices) for p in me.polygons]
    return co, polys


def object_bvh(obj):
    co, polys = world_arrays(obj)
    return BVHTree.FromPolygons(co.tolist(), polys, all_triangles=False, epsilon=0.0)


def check_intersections(groups, allowed):
    """groups: {name: [objects]}.  Reports mesh overlaps between objects of
    different groups; pairs in `allowed` (frozensets of object names) are
    expected contacts."""
    trees = {}
    for objs in groups.values():
        for o in objs:
            trees[o.name] = object_bvh(o)
    names = list(groups)
    bad = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            for oa in groups[a]:
                for ob in groups[b]:
                    if frozenset((oa.name, ob.name)) in allowed:
                        continue
                    n = len(trees[oa.name].overlap(trees[ob.name]))
                    if n:
                        bad.append((oa.name, ob.name, n))
    return bad


def bisect_for_warp(obj, spec):
    """Cut the mesh along the warp's breakpoints so the mapping is exact."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for axis, breaks in ((spec["u"], spec["breaks_u"]), (spec["v"], spec["breaks_v"])):
        for b in breaks[1:-1]:
            co = [0.0, 0.0, 0.0]
            no = [0.0, 0.0, 0.0]
            co[axis] = b
            no[axis] = 1.0
            bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
                                   plane_co=co, plane_no=no, dist=1e-6)
    bm.to_mesh(obj.data)
    bm.free()


def glass_setup(tube):
    """Give the GlassProxy material a switchable emissive picture area."""
    mat = bpy.data.materials["GlassProxy"]
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.object = tube
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    masks = []
    for axis, half in (("X", PICTURE_HALF[0]), ("Z", PICTURE_HALF[1])):
        ab = nt.nodes.new("ShaderNodeMath")
        ab.operation = "ABSOLUTE"
        nt.links.new(sep.outputs[axis], ab.inputs[0])
        lt = nt.nodes.new("ShaderNodeMath")
        lt.operation = "LESS_THAN"
        lt.inputs[1].default_value = half
        nt.links.new(ab.outputs[0], lt.inputs[0])
        masks.append(lt)
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(masks[0].outputs[0], mul.inputs[0])
    nt.links.new(masks[1].outputs[0], mul.inputs[1])
    lvl = nt.nodes.new("ShaderNodeMath")
    lvl.operation = "MULTIPLY"
    lvl.name = "PictureLevel"
    lvl.inputs[1].default_value = 0.0
    nt.links.new(mul.outputs[0], lvl.inputs[0])
    nt.links.new(lvl.outputs[0], bsdf.inputs["Emission Strength"])
    bsdf.inputs["Emission Color"].default_value = (1, 1, 1, 1)
    return mat


def glass_picture(rgb, level):
    mat = bpy.data.materials["GlassProxy"]
    nt = mat.node_tree
    nt.nodes["PictureLevel"].inputs[1].default_value = level
    nt.nodes["Principled BSDF"].inputs["Emission Color"].default_value = (*rgb, 1.0)


def build_backing(col):
    """Opaque cap just behind the glass.  GlassProxy is not exported, and the
    cabinet behind the opening is hollow, so without this a page whose own
    tube mesh does not seal the opening would show the wall through it."""
    U = vt_terminal.U
    nx, nz, hx, hz = 16, 12, 2.06, 1.56
    bm = bmesh.new()
    grid = []
    for j in range(nz + 1):
        zu = (-hz + 2 * hz * j / nz) * U
        grid.append([bm.verts.new(vt_terminal.P(xu, zu, vt_terminal.glass_d(xu, zu) + BACKING_MM))
                     for xu in ((-hx + 2 * hx * i / nx) * U for i in range(nx + 1))])
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    if bm.faces[0].normal.dot(-vt_terminal.E_D) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new("ScreenBacking")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("ScreenBacking", me)
    col.objects.link(obj)
    for layer in ("UVMap", LM_NAME):
        me.uv_layers.new(name=layer, do_init=False)
        set_uv(me, np.zeros((len(me.loops), 2)), layer)
    obj["role"] = "backing"
    return obj


def split_glow(obj, col, room, rng, size):
    """Move the faces of `obj` whose room-light value is above the map's range
    (they would clip to a flat grey) into a new object drawn unlit.  Returns
    (new object, mean linear radiance of those faces) or (None, None)."""
    me = obj.data
    uv = get_uv(me)
    hot = np.zeros(len(me.polygons), bool)
    vals, areas = [], []
    for p in me.polygons:
        c = uv[p.loop_start:p.loop_start + p.loop_total].mean(axis=0)
        x = min(max(int(c[0] * size), 0), size - 1)
        y = min(max(int(c[1] * size), 0), size - 1)
        v = room[y, x]
        if float(v.max()) > rng:
            hot[p.index] = True
            vals.append(v)
            areas.append(p.area)
    if not hot.any():
        return None, None
    glow = obj.copy()
    glow.data = me.copy()
    glow.name = glow.data.name = obj.name + "Glow"
    col.objects.link(glow)
    for o, kill in ((obj, hot), (glow, ~hot)):
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if kill[f.index]], context="FACES")
        bm.to_mesh(o.data)
        bm.free()
    set_uv(glow.data, np.zeros((len(glow.data.loops), 2)))
    w = np.array(areas)[:, None]
    return glow, (np.array(vals) * w).sum(axis=0) / w.sum()


# =========================================================================
# visibility
# =========================================================================
class World:
    """One BVH over a set of objects, remembering which object owns a face."""

    def __init__(self, objs):
        verts, polys, owner = [], [], []
        base = 0
        for i, o in enumerate(objs):
            co, pl = world_arrays(o)
            verts.extend(co.tolist())
            polys.extend(tuple(base + v for v in p) for p in pl)
            owner.extend([i] * len(pl))
            base += len(co)
        self.objs = objs
        self.owner = owner
        self.bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)

    def blocked(self, eye, point):
        d = point - eye
        dist = d.length
        hit = self.bvh.ray_cast(eye, d / dist, dist - 3e-4)
        return hit[0] is not None


def face_visibility(obj, world, eyes):
    """Per polygon: 1 if some eye sees it.  Then one ring of neighbours that
    at least face an eye is added, so thin slivers at silhouettes survive."""
    me = obj.data
    mw = obj.matrix_world
    rot = mw.to_3x3()
    vw = [mw @ v.co for v in me.vertices]
    n = len(me.polygons)
    seen = np.zeros(n, bool)
    facing = np.zeros(n, bool)
    for p in me.polygons:
        c = mw @ p.center
        nrm = (rot @ p.normal).normalized()
        front = [e for e in eyes if (e - c).dot(nrm) > 0.02 * (e - c).length]
        if not front:
            continue
        facing[p.index] = True
        # sample points: centre, then rings that close in on the outline, so a
        # face that only shows as a sliver along one edge is still kept
        vs = [vw[vi] for vi in p.vertices]
        pts = [c] + [c.lerp(v, 0.82) for v in vs]
        for a, b in zip(vs, vs[1:] + vs[:1]):
            pts += [c.lerp(a.lerp(b, t), 0.9) for t in (0.5,)]
            pts += [c.lerp(a.lerp(b, t), 0.985) for t in (0.0, 0.25, 0.5, 0.75)]
        done = False
        for q in pts:
            q = q + nrm * 2e-5
            for e in front:
                if not world.blocked(e, q):
                    done = True
                    break
            if done:
                break
        seen[p.index] = done
    # one ring
    edge_faces = {}
    for p in me.polygons:
        for ek in p.edge_keys:
            edge_faces.setdefault(ek, []).append(p.index)
    grow = seen.copy()
    small = np.array([p.area < 5e-5 for p in me.polygons])     # under half a square centimetre
    for fs in edge_faces.values():
        if any(seen[f] for f in fs):
            for f in fs:
                if facing[f] and small[f]:
                    grow[f] = True
    return seen, grow, small


def framing_hits(world, views, grid=220):
    """Cast a grid of rays through each framing; returns {object name: {view: hits}}."""
    out = {}
    for name, (eye, target, lens, (w, h)) in views.items():
        f = (target - eye).normalized()
        r = f.cross(Vector((0, 0, 1))).normalized()
        u = r.cross(f)
        half_long = 18.0 / lens
        aspect = w / h
        hx, hy = (half_long, half_long / aspect) if aspect >= 1 else (half_long * aspect, half_long)
        nx = grid
        ny = max(8, int(grid / aspect))
        for j in range(ny):
            for i in range(nx):
                d = f + r * (hx * (2 * (i + 0.5) / nx - 1)) + u * (hy * (2 * (j + 0.5) / ny - 1))
                hit = world.bvh.ray_cast(eye, d.normalized(), 20.0)
                if hit[0] is not None:
                    o = world.objs[world.owner[hit[2]]].name
                    out.setdefault(o, {}).setdefault(name, 0)
                    out[o][name] += 1
    return out


def density_for(name):
    for prefix, k in DENSITY:
        if name.startswith(prefix):
            return k
    return 1.0


def face_weights(obj):
    """Linear texel-density weight per polygon, from how large and how
    square-on the face is for a seated viewer."""
    me = obj.data
    mw = obj.matrix_world
    rot = mw.to_3x3()
    k = density_for(obj.name)
    w = np.empty(len(me.polygons), np.float64)
    # near-black cavity and seam-shadow faces carry almost no visible detail
    dark = [{"Cavity": 0.1, "SeamShadow": 0.6}.get(m.name, 1.0) if m else 1.0 for m in me.materials]
    for p in me.polygons:
        c = mw @ p.center
        nrm = (rot @ p.normal).normalized()
        d = SEAT - c
        dist = d.length
        cos = max(d.dot(nrm) / dist, 0.2)
        w[p.index] = k * min(max(math.sqrt(cos) * 0.66 / dist, 0.3), 1.5) * (dark[p.material_index] if dark else 1.0)
    return w


# =========================================================================
# lightmap UVs
# =========================================================================
def tri_data(obj):
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    loops = np.empty(nt * 3, np.int32)
    polyi = np.empty(nt, np.int32)
    verts = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get("loops", loops)
    me.loop_triangles.foreach_get("polygon_index", polyi)
    me.loop_triangles.foreach_get("vertices", verts)
    return loops.reshape(-1, 3), polyi, verts.reshape(-1, 3)


def get_uv(me, name=LM_NAME):
    layer = me.uv_layers[name]
    uv = np.empty(len(me.loops) * 2, np.float64)
    layer.uv.foreach_get("vector", uv)
    return uv.reshape(-1, 2)


def set_uv(me, uv, name=LM_NAME):
    me.uv_layers[name].uv.foreach_set("vector", np.ascontiguousarray(uv, np.float32).ravel())


def poly_areas(obj):
    """World-space area and lightmap-UV area per polygon."""
    me = obj.data
    co, _ = world_arrays(obj)
    loops, polyi, verts = tri_data(obj)
    a, b, c = co[verts[:, 0]], co[verts[:, 1]], co[verts[:, 2]]
    ta = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    uv = get_uv(me)
    ua, ub, uc = uv[loops[:, 0]], uv[loops[:, 1]], uv[loops[:, 2]]
    tu = 0.5 * np.abs((ub[:, 0] - ua[:, 0]) * (uc[:, 1] - ua[:, 1]) - (ub[:, 1] - ua[:, 1]) * (uc[:, 0] - ua[:, 0]))
    n = len(me.polygons)
    area = np.zeros(n)
    uarea = np.zeros(n)
    np.add.at(area, polyi, ta)
    np.add.at(uarea, polyi, tu)
    return area, uarea


ISLAND_GROUP = {}       # object name -> int per polygon; islands never span two groups


def side_groups(obj):
    """Which of the four sides of the object's footprint a polygon lies on.
    Cuts the ring that a bevel running round a rectangular top unwraps to
    into four strips, which pack far better than a ring with an empty middle."""
    me = obj.data
    c = np.empty(len(me.polygons) * 3)
    me.polygons.foreach_get("center", c)
    c = c.reshape(-1, 3)
    lo, hi = c.min(axis=0), c.max(axis=0)
    s = (c[:, 0] - (lo[0] + hi[0]) / 2) / max((hi[0] - lo[0]) / 2, 1e-9)
    t = (c[:, 1] - (lo[1] + hi[1]) / 2) / max((hi[1] - lo[1]) / 2, 1e-9)
    return np.where(np.abs(s) > np.abs(t), np.where(s > 0, 0, 1), np.where(t > 0, 2, 3))


def uv_islands(me, uv, mask, group=None):
    """Label polygons (mask = True only) by lightmap island."""
    n = len(me.polygons)
    if group is None:
        group = np.zeros(n, np.int32)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first = {}
    q = np.round(uv * 1e5).astype(np.int64)
    for p in me.polygons:
        if not mask[p.index]:
            continue
        for li, vi in zip(p.loop_indices, p.vertices):
            key = (vi, int(q[li, 0]), int(q[li, 1]), int(group[p.index]))
            other = first.get(key)
            if other is None:
                first[key] = p.index
            else:
                ra, rb = find(other), find(p.index)
                if ra != rb:
                    parent[rb] = ra
    return np.array([find(i) for i in range(n)])


def edit_select(objs, state, show):
    """In multi-object edit mode: show and select faces whose state is in `show`."""
    for o in objs:
        bm = bmesh.from_edit_mesh(o.data)
        st = state[o.name]
        for f in bm.faces:
            vis = st[f.index] in show
            f.hide_set(not vis)
        for f in bm.faces:
            if st[f.index] in show:
                f.select_set(True)
        bm.select_flush(True)
        bmesh.update_edit_mesh(o.data)


def enter_edit(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")


def warp_coord(x, breaks, dens):
    out = 0.0
    for b0, b1, d in zip(breaks, breaks[1:], dens):
        if x <= b0:
            break
        out += (min(x, b1) - b0) * d
    return out


def layout_atlas(objs, state, weights, size, custom):
    """state[name]: per polygon 0 = never seen, 1 = automatic unwrap,
    2 = warped planar mapping.  Writes the `Lightmap` layer of every object
    so that all of them share one 0..1 atlas."""
    for o in objs:
        me = o.data
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[-1])
        assert me.uv_layers[0].name == "UVMap", o.name
        me.uv_layers.new(name=LM_NAME, do_init=False)
        set_uv(me, np.zeros((len(me.loops), 2)))
        me.uv_layers.active = me.uv_layers[LM_NAME]

    enter_edit(objs)
    edit_select(objs, state, (1,))
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0,
                             correct_aspect=False, scale_to_bounds=False)
    bpy.ops.mesh.reveal(select=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    degenerate = 0
    for o in objs:
        me = o.data
        st = state[o.name]
        uv = get_uv(me)
        uv[np.isnan(uv)] = 0.0
        # faces with a hand-made mapping (warped planes, cable strips)
        if o.name in custom:
            cu = custom[o.name]
            for p in me.polygons:
                if st[p.index] == 2:
                    sl = slice(p.loop_start, p.loop_start + p.loop_total)
                    uv[sl] = cu[sl]
        set_uv(me, uv)
        # scale every automatic island to its weighted world area
        area, uarea = poly_areas(o)
        label = uv_islands(me, uv, st == 1, ISLAND_GROUP.get(o.name))
        w = weights[o.name]
        loop_scale = np.ones(len(me.loops))
        for isl in np.unique(label[st == 1]):
            sel = (label == isl) & (st == 1)
            a3 = float(np.sum(area[sel] * w[sel] ** 2))
            au = float(np.sum(uarea[sel]))
            if au < 1e-14 or a3 < 1e-14:
                degenerate += int(sel.sum())
                continue
            s = math.sqrt(a3 / au)
            for pi in np.nonzero(sel)[0]:
                p = me.polygons[pi]
                loop_scale[p.loop_start:p.loop_start + p.loop_total] = s
        set_uv(me, uv * loop_scale[:, None])

    t0 = time.time()
    info = pack_raster(objs, state, size)
    info["degenerate_faces"] = degenerate
    info["pack_seconds"] = round(time.time() - t0, 1)
    return info


def raster_tris(mask, tri_px, conservative=True):
    """OR into `mask` (h,w bool) every pixel whose centre is inside one of the
    triangles tri_px (m,3,2), in pixel units.  With `conservative`, also the
    pixels under each triangle's corners, edge midpoints and centroid, so
    slivers are not lost."""
    h, w = mask.shape
    for t in tri_px:
        p0, p1, p2 = t
        if conservative:
            for q in (p0, p1, p2, (p0 + p1) / 2, (p1 + p2) / 2, (p2 + p0) / 2, (p0 + p1 + p2) / 3):
                x, y = int(q[0]), int(q[1])
                if 0 <= x < w and 0 <= y < h:
                    mask[y, x] = True
        x0 = max(int(math.floor(min(p0[0], p1[0], p2[0]) - 0.5)), 0)
        x1 = min(int(math.ceil(max(p0[0], p1[0], p2[0]) + 0.5)), w - 1)
        y0 = max(int(math.floor(min(p0[1], p1[1], p2[1]) - 0.5)), 0)
        y1 = min(int(math.ceil(max(p0[1], p1[1], p2[1]) + 0.5)), h - 1)
        if x1 < x0 or y1 < y0:
            continue
        d = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])
        if abs(d) < 1e-12:
            continue
        X = (np.arange(x0, x1 + 1) + 0.5)[None, :]
        Y = (np.arange(y0, y1 + 1) + 0.5)[:, None]
        w1 = ((X - p0[0]) * (p2[1] - p0[1]) - (Y - p0[1]) * (p2[0] - p0[0])) / d
        w2 = ((p1[0] - p0[0]) * (Y - p0[1]) - (p1[1] - p0[1]) * (X - p0[0])) / d
        mask[y0:y1 + 1, x0:x1 + 1] |= (w1 >= -1e-6) & (w2 >= -1e-6) & (w1 + w2 <= 1 + 1e-6)


def grow_mask(m, r):
    """Binary dilation by a (2r+1) square."""
    h, w = m.shape
    p = np.pad(m, r)
    a = np.zeros((h + 2 * r, w), bool)
    for i in range(2 * r + 1):
        a |= p[:, i:i + w]
    b = np.zeros((h, w), bool)
    for i in range(2 * r + 1):
        b |= a[i:i + h, :]
    return b


def pack_raster(objs, state, size, grid=512):
    """Pack every lightmap island into the 0..1 square, keeping the relative
    sizes they have now.  Islands are rasterised (with their margin) onto a
    coarse occupancy grid and dropped into the first free place, bottom row
    first; small islands may land inside the holes of big ones, which
    Blender's own packer does not do.  An island may be mirrored about its
    diagonal (u and v swapped), which a lightmap does not mind."""
    cell = size // grid
    margin = int(math.ceil(PACK_MARGIN_PX * size / 2048.0 / 2.0))    # the gap is in 2048-atlas pixels
    uvs, islands = {}, []
    for o in objs:
        me = o.data
        st = state[o.name]
        uv = get_uv(me)
        uvs[o.name] = uv
        grp = ISLAND_GROUP.get(o.name)
        if grp is not None:
            grp = np.where(st == 1, grp, -1)        # hand-mapped faces stay whole
        label = uv_islands(me, uv, st > 0, grp)
        loops_tri, polyi, _ = tri_data(o)
        n = len(me.polygons)
        totals = np.empty(n, np.int32)
        starts = np.empty(n, np.int32)
        me.polygons.foreach_get("loop_total", totals)
        me.polygons.foreach_get("loop_start", starts)
        assert (starts == np.concatenate(([0], np.cumsum(totals)[:-1]))).all(), o.name
        loop_poly = np.repeat(np.arange(n), totals)
        lab_loop = np.where(st[loop_poly] > 0, label[loop_poly], -1)
        lab_tri = np.where(st[polyi] > 0, label[polyi], -1)
        order = np.argsort(lab_loop, kind="stable")
        bounds = np.flatnonzero(np.diff(lab_loop[order])) + 1
        for grp in np.split(order, bounds):
            lab = lab_loop[grp[0]]
            if lab < 0:
                continue
            islands.append({"obj": o.name, "loops": grp, "tris": loops_tri[lab_tri == lab]})
    total_area = 0.0
    for isl in islands:
        t = uvs[isl["obj"]][isl["tris"]]
        a, b, c = t[:, 0], t[:, 1], t[:, 2]
        total_area += float(np.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1])
                                   - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])).sum()) * 0.5
        uv = uvs[isl["obj"]][isl["loops"]]
        isl["min"] = uv.min(axis=0)
        isl["ext"] = uv.max(axis=0) - isl["min"]
    longest = max(max(i["ext"]) for i in islands)
    k = min(math.sqrt(0.72 * size * size / total_area), (size - 2 * margin - 2 * cell) / longest)

    def attempt(k):
        H, W = 2 * grid, grid
        occ = np.zeros((H, W), bool)
        prepared = []
        for isl in islands:
            uv = uvs[isl["obj"]]
            off = np.floor(isl["min"] * k) - margin
            w = int(math.ceil(isl["ext"][0] * k)) + 2 * margin + 2
            h = int(math.ceil(isl["ext"][1] * k)) + 2 * margin + 2
            bm = np.zeros((h, w), bool)
            raster_tris(bm, uv[isl["tris"]] * k - off)
            bm = grow_mask(bm, margin)
            hc, wc = -(-h // cell), -(-w // cell)
            pad = np.zeros((hc * cell, wc * cell), bool)
            pad[:h, :w] = bm
            cells = pad.reshape(hc, cell, wc, cell).any(axis=(1, 3))
            shaped = hc >= 8 and wc >= 8 and cells.mean() < 0.72
            prepared.append((max(hc, wc), hc * wc, isl, off, cells, shaped))
        prepared.sort(key=lambda p: (-p[0], -p[1]))
        placed = []
        used = 0
        integral = None
        for _, _, isl, off, cells, shaped in prepared:
            best = None
            if shaped:
                fo = np.fft.rfft2(occ.astype(np.float32))
            for swap in (False, True):
                c = cells.T if swap else cells
                hc, wc = c.shape
                if wc > W or hc > H:
                    continue
                if shaped:
                    fb = np.fft.rfft2(c.astype(np.float32), s=(H, W))
                    corr = np.fft.irfft2(fo * np.conj(fb), s=(H, W))[:H - hc + 1, :W - wc + 1]
                    free = corr < 0.5
                else:
                    if integral is None:
                        integral = np.zeros((H + 1, W + 1), np.int32)
                        integral[1:, 1:] = occ.cumsum(axis=0).cumsum(axis=1)
                    s = integral
                    free = (s[hc:, wc:] - s[:-hc, wc:] - s[hc:, :-wc] + s[:-hc, :-wc]) == 0
                flat = free.ravel()
                i = int(np.argmax(flat))
                if not flat[i]:
                    continue
                y, x = divmod(i, free.shape[1])
                if best is None or (y + hc, x) < (best[0] + best[2].shape[0], best[1]):
                    best = (y, x, c, swap)
            if best is None:
                return None, 10 * H
            y, x, c, swap = best
            occ[y:y + c.shape[0], x:x + c.shape[1]] |= c
            integral = None
            used = max(used, y + c.shape[0])
            placed.append((isl, off, x, y, swap))
        return placed, used

    best = None
    tries = []
    for _ in range(7):
        placed, used = attempt(k)
        tries.append((round(k, 1), used))
        if placed is not None and used <= grid:
            best = (k, placed)
            if used >= 0.95 * grid or len(tries) >= 5:
                break
            k *= min(math.sqrt(grid / used) * 0.985, 1.06)
        else:
            if best is not None:
                break
            k *= max(min(math.sqrt(grid / used) * 0.985, 0.97), 0.7)
    assert best is not None, "could not pack the lightmap islands: %r" % (tries,)
    # first-fit leaves a ragged top; a slightly larger scale often still fits
    for _ in range(5):
        k2 = best[0] * 1.025
        placed, used = attempt(k2)
        tries.append((round(k2, 1), used))
        if placed is None or used > grid:
            break
        best = (k2, placed)
    k, placed = best
    for isl, off, x, y, swap in placed:
        uv = uvs[isl["obj"]]
        local = uv[isl["loops"]] * k - off
        if swap:
            local = local[:, ::-1]
        isl["new"] = (local + np.array([x * cell, y * cell])) / size
    for isl in islands:
        uvs[isl["obj"]][isl["loops"]] = isl["new"]
    lo, hi = np.array([9.0, 9.0]), np.array([-9.0, -9.0])
    for o in objs:
        me = o.data
        st = state[o.name]
        uv = uvs[o.name]
        totals = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get("loop_total", totals)
        keep = np.repeat(st > 0, totals)
        uv[~keep] = 0.0
        # a 1/16384 grid: a 1/8 texel at 2048, and the floats compress far better
        uv = np.round(uv * 16384.0) / 16384.0
        set_uv(me, uv)
        if keep.any():
            lo = np.minimum(lo, uv[keep].min(axis=0))
            hi = np.maximum(hi, uv[keep].max(axis=0))
    return {"uv_min": lo.tolist(), "uv_max": hi.tolist(), "islands": len(islands),
            "pixels_per_unit": round(float(k), 2), "tries": [(float(a), int(b)) for a, b in tries]}


def texel_stats(objs, state, size):
    """Texels per millimetre (linear), per object, from area ratios."""
    rows = []
    for o in objs:
        st = state[o.name]
        area, uarea = poly_areas(o)
        sel = st > 0
        if not sel.any() or area[sel].sum() <= 0:
            continue
        rows.append((o.name, float(math.sqrt(uarea[sel].sum() / area[sel].sum()) * size / 1000.0),
                     float(area[sel].sum())))
    return rows


def uv_checksum(objs):
    h = 0.0
    for o in objs:
        uv = get_uv(o.data)
        h += float(np.sum(uv * np.array([1.0, 1.61803]))) + len(uv)
    return round(h, 3)


# =========================================================================
# baking
# =========================================================================
def setup_bake_device(scene, samples):
    vc.setup_cycles(scene, samples=samples, denoise=False)
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.blur_glossy = 1.0
    # Light that reaches a diffuse surface by way of a mirror-like bounce is
    # a negligible part of the result and the main source of fireflies.
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.sample_clamp_indirect = 4.0


def bake_into(scene, objs, image):
    for o in objs:
        for slot in o.material_slots:
            nt = slot.material.node_tree
            node = nt.nodes.get("LM_BAKE") or nt.nodes.new("ShaderNodeTexImage")
            node.name = "LM_BAKE"
            node.image = image
            for x in nt.nodes:
                x.select = False
            node.select = True
            nt.nodes.active = node
        o.data.uv_layers.active = o.data.uv_layers[LM_NAME]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT", "COLOR"}, margin=0,
                        use_clear=True, target="IMAGE_TEXTURES", uv_layer=LM_NAME)


def image_array(img):
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def save_exr(arr, path):
    h, w = arr.shape[:2]
    img = bpy.data.images.new("exr_tmp", w, h, alpha=True, float_buffer=True)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :arr.shape[2]] = arr
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = "OPEN_EXR"
    img.save(filepath=path, save_copy=True)
    bpy.data.images.remove(img)


def load_image(path, raw=False):
    img = bpy.data.images.load(path, check_existing=False)
    if raw:
        img.colorspace_settings.name = "Non-Color"
    arr = image_array(img).copy()
    bpy.data.images.remove(img)
    return arr


def raster_mask(objs, state, size):
    """Texels whose centre lies inside a shipped lightmap triangle."""
    mask = np.zeros((size, size), bool)
    for o in objs:
        me = o.data
        st = state[o.name]
        uv = get_uv(me) * size
        loops, polyi, _ = tri_data(o)
        raster_tris(mask, uv[loops[st[polyi] > 0]], conservative=False)
    return mask


def dilate(rgb, mask, n):
    """Grow colour outward from covered texels by n pixels (bake margin)."""
    rgb = rgb.astype(np.float32).copy()
    rgb[~mask] = 0.0
    filled = mask.copy()
    h, w = mask.shape
    for _ in range(n):
        pr = np.pad(rgb, ((1, 1), (1, 1), (0, 0)))
        pf = np.pad(filled, 1).astype(np.float32)
        acc = np.zeros_like(rgb)
        cnt = np.zeros((h, w), np.float32)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dy == 1 and dx == 1:
                    continue
                wgt = 1.0 if (dy == 1 or dx == 1) else 0.7
                acc += wgt * pr[dy:dy + h, dx:dx + w]
                cnt += wgt * pf[dy:dy + h, dx:dx + w]
        new = (~filled) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][:, None]
        filled |= new
    return rgb, filled


def smooth_sigma(name):
    for prefix, s in SMOOTH:
        if name.startswith(prefix):
            return s
    return 0.0


def smooth_objects(rgb, covered, objs, state, size):
    """Mask-normalised Gaussian per object (see SMOOTH).  Returns a copy."""
    out = rgb.astype(np.float32).copy()
    n = 0
    for o in objs:
        sigma = smooth_sigma(o.name)
        if sigma <= 0.0:
            continue
        m = raster_mask([o], state, size) & covered
        ys, xs = np.nonzero(m)
        if len(ys) == 0:
            continue
        r = int(math.ceil(3 * sigma))
        y0, y1 = max(ys.min() - r, 0), min(ys.max() + r + 1, size)
        x0, x1 = max(xs.min() - r, 0), min(xs.max() + r + 1, size)
        mm = m[y0:y1, x0:x1]
        w = mm.astype(np.float32)
        num = gaussian_blur(rgb[y0:y1, x0:x1] * w[..., None], sigma, mode="constant")
        den = gaussian_blur(w, sigma, mode="constant")
        sub = out[y0:y1, x0:x1]
        sub[mm] = num[mm] / np.maximum(den[mm], 1e-6)[:, None]
        n += 1
    return out, n


def noise_metric(rgb, mask):
    """Median over 8x8 blocks fully inside `mask` of (std / mean) of the
    luminance residual after removing the block's own plane fit: a rough,
    comparable figure for bake grain."""
    lum = rgb.mean(axis=2)
    h, w = lum.shape
    hb, wb = h // 8, w // 8
    L = lum[:hb * 8, :wb * 8].reshape(hb, 8, wb, 8).transpose(0, 2, 1, 3).reshape(hb, wb, 64)
    M = mask[:hb * 8, :wb * 8].reshape(hb, 8, wb, 8).transpose(0, 2, 1, 3).reshape(hb, wb, 64).all(axis=2)
    blocks = L[M]
    if len(blocks) == 0:
        return 0.0
    yy, xx = np.mgrid[0:8, 0:8]
    A = np.stack([np.ones(64), xx.ravel() - 3.5, yy.ravel() - 3.5], axis=1)
    coef = blocks @ np.linalg.pinv(A).T
    res = blocks - coef @ A.T
    mean = blocks.mean(axis=1)
    ok = mean > 1e-5
    if not ok.any():
        return 0.0
    return float(np.median(res[ok].std(axis=1) / mean[ok]))


# =========================================================================
# encoding
# =========================================================================
BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]], np.float32) / 64.0


def srgb_encode(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb_decode(x):
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


def to_bytes(rgb, rng):
    """linear float (h,w,3) -> uint8 sRGB(value / rng) with ordered dither."""
    h, w = rgb.shape[:2]
    enc = srgb_encode(rgb / rng) * 255.0
    thr = np.tile(BAYER8, (h // 8 + 1, w // 8 + 1))[:h, :w]
    return np.clip(np.floor(enc + thr[..., None]), 0, 255).astype(np.uint8)


def save_bytes(b, path, fmt="WEBP", quality=90):
    """Write a uint8 (h,w,3) array (row 0 = bottom, as Blender stores it)
    without any colour management, then reload and return the stored bytes."""
    h, w = b.shape[:2]
    img = bpy.data.images.new("enc_tmp", w, h, alpha=False, float_buffer=False)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = b.astype(np.float32) / 255.0
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = fmt
    img.save(filepath=path, quality=quality, save_copy=True)
    bpy.data.images.remove(img)
    back = load_image(path, raw=True)
    return np.round(back[..., :3] * 255.0).astype(np.int32)


def encode_map(rgb, mask, path, label, stat_mask=None):
    """Pick the range, write the WebP, verify it by reloading.  The range is
    the 99.9th percentile over stat_mask (default: every covered texel)."""
    peak = rgb[mask].max(axis=1)
    stat = rgb[mask if stat_mask is None else stat_mask].max(axis=1)
    p999 = float(np.percentile(stat, 99.9))
    top = float(stat.max())
    # when the brightest texel is not far above the percentile, keep it whole:
    # that costs at most about half a bit and no real highlight is flattened
    rng = float("%.4g" % (top * 1.004 if top <= 1.5 * p999 else p999 * 1.012))
    b = to_bytes(rgb, rng)
    back = save_bytes(b, path)
    with open(path, "rb") as f:
        head = f.read(12)
    assert head[:4] == b"RIFF" and head[8:12] == b"WEBP", "not a WebP file: " + path
    err = np.abs(back - b.astype(np.int32))
    lin_src = float((srgb_decode(b[mask] / 255.0) * rng).mean())
    lin_back = float((srgb_decode(back[mask] / 255.0) * rng).mean())
    lin_true = float(np.minimum(rgb[mask], rng).mean())
    info = {
        "range": rng, "p99.9": p999, "max": float(peak.max()),
        "clipped_fraction": float((peak > rng).mean()),
        "mean_linear_float": lin_true, "mean_linear_8bit": lin_src, "mean_linear_webp": lin_back,
        "webp_mean_abs_code_error": float(err[mask].mean()), "webp_max_code_error": int(err[mask].max()),
        "bytes": os.path.getsize(path), "coverage": float(mask.mean()),
    }
    log("ENC %-16s range %.4g  p99.9 %.4g max %.4g clip %.3f%%  mean float %.5f 8bit %.5f webp %.5f  "
        "code err mean %.2f max %d  %d bytes  fill %.1f%%" % (
            label, rng, p999, info["max"], 100 * info["clipped_fraction"], lin_true, lin_src, lin_back,
            info["webp_mean_abs_code_error"], info["webp_max_code_error"], info["bytes"], 100 * info["coverage"]))
    return info


def gaussian_blur(img, sigma, mode="edge"):
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = img.astype(np.float32)
    for axis in (0, 1):
        pad = [(0, 0)] * out.ndim
        pad[axis] = (r, r)
        p = np.pad(out, pad, mode=mode)
        acc = np.zeros_like(out)
        for i, kv in enumerate(k):
            sl = [slice(None)] * out.ndim
            sl[axis] = slice(i, i + out.shape[axis])
            acc += kv * p[tuple(sl)]
        out = acc
    return out


# =========================================================================
# rendering
# =========================================================================
def black_world():
    w = bpy.data.worlds.get("Black") or bpy.data.worlds.new("Black")
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    bg.inputs["Strength"].default_value = 0.0
    return w


def render_views(scene, views, out_dir, prefix, samples, denoise):
    os.makedirs(out_dir, exist_ok=True)
    vc.setup_cycles(scene, samples=samples, denoise=denoise)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    cam = vc.add_camera(scene, (0, -1, 0.3), (0, 0, 0))
    cam.data.clip_start = 0.01
    cam.data.sensor_width = 36.0
    cam.data.sensor_fit = "AUTO"
    for name, (loc, target, lens, (w, h)) in views.items():
        scene.render.resolution_x, scene.render.resolution_y = w, h
        cam.location = loc
        cam.data.lens = lens
        vc.look_at(cam, target)
        scene.render.filepath = os.path.join(out_dir, "%s_%s.png" % (prefix, name))
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def render_reflection(scene, tube, glass, samples, path_exr):
    """Square 90 degree view from the glass apex, straight out of the screen."""
    M = tube.matrix_world
    R3 = M.to_3x3()
    fwd = (R3 @ Vector((0, -1, 0))).normalized()
    up = (R3 @ Vector((0, 0, 1))).normalized()
    right = fwd.cross(up).normalized()
    up = right.cross(fwd).normalized()
    apex = M @ Vector((0.0, -0.05, 0.0))
    cam = bpy.data.objects.new("ReflectCam", bpy.data.cameras.new("ReflectCam"))
    scene.collection.objects.link(cam)
    rot = Matrix((right, up, -fwd)).transposed()
    cam.matrix_world = Matrix.Translation(apex + fwd * 0.001) @ rot.to_4x4()
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.angle = math.radians(90.0)
    cam.data.clip_start = 0.002
    scene.camera = cam
    vc.setup_cycles(scene, samples=samples, denoise=True)
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "32"
    scene.render.filepath = path_exr
    was = glass.hide_render
    glass.hide_render = True
    bpy.ops.render.render(write_still=True)
    glass.hide_render = was
    bpy.data.objects.remove(cam)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    return {"right": right, "up": up, "forward": fwd, "apex": apex}


def render_glass_light(scene, tube, glass, samples, path_exr, pinhole):
    """How strongly the room lights the glass, and from where.

    The reflection image only covers 45 degrees off the axis; the lamp and
    most of the window light arrive from further round.  So the whole
    hemisphere in front of the glass is rendered once more, as a 180 degree
    equidistant fisheye from the same point, and integrated with the cosine
    to the glass normal.  Returns (rgb, direction): the radiance a matt white
    surface in the glass's place would have (irradiance / pi), and the
    luminance-weighted mean direction the light comes from, in TubeRef local
    axes.  `pinhole` is the raw reflection render; the two are compared over
    the cone they share, as a check on the fisheye mapping assumed here.
    """
    M = tube.matrix_world
    R3 = M.to_3x3()
    fwd = (R3 @ Vector((0, -1, 0))).normalized()
    up = (R3 @ Vector((0, 0, 1))).normalized()
    right = fwd.cross(up).normalized()
    up = right.cross(fwd).normalized()
    apex = M @ Vector((0.0, -0.05, 0.0))
    cam = bpy.data.objects.new("GlassLightCam", bpy.data.cameras.new("GlassLightCam"))
    scene.collection.objects.link(cam)
    cam.matrix_world = Matrix.Translation(apex + fwd * 0.001) @ Matrix((right, up, -fwd)).transposed().to_4x4()
    cam.data.type = "PANO"
    pano = cam.data if hasattr(cam.data, "panorama_type") else cam.data.cycles
    pano.panorama_type = "FISHEYE_EQUIDISTANT"
    pano.fisheye_fov = math.pi
    cam.data.clip_start = 0.002
    scene.camera = cam
    vc.setup_cycles(scene, samples=samples, denoise=True)
    n = 256
    scene.render.resolution_x = scene.render.resolution_y = n
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "32"
    scene.render.filepath = path_exr
    was = glass.hide_render
    glass.hide_render = True
    bpy.ops.render.render(write_still=True)
    glass.hide_render = was
    bpy.data.objects.remove(cam)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"

    lum_w = np.array([0.2126, 0.7152, 0.0722])

    # Fisheye: a pixel at radius r of the inscribed circle looks r * 90
    # degrees off the axis.  Image rows run bottom-up.  Per unit of image
    # area a pixel covers a solid angle proportional to sin(t) / r.
    img = np.nan_to_num(load_image(path_exr)[..., :3]).astype(np.float64)
    c = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    u, v = np.meshgrid(c, c)
    r = np.sqrt(u * u + v * v)
    theta = r * (math.pi / 2)
    inside = r < 1.0
    solid = np.where(inside, np.sin(theta) / np.maximum(r, 1e-6), 0.0)
    cos_t = np.cos(theta)
    w = solid * cos_t
    rgb = (img * w[..., None]).sum(axis=(0, 1)) / w.sum()
    lum = img @ lum_w
    # camera axes: x = `right`, y = `up`, looking along `fwd`
    sx = np.sin(theta) * u / np.maximum(r, 1e-6)
    sy = np.sin(theta) * v / np.maximum(r, 1e-6)
    wl = lum * w
    d_cam = np.array([(wl * sx).sum(), (wl * sy).sum(), (wl * cos_t).sum()])
    d_cam /= np.linalg.norm(d_cam)

    # The same two lateral means over the 40 degree cone both images cover.
    cone = inside & (theta < math.radians(40))
    wc = lum * solid * cone
    fish = np.array([(wc * sx).sum(), (wc * sy).sum()]) / (wc * cos_t).sum()
    m = pinhole.shape[0]
    pc = (np.arange(m) + 0.5) / m * 2.0 - 1.0
    pu, pv = np.meshgrid(pc, pc)
    pr2 = 1.0 + pu * pu + pv * pv
    pcone = np.sqrt(pu * pu + pv * pv) < math.tan(math.radians(40))
    # solid angle of a pinhole pixel, times the cosine that the direction's
    # own components carry: (1 / r^3) * (1 / r)
    pw = (pinhole[..., :3].astype(np.float64) @ lum_w) * pcone / pr2 ** 2
    pin = np.array([(pw * pu).sum(), (pw * pv).sum()]) / pw.sum()
    log("GLASS LIGHT lateral mean over the shared cone: fisheye (%.4f, %.4f), pinhole (%.4f, %.4f)" % (*fish, *pin))
    if np.abs(fish - pin).max() > 0.03:
        raise RuntimeError("fisheye and pinhole views of the room disagree: %r %r" % (fish, pin))

    # camera right is TubeRef local -X, camera up is local +Z, forward is -Y
    direction = [-float(d_cam[0]), -float(d_cam[2]), float(d_cam[1])]
    return [float(x) for x in rgb], direction


FONT = {
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "01010", "01010", "00100"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "=": ("00000", "00000", "11111", "00000", "11111", "00000", "00000"),
    " ": ("00000",) * 7,
}


def draw_text(img_top, text, x, y, scale=3, color=(255, 255, 255)):
    """img_top: uint8 (h,w,3) with row 0 at the TOP.  (x, y) = top-left of the text."""
    for ch in text:
        glyph = FONT[ch]
        for r, row in enumerate(glyph):
            for c, bit in enumerate(row):
                if bit == "1":
                    img_top[y + r * scale:y + (r + 1) * scale, x + c * scale:x + (c + 1) * scale] = color
        x += 6 * scale


def reflection_debug(b, path):
    """b: uint8 (h,w,3) bottom-up.  Writes a PNG with orientation labels."""
    top = b[::-1].copy()
    h, w = top.shape[:2]
    s = 28
    top[:s, :s] = (255, 0, 0)            # top-left: u=0, v=0
    top[:s, w - s:] = (0, 255, 0)        # top-right: u=1, v=0
    top[h - s:, :s] = (0, 0, 255)        # bottom-left: u=0, v=1
    top[h - s:, w - s:] = (255, 255, 0)  # bottom-right: u=1, v=1
    draw_text(top, "U=0 V=0", 34, 6)
    draw_text(top, "U=1 V=0", w - 34 - 7 * 18, 6)
    draw_text(top, "U=0 V=1", 34, h - 27)
    draw_text(top, "U=1 V=1", w - 34 - 7 * 18, h - 27)
    draw_text(top, "+X", 6, h // 2 - 10)
    draw_text(top, "-X", w - 42, h // 2 - 10)
    draw_text(top, "+Z", w // 2 - 18, 40)
    draw_text(top, "-Z", w // 2 - 18, h - 61)
    save_bytes(top[::-1], path, fmt="PNG")


def look_material(name, room_path, screen_path, room_range, screen_range):
    """Emission = decoded room map * range + decoded screen map * range *
    picture radiance.  Back faces glow magenta so holes show."""
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    uv = nt.nodes.new("ShaderNodeUVMap")
    uv.uv_map = LM_NAME
    texs = []
    for p in (room_path, screen_path):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = bpy.data.images.load(p, check_existing=True)
        t.image.colorspace_settings.name = "sRGB"
        t.interpolation = "Linear"
        t.extension = "EXTEND"
        nt.links.new(uv.outputs["UV"], t.inputs["Vector"])
        texs.append(t)
    a = nt.nodes.new("ShaderNodeVectorMath")
    a.operation = "SCALE"
    a.inputs["Scale"].default_value = room_range
    nt.links.new(texs[0].outputs["Color"], a.inputs[0])
    b = nt.nodes.new("ShaderNodeVectorMath")
    b.operation = "MULTIPLY"
    b.inputs[1].default_value = tuple(c * PICTURE_LEVEL * screen_range for c in PICTURE_RGB)
    nt.links.new(texs[1].outputs["Color"], b.inputs[0])
    add = nt.nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    nt.links.new(a.outputs["Vector"], add.inputs[0])
    nt.links.new(b.outputs["Vector"], add.inputs[1])
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(add.outputs["Vector"], em.inputs["Color"])
    back = nt.nodes.new("ShaderNodeEmission")
    back.inputs["Color"].default_value = (1.0, 0.0, 1.0, 1.0)
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(geo.outputs["Backfacing"], mix.inputs["Fac"])
    nt.links.new(em.outputs[0], mix.inputs[1])
    nt.links.new(back.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def flat_material(name, rgb):
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*rgb, 1.0)
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return mat


def set_single_material(obj, mat):
    me = obj.data
    me.materials.clear()
    me.materials.append(mat)
    me.polygons.foreach_set("material_index", np.zeros(len(me.polygons), np.int32))
    me.update()


def compare_png(a_path, b_path):
    a = load_image(a_path, raw=True)[..., :3]
    b = load_image(b_path, raw=True)[..., :3]
    d = np.abs(a - b) * 255.0
    return {"mean_abs_diff_srgb8": [float(v) for v in d.mean(axis=(0, 1))],
            "p95_abs_diff_srgb8": float(np.percentile(d.max(axis=2), 95)),
            "mean_a": [float(v) * 255 for v in a.mean(axis=(0, 1))],
            "mean_b": [float(v) * 255 for v in b.mean(axis=(0, 1))]}


# =========================================================================
# glb export and verification
# =========================================================================
def tune_meshopt_precision(position_bits=16, other_bits=10):
    """Blender's exporter stores positions and normals through meshopt's
    exponential filter with a fixed 12-bit mantissa, which is about 1 mm on
    this scene's larger objects.  Give positions more and normals fewer
    bits.  (Texture coordinates are stored as plain floats, unfiltered.)"""
    import io_scene_gltf2.io.exp.meshopt as mod
    enc = mod.MeshoptEncoder
    if getattr(enc, "_vt_patched", False):
        return
    original = enc.encode_attribute

    def encode_attribute(attribute_name, data, byteStride, export_settings):
        mod.EXP_FILTER_BITS = position_bits if attribute_name == "POSITION" else other_bits
        return original(attribute_name, data, byteStride, export_settings)

    enc.encode_attribute = staticmethod(encode_attribute)
    enc._vt_patched = True


def parse_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _, length = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and length == len(data)
    off = 12
    js, binary = None, b""
    while off < length:
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            binary = chunk
        off += 8 + clen
    return js, binary


class Meshopt:
    def __init__(self):
        from io_scene_gltf2.io.com.library import dll_path
        self.lib = ctypes.CDLL(str(dll_path("bf_intern_meshopt_bridge", "MeshOptimizer").resolve()))
        for fn in (self.lib.decodeVertexBuffer, self.lib.decodeIndexBuffer, self.lib.decodeIndexSequence):
            fn.restype = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t,
                           ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t]
        for fn in (self.lib.decodeFilterOct, self.lib.decodeFilterQuat, self.lib.decodeFilterExp):
            fn.restype = None
            fn.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]

    def view(self, js, binary, index, cache):
        if index in cache:
            return cache[index]
        bv = js["bufferViews"][index]
        ext = (bv.get("extensions") or {}).get("EXT_meshopt_compression")
        if ext is None:
            out = binary[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
            cache[index] = (bytes(out), bv.get("byteStride", 0), False)
            return cache[index]
        src = binary[ext.get("byteOffset", 0):ext.get("byteOffset", 0) + ext["byteLength"]]
        count, stride = ext["count"], ext["byteStride"]
        out = bytearray(count * stride)
        dst = (ctypes.c_ubyte * len(out)).from_buffer(out)
        buf = (ctypes.c_ubyte * len(src)).from_buffer_copy(src)
        fn = {"ATTRIBUTES": self.lib.decodeVertexBuffer, "TRIANGLES": self.lib.decodeIndexBuffer,
              "INDICES": self.lib.decodeIndexSequence}[ext["mode"]]
        rc = fn(dst, count, stride, buf, len(src))
        assert rc == 0, "meshopt decode failed (%d) on bufferView %d" % (rc, index)
        flt = ext.get("filter")
        if ext["mode"] == "ATTRIBUTES" and flt not in (None, "NONE"):
            {"OCTAHEDRAL": self.lib.decodeFilterOct, "QUATERNION": self.lib.decodeFilterQuat,
             "EXPONENTIAL": self.lib.decodeFilterExp}[flt](dst, count, stride)
        del dst
        cache[index] = (bytes(out), stride, True)
        return cache[index]


def accessor_array(js, binary, mo, index, cache):
    acc = js["accessors"][index]
    data, stride, _ = mo.view(js, binary, acc["bufferView"], cache)
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    dt = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[
        acc["componentType"]]
    item = np.dtype(dt).itemsize * ncomp
    stride = stride or item
    off = acc.get("byteOffset", 0)
    raw = np.frombuffer(data, np.uint8)
    rows = np.lib.stride_tricks.as_strided(raw[off:], shape=(acc["count"], item), strides=(stride, 1))
    return np.ascontiguousarray(rows).view(dt).reshape(acc["count"], ncomp)


def verify_glb(path, expect):
    """expect: {node name: object}.  Checks attributes and decoded positions
    / lightmap UVs against the Blender meshes.  Returns a stats dict."""
    js, binary = parse_glb(path)
    mo = Meshopt()
    cache = {}
    stats = {"file_bytes": os.path.getsize(path), "extensionsUsed": js.get("extensionsUsed", []),
             "extensionsRequired": js.get("extensionsRequired", []),
             "images": len(js.get("images", [])), "textures": len(js.get("textures", [])),
             "materials": [(m.get("name"), m.get("doubleSided", False)) for m in js.get("materials", [])],
             "scene_extras": js["scenes"][js.get("scene", 0)].get("extras", {}),
             "nodes": [], "triangles": 0, "vertices": 0, "max_pos_err_mm": 0.0, "max_uv1_err_texel_2048": 0.0}
    compressed = 0
    for node in js["nodes"]:
        name = node.get("name")
        row = {"name": name, "extras": node.get("extras", {})}
        if "mesh" in node:
            mesh = js["meshes"][node["mesh"]]
            tris = verts = 0
            pos_all, uv1_all = [], []
            for prim in mesh["primitives"]:
                at = prim["attributes"]
                assert "TEXCOORD_0" in at and "TEXCOORD_1" in at, "missing UV set on " + name
                assert "TEXCOORD_2" not in at, "stray third UV set on " + name
                pos = accessor_array(js, binary, mo, at["POSITION"], cache)
                uv1 = accessor_array(js, binary, mo, at["TEXCOORD_1"], cache)
                idx = accessor_array(js, binary, mo, prim["indices"], cache)
                assert int(idx.max()) < len(pos)
                tris += len(idx) // 3
                verts += len(pos)
                pos_all.append(pos)
                uv1_all.append(uv1)
            row.update(triangles=tris, vertices=verts)
            stats["triangles"] += tris
            stats["vertices"] += verts
            obj = expect.get(name)
            if obj is not None:
                me = obj.data
                # glTF is Y up: (x, y, z)_gltf = (x, z, -y)_blender, mesh-local
                kd = KDTree(len(me.vertices))
                for i, v in enumerate(me.vertices):
                    kd.insert((v.co.x, v.co.z, -v.co.y), i)
                kd.balance()
                pos = np.concatenate(pos_all)
                err = max(kd.find(tuple(p))[2] for p in pos.tolist())
                row["pos_err_mm"] = err * 1000.0
                stats["max_pos_err_mm"] = max(stats["max_pos_err_mm"], err * 1000.0)
                if LM_NAME in me.uv_layers:
                    uv = get_uv(me)
                    ku = KDTree(len(uv))
                    for i, (u, v) in enumerate(uv.tolist()):
                        ku.insert((u, 1.0 - v, 0.0), i)
                    ku.balance()
                    uerr = max(ku.find((float(u), float(v), 0.0))[2] for u, v in np.concatenate(uv1_all).tolist())
                    row["uv1_err_texel"] = uerr * 2048.0
                    stats["max_uv1_err_texel_2048"] = max(stats["max_uv1_err_texel_2048"], uerr * 2048.0)
        stats["nodes"].append(row)
    for bv in js["bufferViews"]:
        if "EXT_meshopt_compression" in (bv.get("extensions") or {}):
            compressed += 1
    stats["compressed_bufferviews"] = compressed
    stats["bufferviews"] = len(js["bufferViews"])
    return stats


# =========================================================================
# main
# =========================================================================
def main():
    args = vc.script_args()
    samples = arg(args, "--samples", 1024, int)
    env_samples = arg(args, "--env-samples", samples * 4, int)
    size = arg(args, "--size", 2048, int)
    out_dir = arg(args, "--out", os.path.join(REPO, "src", "assets"))
    bake_dir = arg(args, "--bake-dir", os.path.join(tempfile.gettempdir(), "vt_bake"))
    preview = arg(args, "--preview")
    pv_samples = arg(args, "--preview-samples", 256, int)
    skip_bake = "--skip-bake" in args
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(bake_dir, exist_ok=True)
    t_start = time.time()
    report = {"samples": samples, "size": size}

    # ---------------------------------------------------------- build
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Scene")
    scene.collection.children.link(col)
    T = vt_terminal.build(col)
    K = vt_keyboard.build(col)
    Rm = vt_room.build(col)
    L = vt_room.lights(col)

    kb = K["Keyboard"]
    kb.location = KB_LOC
    kb.rotation_euler = (0.0, 0.0, KB_YAW)
    bpy.context.view_layer.update()
    notch = kb.matrix_world @ K["cable_notch"]["right"]
    out_dir_v = (kb.matrix_world.to_3x3() @ Vector((1, 0, 0))).normalized()
    cable, cable_uv, cable_strip = build_cable(col, notch, out_dir_v, T["kb_jack"])
    custom = {cable.name: cable_uv}

    for name, spec in WARPS.items():
        bisect_for_warp(bpy.data.objects[name], spec)
    bpy.context.view_layer.update()

    tube, glass = T["TubeRef"], T["GlassProxy"]
    glass_setup(tube)
    led_bsdf = bpy.data.materials["PowerLED"].node_tree.nodes["Principled BSDF"]
    led_strength = led_bsdf.inputs["Emission Strength"].default_value
    panes, bulb = Rm["emissive"]

    kb_family = [kb] + K["keys"] + [K["LegendStrip"]] + K["leds"] + K["parts"]
    term_family = T["body"] + [T["PowerButton"], T["PowerLED"]]
    hero_all = T["body"] + [T["PowerButton"], kb] + K["keys"] + [K["LegendStrip"]] + K["parts"] + [cable]
    led_objs = [T["PowerLED"]] + K["leds"]
    shell_front = [bpy.data.objects[n] for n in ("Wall_Left", "Wall_Right", "Floor", "Ceiling", "Skirting")]
    env_all = Rm["desk"] + [Rm["wall"]] + shell_front + Rm["props"] + Rm["lamp"]
    behind = [o for o in Rm["room"] if o not in shell_front] + [panes]

    # ---------------------------------------------------------- intersections
    bad = check_intersections(
        {"keyboard": kb_family, "terminal": term_family + [glass], "props": Rm["props"],
         "lamp": Rm["lamp"] + [bulb], "cable": [cable]},
        {frozenset(("Kbd_Cable", "Keyboard")), frozenset(("Kbd_Cable", "RearDetails")),
         frozenset(("Kbd_Cable", "Housing"))})
    report["intersections"] = bad
    log("INTERSECTIONS", bad if bad else "none")
    kb_lo = [min((o.matrix_world @ Vector(c))[k] for o in kb_family for c in o.bound_box) for k in range(3)]
    kb_hi = [max((o.matrix_world @ Vector(c))[k] for o in kb_family for c in o.bound_box) for k in range(3)]
    log("keyboard world bounds x %.3f..%.3f y %.3f..%.3f z %.4f..%.4f" % (kb_lo[0], kb_hi[0], kb_lo[1], kb_hi[1], kb_lo[2], kb_hi[2]))
    if bad:
        raise RuntimeError("objects intersect: %r" % (bad,))

    # ---------------------------------------------------------- beauty (ground truth)
    if preview and "--no-beauty" not in args:
        glass_picture(PICTURE_RGB, PICTURE_LEVEL)
        t0 = time.time()
        render_views(scene, VIEWS, preview, "beauty", pv_samples, True)
        render_views(scene, EXTREMES, preview, "beauty", max(pv_samples // 2, 32), True)
        render_views(scene, CLOSEUPS, preview, "beauty", pv_samples, True)
        log("beauty renders %.0f s" % (time.time() - t0))
    glass_picture((1, 1, 1), 0.0)

    # ---------------------------------------------------------- what can be seen
    t0 = time.time()
    all_mesh = [o for o in col.objects if o.type == "MESH"]
    button = T["PowerButton"]
    keyset = set(K["keys"])
    world_all = World([o for o in all_mesh if o is not button])
    world_nokeys = World([o for o in all_mesh if o is not button and o not in keyset])
    hits = framing_hits(World(all_mesh), dict(VIEWS, **EXTREMES))
    report["framing_hits"] = hits
    for n in sorted(hits):
        if not n.startswith("Key_"):
            log("FRAMING %-16s %s" % (n, hits[n]))
    eyes = viewpoints()
    state, weights = {}, {}
    keep_objs = []
    vis_rows = []
    for o in hero_all + env_all + led_objs + [bulb]:
        if o in shell_front:
            seen_any = o.name in hits
            st = np.ones(len(o.data.polygons), np.int8) if seen_any else np.zeros(len(o.data.polygons), np.int8)
            if o.name == "Skirting" and seen_any:
                _, grow, _ = face_visibility(o, world_all, eyes)
                st = grow.astype(np.int8)
        else:
            _, grow, tiny = face_visibility(o, world_nokeys if o in keyset else world_all, eyes)
            if o.name == "Notepad":
                grow = grow | tiny          # the spiral wire: point samples miss its facets
            st = grow.astype(np.int8)
        if o is button or o in led_objs or o.name.startswith("Nameplate"):
            st[:] = 1                       # small moving / recoloured parts keep every face
        if o.name in WARPS:
            spec = WARPS[o.name]
            axis_n = 3 - spec["u"] - spec["v"]
            mw = o.matrix_world
            co, _ = world_arrays(o)
            cu = np.zeros((len(o.data.loops), 2))
            for p in o.data.polygons:
                # the big flat faces are always shipped, whatever the ray test said
                if abs(p.normal[axis_n]) > 0.999 and (SEAT - mw @ p.center).dot(p.normal) > 0:
                    st[p.index] = 2
                    for li, vi in zip(p.loop_indices, p.vertices):
                        cu[li, 0] = warp_coord(co[vi][spec["u"]], spec["breaks_u"], spec["dens_u"])
                        cu[li, 1] = warp_coord(co[vi][spec["v"]], spec["breaks_v"], spec["dens_v"])
            custom[o.name] = cu
        if o is cable:
            st[(st > 0) & cable_strip] = 2
        state[o.name] = st
        weights[o.name] = face_weights(o)
        vis_rows.append((o.name, int((st > 0).sum()), len(st)))
        if (st > 0).any():
            keep_objs.append(o)
    log("visibility %.0f s" % (time.time() - t0))
    dropped = [n for n, k, _ in vis_rows if k == 0]
    report["dropped_objects"] = dropped
    log("DROPPED (never seen):", dropped)
    kk = [(k, t) for n, k, t in vis_rows if n.startswith("Key_")]
    log("VIS keys: %d of %d faces kept" % (sum(k for k, _ in kk), sum(t for _, t in kk)))
    for n, k, t in vis_rows:
        if not n.startswith("Key_"):
            log("VIS %-16s %5d of %5d faces kept" % (n, k, t))

    hero = [o for o in hero_all if o in keep_objs]
    env = [o for o in env_all if o in keep_objs]
    atlases = {"hero": hero, "env": env}

    # ---------------------------------------------------------- lightmap UVs
    ISLAND_GROUP["Desk_Top"] = side_groups(bpy.data.objects["Desk_Top"])
    for name, objs in atlases.items():
        t0 = time.time()
        info = layout_atlas(objs, state, weights, size, custom)
        log("UV %s: %s  (%.0f s)" % (name, info, time.time() - t0))
        report["uv_" + name] = info
        rows = texel_stats(objs, state, size)
        keys_rows = [r for r in rows if r[0].startswith("Key_")]
        if keys_rows:
            log("TEXEL keys: %.2f texels/mm (mean)" % (sum(r[1] for r in keys_rows) / len(keys_rows)))
        for n, d, a in rows:
            if not n.startswith("Key_"):
                log("TEXEL %-16s %.2f texels/mm  (%.4f m2 shipped)" % (n, d, a))
        report["texel_" + name] = rows
    for o in led_objs + ([bulb] if bulb in keep_objs else []):
        me = o.data
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[-1])
        me.uv_layers.new(name=LM_NAME, do_init=False)
        set_uv(me, np.zeros((len(me.loops), 2)))
    checksum = {n: uv_checksum(objs) for n, objs in atlases.items()}

    masks = {}
    for name, objs in atlases.items():
        t0 = time.time()
        masks[name] = raster_mask(objs, state, size)
        log("mask %s: %.1f%% of the atlas covered (%.0f s)" % (name, 100 * masks[name].mean(), time.time() - t0))

    # Texels left out when a map's range is chosen: the inside of the lamp
    # shade sits a few centimetres from the bulb and is ten times brighter
    # than anything else, so it is allowed to clip instead of costing every
    # other surface three bits of precision.
    range_skip = {}
    for name, objs in atlases.items():
        skip = [o for o in objs if o.name in RANGE_SKIP]
        range_skip[name] = grow_mask(raster_mask(skip, state, size), 2) if skip else np.zeros((size, size), bool)

    if "--blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(bake_dir, "scene.blend"))

    # ---------------------------------------------------------- bake
    meta_path = os.path.join(bake_dir, "bake_meta.json")
    raw = {}
    if skip_bake:
        with open(meta_path) as f:
            meta = json.load(f)
        if meta.get("checksum") != checksum or meta.get("size") != size:
            raise RuntimeError("--skip-bake: the lightmap layout changed since the masters were baked")
        for name in atlases:
            for pas in ("room", "screen"):
                raw[(name, pas)] = load_image(os.path.join(bake_dir, "raw_%s_%s.exr" % (name, pas)))
        log("reused baked masters from", bake_dir, "(%d spp)" % meta.get("samples", -1))
        report["samples"] = meta.get("samples")
    else:
        setup_bake_device(scene, samples)
        led_bsdf.inputs["Emission Strength"].default_value = 0.0
        light_objs = [L["window_light"], L["lamp_light"]]
        for pas in ("room", "screen"):
            if pas == "room":
                scene.world = L["world"]
                glass_picture((1, 1, 1), 0.0)
                for o in light_objs + [panes, bulb]:
                    o.hide_render = False
            else:
                scene.world = black_world()
                glass_picture((1, 1, 1), 1.0)
                for o in light_objs + [panes, bulb]:
                    o.hide_render = True
            for name, objs in atlases.items():
                t0 = time.time()
                img = bpy.data.images.new("bake_%s_%s" % (name, pas), size, size, alpha=True, float_buffer=True)
                spp = env_samples if name == "env" else samples
                scene.cycles.samples = spp
                bake_into(scene, objs, img)
                arr = image_array(img)
                alpha = arr[..., 3] > 0
                lit = arr[..., :3].max(axis=2) > 0
                log("  alpha>0 %.2f%%  rgb>0 %.2f%%  mask %.2f%%  mask&~alpha %d  alpha&~mask %d  mask&~rgb %d" % (
                    100 * alpha.mean(), 100 * lit.mean(), 100 * masks[name].mean(),
                    int((masks[name] & ~alpha).sum()), int((alpha & ~masks[name]).sum()),
                    int((masks[name] & ~lit).sum())))
                raw[(name, pas)] = arr.copy()
                save_exr(arr, os.path.join(bake_dir, "raw_%s_%s.exr" % (name, pas)))
                bpy.data.images.remove(img)
                log("BAKE %s/%s: %d objects, %d spp, %d px, %.0f s" % (name, pas, len(objs), spp, size, time.time() - t0))
        scene.world = L["world"]
        glass_picture((1, 1, 1), 0.0)
        for o in light_objs + [panes, bulb]:
            o.hide_render = False
        led_bsdf.inputs["Emission Strength"].default_value = led_strength
        with open(meta_path, "w") as f:
            json.dump({"checksum": checksum, "size": size, "samples": samples, "env_samples": env_samples}, f)

    # ---------------------------------------------------------- encode
    enc = {}
    files = {}
    # A texel counts as covered only if the layout says so AND Cycles wrote
    # it in both passes (the baked image's alpha); everything else is margin.
    for name in atlases:
        masks[name] = masks[name] & (raw[(name, "room")][..., 3] > 0) & (raw[(name, "screen")][..., 3] > 0)
    probes = {"hero": {"keys": [o for o in hero if o.name.startswith("Key_")],
                       "Collar": [o for o in hero if o.name == "Collar"]},
              "env": {"Wall_Desk": [o for o in env if o.name == "Wall_Desk"],
                      "Desk_Top": [o for o in env if o.name == "Desk_Top"]}}
    probe_masks = {(name, k): grow_mask(~(raster_mask(objs, state, size) & masks[name]), 1) == 0
                   for name, d in probes.items() for k, objs in d.items() if objs}
    grown_maps = {}
    report["noise"] = {}
    for (name, pas), rgba in raw.items():
        rgb = np.nan_to_num(rgba[..., :3], nan=0.0, posinf=0.0, neginf=0.0)
        if "--no-smooth" not in args:
            before = rgb
            rgb, n_s = smooth_objects(rgb, masks[name], atlases[name], state, size)
            for (an, k), pm in probe_masks.items():
                if an == name:
                    a, b = noise_metric(before, pm), noise_metric(rgb, pm)
                    report["noise"]["%s_%s_%s" % (name, pas, k)] = [a, b]
                    log("NOISE %s/%s %-10s relative grain %.2f%% -> %.2f%% (%d objects filtered)" % (
                        name, pas, k, 100 * a, 100 * b, n_s))
        grown, _ = dilate(rgb, masks[name], DILATE_PX)
        grown_maps[(name, pas)] = grown
        save_exr(grown, os.path.join(bake_dir, "lm_%s_%s.exr" % (name, pas)))
        path = os.path.join(out_dir, "lm_%s_%s.webp" % (name, pas))
        enc[(name, pas)] = encode_map(grown, masks[name], path, "%s/%s" % (name, pas),
                                      masks[name] & ~range_skip[name])
        files[(name, pas)] = path
        over = grown.max(axis=2) > enc[(name, pas)]["range"]
        if (over & masks[name]).any():
            rows = []
            for o in atlases[name]:
                m = raster_mask([o], state, size) & masks[name]
                if (m & over).any():
                    rows.append((o.name, int((m & over).sum()), round(float(grown[m].max()), 3)))
            enc[(name, pas)]["clipped_by_object"] = rows
            log("CLIP %s/%s (object, texels above range, object max): %s" % (name, pas, rows))
    report["encode"] = {"%s_%s" % k: v for k, v in enc.items()}

    # ---------------------------------------------------------- reflection
    t0 = time.time()
    led_bsdf.inputs["Emission Strength"].default_value = 0.0
    refl_exr = os.path.join(bake_dir, "reflect_raw.exr")
    basis = render_reflection(scene, tube, glass, arg(args, "--reflect-samples", 512, int), refl_exr)
    refl = np.nan_to_num(load_image(refl_exr)[..., :3])
    glass_light, glass_light_dir = render_glass_light(
        scene, tube, glass, 256, os.path.join(bake_dir, "glass_light.exr"), refl)
    led_bsdf.inputs["Emission Strength"].default_value = led_strength
    log("GLASS LIGHT radiance of a white surface %s, from %s (TubeRef local)" % (
        [round(c, 4) for c in glass_light], [round(c, 3) for c in glass_light_dir]))
    report["glass_light"] = {"rgb": glass_light, "direction": glass_light_dir}
    refl = gaussian_blur(refl, 2.5)
    save_exr(refl, os.path.join(bake_dir, "reflect.exr"))
    peak = refl.max(axis=2)
    reflect_range = float("%.4g" % max(1.0, float(np.percentile(peak, 99.7)) * 1.012))
    rb = to_bytes(refl, reflect_range)
    refl_path = os.path.join(out_dir, "reflect.webp")
    back = save_bytes(rb, refl_path)
    reflection_debug(rb, os.path.join(bake_dir, "reflect_debug.png"))
    report["reflect"] = {
        "range": reflect_range, "max": float(peak.max()), "p99": float(np.percentile(peak, 99)),
        "p99.7": float(np.percentile(peak, 99.7)), "clipped_fraction": float((peak > reflect_range).mean()),
        "mean_linear_float": float(np.minimum(refl, reflect_range).mean()),
        "mean_linear_webp": float((srgb_decode(back / 255.0) * reflect_range).mean()),
        "bytes": os.path.getsize(refl_path),
        "camera_right": [round(v, 5) for v in basis["right"]], "camera_up": [round(v, 5) for v in basis["up"]],
        "camera_forward": [round(v, 5) for v in basis["forward"]], "camera_at": [round(v, 5) for v in basis["apex"]],
    }
    log("REFLECT", report["reflect"], "(%.0f s)" % (time.time() - t0))

    # ---------------------------------------------------------- strip unseen faces
    tri_before = tri_after = 0
    for o in keep_objs:
        me = o.data
        me.calc_loop_triangles()
        tri_before += len(me.loop_triangles)
        st = state[o.name]
        if (st == 0).any():
            bm = bmesh.new()
            bm.from_mesh(me)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if st[f.index] == 0], context="FACES")
            bm.to_mesh(me)
            bm.free()
        me.calc_loop_triangles()
        tri_after += len(me.loop_triangles)
    log("TRIM %d -> %d triangles" % (tri_before, tri_after))
    report["triangles_before_trim"] = tri_before
    report["triangles_after_trim"] = tri_after

    # ---------------------------------------------------------- properties
    for name, objs in atlases.items():
        for o in objs:
            o["atlas"] = name
    for o in led_objs:
        o["role"] = "led"
    bulb_rgb = [1.0, 0.86, 0.66]
    if bulb in keep_objs:
        bulb["role"] = "emissive"
        bulb["emissive"] = bulb_rgb
        if "emission_strength" in bulb:
            del bulb["emission_strength"]
    ranges = {
        "room_range_hero": enc[("hero", "room")]["range"], "room_range_env": enc[("env", "room")]["range"],
        "screen_range_hero": enc[("hero", "screen")]["range"], "screen_range_env": enc[("env", "screen")]["range"],
        "reflect_range": reflect_range, "tube_unit": vc.TUBE_UNIT,
    }
    for k, v in ranges.items():
        scene[k] = v
    scene["lightmap_size"] = size
    scene["picture_scale"] = [0.88, 0.84]
    scene["reflect_fov_deg"] = 90.0
    scene["glass_light"] = [round(c, 5) for c in glass_light]
    scene["glass_light_dir"] = [round(c, 4) for c in glass_light_dir]
    report["ranges"] = ranges

    # ---------------------------------------------------------- unlit extras
    # Faces brighter than their map can hold (the inside of the lamp shade
    # next to the bulb) become a separate unlit object, so they read as
    # glowing instead of clipping to a flat grey.
    glows = []
    for o in [x for x in env if x.name in RANGE_SKIP]:
        glow, rad = split_glow(o, col, grown_maps[("env", "room")], enc[("env", "room")]["range"], size)
        if glow is None:
            continue
        del glow["atlas"]
        glow["role"] = "emissive"
        glow["emissive"] = [round(min(float(c), 1.0), 4) for c in rad]
        glow["emissive_radiance"] = [round(float(c), 4) for c in rad]
        glows.append(glow)
        keep_objs.append(glow)
        log("GLOW %s: %d faces, mean radiance %s" % (glow.name, len(glow.data.polygons), glow["emissive_radiance"][:]))
    report["glow"] = {g.name: list(g["emissive_radiance"]) for g in glows}
    backing = build_backing(col)
    keep_objs.append(backing)

    # ---------------------------------------------------------- baked look
    export_objs = keep_objs + [tube] + Rm["cameras"]
    if preview:
        t0 = time.time()
        for name, objs in atlases.items():
            mat = look_material("Look_" + name, files[(name, "room")], files[(name, "screen")],
                                enc[(name, "room")]["range"], enc[(name, "screen")]["range"])
            for o in objs:
                set_single_material(o, mat)
        set_single_material(T["PowerLED"], flat_material("Look_PowerLED", tuple(c * 0.7 for c in vc.srgb("#58E84A"))))
        kled = flat_material("Look_KbdLED", tuple(c * 0.25 for c in vc.srgb("#33523A")))
        for o in K["leds"]:
            set_single_material(o, kled)
        if bulb in keep_objs:
            set_single_material(bulb, flat_material("Look_Bulb", bulb_rgb))
        for g in glows:
            set_single_material(g, flat_material("Look_" + g.name, tuple(g["emissive"])))
        # blue, so that it is obvious wherever it shows (it must only ever
        # show through the screen opening, and only when the glass is hidden)
        set_single_material(backing, flat_material("Look_Backing", (0.0, 0.0, 1.0)))
        # the glass shows only its picture
        gm = bpy.data.materials.new("Look_Glass")
        nt = gm.node_tree
        nt.nodes.clear()
        o_ = nt.nodes.new("ShaderNodeOutputMaterial")
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = (*PICTURE_RGB, 1.0)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.object = tube
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(tc.outputs["Object"], sep.inputs[0])
        prod = None
        for axis, half in (("X", PICTURE_HALF[0]), ("Z", PICTURE_HALF[1])):
            ab = nt.nodes.new("ShaderNodeMath")
            ab.operation = "ABSOLUTE"
            nt.links.new(sep.outputs[axis], ab.inputs[0])
            lt = nt.nodes.new("ShaderNodeMath")
            lt.operation = "LESS_THAN"
            lt.inputs[1].default_value = half
            nt.links.new(ab.outputs[0], lt.inputs[0])
            if prod is None:
                prod = lt
            else:
                m2 = nt.nodes.new("ShaderNodeMath")
                m2.operation = "MULTIPLY"
                m2.inputs[1].default_value = PICTURE_LEVEL
                nt.links.new(prod.outputs[0], m2.inputs[0])
                m3 = nt.nodes.new("ShaderNodeMath")
                m3.operation = "MULTIPLY"
                nt.links.new(m2.outputs[0], m3.inputs[0])
                nt.links.new(lt.outputs[0], m3.inputs[1])
                nt.links.new(m3.outputs[0], em.inputs["Strength"])
        nt.links.new(em.outputs[0], o_.inputs["Surface"])
        set_single_material(glass, gm)

        hidden = []
        for o in list(col.objects):
            if o not in keep_objs and o is not glass and o.type in ("MESH", "LIGHT") and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
        scene.world = black_world()
        allv = dict(VIEWS, **EXTREMES)
        allv.update(CLOSEUPS)
        render_views(scene, allv, preview, "baked", 24, False)
        # the same without the glass: what the glb alone shows.  The opening
        # must be closed by ScreenBacking (blue) with no magenta round it.
        glass.hide_render = True
        noglass = dict(VIEWS, **EXTREMES)
        noglass["close_recess_chin"] = CLOSEUPS["close_recess_chin"]
        render_views(scene, noglass, preview, "noglass", 24, False)
        glass.hide_render = False
        # would the env atlas survive at half size?
        half = {}
        for pas in ("room", "screen"):
            g = grown_maps[("env", pas)]
            g = g.reshape(size // 2, 2, size // 2, 2, 3).mean(axis=(1, 3))
            half[pas] = os.path.join(bake_dir, "lm_env_%s_half.webp" % pas)
            save_bytes(to_bytes(g, enc[("env", pas)]["range"]), half[pas])
        hm = look_material("Look_env_half", half["room"], half["screen"],
                           enc[("env", "room")]["range"], enc[("env", "screen")]["range"])
        full = {o.name: o.data.materials[0] for o in env}
        for o in env:
            set_single_material(o, hm)
        half_views = {k: allv[k] for k in ("seat28", "lookdown", "close_desk_lamp", "close_keys")}
        render_views(scene, half_views, preview, "bakedhalf", 24, False)
        for o in env:
            set_single_material(o, full[o.name])
        for v in half_views:
            c = compare_png(os.path.join(preview, "baked_%s.png" % v), os.path.join(preview, "bakedhalf_%s.png" % v))
            report["half_env_" + v] = c
            log("HALF-ENV %s full vs half-size env atlas: mean abs diff %s, p95 %.2f (sRGB8)" % (
                v, [round(x, 2) for x in c["mean_abs_diff_srgb8"]], c["p95_abs_diff_srgb8"]))
        for o in hidden:
            o.hide_render = False
        scene.world = L["world"]
        log("baked-look renders %.0f s" % (time.time() - t0))
        holes = {}
        for prefix, vs in (("baked", allv), ("noglass", noglass)):
            for v in vs:
                a = load_image(os.path.join(preview, "%s_%s.png" % (prefix, v)), raw=True)
                holes["%s_%s" % (prefix, v)] = int(((a[..., 0] - a[..., 1] > 0.2) & (a[..., 2] - a[..., 1] > 0.2)).sum())
        report["magenta_pixels"] = holes
        log("HOLES (magenta back-face pixels per view; noglass = glass hidden):", holes)
        if "--no-beauty" not in args:
            for v in VIEWS:
                c = compare_png(os.path.join(preview, "beauty_%s.png" % v), os.path.join(preview, "baked_%s.png" % v))
                report["compare_" + v] = c
                log("COMPARE %s beauty vs baked: %s" % (v, c))
        # atlas views
        for (name, pas), path in files.items():
            b = np.round(load_image(path, raw=True)[..., :3] * 255).astype(np.uint8)
            save_bytes(b, os.path.join(preview, "atlas_%s_%s.png" % (name, pas)), fmt="PNG")
            if pas == "room":
                m = np.where(masks[name][..., None], b, (b // 3 + np.array([90, 0, 90])).astype(np.uint8))
                save_bytes(m.astype(np.uint8), os.path.join(preview, "atlas_%s_mask.png" % name), fmt="PNG")

    # ---------------------------------------------------------- export
    if "--no-export" not in args:
        plain = bpy.data.materials.new("Baked")
        plain.use_backface_culling = True
        bs = plain.node_tree.nodes["Principled BSDF"]
        bs.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
        bs.inputs["Roughness"].default_value = 0.6
        legend_users = set(K["keys"]) | {K["LegendStrip"]}
        for o in keep_objs:
            set_single_material(o, plain)
            o.data.name = o.name
            # TEXCOORD_0 only means something on keys and the legend strip
            uv0 = get_uv(o.data, "UVMap")
            uv0 = np.round(uv0 * 8192.0) / 8192.0 if o in legend_users else np.zeros_like(uv0)
            set_uv(o.data, uv0, "UVMap")
            assert [l.name for l in o.data.uv_layers] == ["UVMap", LM_NAME], (o.name, [l.name for l in o.data.uv_layers])
        bpy.ops.object.select_all(action="DESELECT")
        for o in export_objs:
            o.hide_render = False
            o.select_set(True)
        bpy.context.view_layer.objects.active = kb
        glb = os.path.join(out_dir, "scene.glb")
        tune_meshopt_precision()
        bpy.ops.export_scene.gltf(
            filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
            export_texcoords=True, export_normals=True, export_extras=True, export_yup=True,
            export_cameras=False, export_lights=False, export_animations=False,
            export_materials="EXPORT", export_image_format="NONE",
            export_meshopt_compression_enable=True, export_meshopt_extension="EXT_meshopt_compression")
        stats = verify_glb(glb, {o.name: o for o in keep_objs})
        names = [n["name"] for n in stats["nodes"]]
        for must in ("TubeRef", "Cam_Seat", "Cam_Target", "PowerButton", "PowerLED", "Keyboard"):
            assert must in names, must + " missing from the glb"
        assert "GlassProxy" not in names
        assert all(n["extras"].get("role") != "proxy" for n in stats["nodes"])
        assert stats["images"] == 0 and stats["textures"] == 0
        assert "EXT_meshopt_compression" in stats["extensionsRequired"]
        for k in ranges:
            assert k in stats["scene_extras"], k + " missing from scene extras"
        report["glb"] = stats
        log("GLB %d bytes, %d nodes, %d triangles, %d vertices, max position error %.4f mm, "
            "max uv1 error %.4f texel, %d of %d bufferViews meshopt" % (
                stats["file_bytes"], len(stats["nodes"]), stats["triangles"], stats["vertices"],
                stats["max_pos_err_mm"], stats["max_uv1_err_texel_2048"], stats["compressed_bufferviews"],
                stats["bufferviews"]))
        log("GLB extensions used %s required %s materials %s" % (stats["extensionsUsed"], stats["extensionsRequired"], stats["materials"]))
        log("GLB scene extras %s" % stats["scene_extras"])
        for n in stats["nodes"]:
            if not (n["name"] or "").startswith("Key_"):
                log("NODE %-16s tris %6s verts %6s role %-8s atlas %-5s" % (
                    n["name"], n.get("triangles", "-"), n.get("vertices", "-"),
                    n["extras"].get("role", "-"), n["extras"].get("atlas", "-")))
        kn = [n for n in stats["nodes"] if (n["name"] or "").startswith("Key_")]
        log("NODE Key_* x%d: tris %d verts %d, atlas %s" % (
            len(kn), sum(n["triangles"] for n in kn), sum(n["vertices"] for n in kn),
            sorted(set(n["extras"].get("atlas", "-") for n in kn))))

    for fn in sorted(os.listdir(out_dir)):
        log("ASSET %-22s %9d bytes" % (fn, os.path.getsize(os.path.join(out_dir, fn))))
    with open(os.path.join(bake_dir, "report.json"), "w") as f:
        json.dump(report, f, indent=1, default=lambda o: o if isinstance(o, (int, float, str)) else str(o))
    log("done in %.0f s" % (time.time() - t_start))


if __name__ == "__main__":
    main()

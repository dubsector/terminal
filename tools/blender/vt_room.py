"""Desk, room shell, props, desk lamp and the lighting design.

    blender -b --factory-startup --python tools/blender/vt_room.py -- --preview <dir>

build(collection)  -> dict of geometry (no lights, no cameras)
lights(collection) -> dict of light objects + world (the bake uses exactly these)

Layout (metres, Z up, desk top z = 0, viewer at -Y):
  desk top     x -0.75..0.75, y -0.42..0.45
  desk wall    y = 0.47 (80 mm behind the terminal's back)
  room         x -1.9..1.7, y -3.62..0.47, floor z -0.74, ceiling z 1.86
  window       on the back wall, x -1.80..-0.80, z 0.50..1.62
  lamp         base at LAMP_POS, head over LAMP_HEAD_XY (see the constants);
               the bulb stays behind the terminal's front plane (y >= 0) so
               the lamp lights the desk and the terminal's right flank, not
               its face or the glass

Notes for the bake stage:
  - Every mesh has exactly one UV layer, "UVMap" (unused here, zeros), so the
    assembly's "Lightmap" layer is always the second set.
  - Desk_Top carries all the albedo detail that matters (grain, wear): give
    it the largest lightmap island.
  - No material here is metallic: a metallic surface has no diffuse lobe and
    would bake black. "Steel" and "brass" are grey / ochre dielectrics.
  - Window panes and the bulb are emissive meshes that are visible to camera
    and glossy rays only (visible_diffuse = False, bulb also casts no
    shadow). The light they stand for comes from the two lamps made by
    lights(), which are in turn hidden from camera and glossy rays, so
    nothing is counted twice.
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import vt_common as vc  # noqa: E402

# ---------------------------------------------------------------- layout
DESK_X = 0.75
DESK_Y0, DESK_Y1 = -0.42, 0.45
DESK_T = 0.032
ROOM_X0, ROOM_X1 = -1.9, 1.7
Y_WALL, Y_BACK = 0.47, -3.62
Z_FLOOR, Z_CEIL = -0.74, 1.86
WIN_X0, WIN_X1, WIN_Z0, WIN_Z1 = -1.80, -0.80, 0.50, 1.62

LAMP_POS = Vector((0.37, 0.27, 0.0))
LAMP_HEAD_XY = Vector((0.305, 0.075))
LAMP_WRIST_Z = 0.36
# inline rocker switch on the lamp cord, lying on the desk in front of and
# to the right of the base (world x, y of its two ends, where the cord goes in)
CORD_SWITCH_A = (0.335, 0.097)
CORD_SWITCH_B = (0.397, 0.080)
CORD_SWITCH_THROW = 11.0            # degrees the rocker tips either side of level
CORD_SWITCH_PIVOT_Z = 0.017         # m, the rocker's pivot: level with the top of the switch body
# where the open end of the shade points, in world space
SHADE_AIM = Vector((0.06, -0.20, -1.0)).normalized()
_d = LAMP_HEAD_XY - LAMP_POS.xy
LAMP_ROT = math.atan2(_d.y, _d.x)
LAMP_MATRIX = Matrix.Translation(LAMP_POS) @ Matrix.Rotation(LAMP_ROT, 4, "Z")
# lamp-local frame: +X toward the head, +Y lateral, +Z up
_S = Vector((0.0, 0.0, 0.078))           # shoulder pivot
_W = Vector((_d.length, 0.0, LAMP_WRIST_Z))   # wrist pivot
_ARM = 0.32                              # lower arm length; the upper arm spans elbow to wrist
_ARM_LEAN = 16.0                         # degrees the lower arm leans away from the head
_SHADE_AXIS = Matrix.Rotation(-LAMP_ROT, 3, "Z") @ SHADE_AIM
_SHADE_M = (Matrix.Translation(_W + Vector((0.004, 0.0, -0.022)))
            @ Vector((0, 0, -1)).rotation_difference(_SHADE_AXIS).to_matrix().to_4x4())
_BULB_Z = -0.090
BULB_WORLD = LAMP_MATRIX @ (_SHADE_M @ Vector((0, 0, _BULB_Z)))

# Lighting. Colours are as a camera balanced to about 4300 K would see them
# (between the 2700 K lamp and the dusk sky), not raw blackbody colours.
LAMP_COLOR = (1.0, 0.70, 0.40)
LAMP_WATTS = 1.75
LAMP_RADIUS = 0.028
WINDOW_COLOR = (0.70, 0.80, 1.0)
WINDOW_WATTS = 21.5
WINDOW_SPREAD = math.radians(100)
WINDOW_PITCH = math.radians(25)          # the sky lights downward into the room
PANE_STRENGTH = 1.1
BULB_STRENGTH = 40.0

MUG_POS = (-0.262, 0.03)
PAD_POS, PAD_ROT = (0.455, -0.195), math.radians(-11)
STACK_POS = (-0.435, -0.255)
BINDER_POS, BINDER_ROT = (-0.445, 0.245), math.radians(96)
NOTE_POS = (-0.36, 0.40)                 # x, z of the pinned note's top edge
INK = "#1f2644"

CAM_SEAT = (0.0, -0.62, 0.40)
CAM_TARGET = (0.0, 0.02, 0.165)


# ---------------------------------------------------------------- mesh kit
def _merge(dst, src):
    tmp = bpy.data.meshes.new("_tmp")
    src.to_mesh(tmp)
    src.free()
    dst.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)


class Mesh:
    """Collects bmesh parts (each with its own materials and transform)."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def _slot(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def add(self, part, mats, matrix=None):
        if not isinstance(mats, (list, tuple)):
            mats = [mats]
        remap = [self._slot(m) for m in mats]
        for f in part.faces:
            f.material_index = remap[min(f.material_index, len(remap) - 1)]
        if matrix is not None:
            bmesh.ops.transform(part, matrix=matrix, verts=part.verts)
        _merge(self.bm, part)
        return self

    def finish(self, name, collection, loc=(0, 0, 0), rot_z=0.0, rot=None,
               angle=40.0, weighted=True):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        # the assembly adds "Lightmap" as the second layer; it must not become the first
        if not me.uv_layers:
            me.uv_layers.new(name="UVMap")
        obj = vc.new_object(name, me, collection)
        for m in self.mats:
            me.materials.append(m)
        vc.smooth(obj, angle)
        if weighted:
            mod = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
            mod.weight = 100
            vc.apply_modifiers(obj)
        obj.location = loc
        obj.rotation_euler = rot if rot is not None else (0, 0, rot_z)
        return obj


def T(x=0.0, y=0.0, z=0.0):
    return Matrix.Translation((x, y, z))


def R(deg, axis):
    return Matrix.Rotation(math.radians(deg), 4, axis)


def orient(direction):
    """Matrix turning +Z onto `direction`."""
    return Vector((0, 0, 1)).rotation_difference(Vector(direction).normalized()).to_matrix().to_4x4()


def p_box(size, bevel=0.0, segs=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segs,
                        profile=0.5, affect="EDGES", clamp_overlap=True)
    return bm


def p_lathe(profile, segs=32, seg_mats=None):
    """Revolve (r, z) points about Z. A profile that runs counter-clockwise in
    the (r, z) plane gives outward normals. r = 0 points become poles."""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        if r < 1e-7:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * j / segs),
                                        r * math.sin(2 * math.pi * j / segs), z))
                          for j in range(segs)])
    for i in range(len(profile) - 1):
        a, b = rings[i], rings[i + 1]
        mi = seg_mats[i] if seg_mats else 0
        if len(a) == 1 and len(b) == 1:
            continue
        for j in range(segs):
            k = (j + 1) % segs
            if len(a) == 1:
                f = bm.faces.new((a[0], b[k], b[j]))
            elif len(b) == 1:
                f = bm.faces.new((a[j], a[k], b[0]))
            else:
                f = bm.faces.new((a[j], a[k], b[k], b[j]))
            f.material_index = mi
    return bm


def cyl_profile(r, z0, z1, b, n=2):
    pts = [(0.0, z0)]
    for k in range(n + 1):
        a = math.radians(-90 + 90 * k / n)
        pts.append((r - b + b * math.cos(a), z0 + b + b * math.sin(a)))
    for k in range(n + 1):
        a = math.radians(90 * k / n)
        pts.append((r - b + b * math.cos(a), z1 - b + b * math.sin(a)))
    pts.append((0.0, z1))
    return pts


def p_cyl(r, z0, z1, b=0.001, segs=20, n=2):
    return p_lathe(cyl_profile(r, z0, z1, b, n), segs)


def p_tube(points, radius, sides=8, caps=True):
    bm = bmesh.new()
    pts = [Vector(p) for p in points]
    n = len(pts)
    tans = []
    for i in range(n):
        t = pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]
        tans.append(t.normalized())
    nrm = tans[0].orthogonal().normalized()
    rings = []
    for i in range(n):
        t = tans[i]
        if i > 0:
            nrm = tans[i - 1].rotation_difference(t) @ nrm
        nrm = (nrm - t * nrm.dot(t)).normalized()
        bn = t.cross(nrm)
        rings.append([bm.verts.new(pts[i] + radius * (math.cos(2 * math.pi * j / sides) * nrm
                                                      + math.sin(2 * math.pi * j / sides) * bn))
                      for j in range(sides)])
    for i in range(n - 1):
        for j in range(sides):
            k = (j + 1) % sides
            bm.faces.new((rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]))
    if caps:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def rrect(hx, hy, r, n=4):
    """Outline of a rounded rectangle in XY, counter-clockwise, n segments
    per corner: always 4 * (n + 1) points, corner for corner."""
    r = max(min(r, hx, hy), 1e-5)
    pts = []
    for cx, cy, a0 in ((hx - r, hy - r, 0), (r - hx, hy - r, 90), (r - hx, r - hy, 180), (hx - r, r - hy, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def p_loft(rings):
    """Closed skin over consecutive rings (each the same number of 3D points),
    capped at both ends."""
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(vs[0])
    for a, b in zip(vs, vs[1:]):
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(list(reversed(vs[0])))
    bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def catmull(points, n=6):
    pts = [Vector(p) for p in points]
    out = []
    for i in range(len(pts) - 1):
        p0, p1, p2, p3 = pts[max(i - 1, 0)], pts[i], pts[i + 1], pts[min(i + 2, len(pts) - 1)]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(pts[-1])
    return out


def helix(p0, p1, radius, turns, per_turn=8):
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0)
    a = axis.normalized()
    u = a.orthogonal().normalized()
    v = a.cross(u)
    n = int(turns * per_turn)
    return [p0 + axis * (i / n) + radius * (math.cos(2 * math.pi * i / per_turn) * u
                                           + math.sin(2 * math.pi * i / per_turn) * v)
            for i in range(n + 1)]


def p_extrude(poly, depth, triangulate=False, bevel=0.0):
    """CCW polygon in XY, extruded from z = 0 to z = depth. `bevel` rounds
    the rims of the two end caps."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, 0.0)) for x, y in poly]
    hi = [bm.verts.new((x, y, depth)) for x, y in poly]
    caps = [bm.faces.new(list(reversed(lo))), bm.faces.new(hi)]
    n = len(poly)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    if bevel > 0:
        rims = list({e for f in caps for e in f.edges})
        bmesh.ops.bevel(bm, geom=rims, offset=bevel, segments=2, profile=0.5, affect="EDGES",
                        clamp_overlap=True)
        caps = [f for f in bm.faces if len(f.verts) > 4]
    if triangulate:
        bmesh.ops.triangulate(bm, faces=caps)
    return bm


def p_poly(poly, z=0.0):
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((x, y, z)) for x, y in poly])
    return bm


def p_rect(w, h, z=0.0):
    return p_poly([(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)], z)


def p_disc(r, segs=24, z=0.0):
    return p_poly([(r * math.cos(2 * math.pi * j / segs), r * math.sin(2 * math.pi * j / segs))
                   for j in range(segs)], z)


def p_ring(r0, r1, segs=24, z=0.0):
    bm = bmesh.new()
    a = [bm.verts.new((r0 * math.cos(2 * math.pi * j / segs), r0 * math.sin(2 * math.pi * j / segs), z))
         for j in range(segs)]
    b = [bm.verts.new((r1 * math.cos(2 * math.pi * j / segs), r1 * math.sin(2 * math.pi * j / segs), z))
         for j in range(segs)]
    for j in range(segs):
        k = (j + 1) % segs
        bm.faces.new((a[j], b[j], b[k], a[k]))
    return bm


def stadium(w, length, n=6):
    r = w / 2
    h = length / 2 - r
    pts = []
    for k in range(n + 1):
        a = math.pi * k / n
        pts.append((r * math.cos(a), h + r * math.sin(a)))
    for k in range(n + 1):
        a = math.pi + math.pi * k / n
        pts.append((r * math.cos(a), -h + r * math.sin(a)))
    return pts


def p_quad(pts, normal):
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new(p) for p in pts])
    f.normal_update()
    if f.normal.dot(Vector(normal)) < 0:
        bmesh.ops.reverse_faces(bm, faces=[f])
    return bm


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---------------------------------------------------------------- node kit
class Nodes:
    def __init__(self, mat):
        self.nt = mat.node_tree
        self.bsdf = self.nt.nodes["Principled BSDF"]

    def new(self, kind, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def set(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif isinstance(v, (int, float)):
            sock.default_value = v
        else:
            v = tuple(v)
            if len(v) == 3 and sock.type == "RGBA":
                v = (*v, 1.0)
            sock.default_value = v

    def math(self, op, a, b=None, clamp=False):
        n = self.new("ShaderNodeMath", operation=op, use_clamp=clamp)
        self.set(n.inputs[0], a)
        if b is not None:
            self.set(n.inputs[1], b)
        return n.outputs[0]

    def mix(self, fac, a, b):
        n = self.new("ShaderNodeMix", data_type="RGBA")
        n.clamp_factor = True
        self.set(n.inputs[0], fac)
        self.set(n.inputs[6], a)
        self.set(n.inputs[7], b)
        return n.outputs[2]

    def smooth(self, v, lo, hi):
        n = self.new("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP")
        self.set(n.inputs[0], v)
        n.inputs[1].default_value = lo
        n.inputs[2].default_value = hi
        return n.outputs[0]

    def noise(self, vec, scale, detail=2.0, rough=0.5):
        n = self.new("ShaderNodeTexNoise")
        self.set(n.inputs["Vector"], vec)
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        return n.outputs[0]

    def mapping(self, vec, scale=(1, 1, 1), loc=(0, 0, 0)):
        n = self.new("ShaderNodeMapping")
        self.set(n.inputs[0], vec)
        n.inputs[1].default_value = loc
        n.inputs[3].default_value = scale
        return n.outputs[0]

    def sep(self, vec):
        n = self.new("ShaderNodeSeparateXYZ")
        self.set(n.inputs[0], vec)
        return n.outputs

    def comb(self, x, y, z):
        n = self.new("ShaderNodeCombineXYZ")
        for i, v in enumerate((x, y, z)):
            self.set(n.inputs[i], v)
        return n.outputs[0]

    def object_co(self):
        return self.new("ShaderNodeTexCoord").outputs["Object"]

    def world_co(self):
        return self.new("ShaderNodeNewGeometry").outputs["Position"]

    def base(self, color):
        self.set(self.bsdf.inputs["Base Color"], color)

    def band(self, v, lo, hi, soft=0.0005):
        """1 between lo and hi, 0 outside."""
        a = self.smooth(v, lo - soft, lo + soft)
        b = self.math("SUBTRACT", 1.0, self.smooth(v, hi - soft, hi + soft))
        return self.math("MULTIPLY", a, b)

    def scribble(self, u, v, pitch, centre=0.5, amp=0.28, thick=0.09, letter=0.0018, word=0.013,
                 seed=0.0):
        """Mask of handwriting-like lines running along u, stacked along v
        every `pitch` metres. It only has to read as writing from a metre
        away: a wobbling stroke broken into words."""
        t = self.math("DIVIDE", v, pitch)
        row = self.math("FLOOR", t)
        fr = self.math("SUBTRACT", t, row)
        lett = self.noise(self.comb(u, self.math("ADD", self.math("MULTIPLY", row, 0.37), seed), 0.0),
                          1.0 / letter, 2.0, 0.6)
        wob = self.math("MULTIPLY", self.math("SUBTRACT", lett, 0.5), 2.0 * amp)
        d = self.math("ABSOLUTE", self.math("SUBTRACT", self.math("SUBTRACT", fr, centre), wob))
        ink = self.math("SUBTRACT", 1.0, self.smooth(d, thick * 0.5, thick))
        words = self.noise(self.comb(u, self.math("ADD", self.math("MULTIPLY", row, 0.61), seed + 3.0), 0.0),
                           1.0 / word, 0.0)
        return self.math("MULTIPLY", ink, self.smooth(words, 0.36, 0.42))


def _mat(name, hex_color, roughness=0.6):
    return vc.material(name, vc.srgb(hex_color), roughness)


def _mottled(name, hex_a, hex_b, scale, roughness=0.6, amount=1.0, world=False, detail=2.0):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = _mat(name, hex_a, roughness)
    n = Nodes(mat)
    co = n.world_co() if world else n.object_co()
    f = n.smooth(n.noise(co, scale, detail), 0.3, 0.7)
    n.base(n.mix(n.math("MULTIPLY", f, amount), vc.srgb(hex_a), vc.srgb(hex_b)))
    return mat


def wood_material(name, wear, vertical=False):
    """Crown-cut veneer. Grain runs along X, or along Z when `vertical`."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = _mat(name, "#8a5c32", 0.36)
    n = Nodes(mat)
    co = n.object_co()
    sx, sy, sz = n.sep(co)
    if vertical:
        sx, sz = sz, sx
        co = n.comb(sx, sy, sz)
    # veneer leaves about 210 mm wide, each with its own tone and grain offset
    leaf = n.math("FLOOR", n.math("ADD", n.math("MULTIPLY", sy, 1 / 0.21), 0.37))
    wn = n.new("ShaderNodeTexWhiteNoise", noise_dimensions="1D")
    n.set(wn.inputs["W"], leaf)
    rnd = wn.outputs[0]
    co2 = n.comb(n.math("ADD", sx, n.math("MULTIPLY", rnd, 7.3)), sy, sz)
    # broad growth-ring figure: slow bands across the leaf, bent by stretched noise
    warp = n.noise(n.mapping(co2, (0.30, 4.0, 4.0)), 1.6, 3.0, 0.55)
    wave = n.new("ShaderNodeTexWave", wave_type="BANDS", bands_direction="Y", wave_profile="SIN")
    n.set(wave.inputs["Vector"], n.mapping(co2, (0.04, 1.0, 1.0)))
    wave.inputs["Scale"].default_value = 5.5
    wave.inputs["Distortion"].default_value = 3.0
    wave.inputs["Detail"].default_value = 3.0
    wave.inputs["Detail Scale"].default_value = 2.5
    n.set(wave.inputs["Phase Offset"], n.math("MULTIPLY", warp, 46.0))
    figure = n.smooth(wave.outputs[1], 0.05, 0.95)
    # irregular streaks at two widths, long in the grain direction
    # Nothing here is finer than a few millimetres: the albedo only survives
    # as lightmap texels, so sub-texel fibre would vanish or shimmer.
    streak = n.noise(n.mapping(co2, (0.025, 1.0, 1.0)), 150.0, 3.0, 0.6)
    streak2 = n.noise(n.mapping(co2, (0.02, 1.0, 1.0)), 45.0, 2.0)
    fibre = n.noise(n.mapping(co2, (0.012, 1.0, 1.0)), 250.0, 2.0)
    blotch = n.noise(co, 2.5, 2.0)

    g = n.math("ADD", n.math("MULTIPLY", figure, 0.30),
               n.math("ADD", n.math("MULTIPLY", n.smooth(streak, 0.40, 0.60), 0.50),
                      n.math("MULTIPLY", n.smooth(streak2, 0.3, 0.7), 0.24)))
    c = n.mix(g, vc.srgb("#6f4628"), vc.srgb("#a27142"))
    c = n.mix(n.math("MULTIPLY", n.smooth(fibre, 0.50, 0.64), 0.50), c, vc.srgb("#5a3820"))
    c = n.mix(n.math("MULTIPLY", rnd, 0.16), c, vc.srgb("#ab7c4e"))
    c = n.mix(n.math("MULTIPLY", n.smooth(blotch, 0.35, 0.8), 0.20), c, vc.srgb("#6b4428"))
    if wear:
        worn = vc.srgb("#bd9a6e")
        breakup = n.math("ADD", 0.45, n.noise(co, 16.0, 3.0))
        # where the keyboard sits and gets shuffled about
        kx = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", sx), 0.21, 0.33))
        ky = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("ADD", sy, 0.205)), 0.06, 0.15))
        kb = n.math("MULTIPLY", n.math("MULTIPLY", kx, ky), breakup)
        c = n.mix(n.math("MULTIPLY", kb, 0.44), c, worn)
        # front edge, rubbed by wrists and sleeves
        fx = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", sx), 0.30, 0.62))
        fe = n.math("SUBTRACT", 1.0, n.smooth(sy, DESK_Y0 + 0.004, DESK_Y0 + 0.05))
        fe = n.math("MULTIPLY", n.math("MULTIPLY", fe, breakup), n.math("ADD", 0.35, fx))
        c = n.mix(n.math("MULTIPLY", fe, 0.34), c, worn)
        # an old mug ring
        dx = n.math("SUBTRACT", sx, MUG_POS[0] + 0.052)
        dy = n.math("SUBTRACT", sy, MUG_POS[1] - 0.048)
        dist = n.math("SQRT", n.math("ADD", n.math("MULTIPLY", dx, dx), n.math("MULTIPLY", dy, dy)))
        ring = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("SUBTRACT", dist, 0.039)),
                                                0.0015, 0.006))
        ring = n.math("MULTIPLY", ring, n.smooth(n.noise(co, 30.0, 2.0), 0.38, 0.62))
        c = n.mix(n.math("MULTIPLY", ring, 0.38), c, vc.srgb("#4d321d"))
        # scratches across the grain
        sc = n.noise(n.mapping(co, (60.0, 1.2, 1.0)), 28.0, 1.0)
        sc = n.smooth(sc, 0.72, 0.80)
        c = n.mix(n.math("MULTIPLY", sc, 0.22), c, worn)
    n.base(c)
    return mat


def paint_material():
    mat = bpy.data.materials.get("WallPaint")
    if mat:
        return mat
    mat = _mat("WallPaint", "#b3b7aa", 0.85)
    n = Nodes(mat)
    co = n.world_co()
    big = n.smooth(n.noise(co, 1.1, 3.0), 0.3, 0.75)
    roller = n.smooth(n.noise(n.mapping(co, (9.0, 9.0, 0.6)), 6.0, 2.0), 0.35, 0.7)
    c = n.mix(n.math("MULTIPLY", big, 0.55), vc.srgb("#b6baad"), vc.srgb("#a5a99b"))
    c = n.mix(n.math("MULTIPLY", roller, 0.08), c, vc.srgb("#bcc0b4"))
    # a little grubbier just above the desk where things get pushed against it
    _, _, sz = n.sep(co)
    low = n.math("SUBTRACT", 1.0, n.smooth(sz, -0.05, 0.30))
    c = n.mix(n.math("MULTIPLY", low, 0.22), c, vc.srgb("#9c9f90"))
    n.base(c)
    return mat


def pane_material():
    mat = bpy.data.materials.get("WindowPane")
    if mat:
        return mat
    mat = vc.material("WindowPane", (0.0, 0.0, 0.0), 0.1)
    n = Nodes(mat)
    co = n.world_co()
    sx, _, sz = n.sep(co)
    t = n.math("DIVIDE", n.math("SUBTRACT", sz, WIN_Z0), WIN_Z1 - WIN_Z0)
    c = n.mix(n.smooth(t, 0.10, 0.50), (1.25, 0.62, 0.30), (0.42, 0.50, 0.80))
    c = n.mix(n.smooth(t, 0.42, 1.0), c, (0.07, 0.12, 0.32))
    # far roofline and trees, already in silhouette
    sky = n.math("ADD", 0.13, n.math("MULTIPLY", n.noise(n.comb(sx, 0.0, 0.0), 9.0, 4.0, 0.65), 0.16))
    c = n.mix(n.smooth(n.math("SUBTRACT", t, sky), -0.004, 0.004), (0.012, 0.016, 0.03), c)
    n.set(n.bsdf.inputs["Emission Color"], c)
    n.bsdf.inputs["Emission Strength"].default_value = PANE_STRENGTH
    return mat


def paper_ruled_material(hole_x=0.0, hole_y=0.093, hole_pitch=0.0068):
    """Ruled pad page with a few written lines and the punched binding holes."""
    mat = bpy.data.materials.get("PadPaper")
    if mat:
        return mat
    mat = _mat("PadPaper", "#e2ddcb", 0.8)
    n = Nodes(mat)
    sx, sy, _ = n.sep(n.object_co())
    rule = 0.0071
    fr = n.math("FRACT", n.math("MULTIPLY", n.math("ADD", sy, 0.2), 1 / rule))
    line = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("SUBTRACT", fr, 0.5)), 0.03, 0.075))
    head = n.math("SUBTRACT", 1.0, n.smooth(sy, 0.068, 0.070))
    line = n.math("MULTIPLY", line, head)
    c = n.mix(n.math("MULTIPLY", line, 0.75), vc.srgb("#e2ddcb"), vc.srgb("#8fa3b8"))
    margin = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("ADD", sx, 0.052)), 0.0002, 0.0006))
    c = n.mix(n.math("MULTIPLY", margin, 0.7), c, vc.srgb("#c0706a"))
    # five lines of notes, sitting on the top rules
    ink = n.scribble(sx, n.math("ADD", sy, 0.2), rule, centre=0.76, amp=0.20, thick=0.10)
    ink = n.math("MULTIPLY", ink, n.math("MULTIPLY", n.band(sx, -0.046, 0.050, 0.004),
                                         n.band(sy, 0.068 - 5.45 * rule, 0.0665, 0.0002)))
    c = n.mix(n.math("MULTIPLY", ink, 0.85), c, vc.srgb(INK))
    # slots punched for the wire
    hx = n.math("SUBTRACT", n.math("FRACT", n.math("ADD", n.math("DIVIDE", n.math("SUBTRACT", sx, hole_x),
                                                                 hole_pitch), 0.5)), 0.5)
    hx = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("MULTIPLY", hx, hole_pitch)), 0.0011, 0.0015))
    hy = n.math("SUBTRACT", 1.0, n.smooth(n.math("ABSOLUTE", n.math("SUBTRACT", sy, hole_y)), 0.0021, 0.0026))
    hole = n.math("MULTIPLY", n.math("MULTIPLY", hx, hy), n.band(sx, -0.0715, 0.0715, 0.0003))
    c = n.mix(hole, c, vc.srgb("#2a2823"))
    n.base(c)
    return mat


def written_material(name, hex_paper, u_axis, v_axis, pitch, u_lim, v_lim, hex_ink=INK, mottle=None, **kw):
    """Plain paper with handwriting. u_axis / v_axis are 0, 1, 2 for the
    object-space axis the lines run along / are stacked along."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = _mat(name, hex_paper, 0.75)
    n = Nodes(mat)
    co = n.object_co()
    axes = n.sep(co)
    u, v = axes[u_axis], axes[v_axis]
    c = vc.srgb(hex_paper)
    if mottle:
        c = n.mix(n.math("MULTIPLY", n.smooth(n.noise(co, 9.0, 2.0), 0.3, 0.7), 0.8), c, vc.srgb(mottle))
    ink = n.scribble(u, v, pitch, **kw)
    gate = n.math("MULTIPLY", n.band(u, u_lim[0], u_lim[1], 0.003), n.band(v, v_lim[0], v_lim[1], 0.0003))
    n.base(n.mix(n.math("MULTIPLY", n.math("MULTIPLY", ink, gate), 0.88), c, vc.srgb(hex_ink)))
    return mat


def mug_material():
    mat = bpy.data.materials.get("MugCeramic")
    if mat:
        return mat
    mat = _mat("MugCeramic", "#d9d3c2", 0.18)
    n = Nodes(mat)
    _, _, sz = n.sep(n.object_co())

    def band(z0, z1):
        a = n.smooth(sz, z0 - 0.0006, z0 + 0.0006)
        b = n.math("SUBTRACT", 1.0, n.smooth(sz, z1 - 0.0006, z1 + 0.0006))
        return n.math("MULTIPLY", a, b)

    c = n.mix(band(0.058, 0.070), vc.srgb("#d9d3c2"), vc.srgb("#8a4a26"))
    c = n.mix(band(0.073, 0.077), c, vc.srgb("#c58a34"))
    n.base(c)
    return mat


# ---------------------------------------------------------------- desk
def _desk(col):
    wood_top = wood_material("DeskVeneer", True)
    wood = wood_material("DeskVeneerPlain", False)
    wood_side = wood_material("DeskVeneerUpright", False, vertical=True)
    steel = _mat("PullSteel", "#8f8e8a", 0.35)

    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(2 * DESK_X, DESK_Y1 - DESK_Y0, DESK_T), verts=bm.verts)
    bmesh.ops.translate(bm, vec=(0, (DESK_Y0 + DESK_Y1) / 2, -DESK_T / 2), verts=bm.verts)
    front = [e for e in bm.edges
             if all(v.co.y < DESK_Y0 + 1e-5 for v in e.verts) and abs(e.verts[0].co.x - e.verts[1].co.x) > 1.0]
    bmesh.ops.bevel(bm, geom=front, offset=0.013, segments=5, profile=0.5, affect="EDGES")
    rest = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle() > math.radians(60)]
    bmesh.ops.bevel(bm, geom=rest, offset=0.0022, segments=2, profile=0.5, affect="EDGES")
    top = Mesh().add(bm, wood_top).finish("Desk_Top", col)

    m = Mesh()
    zc = (Z_FLOOR - DESK_T) / 2
    for sx in (-1, 1):
        m.add(p_box((0.025, 0.80, -Z_FLOOR - DESK_T), 0.002, 1), wood_side, T(sx * 0.715, 0.03, zc))
    m.add(p_box((1.405, 0.018, 0.42), 0.002, 1), wood, T(0, 0.405, -DESK_T - 0.21))
    # hanging drawer pedestal on the right
    px0, px1 = 0.29, 0.7025
    m.add(p_box((px1 - px0, 0.76, 0.56), 0.002, 1), wood, T((px0 + px1) / 2, 0.0, -DESK_T - 0.28))
    fronts = ((-0.015, 0.120), (-0.140, 0.120), (-0.265, 0.285))
    for z_top, h in fronts:
        z = z_top - DESK_T - h / 2
        m.add(p_box((px1 - px0 - 0.012, 0.018, h - 0.006), 0.003), wood, T((px0 + px1) / 2, -0.386, z))
        hz = z + h / 2 - 0.04
        m.add(p_box((0.11, 0.010, 0.010), 0.003), steel, T((px0 + px1) / 2, -0.412, hz))
        for dx in (-0.045, 0.045):
            m.add(p_box((0.008, 0.016, 0.008), 0.002), steel, T((px0 + px1) / 2 + dx, -0.402, hz))
    body = m.finish("Desk_Body", col)
    return [top, body]


# ---------------------------------------------------------------- room
def _room(col):
    paint = paint_material()
    ceil = _mottled("CeilingPaint", "#d2d0c8", "#c6c4bb", 1.5, 0.9, 0.6, world=True)
    carpet = _mottled("Carpet", "#4b4741", "#383531", 420.0, 0.95, 1.0, world=True, detail=1.0)
    gloss = _mat("WhiteGloss", "#d6d3ca", 0.3)
    door_wood = wood_material("DoorVeneer", False, vertical=True)
    steel = _mat("PullSteel", "#8f8e8a", 0.35)
    x0, x1, y0, y1, z0, z1 = ROOM_X0, ROOM_X1, Y_BACK, Y_WALL, Z_FLOOR, Z_CEIL

    def quad(name, pts, normal, mat):
        return Mesh().add(p_quad(pts, normal), mat).finish(name, col, weighted=False)

    wall = quad("Wall_Desk", [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], (0, -1, 0), paint)
    shell = [
        quad("Wall_Back", [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, 1, 0), paint),
        quad("Wall_Left", [(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], (1, 0, 0), paint),
        quad("Wall_Right", [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (-1, 0, 0), paint),
        quad("Floor", [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], (0, 0, 1), carpet),
        quad("Ceiling", [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, -1), ceil),
    ]

    # skirting
    m = Mesh()
    sh, st = 0.11, 0.016
    zc = z0 + sh / 2
    door_x0, door_x1 = 0.47, 1.43
    m.add(p_box((x1 - x0, st, sh), 0.004, 1), gloss, T((x0 + x1) / 2, y1 - st / 2, zc))
    m.add(p_box((door_x0 - x0, st, sh), 0.004, 1), gloss, T((x0 + door_x0) / 2, y0 + st / 2, zc))
    m.add(p_box((x1 - door_x1, st, sh), 0.004, 1), gloss, T((x1 + door_x1) / 2, y0 + st / 2, zc))
    m.add(p_box((st, y1 - y0, sh), 0.004, 1), gloss, T(x0 + st / 2, (y0 + y1) / 2, zc))
    m.add(p_box((st, y1 - y0, sh), 0.004, 1), gloss, T(x1 - st / 2, (y0 + y1) / 2, zc))
    shell.append(m.finish("Skirting", col))

    # window: casing, sill, mullions (the panes are a separate emissive object)
    m = Mesh()
    wc, wz = (WIN_X0 + WIN_X1) / 2, (WIN_Z0 + WIN_Z1) / 2
    ww, wh = WIN_X1 - WIN_X0, WIN_Z1 - WIN_Z0
    cw, cd = 0.065, 0.034
    yf = y0 + cd / 2
    for sx in (-1, 1):
        m.add(p_box((cw, cd, wh + 2 * cw), 0.004, 1), gloss, T(wc + sx * (ww + cw) / 2, yf, wz))
    m.add(p_box((ww, cd, cw), 0.004, 1), gloss, T(wc, yf, WIN_Z1 + cw / 2))
    m.add(p_box((ww + 2 * cw + 0.06, 0.13, 0.03), 0.006, 1), gloss, T(wc, y0 + 0.065, WIN_Z0 - 0.015))
    m.add(p_box((0.05, 0.03, wh), 0.004, 1), gloss, T(wc, y0 + 0.015, wz))
    for k in (1, 2):
        m.add(p_box((ww, 0.03, 0.036), 0.004, 1), gloss, T(wc, y0 + 0.015, WIN_Z0 + wh * k / 3))
    # inner sash frame
    for sx in (-1, 1):
        m.add(p_box((0.04, 0.03, wh), 0.004, 1), gloss, T(wc + sx * (ww / 2 - 0.02), y0 + 0.015, wz))
    for sz in (-1, 1):
        m.add(p_box((ww, 0.03, 0.045), 0.004, 1), gloss, T(wc, y0 + 0.015, wz + sz * (wh / 2 - 0.0225)))
    shell.append(m.finish("Window_Frame", col))

    panes = Mesh().add(p_quad([(WIN_X0, y0 + 0.004, WIN_Z0), (WIN_X1, y0 + 0.004, WIN_Z0),
                               (WIN_X1, y0 + 0.004, WIN_Z1), (WIN_X0, y0 + 0.004, WIN_Z1)], (0, 1, 0)),
                       pane_material()).finish("Window_Panes", col, weighted=False)
    panes.visible_diffuse = False
    panes.visible_shadow = False
    panes["emissive"] = True
    panes["emission_strength"] = PANE_STRENGTH

    # door on the back wall, right of the viewer
    m = Mesh()
    dc, dw, dh = 0.95, 0.82, 2.03
    m.add(p_box((dw, 0.04, dh), 0.003), door_wood, T(dc, y0 + 0.012, z0 + dh / 2 + 0.004))
    for sx in (-1, 1):
        m.add(p_box((0.07, 0.03, dh + 0.07), 0.004), gloss, T(dc + sx * (dw + 0.07) / 2, y0 + 0.015, z0 + (dh + 0.07) / 2))
    m.add(p_box((dw + 0.14, 0.03, 0.07), 0.004), gloss, T(dc, y0 + 0.015, z0 + dh + 0.035))
    hx, hz = dc - dw / 2 + 0.07, z0 + 1.0
    m.add(p_cyl(0.026, 0.0, 0.008, 0.002, 16), steel, T(hx, y0 + 0.032, hz) @ R(-90, "X"))
    m.add(p_tube(catmull([(hx, y0 + 0.036, hz), (hx, y0 + 0.075, hz), (hx + 0.02, y0 + 0.082, hz),
                          (hx + 0.12, y0 + 0.082, hz)], 4), 0.008, 8), steel)
    shell.append(m.finish("Door", col))
    return wall, shell, panes


def _wall_note(col):
    paper = written_material("NotePaper", "#d8d1b2", 0, 2, 0.0088, (-0.030, 0.026), (-0.102, -0.024),
                             mottle="#cfc7a4", amp=0.26, thick=0.10, letter=0.0022, word=0.015)
    pin = _mat("PinRed", "#9c1f1c", 0.3)
    w, h, rows = 0.076, 0.127, 7
    bm = bmesh.new()
    grid = []
    for i in range(rows + 1):
        s = i / rows
        out = 0.0008 + 0.016 * s * s
        grid.append([bm.verts.new((x, -out, -h * s + 0.004 * s * s)) for x in (-w / 2, w / 2)])
    for i in range(rows):
        f = bm.faces.new((grid[i][0], grid[i][1], grid[i + 1][1], grid[i + 1][0]))
        f.normal_update()
        if f.normal.y > 0:
            bmesh.ops.reverse_faces(bm, faces=[f])
    m = Mesh().add(bm, paper)
    m.add(p_cyl(0.0048, 0.0, 0.0085, 0.0015, 12), pin, T(0.004, -0.001, -0.010) @ R(90, "X"))
    return m.finish("Wall_Note", col, loc=(NOTE_POS[0], Y_WALL, NOTE_POS[1]), rot=(0, math.radians(2.5), 0),
                    angle=50.0, weighted=False)


# ---------------------------------------------------------------- lamp
def _lamp(col):
    enamel = _mat("LampEnamel", "#1b1c1b", 0.32)
    inner = _mat("LampInner", "#dedacd", 0.45)
    steel = _mat("LampSteel", "#9a9995", 0.3)
    spring = _mat("LampSpring", "#5d5c58", 0.4)
    plug_mat = _mat("LampPlug", "#d2cfc4", 0.4)
    knob = _mat("LampKnob", "#121212", 0.45)
    cord_mat = _mat("LampCord", "#2a2622", 0.6)
    bulb_mat = vc.material("LampBulb", (0.9, 0.85, 0.75), 0.4, emission=LAMP_COLOR, strength=BULB_STRENGTH)

    S, W = _S, _W
    # lower arm leans back from the head, upper arm comes forward and slightly down
    E = S + _ARM * Vector((-math.sin(math.radians(_ARM_LEAN)), 0, math.cos(math.radians(_ARM_LEAN))))
    lat = R(-90, "X")      # turns a Z lathe onto the lateral (Y) axis

    # base
    m = Mesh()
    m.add(p_lathe(cyl_profile(0.085, 0.0, 0.022, 0.008, 3), 40), enamel, T(0.042, 0, 0))
    m.add(p_cyl(0.0095, 0.018, 0.070, 0.001, 14), enamel)
    m.add(p_cyl(0.014, -0.019, 0.019, 0.002, 18), enamel, T(*S) @ lat)
    base = m.finish("Lamp_Base", col)

    # arm
    m = Mesh()
    for sy in (-1, 1):
        off = Vector((0, sy * 0.012, 0))
        m.add(p_tube([S + off, E + off], 0.0034, 8), steel)
        m.add(p_tube([E + off, W + off], 0.0034, 8), steel)
    m.add(p_cyl(0.012, -0.018, 0.018, 0.002, 16), enamel, T(*E) @ lat)
    m.add(p_cyl(0.011, -0.018, 0.018, 0.002, 16), enamel, T(*W) @ lat)
    for p in (S, E, W):
        m.add(p_cyl(0.0105, 0.019, 0.031, 0.002, 14), knob, T(*p) @ lat)
        m.add(p_cyl(0.004, -0.024, -0.018, 0.001, 8), steel, T(*p) @ lat)
    a = (E - S).normalized()
    back = Vector((-a.z, 0, a.x))
    if back.x > 0:
        back = -back
    # tension springs: close-wound, so at this size they read as dull sleeves
    for sy in (-1, 1):
        off = Vector((0, sy * 0.012, 0))
        p0 = S + back * 0.017 + a * 0.004 + off
        p1 = S + back * 0.013 + a * 0.118 + off
        m.add(p_tube([p0, p1], 0.0042, 8), spring)
        m.add(p_tube([p0, S + back * 0.010 - a * 0.004 + off], 0.0011, 4), steel)
        m.add(p_tube([p1, S + a * 0.132 + off], 0.0011, 4), steel)
    arm = m.finish("Lamp_Arm", col)

    # shade: closed shell, counter-clockwise in (r, z): inner surface first
    r0, z0, r1, z1 = 0.0245, -0.042, 0.080, -0.146
    t = 0.0016
    steps = 7
    shade_segs = 36

    def flare(k):
        u = k / steps
        return r0 + (r1 - r0) * math.sin(u * math.pi / 2) ** 0.85, z0 + (z1 - z0) * u

    prof = [(0.0, -0.006), (r0 - t - 0.002, -0.006), (r0 - t, -0.008)]
    prof += [(flare(k)[0] - t, flare(k)[1]) for k in range(steps + 1)]
    n_inner = len(prof) - 1
    prof += [(r1 - t * 0.4, z1 - 0.0012), (r1 + 0.0004, z1 - 0.0008)]
    prof += [flare(k) for k in range(steps, -1, -1)]
    prof += [(r0, -0.004), (r0 - 0.004, 0.0), (0.0, 0.0)]
    seg_mats = [0 if i < n_inner else 1 for i in range(len(prof) - 1)]
    m = Mesh()
    m.add(p_lathe(prof, shade_segs, seg_mats), [inner, enamel], _SHADE_M)
    m.add(p_cyl(0.017, -0.052, -0.006, 0.0015, 16), inner, _SHADE_M)
    m.add(p_cyl(0.0065, 0.022, 0.036, 0.0015, 12), knob, _SHADE_M @ T(0, 0, -0.022) @ lat)
    m.add(p_box((0.016, 0.028, 0.034), 0.003), enamel, T(W.x + 0.002, 0, W.z - 0.012))
    shade = m.finish("Lamp_Shade", col)

    # bulb
    zc, rb = _BULB_Z, 0.030
    prof = [(0.0, zc - rb)]
    for k in range(1, 13):
        ang = math.radians(-90 + 145 * k / 12)
        prof.append((rb * math.cos(ang), zc + rb * math.sin(ang)))
    prof += [(0.0138, -0.056), (0.0138, -0.050), (0.0, -0.050)]
    bulb = Mesh().add(p_lathe(prof, 20), bulb_mat, _SHADE_M).finish("Lamp_Bulb", col)
    bulb.visible_diffuse = False
    bulb.visible_shadow = False
    bulb["emissive"] = True
    bulb["emission_strength"] = BULB_STRENGTH

    for o in (base, arm, shade, bulb):
        o.location = LAMP_POS
        o.rotation_euler = (0, 0, LAMP_ROT)

    # mains cord, in world space: out of the back of the base, over the rear
    # edge of the desk, down the gap to the floor, along the skirting and up
    # to a wall socket right of the desk
    rc = 0.0032
    zd, zf = rc + 0.0002, Z_FLOOR + rc + 0.0012
    yg = Y_WALL - 0.009            # in the 20 mm gap behind the desk
    ys = Y_WALL - 0.016 - rc - 0.002   # just clear of the skirting face
    px, pz = 0.958, Z_FLOOR + 0.29
    # Out of the front-right of the base, into the inline switch, out of its
    # far end, round the right of the base and back to the rear edge of the
    # desk. The switch holds the cord a little off the desk at both ends.
    zs = 0.0062
    sa, sb = Vector((*CORD_SWITCH_A, zs)), Vector((*CORD_SWITCH_B, zs))
    sd = (sb - sa).normalized()
    c0 = Vector((0.334, 0.153, 0.0045))
    per = 4
    ctrl = [c0, (0.320, 0.124, zd), sa - sd * 0.012, sa, sb, sb + sd * 0.016,
            (0.440, 0.082, zd), (0.470, 0.100, zd), (0.488, 0.150, zd), (0.500, 0.220, zd), (0.508, 0.300, zd),
            (0.522, 0.390, zd), (0.535, 0.4445, zd), (0.547, 0.4545, zd), (0.556, yg, -0.007),
            (0.559, yg, -0.035), (0.560, yg, -0.15), (0.560, yg, -0.35), (0.560, yg, -0.52),
            (0.561, yg - 0.003, -0.585), (0.563, ys, -0.625), (0.565, ys, -0.68),
            (0.572, ys, zf + 0.012), (0.592, ys, zf), (0.66, ys, zf), (0.78, ys - 0.003, zf),
            (0.90, ys, zf), (0.938, ys, zf), (0.953, ys, zf + 0.012), (px, ys, zf + 0.045),
            (px, ys, zf + 0.13), (px, ys, pz - 0.03), (px, ys, pz - 0.015)]
    path = catmull(ctrl, per)
    # the cord stops a quarter of the way into each end of the switch body
    # (sa and sb are control points 3 and 4) instead of running under the rocker
    m = Mesh().add(p_tube(path[:3 * per + 2], rc, 6), cord_mat)
    m.add(p_tube(path[4 * per - 1:], rc, 6), cord_mat)
    m.add(p_box((0.086, 0.008, 0.086), 0.002, 1), plug_mat, T(px, Y_WALL - 0.004, pz + 0.010))
    m.add(p_box((0.044, 0.032, 0.048), 0.005, 2), plug_mat, T(px, Y_WALL - 0.008 - 0.016, pz + 0.004))
    cord = m.finish("Lamp_Cord", col)

    body, switch = _cord_switch(col, (sa + sb) / 2, math.atan2(sd.y, sd.x), (sb - sa).length, zs,
                                knob, plug_mat)
    return [base, body, switch, arm, shade, cord], bulb


def _cord_switch(col, mid, yaw, length, cord_z, body_mat, rocker_mat):
    """Inline rocker switch on the lamp cord. Local +X runs along the cord
    toward the plug, +Z is up. Returns (body, rocker); the rocker's origin is
    on its pivot and it is built level, half way between on and off."""
    mm = 0.001
    hx, hy, top = length / 2, 14.0 * mm, 17.0 * mm
    zp = CORD_SWITCH_PIVOT_Z
    throw = math.radians(CORD_SWITCH_THROW)
    arc_r = 13.2 * mm                   # the rocker's ends are arcs about the pivot,
    gap = 0.5 * mm                      # so this gap to the well stays the same as it tips
    well_x = arc_r + gap
    rock_y = 7.0 * mm
    well_y = rock_y + gap
    well_floor = 10.5 * mm
    n = 5

    def outline(inset, z):
        return [(x, y, z) for x, y in rrect(hx - inset, hy - inset, 8.0 * mm - inset, n)]

    # soap-bar shell from the desk up, then in across the top to the rim of
    # the rocker's well and down to its floor
    rings = [outline(i * mm, z * mm) for z, i in (
        (0.0, 2.2), (0.4, 1.0), (1.2, 0.3), (2.4, 0.0), (13.6, 0.0), (15.2, 0.4), (16.3, 1.3), (16.85, 2.4),
        (17.0, 3.4))]
    for z in (top, well_floor):
        rings.append([(x, y, z) for x, y in rrect(well_x, well_y, 1.0 * mm, n)])
    m = Mesh().add(p_loft(rings), body_mat)
    # ribbed strain relief where the cord goes in at each end
    collar = [(0.0, 0.0), (4.7, 0.0), (4.7, 3.6), (4.2, 3.9), (4.2, 4.6), (4.5, 4.9), (4.5, 6.4), (4.0, 6.7),
              (4.0, 7.4), (4.2, 7.7), (4.2, 9.2), (3.8, 9.6), (3.8, 11.0), (0.0, 11.0)]
    collar = [(r * mm, z * mm) for r, z in collar]
    for sx in (-1, 1):
        m.add(p_lathe(collar, 14), body_mat, T(sx * (hx - 2.0 * mm), 0, cord_z) @ orient((sx, 0, 0)))
    body = m.finish("Lamp_SwitchBody", col, loc=(mid.x, mid.y, 0.0), rot_z=yaw)

    # rocker, side on: a shallow V on top (each half lies level when it is the
    # one pressed down), arcs at the ends, flat underneath
    z0 = top + 0.6 * mm - zp            # the valley of the V, above the pivot
    phi_t = throw + math.asin(z0 * math.cos(throw) / arc_r)
    phi_b = math.radians(12.0)
    prof = [(0.0, z0 + 0.12 * mm)]
    for sx in (-1, 1):
        side = [(sx * 1.2 * mm, z0 + 1.2 * mm * math.tan(throw))]
        xt = arc_r * math.cos(phi_t) - 0.5 * mm
        side.append((sx * xt, z0 + xt * math.tan(throw)))
        for k in range(7):
            a = phi_t - math.radians(2.5) - (phi_t - math.radians(2.5) + phi_b) * k / 6
            side.append((sx * arc_r * math.cos(a), arc_r * math.sin(a)))
        prof = side[::-1] + prof if sx < 0 else prof + side
    zc = 1.0 * mm                       # the side edges are eased toward this height
    rings = []
    for y, inset in ((-1.0, 0.5), (-0.94, 0.15), (-0.86, 0.0), (0.86, 0.0), (0.94, 0.15), (1.0, 0.5)):
        s = 1.0 - inset * mm / arc_r
        rings.append([(x * s, y * rock_y, zc + (z - zc) * s) for x, z in prof])
    m = Mesh().add(p_loft(rings), rocker_mat)
    # moulded bar on the half that is down when the lamp is on
    xm = 6.5 * mm
    m.add(p_box((1.3 * mm, 7.0 * mm, 0.3 * mm)), _mat("LampSwitchMark", "#2b2a28", 0.5),
          T(xm, 0, z0 + xm * math.tan(throw) + 0.05 * mm) @ R(-CORD_SWITCH_THROW, "Y"))
    switch = m.finish("Lamp_Switch", col, loc=(mid.x, mid.y, zp), rot_z=yaw)
    # Tipping it by angle_on about `axis` (object space, Blender axes) puts
    # the +X half down: the lamp is on. angle_off is the other way.
    switch["axis"] = [0.0, 1.0, 0.0]
    switch["angle_on"] = throw
    switch["angle_off"] = -throw
    return body, switch


# ---------------------------------------------------------------- props
def _mug(col):
    ceramic = mug_material()
    coffee = _mat("Coffee", "#20120a", 0.08)
    prof = [(0.0, 0.0), (0.035, 0.0), (0.0385, 0.0012), (0.0405, 0.0040), (0.041, 0.009), (0.041, 0.089)]
    for k in range(7):
        a = math.pi * k / 6
        prof.append((0.039 + 0.002 * math.cos(a), 0.0925 + 0.0025 * math.sin(a) + 0.0 * k))
    prof += [(0.037, 0.089), (0.037, 0.068), (0.0, 0.068)]
    seg_mats = [0] * (len(prof) - 2) + [1]
    m = Mesh().add(p_lathe(prof, 72, seg_mats), [ceramic, coffee])
    path = catmull([(0.0385, 0, 0.076), (0.058, 0, 0.079), (0.070, 0, 0.066), (0.071, 0, 0.046),
                    (0.062, 0, 0.029), (0.0385, 0, 0.024)], 5)
    # strap handle: 8 mm thick, 16 mm wide
    handle = p_tube(path, 0.004, 16)
    bmesh.ops.scale(handle, vec=(1.0, 2.0, 1.0), verts=handle.verts)
    m.add(handle, ceramic)
    return m.finish("Mug", col, loc=(MUG_POS[0], MUG_POS[1], 0), rot_z=math.radians(-38))


_FLOPPY_H = 0.13335 / 2


def _floppy_mats():
    return {
        "jacket": _mat("FloppyJacket", "#161616", 0.5),
        "mylar": _mat("FloppyMylar", "#33261d", 0.25),
        "hole": _mat("FloppyHole", "#070707", 0.8),
        "hub": _mat("FloppyHubRing", "#c9c4b8", 0.6),
        "sleeve": _mottled("FloppySleeve", "#d4d0c3", "#c9c4b4", 25.0, 0.75, 0.7),
        "label": written_material("FloppyLabel", "#dedacc", 0, 1, 0.0056, (-10.0, 10.0), (-10.0, 10.0),
                                  amp=0.24, thick=0.13, letter=0.002, word=0.016),
        "stripes": [_mat("FloppyStripeRed", "#a8322a", 0.6), _mat("FloppyStripeBlue", "#2f4f86", 0.6),
                    _mat("FloppyStripeOchre", "#c08a2c", 0.6), _mat("FloppyStripeGreen", "#3f7350", 0.6)],
        "band": _mat("FloppySleeveBand", "#31517f", 0.7),
    }


def _floppy(m, mats, matrix, sleeve, stripe):
    h = _FLOPPY_H
    tj = 0.0016
    zj = 0.0005 if sleeve else 0.0
    outline = [(-h, -h), (h, -h), (h, 0.0285), (h - 0.004, 0.0285), (h - 0.004, 0.0345), (h, 0.0345),
               (h, h), (-h, h)]
    m.add(p_extrude(outline, tj, triangulate=True), mats["jacket"], matrix @ T(0, 0, zj))
    zt = zj + tj + 0.00025
    ly0 = 0.0415 if sleeve else 0.030
    ly1 = 0.0625
    lx0, lx1 = -0.060, 0.034
    m.add(p_poly([(lx0, ly0), (lx1, ly0), (lx1, ly1 - 0.007), (lx0, ly1 - 0.007)], zt), mats["label"], matrix)
    m.add(p_poly([(lx0, ly1 - 0.007), (lx1, ly1 - 0.007), (lx1, ly1), (lx0, ly1)], zt), stripe, matrix)
    if sleeve:
        m.add(p_box((0.1365, 0.108, 0.0026), 0.0005, 1), mats["sleeve"], matrix @ T(0, -0.0145, 0.0013))
        m.add(p_rect(0.1355, 0.011, 0.0026 + 0.00025), mats["band"], matrix @ T(0, 0.022, 0))
    else:
        m.add(p_disc(0.0198, 28, zt), mats["mylar"], matrix)
        m.add(p_ring(0.0143, 0.0176, 28, zt + 0.0002), mats["hub"], matrix)
        m.add(p_disc(0.0143, 28, zt + 0.0002), mats["hole"], matrix)
        m.add(p_poly(stadium(0.0127, 0.034), zt), mats["mylar"], matrix @ T(0, -0.043, 0))
        m.add(p_disc(0.0032, 12, zt), mats["mylar"], matrix @ T(0.0246, -0.0062, 0))


def _floppies(col):
    mats = _floppy_mats()
    m = Mesh()
    unit = 0.0027
    jitter = [(0.0, 0.0, 4.0), (0.004, -0.003, -3.0), (-0.003, 0.002, 7.5), (0.005, 0.004, -1.5)]
    for i, (dx, dy, ang) in enumerate(jitter):
        _floppy(m, mats, T(dx, dy, i * unit) @ R(ang, "Z"), True, mats["stripes"][i % 4])
    stack = m.finish("Floppy_Stack", col, loc=(STACK_POS[0], STACK_POS[1], 0), rot_z=math.radians(-6),
                     weighted=False)

    # one out of its sleeve, dropped with its far edge on the stack
    heading = Vector((0.83, -0.56)).normalized()
    dist = 0.165
    origin = Vector(STACK_POS) - heading * dist
    reach = dist - _FLOPPY_H * 1.36       # nearest stack corner along the heading
    tilt = math.asin((len(jitter) * unit + 0.0008) / reach)
    m = Mesh()
    _floppy(m, mats, T(0, _FLOPPY_H, 0), False, mats["stripes"][2])
    loose = m.finish("Floppy_Loose", col, weighted=False)
    loose.matrix_world = (Matrix.Translation((origin.x, origin.y, 0.0))
                          @ Matrix.Rotation(math.atan2(heading.y, heading.x) - math.pi / 2, 4, "Z")
                          @ Matrix.Rotation(tilt, 4, "X"))
    return [stack, loose]


def _notepad(col):
    w, length = 0.148, 0.210
    z_top = 0.0082
    # wire binding: the coil rests on the desk, wraps the top edge of the
    # block and enters the pages through a row of punched slots
    turns, coil_r, wire_r = 20, 0.0050, 0.0009
    ya, zc = length / 2 - 0.0075, 0.0060
    coil = helix((-0.068, ya, zc), (0.068, ya, zc), coil_r, turns, 6)
    hits = []
    for a, b in zip(coil, coil[1:]):
        if (a.z - z_top) * (b.z - z_top) < 0 and (a.y + b.y) / 2 < ya:
            hits.append(a.lerp(b, (z_top - a.z) / (b.z - a.z)))
    pitch = 0.136 / turns
    paper = paper_ruled_material(hits[0].x, sum(h.y for h in hits) / len(hits), pitch)
    edge = _mottled("PadEdges", "#d6d1bf", "#c8c2ae", 500.0, 0.85, 0.8)
    card = _mat("PadCard", "#7d7362", 0.9)
    wire = _mat("PadWire", "#a3a29d", 0.3)
    m = Mesh()
    m.add(p_box((w + 0.002, length + 0.002, 0.0012), 0.0003, 1), card, T(0, 0, 0.0006))
    block = p_box((w, length - 0.004, 0.0070), 0.0004, 1)
    for f in block.faces:
        f.normal_update()
        f.material_index = 1 if f.normal.z > 0.99 else 0
    m.add(block, [edge, paper], T(0, -0.002, 0.0012 + 0.0035))
    # header strip above the first ruled line reads as the perforation margin
    m.add(p_tube(coil, wire_r, 3, caps=False), wire)
    pad = m.finish("Notepad", col, loc=(PAD_POS[0], PAD_POS[1], 0), rot_z=PAD_ROT)

    barrel = _mat("PenBarrel", "#cf8226", 0.35)
    cap = _mat("PenCap", "#22407f", 0.35)
    tip = _mat("PenTip", "#a88a45", 0.35)
    prof = [(0.0, 0.0), (0.0007, 0.0004), (0.0021, 0.010), (0.0038, 0.0125), (0.0038, 0.101),
            (0.0046, 0.1015), (0.0046, 0.1455), (0.0040, 0.1478), (0.0026, 0.1488), (0.0, 0.1488)]
    seg_mats = [0, 0, 1, 1, 2, 2, 2, 2, 2]
    m = Mesh().add(p_lathe(prof, 12, seg_mats), [tip, barrel, cap], R(90, "Y") @ T(0, 0, -0.074))
    m.add(p_box((0.036, 0.0036, 0.0012), 0.0004, 1), cap, T(0.053, 0.0, 0.0052))
    m.add(p_box((0.005, 0.0036, 0.0026), 0.0004, 1), cap, T(0.069, 0.0, 0.0046))
    pen = m.finish("Pen", col)
    # A capped pen lies on two rings: the front lip of the cap (r 4.6 mm at
    # x = +27.5 mm) and the shoulder of the barrel (r 3.8 mm at x = -61.5 mm),
    # so it pitches nose-down by about half a degree and the writing tip
    # itself stays clear of the paper.
    xc, xb, rcap, rbar = 0.0275, -0.0615, 0.0046, 0.0038
    pitch_a = math.atan2(rcap - rbar, xc - xb)
    pen.matrix_world = (Matrix.Translation((PAD_POS[0], PAD_POS[1], z_top + rcap - xc * math.sin(pitch_a)))
                        @ Matrix.Rotation(PAD_ROT, 4, "Z") @ Matrix.Translation((0.018, -0.030, 0))
                        @ Matrix.Rotation(math.radians(63), 4, "Z") @ Matrix.Rotation(-pitch_a, 4, "Y")
                        @ Matrix.Rotation(math.radians(72), 4, "X"))
    return [pad, pen]


def _binder(col):
    vinyl = _mottled("BinderVinyl", "#4a5f7a", "#41556e", 14.0, 0.45, 0.7)
    pages = _mottled("BinderPages", "#d8d4c6", "#c9c4b3", 700.0, 0.85, 0.8)
    label = written_material("BinderLabel", "#dcd8cb", 1, 2, 0.011, (-0.050, 0.038), (0.0125, 0.0335),
                             hex_ink="#1a1a1c", amp=0.22, thick=0.17, letter=0.004, word=0.03)
    wd, ln, hh, t, r = 0.265, 0.315, 0.046, 0.003, 0.009
    x0, x1 = -wd / 2, wd / 2

    def arc(cx, cz, rad, a0, a1, n=4):
        return [(cx + rad * math.cos(math.radians(a0 + (a1 - a0) * k / n)),
                 cz + rad * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]

    # outline in (x, z), counter-clockwise, drawn as (x, y) then stood up
    poly = [(x1, 0.0), (x1, t)]
    poly += arc(x0 + r, r, r - t, 270, 180)              # inside of the spine, going up
    poly += arc(x0 + r, hh - r, r - t, 180, 90)
    poly += [(x1, hh - t), (x1, hh)]
    poly += arc(x0 + r, hh - r, r, 90, 180)              # outside of the spine, coming down
    poly += arc(x0 + r, r, r, 180, 270)
    stand = T(0, ln / 2, 0) @ R(90, "X")
    m = Mesh()
    m.add(p_extrude(poly, ln, triangulate=True, bevel=0.0012), vinyl, stand)
    m.add(p_box((0.209, ln - 0.026, 0.0385), 0.0008, 1), pages, T(0.0105, 0, 0.0035 + 0.01925))
    lab = p_quad([(x0 - 0.0003, -0.065, 0.011), (x0 - 0.0003, 0.065, 0.011),
                  (x0 - 0.0003, 0.065, 0.035), (x0 - 0.0003, -0.065, 0.035)], (-1, 0, 0))
    m.add(lab, label)
    return m.finish("Binder", col, loc=(BINDER_POS[0], BINDER_POS[1], 0), rot_z=BINDER_ROT)


# ---------------------------------------------------------------- public
def build(collection):
    desk = _desk(collection)
    wall, shell, panes = _room(collection)
    note = _wall_note(collection)
    lamp_parts, bulb = _lamp(collection)
    props = [_mug(collection)] + _floppies(collection) + _notepad(collection) + [_binder(collection), note]

    cams = []
    for name, loc in (("Cam_Seat", CAM_SEAT), ("Cam_Target", CAM_TARGET)):
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.03
        e.location = loc
        collection.objects.link(e)
        cams.append(e)

    return {
        "desk": desk,
        "wall": wall,
        "room": shell,
        "props": props,
        "lamp": lamp_parts,
        "emissive": [panes, bulb],
        "cameras": cams,
        # what lights() will create; build() itself adds no lights
        "lights": {
            "window": {"type": "AREA", "location": _window_light_loc(), "rotation": _window_light_rot(),
                       "size": (WIN_X1 - WIN_X0, WIN_Z1 - WIN_Z0), "spread": WINDOW_SPREAD,
                       "color": WINDOW_COLOR, "watts": WINDOW_WATTS},
            "lamp": {"type": "POINT", "location": tuple(BULB_WORLD), "radius": LAMP_RADIUS,
                     "color": LAMP_COLOR, "watts": LAMP_WATTS},
        },
    }


def _window_light_loc():
    # far enough into the room that the pitched rectangle stays clear of the wall
    return ((WIN_X0 + WIN_X1) / 2,
            Y_BACK + 0.06 + (WIN_Z1 - WIN_Z0) / 2 * math.sin(WINDOW_PITCH),
            (WIN_Z0 + WIN_Z1) / 2)


def _window_light_rot():
    # an area light emits along its local -Z; X = 90 deg points that at +Y
    # (into the room), less than 90 tips it down toward the floor
    return (math.radians(90) - WINDOW_PITCH, 0.0, 0.0)


def _light(name, kind, collection):
    """Reuse the light of this name if lights() ran before."""
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type != "LIGHT" or obj.data.type != kind:
        obj = bpy.data.objects.new(name, bpy.data.lights.new(name, kind))
    if obj.name not in collection.objects:
        collection.objects.link(obj)
    return obj


def lights(collection):
    scene = bpy.context.scene
    world = bpy.data.worlds.get("Dusk") or bpy.data.worlds.new("Dusk")
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.02, 0.03, 0.06, 1.0)
    bg.inputs["Strength"].default_value = 0.05      # the room is closed; this only guards leaks
    scene.world = world

    win = _light("Light_Window", "AREA", collection)
    wd = win.data
    wd.shape = "RECTANGLE"
    wd.size = WIN_X1 - WIN_X0
    wd.size_y = WIN_Z1 - WIN_Z0
    wd.energy = WINDOW_WATTS
    wd.color = WINDOW_COLOR
    wd.spread = WINDOW_SPREAD
    win.location = _window_light_loc()
    win.rotation_euler = _window_light_rot()

    lamp = _light("Light_Lamp", "POINT", collection)
    ld = lamp.data
    ld.energy = LAMP_WATTS
    ld.color = LAMP_COLOR
    ld.shadow_soft_size = LAMP_RADIUS
    lamp.location = BULB_WORLD

    for o in (win, lamp):
        o.visible_camera = False
        o.visible_glossy = False
    return {"window_light": win, "lamp_light": lamp, "world": world}


# ---------------------------------------------------------------- preview
_LEAN = math.radians(12.0)      # the real terminal's face leans back this much
_GLASS_R = 0.60                 # guessed radius of the tube face, for the mirror test only


def _standins(col):
    """Preview-only stand-ins for the terminal, the keyboard and the glass."""
    cream = _mat("StandInCream", "#DDD8C6", 0.55)
    box = p_box((0.32, 0.39, 0.30), 0.012, 3)
    bmesh.ops.translate(box, vec=(0, 0.195, 0.15), verts=box.verts)
    for v in box.verts:             # shear so the face leans back but the foot stays flat
        v.co.y += v.co.z * math.tan(_LEAN)
    term = Mesh().add(box, cream).finish("StandIn_Terminal", col)
    kb = Mesh().add(p_box((0.533, 0.171, 0.030), 0.004, 2), cream).finish("StandIn_Keyboard", col, loc=(0, -0.20, 0.015))

    # convex mirror the size of the glass opening, to see what the tube face reflects
    chrome = bpy.data.materials.new("StandInMirror")
    bsdf = chrome.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.9, 0.9, 0.9, 1.0)
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 0.0
    bm = bmesh.new()
    nu, nv, hw, hh = 40, 28, 0.127, 0.0865
    grid = [[bm.verts.new((hw * (2 * i / nu - 1), hh * (2 * j / nv - 1), 0.0)) for i in range(nu + 1)]
            for j in range(nv + 1)]
    for row in grid:
        for v in row:
            v.co.z = math.sqrt(_GLASS_R ** 2 - v.co.x ** 2 - v.co.y ** 2) - _GLASS_R
    for j in range(nv):
        for i in range(nu):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    mirror = Mesh().add(bm, chrome).finish("StandIn_Glass", col, angle=80.0, weighted=False)
    apex = Vector((0.0, CAM_TARGET[2] * math.tan(_LEAN) - 0.024, CAM_TARGET[2]))
    mirror.matrix_world = Matrix.Translation(apex) @ orient((0.0, -math.cos(_LEAN), math.sin(_LEAN)))
    mirror.hide_render = True
    for o in (term, kb, mirror):
        o["role"] = "proxy"         # never exported, even from a --blend save
    return term, kb, mirror


def _render(scene, out_dir, views, samples=192, denoise=True, size=(1280, 960)):
    """Like vc.render_previews, with the denoiser switchable."""
    os.makedirs(out_dir, exist_ok=True)
    vc.setup_cycles(scene, samples=samples, denoise=denoise)
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    cam = vc.add_camera(scene, (0, -1, 0.3), (0, 0, 0))
    for name, (loc, target, lens) in views.items():
        cam.location = loc
        cam.data.lens = lens
        vc.look_at(cam, target)
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def main():
    args = vc.script_args()
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Room")
    scene.collection.children.link(col)
    out = build(col)
    lights(col)
    lights(col)     # must be repeatable
    bpy.context.view_layer.update()

    objs = out["desk"] + [out["wall"]] + out["room"] + out["props"] + out["lamp"] + out["emissive"]
    total = 0
    for o in objs:
        n = tri_count(o)
        total += n
        lo = [min((o.matrix_world @ Vector(c))[k] for c in o.bound_box) for k in range(3)]
        hi = [max((o.matrix_world @ Vector(c))[k] for c in o.bound_box) for k in range(3)]
        print("TRIS %-16s %6d  uv=%s  x %.3f..%.3f  y %.3f..%.3f  z %.4f..%.4f"
              % (o.name, n, [l.name for l in o.data.uv_layers], lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    print("TRIS %-16s %6d" % ("total", total))
    print("BULB_WORLD", tuple(round(v, 4) for v in BULB_WORLD))
    print("LIGHTS", [o.name for o in bpy.data.objects if o.type == "LIGHT"], [w.name for w in bpy.data.worlds])
    # How far each point sits on the open side of the shade's rim plane
    # (positive = it can see into the shade), and its angle off the shade axis
    # as seen from the bulb (the rim cuts the light off near 54 degrees).
    axis = (LAMP_MATRIX.to_3x3() @ _SHADE_AXIS).normalized()
    rim = LAMP_MATRIX @ (_SHADE_M @ Vector((0, 0, -0.146)))
    for label, p in (("screen centre", CAM_TARGET), ("screen right", (0.12, 0.03, 0.165)),
                     ("screen low", (0.0, 0.01, 0.085)), ("face right mid", (0.15, 0.03, 0.15)),
                     ("side low", (0.167, 0.15, 0.04)), ("side mid", (0.167, 0.20, 0.15)),
                     ("kbd right end", (0.25, -0.20, 0.03)), ("seat", CAM_SEAT)):
        p = Vector(p)
        off = math.degrees((p - BULB_WORLD).normalized().angle(axis))
        print("SHADE %-15s rim-plane side %+.3f m, %5.1f deg off axis" % (label, (p - rim).dot(axis), off))

    if "--preview" in args:
        out_dir = args[args.index("--preview") + 1]
        only = args[args.index("--only") + 1].split(",") if "--only" in args else None
        samples = int(args[args.index("--samples") + 1]) if "--samples" in args else 192
        term, kb, mirror = _standins(col)

        def want(name):
            return not only or name in only

        views = {
            "seat": (CAM_SEAT, CAM_TARGET, 35.0),
            "establishing": ((0.55, -2.35, 0.80), (0.0, 0.0, 0.12), 28.0),
            "top": ((0.0, 0.015, 1.80), (0.0, 0.0151, 0.0), 24.0),
            "lamp": ((-0.22, -0.78, 0.46), (0.36, 0.17, 0.20), 50.0),
            "props_left": ((-0.12, -0.86, 0.50), (-0.40, -0.04, 0.02), 40.0),
            "props_back": ((-0.20, -0.42, 0.34), (-0.36, 0.16, 0.03), 50.0),
            "props_right": ((0.36, -0.72, 0.36), (0.43, -0.16, 0.02), 55.0),
            "cord": ((1.45, -0.75, -0.25), (0.80, 0.45, -0.55), 35.0),
        }
        _render(scene, out_dir, {k: v for k, v in views.items() if want(k)}, samples)
        if want("switch"):
            # the cord switch level (as baked), then tipped on and off
            rocker = bpy.data.objects["Lamp_Switch"]
            yaw = rocker.rotation_euler.z
            close = ((0.33, -0.13, 0.15), (0.366, 0.088, 0.012), 85.0)
            for tag, a in (("level", 0.0), ("on", rocker["angle_on"]), ("off", rocker["angle_off"])):
                rocker.rotation_euler = (0.0, a, yaw)
                _render(scene, out_dir, {"switch_" + tag: close}, samples)
                if tag == "on":
                    _render(scene, out_dir, {"switch_seat": (CAM_SEAT, (0.366, 0.088, 0.012), 120.0)}, samples)
            rocker.rotation_euler = (0.0, 0.0, yaw)
        if want("desk_texture"):
            # no denoiser: it smears exactly the grain this view is meant to judge
            _render(scene, out_dir, {"desk_texture": ((-0.05, -0.55, 0.50), (0.05, -0.33, 0.0), 50.0)},
                    max(samples, 512), denoise=False)
        if want("mirror"):
            # what the glass shows the seated viewer: window upper-left?
            mirror.hide_render = False
            _render(scene, out_dir, {"mirror": (CAM_SEAT, CAM_TARGET, 85.0)}, samples)
            mirror.hide_render = True
        if want("desk_bare"):
            term.hide_render = kb.hide_render = True
            _render(scene, out_dir, {"desk_bare": ((0.0, -0.75, 0.95), (0.0, -0.10, 0.0), 35.0)}, samples)
            kb.hide_render = False
        term.hide_render = True
        if want("reflect"):
            _render(scene, out_dir, {"reflect": (CAM_TARGET, (0.0, -3.0, 0.90), 10.0)}, samples)
        if want("screen_right"):
            # from the screen toward the lamp: the shade's opening and bulb should not show
            _render(scene, out_dir, {"screen_right": ((0.0, 0.0, 0.165), (1.0, 0.0, 0.165), 14.0)}, samples)
        term.hide_render = False
        if "--blend" in args:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, "room.blend"))


if __name__ == "__main__":
    main()

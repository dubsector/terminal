"""The monitor unit: a fictional "DS-220" video terminal in the VT220 family.

    blender -b --factory-startup --python tools/blender/vt_terminal.py -- --preview <dir>

build(collection) makes the unit resting on the desk (z = 0), leaning back
LEAN degrees, centred on x = 0 with the front-most point of the collar at
y = 0. See README.md for the object-name contract.

All construction is done in a "face frame" in millimetres:
    x  to the viewer's right
    u  up the leaned face
    d  depth behind the flat front of the collar (into the unit)
and P(x, u, d) maps that to world metres. The glass opening is centred on
x = u = 0, D_OPEN behind the front plane; that point is the TubeRef empty.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vt_common as vc  # noqa: E402

MM = 0.001
LEAN = math.radians(12.0)
S, C, T = math.sin(LEAN), math.cos(LEAN), math.tan(LEAN)
U = vc.TUBE_UNIT * 1000.0            # one tube unit in mm (60.96)

# Glass opening (must match the page's tube exactly).
GX, GU, GR = 2.0 * U, 1.5 * U, 0.28 * U
# Bezel: recess step, then flat borders.
STEP, B_TOP, B_SIDE, B_CHIN = 13.0, 25.0, 25.0, 48.0
HX = GX + STEP + B_SIDE              # collar half width   (159.9)
TOP = GU + STEP + B_TOP              # collar top          (129.4)
BOT = -(GU + STEP + B_CHIN)          # collar bottom      (-152.4)
D_OPEN = 20.0                        # opening plane behind the front plane
COLLAR_D = 65.0                      # collar depth
RECESS_TIGHTEN = 0.55                # recess corner radius lost per mm outward from the glass
R_FRONT = 6.5                        # front edge radius (photos: a flat frame, tight roll)
R_CORNER = 14.0                      # front-view corner radius
GROOVE = 8.0                         # seam groove depth below the collar skin
SEAM_W = 2.2                         # seam groove width

# Rear housing: nominal skin as a function of depth.
H_D0 = COLLAR_D + SEAM_W             # where the housing shoulder starts
H_DR = 341.0                         # rear face
H_STEP = 2.0                         # housing skin sits this far inside the collar skin
H_TOP_SLOPE = math.tan(LEAN - math.radians(18.0))   # top falls 18 deg to the rear (world)
H_HX_REAR = 124.0
PLINTH_H = 10.0                      # housing underside above the desk

Z0 = PLINTH_H - ((BOT + H_STEP) * C - H_D0 * S)
Y0 = -((BOT + R_FRONT) * S + R_FRONT * C - R_FRONT)

E_X = Vector((1.0, 0.0, 0.0))
E_D = Vector((0.0, C, -S))           # into the unit
E_U = Vector((0.0, S, C))            # up the face

K_CORNER = 8                         # segments per rounded-rect corner


def P(x, u, d):
    return Vector((x * MM, (Y0 + u * S + d * C) * MM, (Z0 + u * C - d * S) * MM))


def face_ud(y_mm, z_mm):
    """World (y, z) in mm -> face frame (u, d)."""
    dy, dz = y_mm - Y0, z_mm - Z0
    return dy * S + dz * C, dy * C - dz * S


def glass_d(x, u):
    """Depth of the glass sphere (mm behind the front plane) at face x, u (mm)."""
    xu, zu = x / U, u / U
    return D_OPEN - U * (math.sqrt(121.0 - xu * xu - zu * zu) - 11.0 + 0.05)


def h_hx(d):
    return HX - H_STEP - (d - H_D0) * (HX - H_STEP - H_HX_REAR) / (H_DR - H_D0)


def h_top(d):
    return TOP - H_STEP + (d - H_D0) * H_TOP_SLOPE


def h_bot(d):
    return BOT + H_STEP + (d - H_D0) * T      # horizontal in the world


def h_r(d):
    return 14.0 + 0.02 * (d - H_D0)


# --------------------------------------------------------------------------
# generic geometry helpers
# --------------------------------------------------------------------------

def rrect(hx, top, bot, r, k=K_CORNER, sh=8, sv=6):
    """Rounded rectangle as a list of (a, b), same vertex count for any size."""
    r = max(0.01, min(r, hx - 0.005, (top - bot) / 2.0 - 0.005))
    pts = []

    def line(p, q, n):
        for i in range(n):
            t = i / n
            pts.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))

    def arc(cx, cy, a0):
        for i in range(k):
            a = a0 + (math.pi / 2.0) * i / k
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    line((hx, bot + r), (hx, top - r), sv)
    arc(hx - r, top - r, 0.0)
    line((hx - r, top), (-(hx - r), top), sh)
    arc(-(hx - r), top - r, math.pi / 2.0)
    line((-hx, top - r), (-hx, bot + r), sv)
    arc(-(hx - r), bot + r, math.pi)
    line((-(hx - r), bot), (hx - r, bot), sh)
    arc(hx - r, bot + r, 1.5 * math.pi)
    return pts


def fillet_poly(pts, radii, segs):
    """Round the interior corners of a 2D polyline."""
    out = [tuple(pts[0])]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[i + 1])
        r = radii[i]
        if r <= 0.0:
            out.append(tuple(p1))
            continue
        d1, d2 = (p0 - p1).normalized(), (p2 - p1).normalized()
        ang = d1.angle(d2)
        tl = r / math.tan(ang / 2.0)
        a = p1 + d1 * tl
        b = p1 + d2 * tl
        centre = p1 + (d1 + d2).normalized() * (r / math.sin(ang / 2.0))
        va, vb = a - centre, b - centre
        sweep = math.atan2(va.x * vb.y - va.y * vb.x, va.dot(vb))
        for k in range(segs[i] + 1):
            t = sweep * k / segs[i]
            ct, st = math.cos(t), math.sin(t)
            out.append((centre.x + va.x * ct - va.y * st, centre.y + va.x * st + va.y * ct))
    out.append(tuple(pts[-1]))
    return out


def loft(bm, rings, band_mat=None):
    """Skin consecutive rings. band_mat: {band index: material index}; band j lies
    between ring j and ring j + 1, negative indices count from the last band."""
    vr = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    bands = len(vr) - 1
    mat = {}
    for j, m in (band_mat or {}).items():
        mat[j % bands] = m
    for j in range(bands):
        a, b = vr[j], vr[j + 1]
        for i in range(n):
            k = (i + 1) % n
            f = bm.faces.new((a[i], a[k], b[k], b[i]))
            f.material_index = mat.get(j, 0)
    return vr


def cap_fan(bm, ring):
    centre = Vector((0.0, 0.0, 0.0))
    for v in ring:
        centre += v.co
    c = bm.verts.new(centre / len(ring))
    n = len(ring)
    for i in range(n):
        bm.faces.new((ring[i], ring[(i + 1) % n], c))
    return [c] + list(ring)


def frame(origin, e1, e2, n):
    return Matrix((
        (e1.x, e2.x, n.x, origin.x),
        (e1.y, e2.y, n.y, origin.y),
        (e1.z, e2.z, n.z, origin.z),
        (0.0, 0.0, 0.0, 1.0),
    ))


def add_box(bm, M, size, bevel=0.0, segs=2, mat=0):
    """Box of `size` (mm, along the frame axes) centred on the frame origin."""
    before = set(bm.verts)
    fbefore = set(bm.faces)
    bmesh.ops.create_cube(bm, size=1.0)
    new = [v for v in bm.verts if v not in before]
    bmesh.ops.scale(bm, vec=Vector(size) * MM, verts=new)
    if bevel > 0.0:
        edges = list({e for v in new for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=edges, offset=bevel * MM, segments=segs, profile=0.5,
                        affect="EDGES")
        new = [v for v in bm.verts if v not in before]
    bmesh.ops.transform(bm, matrix=M, verts=new)
    for f in bm.faces:
        if f not in fbefore:
            f.material_index = mat


def add_prism(bm, M, ring, h0, h1, mat=0):
    """Closed prism of a 2D ring (mm, frame a/b) from height h0 to h1 (mm)."""
    lo = [bm.verts.new(M @ Vector((a * MM, b * MM, h0 * MM))) for a, b in ring]
    hi = [bm.verts.new(M @ Vector((a * MM, b * MM, h1 * MM))) for a, b in ring]
    n = len(ring)
    faces = [bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i])) for i in range(n)]
    faces.append(bm.faces.new(hi))
    faces.append(bm.faces.new(list(reversed(lo))))
    for f in faces:
        f.material_index = mat


def add_cutter(bm, M, ring_fn, depth, lip, segs, above=1.0):
    """Closed cutter for a pocket `depth` mm deep whose mouth is rounded (segs > 1)
    or chamfered (segs == 1) by `lip` mm. ring_fn(offset) -> [(a, b)] in mm."""
    prof = [(0.0, -depth)]
    if segs <= 1:
        prof += [(0.0, -lip), (lip + above, above)]
    else:
        amax = math.radians(75.0)
        for k in range(segs + 1):
            a = amax * k / segs
            prof.append((lip * (1.0 - math.cos(a)), -lip + lip * math.sin(a)))
        o, h = prof[-1]
        prof.append((o + math.tan(amax) * (above - h), above))
    rings = []
    for o, h in prof:
        rings.append([M @ Vector((a * MM, b * MM, h * MM)) for a, b in ring_fn(o)])
    vr = loft(bm, rings)
    bm.faces.new(list(reversed(vr[0])))
    bm.faces.new(vr[-1])


def ensure_uv(me):
    """Every exported mesh carries `UVMap` as its first UV layer, so the layer the
    assembly adds (`Lightmap`) is the second one on every object (README)."""
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    me.uv_layers[0].name = "UVMap"


def edit_mesh(obj, fn):
    """Run fn(bm) on the object's mesh."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    fn(bm)
    bm.to_mesh(obj.data)
    bm.free()
    ensure_uv(obj.data)


def bm_object(bm, name, collection, mats=()):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ensure_uv(me)
    obj = vc.new_object(name, me, collection)
    for m in mats:                    # (materials.clear() would reset face indices)
        me.materials.append(m)
    return obj


def boolean_cut(obj, cutter):
    mats = [s.material for s in obj.material_slots]
    mod = obj.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    vc.apply_modifiers(obj)
    me = cutter.data
    bpy.data.objects.remove(cutter)
    bpy.data.meshes.remove(me)
    idx = [p.material_index for p in obj.data.polygons]    # clear() resets them
    obj.data.materials.clear()
    for m in mats:
        obj.data.materials.append(m)
    for p, i in zip(obj.data.polygons, idx):
        p.material_index = i if i < len(mats) else 0
    ensure_uv(obj.data)


def key(co):
    return (round(co.x, 5), round(co.y, 5), round(co.z, 5))


def cleanup(obj, cap_keys=(), drop=None):
    """Delete construction caps (all verts in cap_keys) and faces drop(face) is true for."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    caps = set(cap_keys)
    dead = []
    for f in bm.faces:
        if caps and all(key(v.co) in caps for v in f.verts):
            dead.append(f)
        elif drop is not None and drop(f):
            dead.append(f)
    if dead:
        bmesh.ops.delete(bm, geom=dead, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    ensure_uv(obj.data)


def paint_floors(obj, specs, index):
    """Give pocket floors another material. spec: (M, depth_mm, half_a_mm, half_b_mm)."""
    for M, depth, ha, hb in specs:
        inv = M.inverted()
        n = (M.to_3x3() @ Vector((0.0, 0.0, 1.0))).normalized()
        for p in obj.data.polygons:
            c = inv @ p.center
            if abs(c.z + depth * MM) < 0.15 * MM and abs(c.x) <= ha * MM and abs(c.y) <= hb * MM \
                    and p.normal.dot(n) > 0.9:
                p.material_index = index


def tri_ngons(bm):
    """Split n-gons (boolean leftovers have hundreds of sides) so the lightmap
    packer and the exporter triangulate them the same way."""
    big = [f for f in bm.faces if len(f.verts) > 4]
    if big:
        bmesh.ops.triangulate(bm, faces=big, quad_method="BEAUTY", ngon_method="BEAUTY")


def finish(obj, angle=40.0, weighted=True):
    edit_mesh(obj, tri_ngons)
    vc.smooth(obj, angle)
    if weighted:
        try:
            mod = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
            mod.weight = 60
            vc.apply_modifiers(obj)
        except Exception as exc:   # normals stay area-unweighted; cosmetic only
            print("weighted normals skipped on", obj.name, exc)
    obj.data.name = obj.name


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# --------------------------------------------------------------------------
# materials
# --------------------------------------------------------------------------

def _sock(coll, name, typ):
    for s in coll:
        if s.name == name and s.type == typ and s.enabled:
            return s
    raise KeyError(name)


def _mix(nodes, blend="MIX"):
    m = nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = blend
    return (m, _sock(m.inputs, "Factor", "VALUE"), _sock(m.inputs, "A", "RGBA"),
            _sock(m.inputs, "B", "RGBA"), _sock(m.outputs, "Result", "RGBA"))


def _maprange(nodes, links, src, f0, f1, t0, t1):
    m = nodes.new("ShaderNodeMapRange")
    for i, v in zip((1, 2, 3, 4), (f0, f1, t0, t1)):
        m.inputs[i].default_value = v
    links.new(src, m.inputs[0])
    return m.outputs[0]


def _noise(nodes, links, vec, scale, detail=3.0, mapping=None):
    n = nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = 0.55
    if mapping is not None:
        mp = nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = mapping
        links.new(vec, mp.inputs["Vector"])
        vec = mp.outputs["Vector"]
    links.new(vec, n.inputs["Vector"])
    return n.outputs[0]


def _math(nodes, links, op, a, b, clamp=False):
    """a, b: sockets or floats."""
    m = nodes.new("ShaderNodeMath")
    m.operation = op
    m.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            links.new(v, m.inputs[i])
    return m.outputs[0]


def abs_material(name, clean, yellow, lo, hi, zgain, scale=4.5, rough=0.5,
                 dust=0.06, grime=True):
    """Aged ABS. Colours are sRGB hex. Only the colour is baked, so all the wear
    is albedo: uneven yellowing in two octaves of soft patches plus a little more
    toward the top, a fine mottle, grey-brown grime where the surface is occluded
    (recess corners, seam, slots) and a film of dust on upward faces."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N["Principled BSDF"]
    tc = N.new("ShaderNodeTexCoord")
    obj = tc.outputs["Object"]
    big = _noise(N, L, obj, scale)
    mid = _noise(N, L, obj, 14.0, 2.0)
    both = _math(N, L, "ADD", _math(N, L, "MULTIPLY", big, 0.65),
                 _math(N, L, "MULTIPLY", mid, 0.35))
    patch = _maprange(N, L, both, 0.38, 0.62, lo, hi)
    sep = N.new("ShaderNodeSeparateXYZ")
    L.new(obj, sep.inputs[0])
    height = _maprange(N, L, sep.outputs[2], 0.0, 0.3, 0.0, zgain)
    amount = _math(N, L, "ADD", patch, height, clamp=True)
    mix, fac, a, b, out = _mix(N)
    a.default_value = (*vc.srgb(clean), 1.0)
    b.default_value = (*vc.srgb(yellow), 1.0)
    L.new(amount, fac)

    # dust settles on faces that look up
    if dust > 0.0:
        geo = N.new("ShaderNodeNewGeometry")
        gsep = N.new("ShaderNodeSeparateXYZ")
        L.new(geo.outputs["Normal"], gsep.inputs[0])
        up = _maprange(N, L, gsep.outputs[2], 0.85, 0.97, 0.0, dust)
        dmix, dfac, da, db, dout = _mix(N)
        L.new(up, dfac)
        L.new(out, da)
        db.default_value = (*vc.srgb("#BEB8A8"), 1.0)
        out = dout

    mottle = _maprange(N, L, _noise(N, L, obj, 55.0, 2.0), 0.25, 0.75, 0.93, 1.0)
    mul, mfac, ma, mb, mout = _mix(N, "MULTIPLY")
    mfac.default_value = 1.0
    L.new(out, ma)
    L.new(mottle, mb)
    out = mout

    # grime collects where a cloth never reaches
    if grime:
        ao = N.new("ShaderNodeAmbientOcclusion")
        ao.samples = 16
        ao.inputs["Distance"].default_value = 0.012
        occ = _maprange(N, L, ao.outputs["AO"], 0.55, 1.0, 0.0, 1.0)
        tint, tfac, ta, tb, tout = _mix(N)
        ta.default_value = (0.60, 0.57, 0.50, 1.0)       # linear; about 20% darker, warm grey
        tb.default_value = (1.0, 1.0, 1.0, 1.0)
        L.new(occ, tfac)
        gm, gfac, ga, gb, gout = _mix(N, "MULTIPLY")
        gfac.default_value = 1.0
        L.new(out, ga)
        L.new(tout, gb)
        out = gout

    L.new(out, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    return mat


def brushed_material(name):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N["Principled BSDF"]
    tc = N.new("ShaderNodeTexCoord")
    streak = _noise(N, L, tc.outputs["Object"], 1.0, 4.0, mapping=(25.0, 2600.0, 2600.0))
    mix, fac, a, b, out = _mix(N)
    a.default_value = (*vc.srgb("#B4B4AE"), 1.0)
    b.default_value = (*vc.srgb("#DADAD5"), 1.0)
    L.new(streak, fac)
    L.new(out, bsdf.inputs["Base Color"])
    L.new(_maprange(N, L, streak, 0.2, 0.8, 0.30, 0.46), bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = 0.35
    return mat


def materials():
    m = {}
    m["collar"] = abs_material("ABS_Collar", "#DDD8C6", "#D4C8A2", 0.04, 0.60, 0.10)
    m["housing"] = abs_material("ABS_Housing", "#DDD8C6", "#D6C9A0", 0.0, 0.46, 0.06, scale=3.5)
    m["plinth"] = abs_material("ABS_Plinth", "#C6C1B0", "#C2B691", 0.05, 0.45, 0.0, scale=6.0)
    m["cavity"] = vc.material("Cavity", (0.006, 0.006, 0.006), roughness=0.9)
    # bottom of the collar/housing seam: plastic in permanent shadow
    m["seam"] = vc.material("SeamShadow", vc.srgb("#2E2B25"), roughness=0.8)
    m["button"] = abs_material("ABS_Button", "#A9A396", "#A39A82", 0.1, 0.5, 0.0, scale=30.0,
                               rough=0.45, dust=0.0, grime=False)
    m["led"] = vc.material("PowerLED", vc.srgb("#1F3A1C"), roughness=0.22,
                           emission=vc.srgb("#58E84A"), strength=0.7)
    m["glass"] = vc.material("GlassProxy", vc.srgb("#333C3E"), roughness=0.06)
    m["plate"] = brushed_material("Nameplate")
    m["ink"] = vc.material("NameplateInk", vc.srgb("#5C1820"), roughness=0.7)
    m["wheel"] = vc.material("ControlGrey", vc.srgb("#6F6D68"), roughness=0.55)
    m["rear_dark"] = vc.material("RearDark", vc.srgb("#1C1C1C"), roughness=0.45)
    m["rear_metal"] = vc.material("RearMetal", vc.srgb("#C8C8C4"), roughness=0.4, metallic=0.3)
    m["rear_white"] = vc.material("RearWhite", vc.srgb("#E4E1D6"), roughness=0.5)
    return m


# --------------------------------------------------------------------------
# front-face layout (face frame, mm)
# --------------------------------------------------------------------------
CHIN_U = -(GU + STEP) - B_CHIN / 2.0 - 2.0     # controls sit a little below chin centre
PLATE_X, PLATE_U, PLATE_W, PLATE_H = -76.0, CHIN_U + 1.0, 68.0, 15.0
LED_X, LED_U, LED_W, LED_H = 98.0, CHIN_U, 9.0, 3.0
PAD_W, PAD_D, PAD_AT = 40.0, 11.0, 30.0        # top-centre pad on the collar
BTN_X, BTN_U, BTN_HALF = 122.0, CHIN_U, 6.9
BTN_SOCKET_HALF, BTN_SOCKET_DEPTH = 7.7, 6.0


def front_frame(x, u, d=0.0):
    """Right-handed frame on the collar front: a = right, b = up the face, n = out."""
    return frame(P(x, u, d), E_X, E_U, -E_D)


def local_frame(x, u, d=0.0):
    """TubeRef-like orientation (local +Y into the unit) at a point of the face."""
    return Matrix.Translation(P(x, u, d)) @ Matrix.Rotation(-LEAN, 4, "X")


# --------------------------------------------------------------------------
# parts
# --------------------------------------------------------------------------

def build_collar(collection, mats):
    bm = bmesh.new()
    base = rrect(GX, GU, -GU, GR)
    lip_d = [glass_d(x, u) for x, u in base]
    rings = []
    # wall continuing behind the glass, the lip itself, and its small chamfer
    rings.append([P(x, u, d + 7.0) for (x, u), d in zip(base, lip_d)])
    rings.append([P(x, u, d - 0.4) for (x, u), d in zip(base, lip_d)])
    rings.append([P(x, u, d - 1.1) for (x, u), d in
                  zip(rrect(GX + 0.7, GU + 0.7, -GU - 0.7, GR + 0.7), lip_d)])
    # mask wall, thin ledge, drafted outer wall, crisp mouth 13 mm outside the glass
    # (offset from the glass, depth). The corner radius tightens toward the mouth.
    inner = fillet_poly([(5.0, 13.4), (5.5, 12.2), (7.2, 11.9), (STEP, 0.0), (19.5, 0.0)],
                        [0, 0.7, 0.7, 1.5, 0], [0, 2, 2, 3, 0])[:-1]
    for o, d in inner:
        rings.append([P(x, u, d) for x, u in
                      rrect(GX + o, GU + o, -GU - o, GR + 0.7 - RECESS_TIGHTEN * (o - 0.7))])
    # front edge, side walls, back edge, seam groove (inset from the skin, depth)
    outer = fillet_poly([(20.0, 0.0), (0.0, 0.0), (0.0, COLLAR_D), (1.5, COLLAR_D),
                         (GROOVE, COLLAR_D), (GROOVE, H_D0 + 0.3)],
                        [0, R_FRONT, 0.7, 0, 0, 0], [0, 7, 2, 0, 0, 0])[1:]
    for e, d in outer:
        rings.append([P(x, u, d) for x, u in
                      rrect(HX - e, TOP - e, BOT + e, max(R_CORNER - e, 3.0))])
    # the back wall below 1.5 mm and the groove floor are in permanent shadow
    vr = loft(bm, rings, {-2: 2, -1: 2})
    caps = [key(v.co) for v in cap_fan(bm, vr[0])] + [key(v.co) for v in cap_fan(bm, vr[-1])]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    collar = bm_object(bm, "Collar", collection, (mats["collar"], mats["cavity"], mats["seam"]))

    # moulded pockets: power button socket and the nameplate seat
    cb = bmesh.new()
    Mb = front_frame(BTN_X, BTN_U)
    add_cutter(cb, Mb, lambda o: rrect(BTN_SOCKET_HALF + o, BTN_SOCKET_HALF + o,
                                       -BTN_SOCKET_HALF - o, 2.6 + o, k=5, sh=1, sv=1),
               BTN_SOCKET_DEPTH, 0.8, 3)
    Mp = front_frame(PLATE_X, PLATE_U)
    add_cutter(cb, Mp, lambda o: rrect(PLATE_W / 2 + 0.25 + o, PLATE_H / 2 + 0.25 + o,
                                       -PLATE_H / 2 - 0.25 - o, 1.3 + o, k=3, sh=1, sv=1),
               0.9, 0.35, 1, above=0.5)
    boolean_cut(collar, bm_object(cb, "CollarCut", collection))
    cleanup(collar, caps)
    paint_floors(collar, [(Mb, BTN_SOCKET_DEPTH, 9.0, 9.0)], 1)

    # moulded pad at the top centre of the collar, 1 mm proud
    Mt = frame(P(0.0, TOP, PAD_AT), E_X, E_D, E_U)

    def pad(bm):
        before = set(bm.faces)
        add_box(bm, Mt @ Matrix.Translation(Vector((0.0, 0.0, -1.0)) * MM),
                (PAD_W, PAD_D, 4.0), bevel=1.0, segs=2)
        inv = Mt.inverted()
        dead = [f for f in bm.faces if f not in before
                and all((inv @ v.co).z < -0.0001 for v in f.verts)]
        bmesh.ops.delete(bm, geom=dead, context="FACES")

    edit_mesh(collar, pad)
    finish(collar)
    return collar


def build_housing(collection, mats):
    bm = bmesh.new()
    # the front wall runs down past the collar's groove floor so the seam is closed
    prof = fillet_poly([(GROOVE - H_STEP + 0.6, H_D0), (1.5, H_D0), (0.0, H_D0), (0.0, H_DR),
                        (16.0, H_DR), (17.0, H_DR - 5.0)],
                       [0, 0, 0.7, 8.0, 1.2, 0], [0, 0, 2, 5, 2, 0])
    rings = []
    for e, d in prof:
        rings.append([P(x, u, d) for x, u in
                      rrect(h_hx(d) - e, h_top(d) - e, h_bot(d) + e, max(h_r(d) - e, 3.0),
                            sh=2, sv=2)])
    vr = loft(bm, rings, {0: 2})
    caps = [key(v.co) for v in cap_fan(bm, vr[0])]
    bm.faces.new(vr[-1])                     # rear panel
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    housing = bm_object(bm, "Housing", collection,
                        (mats["housing"], mats["cavity"], mats["seam"]))

    cb = bmesh.new()
    floors = []
    # louvred vent on the sloped top: two banks of slots running left-right
    dc = 196.0
    o = P(0.0, h_top(dc), dc)
    e2 = (P(0.0, h_top(dc + 1.0), dc + 1.0) - o).normalized()
    Mt = frame(o, E_X, e2, E_X.cross(e2))
    rows, pitch, slot_l, slot_w = 19, 9.0, 94.0, 3.4
    for col in (-1, 1):
        for j in range(rows):
            Ms = Mt @ Matrix.Translation(Vector((col * 52.0, (j - (rows - 1) / 2) * pitch, 0)) * MM)
            add_cutter(cb, Ms, lambda off: rrect(slot_l / 2 + off, slot_w / 2 + off,
                                                 -slot_w / 2 - off, slot_w / 2 + off - 0.001,
                                                 k=2, sh=1, sv=0),
                       6.0, 0.5, 1, above=0.6)
    floors.append((Mt, 6.0, 110.0, rows * pitch / 2 + 4.0))

    # control recess low on the right side, about 42 mm behind the seam
    zc = SIDE_ZC
    useam = (zc - Z0 + H_D0 * S) / C
    yc = Y0 + useam * S + H_D0 * C + 42.0 + SIDE_HL
    uc, dcr = face_ud(yc, zc)

    def wall(u, d):
        return P(h_hx(d), u, d)

    a = wall(uc, dcr)
    n = (wall(uc, dcr + 10.0) - a).cross(wall(uc + 10.0, dcr) - a).normalized()
    if n.x < 0.0:
        n = -n
    ey = Vector((0.0, 1.0, 0.0))
    e1 = (ey - n * ey.dot(n)).normalized()
    Mr = frame(a, e1, n.cross(e1), n)
    # square mouth: the raised rim (build_side_controls) carries the rounding
    add_cutter(cb, Mr, side_ring, SIDE_DEPTH, 0.05, 1)
    boolean_cut(housing, bm_object(cb, "HousingCut", collection))
    cleanup(housing, caps)
    paint_floors(housing, floors, 1)
    finish(housing)
    return housing, Mr


SIDE_ZC, SIDE_HL, SIDE_HH, SIDE_DEPTH = 41.0, 55.0, 13.0, 8.0


def side_ring(off):
    """Stadium outline of the side recess, grown by `off` mm."""
    return rrect(SIDE_HL + off, SIDE_HH + off, -SIDE_HH - off, SIDE_HH + off - 0.004,
                 k=7, sh=2, sv=0)


def build_side_controls(collection, mats, Mr):
    """Two thumbwheels and a ribbed cap in the side recess, plus the recess's
    raised rim. Frame: a = toward the rear, b = up, n = out of the wall; the
    recess floor is at n = -8 mm."""
    bm = bmesh.new()
    floor = -SIDE_DEPTH

    # raised rim: 2.5 mm wide, 1.2 mm proud, in the housing plastic
    prof = fillet_poly([(0.05, 0.0), (0.05, 1.2), (2.5, 1.2), (2.5, -0.3)],
                       [0, 0.5, 0.5, 0], [0, 2, 2, 0])
    vr = loft(bm, [[Mr @ (Vector((a, b, h)) * MM) for a, b in side_ring(o)] for o, h in prof],
              {j: 3 for j in range(len(prof) - 1)})
    bm.normal_update()
    rim = [f for f in bm.faces]
    top = max(rim, key=lambda f: (Mr.inverted() @ f.calc_center_median()).z)
    if top.normal.dot(Mr.to_3x3() @ Vector((0.0, 0.0, 1.0))) < 0.0:
        bmesh.ops.reverse_faces(bm, faces=rim)
    rim = set(rim)

    for ac in (-33.0, -4.0):
        add_box(bm, Mr @ Matrix.Translation(Vector((ac, 0.0, floor + 0.1)) * MM),
                (27.0, 7.6, 0.3), mat=1)
        R, half_t, segs = 17.0, 2.9, 14
        amax = math.radians(46.0)
        cz = floor + 4.6 - R
        lo, hi = [], []
        for k in range(segs + 1):
            ang = -amax + 2.0 * amax * k / segs
            rr = R - (0.55 if k % 2 else 0.0)
            pa, pn = ac + rr * math.sin(ang), cz + rr * math.cos(ang)
            lo.append(bm.verts.new(Mr @ (Vector((pa, -half_t, pn)) * MM)))
            hi.append(bm.verts.new(Mr @ (Vector((pa, half_t, pn)) * MM)))
        for k in range(segs):
            bm.faces.new((lo[k], lo[k + 1], hi[k + 1], hi[k]))
        bm.faces.new(hi)
        bm.faces.new(list(reversed(lo)))
        bm.faces.new((lo[0], hi[0], hi[-1], lo[-1]))
    # stadium cap at the rear end, nearly the full recess height, finely ribbed
    cap_a, cap_hl, cap_hh, cap_r, cap_top = 38.0, 15.0, 11.0, 10.0, floor + 6.2
    Mc = Mr @ Matrix.Translation(Vector((cap_a, 0.0, 0.0)) * MM)
    prof = fillet_poly([(0.0, floor), (0.0, cap_top), (3.0, cap_top)], [0, 1.2, 0], [0, 3, 0])
    vr = loft(bm, [[Mc @ (Vector((a, b, h)) * MM) for a, b in
                    rrect(cap_hl - e, cap_hh - e, -cap_hh + e, cap_r - e, k=6, sh=2, sv=0)]
                   for e, h in prof], {j: 2 for j in range(len(prof) - 1)})
    bm.faces.new(vr[-1]).material_index = 2
    for i in range(11):
        x = (i - 5) * 2.3
        over = max(abs(x) - (cap_hl - cap_r), 0.0)
        half = cap_hh - cap_r + math.sqrt(max(cap_r * cap_r - over * over, 0.0)) - 2.6
        add_box(bm, Mc @ Matrix.Translation(Vector((x, 0.0, cap_top + 0.2)) * MM),
                (1.0, 2.0 * half, 1.0), mat=2)
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f not in rim])
    obj = bm_object(bm, "SideControls", collection,
                    (mats["wheel"], mats["cavity"], mats["wheel"], mats["housing"]))
    finish(obj, 30.0, weighted=False)
    return obj


def build_plinth(collection, mats):
    """Recessed base under the unit with the vent comb under the chin (world mm)."""
    yf = 18.0
    yr = Y0 + h_bot(H_DR) * S + H_DR * C - 26.0
    top = PLINTH_H + 3.0
    prof = [(yf, 0.0), (yf, 19.0), (64.0, top), (yr, top), (yr, 0.0)]

    def hw(y):
        return 120.0 - 10.0 * (y - yf) / (yr - yf)

    bm = bmesh.new()
    left = [bm.verts.new(Vector((-hw(y), y, z)) * MM) for y, z in prof]
    right = [bm.verts.new(Vector((hw(y), y, z)) * MM) for y, z in prof]
    n = len(prof)
    for i in range(n):
        k = (i + 1) % n
        bm.faces.new((left[i], left[k], right[k], right[i]))
    bm.faces.new(left)
    bm.faces.new(list(reversed(right)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=1.2 * MM, segments=2, profile=0.5,
                    affect="EDGES")
    plinth = bm_object(bm, "Plinth", collection, (mats["plinth"], mats["cavity"]))

    cb = bmesh.new()
    slots, pitch, depth = 57, 3.7, 7.0
    for i in range(slots):
        x = (i - (slots - 1) / 2) * pitch
        add_box(cb, Matrix.Translation(Vector((x, yf - 2.0 + (depth + 2.0) / 2, 4.5)) * MM),
                (2.0, depth + 2.0, 13.0))
    boolean_cut(plinth, bm_object(cb, "PlinthCut", collection))
    cleanup(plinth, drop=lambda f: min(v.co.z for v in f.verts) > 11.6 * MM
            or max(v.co.z for v in f.verts) < 0.05 * MM)
    Mc = frame(Vector((0.0, yf, 5.0)) * MM, E_X, Vector((0, 0, -1.0)), Vector((0, -1.0, 0)))
    paint_floors(plinth, [(Mc, depth, 110.0, 12.0)], 1)
    finish(plinth)
    return plinth


def build_rear(collection, mats):
    """Simple rear panel furniture; never seen from the front. Returns the keyboard
    jack location (world)."""
    d = H_DR - 5.0
    uc = (h_top(H_DR) + h_bot(H_DR)) / 2.0
    M = frame(P(0.0, uc, d), -E_X, E_U, E_D)     # a = right as seen from behind

    def at(a, b, h=0.0):
        return M @ Matrix.Translation(Vector((a, b, h)) * MM)

    bm = bmesh.new()
    # The panel is about 215 x 156 mm now that the housing tapers harder.
    add_box(bm, at(-8.0, -4.0, 0.3), (136.0, 62.0, 0.6), mat=1)             # label plate
    add_box(bm, at(74.0, 50.0, 1.5), (56.0, 40.0, 3.0), bevel=1.0, mat=3)   # switch surround
    add_box(bm, at(74.0, 50.0, 4.0), (41.0, 31.0, 4.0), bevel=1.0, mat=0)   # rocker
    add_box(bm, at(-88.0, 48.0, 0.5), (26.0, 43.0, 1.0), mat=3)             # blank cover
    add_box(bm, at(80.0, -20.0, 1.0), (32.0, 26.0, 2.0), mat=0)             # mains inlet
    add_box(bm, at(-92.0, -34.0, 2.5), (14.0, 54.0, 5.0), mat=0)            # comm port
    add_box(bm, at(-46.0, -64.0, 2.0), (42.0, 12.0, 4.0), mat=3)            # 20 mA
    add_box(bm, at(14.0, -64.0, 2.5), (32.0, 13.0, 5.0), mat=1)             # printer port
    add_box(bm, at(80.0, -64.0, 0.75), (13.0, 11.0, 1.5), mat=0)            # keyboard jack
    ring = [(10.5 * math.cos(i * math.pi / 10), 10.5 * math.sin(i * math.pi / 10))
            for i in range(20)]
    add_prism(bm, at(0.0, 56.0), ring, 0.0, 2.0, mat=3)                     # round cap
    ring = [(6.0 * math.cos(i * math.pi / 8), 6.0 * math.sin(i * math.pi / 8))
            for i in range(16)]
    add_prism(bm, at(-92.0, 10.0), ring, 0.0, 12.0, mat=1)                  # video socket
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # faces lying on the panel are never seen and would waste lightmap area
    bm.normal_update()
    dead = [f for f in bm.faces if f.normal.dot(E_D) < -0.99]
    bmesh.ops.delete(bm, geom=dead, context="FACES")
    obj = bm_object(bm, "RearDetails", collection,
                    (mats["rear_dark"], mats["rear_metal"], mats["rear_metal"], mats["rear_white"]))
    finish(obj, 30.0, weighted=False)
    return obj, at(80.0, -64.0, 1.5).to_translation()


def _arc(cx, cy, rx, ry, a0, a1, n):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


# Thin monoline capitals for the nameplate, drawn in a unit square (cap height 1).
# char -> (advance width, [(closed, centre-line points)])
GLYPHS = {
    "D": (0.62, [(True, [(0.0, 0.0), (0.0, 1.0)] + _arc(0.25, 0.5, 0.37, 0.5, 90, -90, 22))]),
    "S": (0.58, [(False, _arc(0.29, 0.75, 0.25, 0.25, 28, 270, 20)
                  + _arc(0.29, 0.25, 0.29, 0.25, 90, -152, 20)[1:])]),
    "-": (0.36, [(False, [(0.03, 0.42), (0.33, 0.42)])]),
    "2": (0.58, [(False, _arc(0.28, 0.72, 0.26, 0.28, 162, -42, 18)
                  + [(0.0, 0.0), (0.58, 0.0)])]),
    "0": (0.60, [(True, _arc(0.30, 0.5, 0.30, 0.5, 0, 360, 36)[:-1])]),
}


def ribbon(bm, pts, closed, width, to3d):
    """Flat stroke of `width` along a 2D polyline, mitred at the joints."""
    n = len(pts)
    P2 = [Vector(p) for p in pts]
    left, right = [], []
    for i in range(n):
        p = P2[i]
        a = P2[(i - 1) % n] if closed or i > 0 else None
        b = P2[(i + 1) % n] if closed or i < n - 1 else None
        d1 = (p - a).normalized() if a is not None else (b - p).normalized()
        d2 = (b - p).normalized() if b is not None else d1
        t = (d1 + d2).normalized()
        nrm = Vector((-t.y, t.x))
        m = 1.0 / max(nrm.dot(Vector((-d1.y, d1.x))), 0.4)
        o = nrm * (width / 2.0 * m)
        left.append(bm.verts.new(to3d(*(p + o))))
        right.append(bm.verts.new(to3d(*(p - o))))
    for i in range(n if closed else n - 1):
        k = (i + 1) % n
        bm.faces.new((left[i], left[k], right[k], right[i]))


def build_nameplate(collection, mats):
    Mp = front_frame(PLATE_X, PLATE_U)
    proud = 0.15
    # plate with the pocket's rounded corners and a hairline chamfer
    bm = bmesh.new()
    vr = loft(bm, [[Mp @ (Vector((a, b, h)) * MM) for a, b in
                    rrect(PLATE_W / 2 - e, PLATE_H / 2 - e, -PLATE_H / 2 + e, 1.2 - e,
                          k=3, sh=1, sv=1)]
                   for e, h in ((0.0, proud - 1.0), (0.0, proud - 0.15), (0.15, proud))])
    bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    plate = bm_object(bm, "Nameplate", collection, (mats["plate"],))
    finish(plate, 30.0, weighted=False)

    # Block mark and model number as flat mesh 0.1 mm proud of the plate. The
    # letters are stroked polylines drawn here, so the result does not depend on
    # any font file.
    h = proud + 0.1
    bm = bmesh.new()

    def put(pts):
        return bm.faces.new([bm.verts.new(Mp @ (Vector((a, b, h)) * MM)) for a, b in pts])

    # mark: three upright bars, the last with a clipped corner
    for i in range(3):
        x0 = -29.4 + i * 4.3
        x1, y0, y1 = x0 + 3.3, -3.5, 3.5
        if i < 2:
            put([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
        else:
            put([(x0, y0), (x1, y0), (x1, y1 - 1.6), (x1 - 1.6, y1), (x0, y1)])

    cap_h, stroke_w, left, gap = 7.0, 0.55, -10.5, 0.24
    unit = cap_h - stroke_w
    x = left + stroke_w / 2.0
    for ch in "DS-220":
        adv, paths = GLYPHS[ch]
        for closed, pts in paths:
            ribbon(bm, [(x + px * unit, (py - 0.5) * unit) for px, py in pts], closed,
                   stroke_w, lambda a, b: Mp @ (Vector((a, b, h)) * MM))
        x += (adv + gap) * unit
    out = -E_D                        # every face must look out of the plate
    bm.normal_update()
    for f in bm.faces:
        if f.normal.dot(out) < 0.0:
            f.normal_flip()
    text = bm_object(bm, "NameplateText", collection, (mats["ink"],))
    text.data.name = text.name
    return plate, text


def build_local_solid(name, collection, mat, M, profile, ring_fn):
    """Small closed part modelled in its own TubeRef-like local space (mm):
    profile = [(inset, y)], y negative toward the viewer; ring_fn(inset) -> [(x, z)]."""
    bm = bmesh.new()
    rings = [[Vector((a, y, b)) * MM for a, b in ring_fn(e)] for e, y in profile]
    vr = loft(bm, rings)
    bm.faces.new(vr[0])
    bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    obj = bm_object(bm, name, collection, (mat,))
    obj.matrix_world = M
    finish(obj, 40.0)
    return obj


def build_controls(collection, mats):
    # power lamp lens, slightly proud of the chin
    prof = fillet_poly([(0.0, 1.0), (0.0, -0.7), (1.2, -0.7)], [0, 0.45, 0], [0, 3, 0])
    led = build_local_solid(
        "PowerLED", collection, mats["led"], local_frame(LED_X, LED_U), prof,
        lambda e: rrect(LED_W / 2 - e, LED_H / 2 - e, -LED_H / 2 + e, max(0.9 - e, 0.15),
                        k=4, sh=1, sv=1))
    # push button standing 1.5 mm proud in its socket, with a shallow finger dish
    # (the skirt stops 2.5 mm in: pressed 3 mm it still clears the 6 mm socket floor)
    prof = fillet_poly([(0.0, 2.5), (0.0, -1.5), (2.2, -1.5)], [0, 0.9, 0], [0, 4, 0])
    prof += [(2.2 + 4.2 * t, -1.5 + 0.42 * (1.0 - math.cos(math.pi * t)) / 2.0)
             for t in (0.2, 0.4, 0.6, 0.8, 1.0)]
    button = build_local_solid(
        "PowerButton", collection, mats["button"], local_frame(BTN_X, BTN_U), prof,
        lambda e: rrect(BTN_HALF - e, BTN_HALF - e, -BTN_HALF + e,
                        min(max(2.0 - e, 0.5) if e < 1.0 else 1.0 + 0.9 * (e - 1.0),
                            BTN_HALF - e - 0.15), k=5, sh=1, sv=1))
    button["travel"] = 0.003
    return led, button


def build_glass_proxy(collection, mats):
    nx, nz = 36, 28
    bm = bmesh.new()
    grid = []
    for j in range(nz + 1):
        zu = -1.75 + 3.5 * j / nz
        row = []
        for i in range(nx + 1):
            xu = -2.25 + 4.5 * i / nx
            row.append(bm.verts.new(P(xu * U, zu * U, glass_d(xu * U, zu * U))))
        grid.append(row)
    for j in range(nz):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    if bm.faces[0].normal.dot(-E_D) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    obj = bm_object(bm, "GlassProxy", collection, (mats["glass"],))
    obj.data.shade_smooth()
    obj["role"] = "proxy"
    return obj


def build(collection):
    mats = materials()
    collar = build_collar(collection, mats)
    housing, Mr = build_housing(collection, mats)
    side = build_side_controls(collection, mats, Mr)
    plinth = build_plinth(collection, mats)
    rear, kb_jack = build_rear(collection, mats)
    plate, text = build_nameplate(collection, mats)
    led, button = build_controls(collection, mats)
    glass = build_glass_proxy(collection, mats)

    tube = bpy.data.objects.new("TubeRef", None)
    tube.empty_display_type = "ARROWS"
    collection.objects.link(tube)
    tube.location = P(0.0, 0.0, D_OPEN)
    tube.rotation_euler = (-LEAN, 0.0, 0.0)
    tube.scale = (vc.TUBE_UNIT,) * 3

    body = [collar, housing, plinth, side, rear, plate, text]
    for ob in body + [led, button, glass]:
        ensure_uv(ob.data)
        assert ob.data.uv_layers[0].name == "UVMap", ob.name
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in body + [led, button]:
        for v in ob.data.vertices:
            w = ob.matrix_world @ v.co
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return {
        "body": body,
        "Collar": collar, "Housing": housing, "Plinth": plinth, "SideControls": side,
        "RearDetails": rear, "Nameplate": plate, "NameplateText": text,
        "TubeRef": tube, "PowerButton": button, "PowerLED": led, "GlassProxy": glass,
        "kb_jack": kb_jack,
        "bounds": (lo, hi),
        "lean": LEAN,
    }


# --------------------------------------------------------------------------
# stand-alone preview
# --------------------------------------------------------------------------

def main():
    args = vc.script_args()
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Terminal")
    scene.collection.children.link(col)
    out = build(col)
    bpy.context.view_layer.update()

    total = 0
    for ob in out["body"] + [out["PowerLED"], out["PowerButton"], out["GlassProxy"]]:
        n = tri_count(ob)
        total += 0 if ob.get("role") == "proxy" else n
        print("TRIS %-14s %6d  mats=%s" % (ob.name, n, [s.material.name for s in ob.material_slots]))
    print("TRIS total (exported) %d" % total)
    lo, hi = out["bounds"]
    print("BOUNDS", tuple(round(v, 4) for v in lo), tuple(round(v, 4) for v in hi))
    print("TUBEREF", tuple(round(v, 4) for v in out["TubeRef"].location))
    print("KBJACK", tuple(round(v, 4) for v in out["kb_jack"]))

    if "--blend" in args:
        bpy.ops.wm.save_as_mainfile(filepath=args[args.index("--blend") + 1])
    if "--preview" not in args:
        return
    out_dir = args[args.index("--preview") + 1]
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None

    desk = bpy.data.meshes.new("PreviewDesk")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=2.0)
    bm.to_mesh(desk)
    bm.free()
    dob = vc.new_object("PreviewDesk", desk, scene.collection,
                        vc.material("PreviewDesk", (0.30, 0.24, 0.18), roughness=0.55))
    dob.location = (0, 0, -0.0002)
    vc.studio_light(scene)
    scene.view_settings.exposure = -1.6      # cream plastic clips under the stock rig

    t = out["TubeRef"].location
    corner = P(-GX, GU, glass_d(GX, GU))
    chin = P(0.0, CHIN_U, 0.0)
    views = {
        "front": ((0.0, -1.15, t.z), (0.0, t.y, t.z - 0.02), 85.0),
        "three_quarter_left": ((-0.72, -0.82, 0.40), (0.0, 0.14, 0.13), 60.0),
        "three_quarter_right": ((0.74, -0.78, 0.44), (0.0, 0.14, 0.13), 60.0),
        "side": ((1.45, 0.19, 0.15), (0.0, 0.19, 0.145), 85.0),
        "top_rear": ((0.50, 1.02, 0.72), (0.0, 0.20, 0.11), 60.0),
        "chin": ((0.02, -0.52, 0.10), tuple(chin), 60.0),
        "chin_plate": ((-0.05, -0.20, 0.075), tuple(P(PLATE_X, PLATE_U, 0.0)), 80.0),
        "chin_power": ((0.13, -0.17, 0.085), tuple(P(107.0, CHIN_U, 0.0)), 80.0),
        "glass_corner": ((-0.045, -0.20, 0.30), tuple(corner), 85.0),
        "low_front": ((0.25, -0.60, 0.035), (0.0, 0.03, 0.03), 60.0),
        "user_view": ((0.0, -0.62, 0.34), (0.0, t.y, t.z - 0.03), 35.0),
        "seam_close": ((0.42, -0.10, 0.30), tuple(P(HX, 60.0, 66.0)), 85.0),
        "side_recess": ((0.50, 0.02, 0.10), (0.15, 0.17, 0.045), 85.0),
        "grazing_top": ((-0.30, -0.45, 0.36), (0.0, 0.05, 0.27), 70.0),
        "vent_close": ((0.10, 0.42, 0.50), (0.0, 0.24, 0.25), 60.0),
        "under_chin": ((0.10, -0.25, 0.012), (0.0, 0.03, 0.015), 50.0),
    }
    if only:
        views = {k: v for k, v in views.items() if k in only}
    vc.render_previews(scene, out_dir, views)


if __name__ == "__main__":
    main()

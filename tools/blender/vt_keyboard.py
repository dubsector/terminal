"""LK201-style keyboard for the VT220-style terminal scene.

    blender -b --factory-startup --python tools/blender/vt_keyboard.py -- --preview <dir>

build(collection) -> dict. The keyboard rests on the desk (z = 0), centred on
x = 0, front edge at y = 0, rear edge at y = +0.171. Everything is parented to
the case object "Keyboard".

All working dimensions in this file are millimetres; vertices are converted to
metres when they are created.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy
import bmesh
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

import vt_common as vc

MM = 0.001

# ---------------------------------------------------------------- dimensions
PITCH = 19.05
CASE_W = 533.0
CASE_D = 171.0
SLOPE = math.radians(5.5)
COS_A, SIN_A, TAN_A = math.cos(SLOPE), math.sin(SLOPE), math.tan(SLOPE)
Z_FRONT = 16.5            # nominal top-plane height at y = 0 (rear: 33.0)
Z_BOTTOM = 1.0            # underside of the lower shell (rubber pads below)
Z_SEAM = 8.4              # centre of the groove between the two shells
X0 = -12.5 * PITCH        # left edge of F1; the key field is 25 units wide
S0 = 11.5                 # front edge of row 5, measured up the slope
S_F = S0 + 5 * PITCH + 12.5   # front edge of the function row
ROW_INDEX = {"5": 0, "4": 1, "3": 2, "2": 3, "1": 4}

KEY_GAP = 0.45            # per side, between a cap skirt and its unit cell
CAP_BOTTOM = -1.8         # skirt bottom relative to the top plane
WELL_MARGIN = 0.6         # well wall outside the unit cells
WELL_DEPTH = 5.7          # >= travel 3.5 + |CAP_BOTTOM| + 0.3
WELL_DRAFT = 0.5          # the wall leans in toward the floor and catches light
WELL_R = 1.5
WELL_RIM = 0.7

STRIP_S0 = S_F + PITCH + 2.8      # grey legend strip, front edge
STRIP_S1 = STRIP_S0 + 9.8
WINDOW_S1 = STRIP_S0 + 23.9       # clear holder behind it
STRIP_X0 = X0 - 2.5
STRIP_X1 = X0 + 25 * PITCH + 2.5
STRIP_H = 0.2             # strip top above the case surface
WINDOW_H = 0.5
POCKET_DEPTH = 1.0        # strip and window sit in a shallow pocket
POCKET_RIM = 0.4
STRIP_RULE = 0.075        # red rule: this fraction of the strip's depth (UV v)
POCKET = (STRIP_X0 - 0.8, STRIP_X1 + 0.8, STRIP_S0 - 0.4, WINDOW_S1 + 0.4)   # x0, x1, s0, s1

NOTCH_Y = (131.0, 137.0)  # cable notch in the lower shell sides
NOTCH_DEPTH = 7.0

# cap sculpt per row: (height of the cap rim above the top plane, tilt in
# degrees; positive = rear edge higher, i.e. the top leans toward the typist)
ROW_PROFILE = {
    "F": (7.3, 7.0),
    "1": (6.9, 5.5),
    "2": (6.4, 3.0),
    "3": (6.8, -1.0),
    "4": (7.2, -5.0),
    "5": (8.1, -8.0),
}


def top_z(y):
    return Z_FRONT + y * TAN_A


def plane_pt(x, s, h=0.0):
    """Point at slope coordinate s (mm from the front edge, along the top
    plane), raised h along the plane normal. Returns metres."""
    return Vector((x * MM, (s * COS_A - h * SIN_A) * MM,
                   (Z_FRONT + s * SIN_A + h * COS_A) * MM))


def row_s(row):
    return S_F if row == "F" else S0 + ROW_INDEX[row] * PITCH


# -------------------------------------------------------------------- layout
def _layout():
    keys = []

    def add(kid, code, legend, legend2, row, u, w=1.0, tone="cream", group="main",
            strip=None, rows=1, poly=None, prof=None):
        s = row_s(row)
        if poly is None:
            x0, x1 = X0 + u * PITCH, X0 + (u + w) * PITCH
            poly = [(x0, s), (x1, s), (x1, s + rows * PITCH), (x0, s + rows * PITCH)]
        # what legend2 is: the shifted glyph of a two-glyph key, or the second
        # line of a two-line word legend
        stack = "" if not legend2 else "shift" if len(legend) == 1 else "line"
        keys.append(dict(id=kid, code=code, legend=legend, legend2=legend2, stack=stack, row=row,
                         u=u, w=w, h=float(rows), tone=tone, group=group, strip=strip,
                         poly=poly, prof=prof or ROW_PROFILE[row]))

    # top strip: 5 - 5 - 4 - 2 - 4
    for i, (kid, text) in enumerate((("HoldScreen", "Hold Screen"), ("PrintScreen", "Print Screen"),
                                     ("SetUp", "Set-Up"), ("DataTalk", "Data/Talk"), ("Break", "Break"))):
        add(kid, "VT_" + kid, "", "", "F", i, tone="taupe", group="f1", strip=text)
    for i in range(5):
        add("F%d" % (6 + i), "F%d" % (6 + i), "", "", "F", 6 + i, tone="taupe", group="f2",
            strip="F%d" % (6 + i))
    for i, text in enumerate(("F11 (ESC)", "F12 (BS)", "F13 (LF)", "F14")):
        add("F%d" % (11 + i), "F%d" % (11 + i), "", "", "F", 12 + i, tone="taupe", group="f3", strip=text)
    add("Help", "VT_Help", "", "", "F", 17, tone="taupe", group="f4", strip="Help")
    add("Do", "VT_Do", "", "", "F", 18, 2.0, tone="taupe", group="f4", strip="Do")
    for i in range(4):
        add("F%d" % (17 + i), "F%d" % (17 + i), "", "", "F", 21 + i, tone="taupe", group="f5",
            strip="F%d" % (17 + i))

    # main array, row 1
    u = 0.75
    for code, lo, hi in (("Backquote", "`", "~"), ("Digit1", "1", "!"), ("Digit2", "2", "@"),
                         ("Digit3", "3", "#"), ("Digit4", "4", "$"), ("Digit5", "5", "%"),
                         ("Digit6", "6", "^"), ("Digit7", "7", "&"), ("Digit8", "8", "*"),
                         ("Digit9", "9", "("), ("Digit0", "0", ")"), ("Minus", "-", "_"),
                         ("Equal", "=", "+")):
        add(code, code, lo, hi, "1", u)
        u += 1
    add("Backspace", "Backspace", "⌫", "", "1", u, 1.5)
    # row 2
    add("Tab", "Tab", "Tab", "", "2", 0.75, 1.5)
    u = 2.25
    for ch in "QWERTYUIOP":
        add("Key" + ch, "Key" + ch, ch, "", "2", u)
        u += 1
    add("BracketLeft", "BracketLeft", "[", "{", "2", u)
    add("BracketRight", "BracketRight", "]", "}", "2", u + 1)
    s2, s3 = row_s("2"), row_s("3")
    xa, xb, xc = X0 + 14.25 * PITCH, X0 + 14.5 * PITCH, X0 + 15.5 * PITCH
    add("Enter", "Enter", "Return", "", "2", 14.25, 1.25, rows=2, prof=(6.6, 1.0),
        poly=[(xb, s3), (xc, s3), (xc, s2 + PITCH), (xa, s2 + PITCH), (xa, s2), (xb, s2)])
    # row 3
    add("ControlLeft", "ControlLeft", "Ctrl", "", "3", 0.0)
    add("CapsLock", "CapsLock", "Lock", "", "3", 1.0, 1.5)
    u = 2.5
    for ch in "ASDFGHJKL":
        add("Key" + ch, "Key" + ch, ch, "", "3", u)
        u += 1
    for code, lo, hi in (("Semicolon", ";", ":"), ("Quote", "'", '"'), ("Backslash", "\\", "|")):
        add(code, code, lo, hi, "3", u)
        u += 1
    # row 4
    add("ShiftLeft", "ShiftLeft", "Shift", "", "4", 0.0, 2.0)
    add("IntlBackslash", "IntlBackslash", "<", ">", "4", 2.0)
    u = 3.0
    for ch in "ZXCVBNM":
        add("Key" + ch, "Key" + ch, ch, "", "4", u)
        u += 1
    for code, lo, hi in (("Comma", ",", ","), ("Period", ".", "."), ("Slash", "/", "?")):
        add(code, code, lo, hi, "4", u)
        u += 1
    add("ShiftRight", "ShiftRight", "Shift", "", "4", 13.0, 2.0)
    # row 5
    add("Compose", "VT_Compose", "Compose", "Character", "5", 1.25, 2.0)
    add("Space", "Space", "", "", "5", 3.25, 9.0)

    # editing keypad and arrows
    for i, (code, a, b) in enumerate((("Insert", "Find", ""), ("Home", "Insert", "Here"),
                                      ("PageUp", "Re-", "move"))):
        add(code, code, a, b, "1", 17 + i, tone="taupe", group="edit")
    for i, (code, a, b) in enumerate((("Delete", "Select", ""), ("End", "Prev", "Screen"),
                                      ("PageDown", "Next", "Screen"))):
        add(code, code, a, b, "2", 17 + i, tone="taupe", group="edit")
    add("ArrowUp", "ArrowUp", "↑", "", "3", 18, tone="taupe", group="edit")
    add("ArrowLeft", "ArrowLeft", "←", "", "4", 17, tone="taupe", group="edit")
    add("ArrowDown", "ArrowDown", "↓", "", "4", 18, tone="taupe", group="edit")
    add("ArrowRight", "ArrowRight", "→", "", "4", 19, tone="taupe", group="edit")

    # numeric keypad
    for i in range(4):
        add("PF%d" % (i + 1), "VT_PF%d" % (i + 1), "PF%d" % (i + 1), "", "1", 21 + i, group="num")
    for row, items in (("2", ("7", "8", "9")), ("3", ("4", "5", "6")), ("4", ("1", "2", "3"))):
        for i, d in enumerate(items):
            add("Numpad" + d, "Numpad" + d, d, "", row, 21 + i, group="num")
    add("NumpadSubtract", "NumpadSubtract", "-", "", "2", 24, group="num")
    add("NumpadComma", "NumpadComma", ",", "", "3", 24, group="num")
    add("NumpadEnter", "NumpadEnter", "Enter", "", "5", 24, rows=2, group="num", prof=(7.6, -6.0))
    add("Numpad0", "Numpad0", "0", "", "5", 21, 2.0, group="num")
    add("NumpadDecimal", "NumpadDecimal", ".", "", "5", 23, group="num")

    for cell, k in enumerate(keys):
        k["cell"] = cell
    assert len(keys) == 105, len(keys)
    assert len({k["id"] for k in keys}) == 105
    assert len({k["code"] for k in keys}) == 105
    return keys


def layout_text(keys=None):
    keys = keys or _layout()
    out = ["LK201 layout: pitch %.2f mm, x0 (left edge of F1) = %.3f mm, units are key pitches from x0"
           % (PITCH, X0),
           "row: s = front edge of the row in mm up the slope from the case front edge", ""]
    blocks = (("top strip", ("f1", "f2", "f3", "f4", "f5")), ("main array", ("main",)),
              ("editing keypad", ("edit",)), ("numeric keypad", ("num",)))
    total = 0
    for title, groups in blocks:
        members = [k for k in keys if k["group"] in groups]
        total += len(members)
        out.append("== %s: %d keys" % (title, len(members)))
        for row in ("F", "1", "2", "3", "4", "5"):
            rk = sorted((k for k in members if k["row"] == row), key=lambda k: k["u"])
            if not rk:
                continue
            out.append("  row %s  s=%.2f  (%d keys)" % (row, row_s(row), len(rk)))
            for k in rk:
                out.append("    %-15s u=%6.2f w=%.2f h=%.0f  x=[%8.2f .. %8.2f] mm  code=%-15s cell=%3d %s"
                           % (k["id"], k["u"], k["w"], k["h"], X0 + k["u"] * PITCH,
                              X0 + (k["u"] + k["w"]) * PITCH, k["code"], k["cell"],
                              ("legend=%r/%r" % (k["legend"], k["legend2"])) if not k["strip"]
                              else "strip=%r" % k["strip"]))
        out.append("")
    out.append("total keys: %d" % total)
    return "\n".join(out)


# ----------------------------------------------------------- outline helpers
def rounded_outline(corners, insets, r_convex, r_concave=None, seg=3, stations=None):
    """Offset a CCW rectilinear polygon inward by a per-edge distance (edge i
    runs corners[i] -> corners[i+1]; negative grows it) and round the corners.
    stations[i] adds points on the straight part of edge i: an int n gives n
    evenly spaced points, a list gives absolute coordinates along the edge.
    Returns (points, tags); a tag is (edge, station index) or None for arc
    points. The point count depends only on seg and stations, so rings built
    from the same polygon can be bridged index to index."""
    n = len(corners)
    if r_concave is None:
        r_concave = r_convex
    lines = []
    for i in range(n):
        p, q = Vector(corners[i]), Vector(corners[(i + 1) % n])
        d = (q - p).normalized()
        lines.append((p + Vector((-d.y, d.x)) * insets[i], d))
    pts = []
    for i in range(n):
        p0, d0 = lines[i - 1]
        p1, d1 = lines[i]
        pts.append(Vector((p1.x, p0.y)) if abs(d0.x) > 0.5 else Vector((p0.x, p1.y)))
    arcs = []
    for i in range(n):
        d_in, d_out = lines[i - 1][1], lines[i][1]
        convex = d_in.x * d_out.y - d_in.y * d_out.x > 0
        len_in = (pts[i] - pts[i - 1]).length
        len_out = (pts[(i + 1) % n] - pts[i]).length
        r = max(min(r_convex if convex else r_concave, 0.5 * len_in - 0.01, 0.5 * len_out - 0.01), 0.02)
        a = pts[i] - d_in * r
        nrm = Vector((-d_in.y, d_in.x)) if convex else Vector((d_in.y, -d_in.x))
        c = a + nrm * r
        a0 = math.atan2(a.y - c.y, a.x - c.x)
        sweep = math.pi / 2 if convex else -math.pi / 2
        arcs.append([c + Vector((math.cos(a0 + sweep * t / seg), math.sin(a0 + sweep * t / seg))) * r
                     for t in range(seg + 1)])
    out, tags = [], []
    for i in range(n):
        out.extend(arcs[i])
        tags.extend([None] * (seg + 1))
        st = stations[i] if stations else 0
        b, a_next = arcs[i][-1], arcs[(i + 1) % n][0]
        d = lines[i][1]
        if isinstance(st, int):
            for k in range(st):
                out.append(b.lerp(a_next, (k + 1) / (st + 1)))
                tags.append((i, k))
        else:
            horizontal = abs(d.x) > 0.5
            vals = sorted(st, reverse=(d.x < 0) if horizontal else (d.y < 0))
            for k, val in enumerate(vals):
                out.append(Vector((val, b.y)) if horizontal else Vector((b.x, val)))
                tags.append((i, k))
    return out, tags


def union_outline(rects):
    """Outline (CCW corner list) of a union of axis-aligned rectangles
    (x0, y0, x1, y1) that forms one simple polygon."""
    xs = sorted({round(v, 4) for r in rects for v in (r[0], r[2])})
    ys = sorted({round(v, 4) for r in rects for v in (r[1], r[3])})

    def filled(i, j):
        if i < 0 or j < 0 or i >= len(xs) - 1 or j >= len(ys) - 1:
            return False
        cx, cy = 0.5 * (xs[i] + xs[i + 1]), 0.5 * (ys[j] + ys[j + 1])
        return any(r[0] < cx < r[2] and r[1] < cy < r[3] for r in rects)

    nxt = {}
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            if not filled(i, j):
                continue
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            if not filled(i, j - 1):
                nxt[(x0, y0)] = (x1, y0)
            if not filled(i + 1, j):
                nxt[(x1, y0)] = (x1, y1)
            if not filled(i, j + 1):
                nxt[(x1, y1)] = (x0, y1)
            if not filled(i - 1, j):
                nxt[(x0, y1)] = (x0, y0)
    start = min(nxt)
    loop, p = [start], nxt[start]
    while p != start:
        loop.append(p)
        p = nxt[p]
    assert len(loop) == len(nxt), "union is not a single simple polygon"
    out = []
    for i, p in enumerate(loop):
        a, b = loop[i - 1], loop[(i + 1) % len(loop)]
        if abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-9:
            out.append(p)
    return out


def bridge(bm, lower, upper, mat=0):
    """Quads between two rings of equal length. For CCW rings, lower -> upper
    faces outward when going up, and inward when 'upper' is in fact below."""
    n = len(lower)
    for i in range(n):
        j = (i + 1) % n
        f = bm.faces.new((lower[i], lower[j], upper[j], upper[i]))
        f.material_index = mat


def fill_polygons(bm, loops, mat=0, flip=False):
    """Triangulate a planar region given as an outer loop plus hole loops of
    BMVerts (judged in the XY plane); faces point +Z (-Z with flip)."""
    verts = [v for loop in loops for v in loop]
    tris = tessellate_polygon([[Vector((v.co.x, v.co.y, 0.0)) for v in loop] for loop in loops])
    for a, b, c in tris:
        va, vb, vc_ = verts[a], verts[b], verts[c]
        cross = ((vb.co.x - va.co.x) * (vc_.co.y - va.co.y)
                 - (vb.co.y - va.co.y) * (vc_.co.x - va.co.x))
        if abs(cross) < 1e-14:
            continue
        try:
            f = bm.faces.new((va, vb, vc_) if (cross > 0) != flip else (va, vc_, vb))
            f.material_index = mat
        except ValueError:
            pass


def finish_mesh(bm, name, collection, mats, smooth_angle=50.0, weighted=True, vertex_normals=None):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    obj = vc.new_object(name, me, collection)
    for m in mats:
        me.materials.append(m)
    if vertex_normals is not None:
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices(vertex_normals)
        return obj
    vc.smooth(obj, smooth_angle)
    if weighted:
        mod = obj.modifiers.new("wn", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
        mod.weight = 50
        mod.mode = "FACE_AREA"
    return obj


# ----------------------------------------------------------------- materials
def _nodes(mat):
    nt = mat.node_tree
    return nt, nt.nodes["Principled BSDF"]


def _mix(nt, fac, a, b):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    if fac is not None:
        nt.links.new(fac, n.inputs[0])
    for idx, val in ((6, a), (7, b)):
        if isinstance(val, tuple):
            n.inputs[idx].default_value = (*val, 1.0)
        else:
            nt.links.new(val, n.inputs[idx])
    return n.outputs[2]


def _noise(nt, scale, detail=2.0, lo=0.35, hi=0.65):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = detail
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = lo
    mr.inputs["From Max"].default_value = hi
    nt.links.new(nz.outputs[0], mr.inputs["Value"])
    return mr.outputs[0]


def _materials():
    mats = {}

    def get(name, color, rough):
        existing = bpy.data.materials.get(name)
        m = vc.material(name, vc.srgb(color), roughness=rough)
        return m, existing is None

    # case: cream ABS that has yellowed unevenly (it yellows more than the caps)
    # (same family as the terminal's ABS_Collar: #DDD8C6 clean, #D3C496 yellowed)
    m, fresh = get("KbdCase", "#D9D0B4", 0.5)
    if fresh:
        nt, bsdf = _nodes(m)
        col = _mix(nt, _noise(nt, 7.0), vc.srgb("#DCD6C0"), vc.srgb("#D4C8A2"))
        # a fine speckle that only nudges the colour
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = 0.14
        nt.links.new(_noise(nt, 90.0, 3.0, 0.2, 0.8), mul.inputs[0])
        col = _mix(nt, mul.outputs[0], col, vc.srgb("#CEC4A2"))
        nt.links.new(col, bsdf.inputs["Base Color"])
    mats["case"] = m

    m, _ = get("KbdWellFloor", "#6A6457", 0.8)
    mats["floor"] = m

    for key, name, base, warm in (("cream", "KeyCream", "#E3DECB", "#DCD3B6"),
                                  ("taupe", "KeyTaupe", "#A2998A", "#9A8F7A")):
        m, fresh = get(name, base, 0.42)
        if fresh:
            nt, bsdf = _nodes(m)
            col = _mix(nt, _noise(nt, 25.0, 2.0, 0.3, 0.7), vc.srgb(base), vc.srgb(warm))
            info = nt.nodes.new("ShaderNodeObjectInfo")
            mr = nt.nodes.new("ShaderNodeMapRange")
            mr.inputs["To Min"].default_value = 0.955
            mr.inputs["To Max"].default_value = 1.03
            nt.links.new(info.outputs["Random"], mr.inputs["Value"])
            hsv = nt.nodes.new("ShaderNodeHueSaturation")
            nt.links.new(mr.outputs[0], hsv.inputs["Value"])
            nt.links.new(col, hsv.inputs["Color"])
            nt.links.new(hsv.outputs["Color"], bsdf.inputs["Base Color"])
        mats[key] = m

    # legend strip: grey paper with a red rule along its lower edge (UV driven)
    m, fresh = get("KbdLegendStrip", "#B4B2AB", 0.6)
    if fresh:
        nt, bsdf = _nodes(m)
        # named layer: must not follow the render-active layer, which the
        # assembly may switch to "Lightmap"
        tc = nt.nodes.new("ShaderNodeUVMap")
        tc.uv_map = "UVMap"
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(tc.outputs["UV"], sep.inputs[0])
        lt = nt.nodes.new("ShaderNodeMath")
        lt.operation = "LESS_THAN"
        lt.inputs[1].default_value = STRIP_RULE
        nt.links.new(sep.outputs["Y"], lt.inputs[0])
        col = _mix(nt, lt.outputs[0], vc.srgb("#B4B2AB"), vc.srgb("#B23A3C"))
        nt.links.new(col, bsdf.inputs["Base Color"])
    mats["strip"] = m

    m, _ = get("KbdStripWindow", "#D9D3BE", 0.42)
    mats["window"] = m
    # grey paper seen through the clear holder
    m, _ = get("KbdStripWindowField", "#C9C6BA", 0.3)
    mats["window_field"] = m
    m, _ = get("KbdLED", "#33523A", 0.15)
    mats["led"] = m
    m, _ = get("KbdRubber", "#161616", 0.85)
    mats["rubber"] = m
    return mats


# ---------------------------------------------------------------------- case
def _build_case(collection, mats, keys):
    bm = bmesh.new()
    hw = CASE_W / 2
    rect = [(-hw, 0.0), (hw, 0.0), (hw, CASE_D), (-hw, CASE_D)]
    notch = [NOTCH_Y[0], NOTCH_Y[0] + 0.3, NOTCH_Y[1] - 0.3, NOTCH_Y[1]]
    stations = [0, notch, 0, notch]
    rc = 6.5

    def ring(ins_f, ins_r, ins_s, zspec, lower=False):
        pts, tags = rounded_outline(rect, [ins_f, ins_s, ins_r, ins_s],
                                    max(rc - ins_s, 1.2), seg=5, stations=stations)
        verts = []
        for p, tag in zip(pts, tags):
            x, y = p.x, p.y
            if lower and tag and tag[1] in (1, 2):
                x += -NOTCH_DEPTH if tag[0] == 1 else NOTCH_DEPTH
            z = zspec[1] if zspec[0] == "abs" else top_z(y) - zspec[1]
            verts.append(bm.verts.new((x * MM, y * MM, z * MM)))
        return verts

    zs = Z_SEAM
    rings = [
        ring(4.6, 3.0, 3.0, ("abs", Z_BOTTOM), True),
        ring(2.6, 1.6, 1.6, ("abs", Z_BOTTOM + 0.5), True),
        ring(1.3, 0.8, 0.8, ("abs", Z_BOTTOM + 1.5), True),
        ring(0.7, 0.5, 0.5, ("abs", Z_BOTTOM + 3.0), True),
        ring(0.5, 0.5, 0.5, ("abs", zs - 0.8), True),
        ring(0.8, 0.8, 0.8, ("abs", zs - 0.5), True),
        ring(1.9, 1.9, 1.9, ("abs", zs - 0.5)),
        ring(1.9, 1.9, 1.9, ("abs", zs + 0.5)),
        ring(0.3, 0.3, 0.3, ("abs", zs + 0.5)),
        ring(0.0, 0.0, 0.0, ("abs", zs + 0.8)),
    ]
    bf, br, bs, bv, rake = 5.5, 2.5, 2.5, 3.5, 1.5
    for k in range(5):
        phi = math.radians(90.0 - 22.5 * k)
        t = 1.0 - math.sin(phi)
        rings.append(ring(bf * t, rake + br * t, bs * t, ("top", bv * (1.0 - math.cos(phi)))))
    for a, b in zip(rings, rings[1:]):
        bridge(bm, a, b)
    top_ring = rings[-1]

    # wells
    groups = {}
    for k in keys:
        xs = [p[0] for p in k["poly"]]
        ss = [p[1] for p in k["poly"]]
        if len(k["poly"]) == 4:
            rects = [(min(xs), min(ss), max(xs), max(ss))]
        else:   # Return: upper and lower rectangles
            p = k["poly"]
            rects = [(p[3][0], p[4][1], p[2][0], p[2][1]), (p[0][0], p[0][1], p[1][0], p[5][1])]
        groups.setdefault(k["group"], []).extend(rects)
    m = WELL_MARGIN
    holes = []

    def recess(poly, rim_w, radius, depth, draft, floor_mat):
        n = len(poly)

        def wring(grow, drop):
            pts, _ = rounded_outline(poly, [-grow] * n, max(radius + grow, 0.3),
                                     max(radius - grow, 0.3), seg=2)
            out = []
            for p in pts:
                y = p.y * COS_A
                out.append(bm.verts.new((p.x * MM, y * MM, (top_z(y) - drop) * MM)))
            return out

        rim = wring(rim_w, 0.0)
        mid = wring(rim_w * 0.293, rim_w * 0.293)
        wall = wring(0.0, rim_w)
        floor = wring(-draft, depth)
        bridge(bm, rim, mid)
        bridge(bm, mid, wall)
        bridge(bm, wall, floor)
        fill_polygons(bm, [floor], mat=floor_mat)
        holes.append(rim)

    for name, rects in groups.items():
        poly = union_outline([(r[0] - m, r[1] - m, r[2] + m, r[3] + m) for r in rects])
        recess(poly, WELL_RIM, WELL_R, WELL_DEPTH, WELL_DRAFT, 1)
    # shallow pocket that the legend strip and its window sit in
    x0, x1, s0, s1 = POCKET
    recess([(x0, s0), (x1, s0), (x1, s1), (x0, s1)], POCKET_RIM, 1.3, POCKET_DEPTH, 0.0, 0)
    fill_polygons(bm, [top_ring] + holes)
    # underside, so nothing shows through the slit above the desk
    fill_polygons(bm, [rings[0]], flip=True)

    obj = finish_mesh(bm, "Keyboard", collection, [mats["case"], mats["floor"]])
    return obj


def _plate(name, collection, mat, x0, x1, s0, s1, h0, h1, radius, bevel, uv01=False, seg=2,
           frame=None, field_mat=None):
    """Thin bevelled plate lying on the top plane. frame = (front/rear rim
    width, end rim width, drop): a raised rim around a sunken field, which
    takes the second material."""
    bm = bmesh.new()
    rect = [(x0, s0), (x1, s0), (x1, s1), (x0, s1)]
    rings = []
    spec = [([0.0] * 4, h0, radius), ([0.0] * 4, h1 - bevel, radius),
            ([bevel * 0.293] * 4, h1 - bevel * 0.293, radius - bevel * 0.2),
            ([bevel] * 4, h1, max(radius - bevel * 0.6, 0.05))]
    if frame:
        rim, end, drop = frame
        r_in = 0.6
        for extra, h in ((0.0, h1), (0.1, h1 - 0.1), (0.3, h1 - drop)):
            spec.append(([bevel + rim + extra, bevel + end + extra] * 2, h, r_in + 0.3 - extra))
    for ins, h, r in spec:
        pts, _ = rounded_outline(rect, ins, r, seg=seg)
        rings.append([bm.verts.new(plane_pt(p.x, p.y, h)) for p in pts])
    for a, b in zip(rings, rings[1:]):
        bridge(bm, a, b)
    top = bm.faces.new(rings[-1])
    if frame:
        top.material_index = 1
    if uv01:
        uv = bm.loops.layers.uv.new("UVMap")
        for f in bm.faces:
            for loop in f.loops:
                co = loop.vert.co
                u = (co.x / MM - x0) / (x1 - x0)
                s = (co.y / MM) / COS_A   # close enough for a thin plate
                v = (s - s0) / (s1 - s0)
                loop[uv].uv = (min(max(u, 0.0), 1.0), min(max(v, 0.0), 1.0))
    return finish_mesh(bm, name, collection, [mat, field_mat] if field_mat else [mat],
                       smooth_angle=35.0 if frame else 50.0)


def _build_feet(collection, mats):
    bm = bmesh.new()

    def box(x0, x1, y0, y1, z0, z1):
        res = bmesh.ops.create_cube(bm, size=1.0)
        for v in res["verts"]:
            v.co.x = (x0 + (v.co.x + 0.5) * (x1 - x0)) * MM
            v.co.y = (y0 + (v.co.y + 0.5) * (y1 - y0)) * MM
            v.co.z = (z0 + (v.co.z + 0.5) * (z1 - z0)) * MM

    hw = CASE_W / 2
    box(-hw + 20, -hw + 80, 10, 16, 0.0, Z_BOTTOM + 0.3)
    box(hw - 80, hw - 20, 10, 16, 0.0, Z_BOTTOM + 0.3)
    box(-135, 135, CASE_D - 16, CASE_D - 10, 0.0, Z_BOTTOM + 0.3)
    for sx in (-1, 1):
        res = bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=8.0 * MM,
                                    radius2=8.0 * MM, depth=(Z_BOTTOM + 0.3) * MM)
        for v in res["verts"]:
            v.co.x += sx * (hw - 37) * MM
            v.co.y += (CASE_D - 26) * MM
            v.co.z += 0.5 * (Z_BOTTOM + 0.3) * MM
    return finish_mesh(bm, "Kbd_Feet", collection, [mats["rubber"]], 40.0, weighted=False)


# ---------------------------------------------------------------------- keys
def _build_key(k, collection, mats):
    poly = k["poly"]
    xs = [p[0] for p in poly]
    ss = [p[1] for p in poly]
    cx, cs = 0.5 * (min(xs) + max(xs)), 0.5 * (min(ss) + max(ss))
    local = [(p[0] - cx, p[1] - cs) for p in poly]
    n = len(local)
    convex = k["id"] == "Space"
    height, tilt = k["prof"]
    tan_t = math.tan(math.radians(tilt))

    front, rear, side, edge_r = 2.45, 1.1, 2.0, 0.9
    kinds, lengths = [], []
    for i in range(n):
        a, b = local[i], local[(i + 1) % n]
        dx, dy = b[0] - a[0], b[1] - a[1]
        kinds.append("front" if dx > 0.5 else "rear" if dx < -0.5 else "side")
        lengths.append(abs(dx) + abs(dy))
    taper = {"front": front, "rear": rear, "side": side}
    top_ins = [KEY_GAP + taper[kd] for kd in kinds]
    base_ins = [KEY_GAP] * n

    # stations along the edges the dish curves across
    stations = [0] * n
    if convex:
        for i in range(n):
            if kinds[i] == "side":
                stations[i] = 3
    else:
        longest = max(lengths[i] for i in range(n) if kinds[i] != "side")
        for i in range(n):
            if kinds[i] != "side" and lengths[i] > longest - 0.01:
                straight = lengths[i] - 2 * (KEY_GAP + side) - 2 * 1.7
                stations[i] = min(max(int(round(straight / 2.8)) - 1, 0), 6)

    half_w = 0.5 * (max(xs) - min(xs)) - KEY_GAP - side
    half_d = 0.5 * (max(ss) - min(ss)) - KEY_GAP - 0.5 * (front + rear)
    y_mid = 0.5 * (front - rear)     # centre of the top face, in local y

    # an L-shaped cap (Return): the dish follows the leg it is on, blending
    # across the step, instead of sitting on the bounding-box centre
    leg = None
    if n == 6:
        front_edges = [i for i in range(n) if kinds[i] == "front"]
        i0 = min(front_edges, key=lambda i: local[i][1])
        lx0, lx1 = sorted((local[i0][0], local[(i0 + 1) % n][0]))
        y_step = max(local[i][1] for i in front_edges)
        leg = (0.5 * (lx0 + lx1), 0.5 * (lx1 - lx0) - KEY_GAP - side, y_step)

    def dish(x, y):
        """(offset from the dish axis, half width) at a point of the top."""
        if leg is None:
            return x, half_w
        f = min(max((y - leg[2] + 2.0) / 4.0, 0.0), 1.0)
        return x - leg[0] * (1.0 - f), leg[1] + (half_w - leg[1]) * f

    def ztop(x, y):
        z = height + y * tan_t
        if convex:
            t = min(abs(y - y_mid) / half_d, 1.0)
            return z + 0.9 * (1.0 - t * t) - 0.9
        dx, hw_ = dish(x, y)
        t = min(abs(dx) / hw_, 1.0)
        return z - 0.55 * (1.0 - t * t)

    top_pts, top_tags = rounded_outline(local, top_ins, 1.7, seg=3, stations=stations)
    top_z_list = [ztop(p.x, p.y) for p in top_pts]

    bm = bmesh.new()
    rings = []
    pts, _ = rounded_outline(local, base_ins, 1.0, seg=3, stations=stations)
    rings.append([bm.verts.new((p.x, p.y, CAP_BOTTOM)) for p in pts])
    for out, drop, r in ((edge_r, edge_r, 2.5), (edge_r * 0.707, edge_r * 0.293, 2.3)):
        pts, _ = rounded_outline(local, [v - out for v in top_ins], r, seg=3, stations=stations)
        rings.append([bm.verts.new((p.x, p.y, z - drop)) for p, z in zip(pts, top_z_list)])
    rings.append([bm.verts.new((p.x, p.y, z)) for p, z in zip(top_pts, top_z_list)])
    for a, b in zip(rings, rings[1:]):
        bridge(bm, a, b)
    top_face = bm.faces.new(rings[-1])
    top_face.material_index = 1

    # cut the top into strips so the dish is a real curve, not a flat fan
    cuts = sorted({round(p.y if convex else p.x, 3) for p, t in zip(top_pts, top_tags) if t})
    for c in cuts:
        faces = [f for f in bm.faces if f.material_index == 1]
        geom = set(faces)
        for f in faces:
            geom.update(f.edges)
            geom.update(f.verts)
        bmesh.ops.bisect_plane(bm, geom=list(geom), dist=1e-5,
                               plane_co=(0, c, 0) if convex else (c, 0, 0),
                               plane_no=(0, 1, 0) if convex else (1, 0, 0))
    for f in bm.faces:
        if f.material_index == 1:
            for v in f.verts:
                v.co.z = ztop(v.co.x, v.co.y)

    # legend atlas UVs
    uv = bm.loops.layers.uv.new("UVMap")
    col, row = k["cell"] % 16, k["cell"] // 16
    bx0, bx1 = min(p.x for p in top_pts), max(p.x for p in top_pts)
    by0, by1 = min(p.y for p in top_pts), max(p.y for p in top_pts)
    blank = ((col + 0.9) / 16.0, 1.0 - (row + 0.9) / 8.0)
    for f in bm.faces:
        is_top = f.material_index == 1
        for loop in f.loops:
            if is_top:
                fx = min(max((loop.vert.co.x - bx0) / (bx1 - bx0), 0.0), 1.0)
                fy = min(max((by1 - loop.vert.co.y) / (by1 - by0), 0.0), 1.0)
                loop[uv].uv = ((col + 0.06 + 0.88 * fx) / 16.0,
                               1.0 - (row + 0.06 + 0.88 * fy) / 8.0)
            else:
                loop[uv].uv = blank
        f.material_index = 0

    # shading normals: flat sides, the true dish normal on top, and the edge
    # round carrying the whole turn between them
    def top_normal(x, y):
        if convex:
            t = (y - y_mid) / half_d
            return Vector((0.0, -(tan_t - (1.8 * t / half_d if abs(t) < 1.0 else 0.0)), 1.0)).normalized()
        dx, hw_ = dish(x, y)
        t = dx / hw_
        return Vector((-(1.1 * t / hw_ if abs(t) < 1.0 else 0.0), -tan_t, 1.0)).normalized()

    normals = {}
    cnt = len(rings[0])
    for i in range(cnt):
        tangent = rings[1][(i + 1) % cnt].co - rings[1][i - 1].co
        side_n = tangent.cross(rings[1][i].co - rings[0][i].co).normalized()
        normals[rings[0][i]] = side_n
        normals[rings[1][i]] = side_n
        tn = top_normal(rings[3][i].co.x, rings[3][i].co.y)
        normals[rings[2][i]] = (side_n + tn).normalized()
    for v in bm.verts:
        if v not in normals:
            normals[v] = top_normal(v.co.x, v.co.y)
    for v in rings[3]:
        normals[v] = top_normal(v.co.x, v.co.y)

    # into the keyboard frame: lean with the top plane, then metres
    vnormals = []
    for v in bm.verts:
        y, z = v.co.y, v.co.z
        v.co = Vector((v.co.x, y * COS_A - z * SIN_A, y * SIN_A + z * COS_A)) * MM
        nv = normals[v]
        vnormals.append((nv.x, nv.y * COS_A - nv.z * SIN_A, nv.y * SIN_A + nv.z * COS_A))

    obj = finish_mesh(bm, "Key_" + k["id"], collection, [mats[k["tone"]]], vertex_normals=vnormals)
    obj.location = plane_pt(cx, cs)
    obj["code"] = k["code"]
    obj["legend"] = k["legend"]
    obj["legend2"] = k["legend2"]
    obj["cell"] = k["cell"]
    obj["w"] = float(k["w"])
    obj["h"] = float(k["h"])
    obj["tone"] = k["tone"]
    obj["travel"] = 0.0035
    # the rectangle of the cap top that the atlas cell (inset 6%) is mapped
    # onto, in metres: draw the legend with this aspect, not w:h
    obj["top_w"] = (bx1 - bx0) * MM
    obj["top_h"] = (by1 - by0) * MM
    obj["stack"] = k["stack"]
    if k["strip"]:
        obj["strip"] = k["strip"]
        obj["strip_u"] = (cx - STRIP_X0) / (STRIP_X1 - STRIP_X0)
    return obj


# --------------------------------------------------------------------- build
def _bake_modifiers(obj):
    """Apply the modifier stack without bpy.ops, so it also works when the
    collection is not linked to the scene or is excluded from the view layer
    (the object is linked to the scene only for the evaluation)."""
    scene = bpy.context.scene
    temp = obj.name not in bpy.context.view_layer.objects
    if temp:
        scene.collection.objects.link(obj)
    try:
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True,
                                             depsgraph=dg)
    finally:
        if temp:
            scene.collection.objects.unlink(obj)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    bpy.data.meshes.remove(old)
    me.name = obj.name


def build(collection):
    mats = _materials()
    keys = _layout()

    kb = _build_case(collection, mats, keys)
    parts = [_build_feet(collection, mats)]

    strip = _plate("LegendStrip", collection, mats["strip"], STRIP_X0, STRIP_X1,
                   STRIP_S0, STRIP_S1, -POCKET_DEPTH, STRIP_H, 0.5, 0.2, uv01=True)
    strip["x0"] = STRIP_X0 * MM
    strip["x1"] = STRIP_X1 * MM
    window = _plate("Kbd_StripWindow", collection, mats["window"], STRIP_X0, STRIP_X1,
                    STRIP_S1 + 0.3, WINDOW_S1, -POCKET_DEPTH, WINDOW_H, 1.0, 0.35,
                    frame=(1.2, 5.0, 0.4), field_mat=mats["window_field"])
    parts.append(window)

    leds = []
    for i, name in enumerate(("Hold", "Lock", "Compose", "Wait")):
        x = X0 + (17.15 + 0.92 * i) * PITCH
        s = STRIP_S0 + 3.1
        led = _plate("Kbd_LED_" + name, collection, mats["led"], x - 2.3, x + 2.3,
                     s - 0.85, s + 0.85, STRIP_H - 0.2, STRIP_H + 0.4, 0.6, 0.3)
        leds.append(led)

    key_objs = [_build_key(k, collection, mats) for k in keys]

    for obj in parts + [strip] + leds + key_objs:
        obj.parent = kb
    for obj in [kb] + parts + [strip] + leds + key_objs:
        if obj.modifiers:
            _bake_modifiers(obj)

    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in [kb] + parts + [strip] + leds + key_objs:
        for v in obj.data.vertices:
            p = obj.location + v.co
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])

    notch_y = 0.5 * (NOTCH_Y[0] + NOTCH_Y[1]) * MM
    notch_z = 0.5 * (Z_BOTTOM + Z_SEAM) * MM
    return {
        "Keyboard": kb,
        "keys": key_objs,
        "LegendStrip": strip,
        "leds": leds,
        "parts": parts,
        "cable_notch": {"left": Vector((-CASE_W / 2 * MM, notch_y, notch_z)),
                        "right": Vector((CASE_W / 2 * MM, notch_y, notch_z))},
        "bounds": (lo, hi),
        "layout": layout_text(keys),
    }


# ------------------------------------------------------------------- preview
def _tri_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def _uv_check_image():
    import numpy as np
    w, h, c = 2048, 1024, 128
    img = np.ones((h, w, 4), dtype=np.float32)
    img[..., 0:3] = (0.85, 0.82, 0.72)
    for row in range(8):
        for col in range(16):
            y0, x0 = row * c, col * c
            img[y0:y0 + c, x0:x0 + 4, 0:3] = (1, 0, 1)          # cell border: must never show
            img[y0:y0 + c, x0 + c - 4:x0 + c, 0:3] = (1, 0, 1)
            img[y0:y0 + 4, x0:x0 + c, 0:3] = (1, 0, 1)
            img[y0 + c - 4:y0 + c, x0:x0 + c, 0:3] = (1, 0, 1)
            img[y0 + 8:y0 + 44, x0 + 8:x0 + 44, 0:3] = (0.05, 0.05, 0.05)   # top-left mark
            img[y0 + 8:y0 + 20, x0 + 44:x0 + 100, 0:3] = (0.8, 0.1, 0.1)    # bar along the top
            # cell index as a row of dots along the bottom half (binary, msb left)
            idx = col + 16 * row
            for bit in range(7):
                if idx >> (6 - bit) & 1:
                    img[y0 + 70:y0 + 84, x0 + 12 + bit * 14:x0 + 22 + bit * 14, 0:3] = (0.1, 0.2, 0.8)
    image = bpy.data.images.new("uvcheck", w, h, alpha=False)
    image.pixels.foreach_set(img[::-1].ravel())
    return image


def main():
    args = vc.script_args()
    scene = vc.reset_scene()
    col = bpy.data.collections.new("Keyboard")
    if "--detached" in args:      # test: build() must not need the view layer
        result = build(col)
        scene.collection.children.link(col)
    else:
        scene.collection.children.link(col)
        result = build(col)

    print(result["layout"])
    total = 0
    counts = []
    for obj in [result["Keyboard"]] + result["parts"] + [result["LegendStrip"]] + result["leds"]:
        counts.append((obj.name, _tri_count(obj)))
    key_counts = [(o.name, _tri_count(o)) for o in result["keys"]]
    total = sum(c for _, c in counts) + sum(c for _, c in key_counts)
    lines = ["%-20s %6d" % c for c in counts]
    lines.append("keys: %d objects, %d triangles (min %d, max %d)" % (
        len(key_counts), sum(c for _, c in key_counts), min(c for _, c in key_counts),
        max(c for _, c in key_counts)))
    lines.extend("  %-20s %5d" % c for c in key_counts)
    lines.append("TOTAL %d triangles" % total)
    lines.append("bounds %s .. %s" % (tuple(round(v, 4) for v in result["bounds"][0]),
                                      tuple(round(v, 4) for v in result["bounds"][1])))
    lines.append("cable notch %s" % {k: tuple(round(c, 4) for c in v)
                                     for k, v in result["cable_notch"].items()})
    print("\n".join(lines))

    if "--preview" not in args:
        return
    out = args[args.index("--preview") + 1]
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "layout.txt"), "w", encoding="utf-8") as fh:
        fh.write(result["layout"] + "\n\n" + "\n".join(lines) + "\n")

    # preview-only desk and light
    me = bpy.data.meshes.new("PreviewDesk")
    me.from_pydata([(-2, -2, 0), (2, -2, 0), (2, 2, 0), (-2, 2, 0)], [], [(0, 1, 2, 3)])
    desk = vc.new_object("PreviewDesk", me, scene.collection,
                         vc.material("PreviewDesk", vc.srgb("#8A8378"), 0.6))
    vc.studio_light(scene)
    # the studio rig is sized for the monitor; this is a low, pale object
    for light in [o for o in scene.objects if o.type == "LIGHT"]:
        light.data.energy *= 0.22
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    views = {
        "kbd_top": ((0.0, 0.085, 1.75), (0.0, 0.0855, 0.0), 105.0),
        "kbd_typist": ((-0.30, -0.42, 0.34), (0.0, 0.07, 0.01), 50.0),
        "kbd_side": ((1.5, 0.085, 0.035), (0.0, 0.085, 0.02), 230.0),
        "kbd_main_left": ((-0.30, -0.10, 0.13), (-0.17, 0.065, 0.02), 55.0),
        "kbd_edit_strip": ((0.10, -0.07, 0.15), (0.135, 0.105, 0.02), 55.0),
        "kbd_rear_corner": ((0.45, 0.33, 0.12), (0.2, 0.15, 0.02), 60.0),
        "kbd_return": ((0.06, -0.06, 0.20), (0.03, 0.085, 0.02), 70.0),
    }
    if "--lmtest" in args:        # test: the red rule must survive a render-active Lightmap layer
        lm = result["LegendStrip"].data.uv_layers.new(name="Lightmap", do_init=False)
        lm.active_render = True
    if only:
        views = {k: v for k, v in views.items() if k in only}
    vc.render_previews(scene, out, views, samples=96)

    if only and "kbd_uvcheck" not in only:
        return
    image = _uv_check_image()
    for name in ("KeyCream", "KeyTaupe"):
        nt = bpy.data.materials[name].node_tree
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    vc.render_previews(scene, out, {"kbd_uvcheck": ((-0.12, 0.02, 0.5), (-0.12, 0.075, 0.0), 80.0)},
                       samples=48)


if __name__ == "__main__":
    main()

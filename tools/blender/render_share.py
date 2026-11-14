"""Turntable frames of the terminal for the link-share preview (og:image).

    blender -b --factory-startup --python tools/blender/render_share.py -- --out <dir> [args]

Builds the terminal, keyboard and cord the same way build_scene.py places
them, lights the screen with the end of the boot as the page prints it,
spins the lot through one full turn on a dark backdrop and writes one PNG
per frame (share_0001.png ...) plus share_still.png, a larger render of the
first frame. tools/share/make.mjs turns those into the files the page links.

Frame 1 is the three-quarter front view, so it is also what the platforms
that only show a GIF's first frame (or the still) display.

| Flag | Meaning |
|---|---|
| `--out DIR` | Where the PNGs go (required). |
| `--frames N` | Frames in one turn (default 60). |
| `--size WxH` | Frame size (default 1200x630, the og:image shape). |
| `--samples N` | Cycles samples per frame (default 96). |
| `--still-only` | Render share_still.png only. |
| `--frame-range A-B` | Render only these frames (1-based), to split a run. |
"""
import json
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vt_common as vc      # noqa: E402
import vt_terminal          # noqa: E402
import vt_keyboard          # noqa: E402
import build_scene as bs    # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))

# Backdrop colour (sRGB). make.mjs lays the frames over the same colour.
BACKDROP = "#0B0D0C"

# The picture: 80 x 25 cells of the 9 x 14 character ROM the page draws with.
COLS, ROWS = 80, 25
SCREEN = [
    "  System load:  0.08               Processes:             112",
    "  Usage of /:   41.7% of 38.6GB   Users logged in:       1",
    "  Memory usage: 23%                IPv4 address for eth0: 10.0.0.12",
    "  Swap usage:   0%",
    "",
    "0 updates can be applied immediately.",
    "",
    "Last login: Fri Nov 13 18:42:07 2026 from 203.0.113.7",
    "You have mail.",
    "",
    "root@websvr:~# cd /var/www/dubsector.dev",
    "root@websvr:/var/www/dubsector.dev# ls -a",
    ".  ..  caffeine  github  projects",
    "root@websvr:/var/www/dubsector.dev# █",
]
HEADER = [
    "websvr login: root",
    "Password:",
    "Welcome to Dubuntu 26.04.1 LTS (GNU/Linux 6.14.0-15-generic x86_64)",
    "",
    " * Documentation:  https://help.ubuntu.com",
    " * Management:     https://landscape.canonical.com",
    " * Support:        https://ubuntu.com/pro",
    "",
    "System information as of Fri Nov 13 20:51:33 UTC 2026",
    "",
]
LINES = (HEADER + SCREEN)[-ROWS:]

# Turntable: the camera stays put and the model turns about the middle of
# its footprint. Camera and target are relative to that pivot.
CAM_OFFSET = Vector((-0.86, -1.34, 0.58))
CAM_TARGET = Vector((0.0, 0.0, 0.125))
LENS = 45.0


def arg(args, name, default=None, cast=str):
    return cast(args[args.index(name) + 1]) if name in args else default


def load_font():
    src = open(os.path.join(REPO, "src", "gl", "font9x14.js"), encoding="utf-8").read()
    glyphs = {}
    for m in re.finditer(r'^  ("(?:[^"\\]|\\.)*"): \[(.*?)\]', src, re.S | re.M):
        rows = re.findall(r'"([.#]+)"', m.group(2))
        glyphs[json.loads(m.group(1))] = rows
    return glyphs


def screen_image(out_dir):
    """The picture as a linear-light float image, one texel per dot."""
    glyphs = load_font()
    fw, fh = 9, 14
    img = np.zeros((ROWS * fh, COLS * fw), np.float32)
    for r, line in enumerate(LINES):
        for c, ch in enumerate(line[:COLS]):
            if ch == "█":
                img[r * fh + 1:(r + 1) * fh - 1, c * fw:c * fw + fw - 1] = 1.0
                continue
            rows = glyphs.get(ch) or glyphs.get("?")
            for y, row in enumerate(rows):
                for x, dot in enumerate(row):
                    if dot == "#":
                        img[r * fh + y, c * fw + x] = 1.0
    # Phosphor bloom: a little of each dot's light spreads to its neighbours.
    glow = img.copy()
    for _ in range(2):
        g = glow
        glow = (g + np.roll(g, 1, 0) + np.roll(g, -1, 0) + np.roll(g, 1, 1) + np.roll(g, -1, 1)) / 5.0
    img = np.clip(0.75 * img + 0.45 * glow, 0.0, 1.0)
    h, w = img.shape
    print("SHARE picture %dx%d, %d lit dots" % (w, h, int((img > 0.5).sum())))
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = img[::-1, :, None]          # Blender's rows run bottom up
    # Written out and loaded back: an image made in memory is regenerated
    # (blank) by the renderer.
    path = os.path.join(out_dir, "share_picture.png")
    tmp = bpy.data.images.new("SharePictureTmp", w, h, alpha=False)
    tmp.pixels.foreach_set(rgba.ravel())
    tmp.filepath_raw = path
    tmp.file_format = "PNG"
    tmp.save()
    bpy.data.images.remove(tmp)
    im = bpy.data.images.load(path)
    im.colorspace_settings.name = "Non-Color"
    return im


def _rgba(node, name, out=False):
    """The colour socket of a Mix node (it has float and vector ones of the same name)."""
    socks = node.outputs if out else node.inputs
    return next(s for s in socks if s.name == name and s.type == "RGBA")


def screen_material(tube, image, level=2.6):
    """Glass with the picture glowing behind it, in tube coordinates."""
    mat = bpy.data.materials["GlassProxy"]
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexCoord")
    tc.object = tube
    mp = nt.nodes.new("ShaderNodeMapping")
    hx, hz = bs.PICTURE_HALF
    # tube x, z  ->  u, v over the lit picture (0..1)
    mp.inputs["Location"].default_value = (0.5, 0.5, 0.0)
    mp.inputs["Scale"].default_value = (0.5 / hx, 0.5 / hz, 1.0)
    sw = nt.nodes.new("ShaderNodeSeparateXYZ")
    cm = nt.nodes.new("ShaderNodeCombineXYZ")
    nt.links.new(tc.outputs["Object"], sw.inputs[0])
    nt.links.new(sw.outputs["X"], cm.inputs["X"])
    nt.links.new(sw.outputs["Z"], cm.inputs["Y"])
    nt.links.new(cm.outputs[0], mp.inputs["Vector"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.extension = "CLIP"
    tex.interpolation = "Linear"
    nt.links.new(mp.outputs[0], tex.inputs["Vector"])
    tint = nt.nodes.new("ShaderNodeMix")
    tint.data_type = "RGBA"
    tint.blend_type = "MULTIPLY"
    tint.inputs["Factor"].default_value = 1.0
    nt.links.new(tex.outputs["Color"], _rgba(tint, "A"))
    _rgba(tint, "B").default_value = (*bs.PICTURE_RGB, 1.0)
    # a faint unlit raster glow, so the tube reads as switched on between lines
    add = nt.nodes.new("ShaderNodeMix")
    add.data_type = "RGBA"
    add.blend_type = "ADD"
    add.inputs["Factor"].default_value = 1.0
    nt.links.new(_rgba(tint, "Result", True), _rgba(add, "A"))
    _rgba(add, "B").default_value = (0.002, 0.012, 0.004, 1.0)
    nt.links.new(_rgba(add, "Result", True), bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = level
    return mat


def lights(scene, pivot):
    world = bpy.data.worlds.new("ShareWorld")
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (*vc.srgb(BACKDROP), 1.0)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    for name, loc, power, size, rgb in (
        ("Key", (-0.95, -0.95, 1.25), 70.0, 0.9, (1.0, 0.95, 0.88)),
        ("Fill", (1.25, -0.75, 0.45), 14.0, 1.2, (0.85, 0.92, 1.0)),
        ("Rim", (0.55, 1.15, 0.95), 45.0, 0.7, (1.0, 1.0, 1.0)),
        ("Top", (0.0, 0.1, 1.6), 16.0, 1.4, (1.0, 1.0, 1.0)),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.size = size
        data.color = rgb
        light = bpy.data.objects.new(name, data)
        scene.collection.objects.link(light)
        light.location = pivot + Vector(loc)
        vc.look_at(light, pivot + Vector((0, 0, 0.12)))


def shadow_floor(col, pivot):
    me = bpy.data.meshes.new("ShareFloor")
    r = 3.0
    me.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new("ShareFloor", me)
    col.objects.link(ob)
    ob.location = (pivot.x, pivot.y, -0.0002)
    ob.is_shadow_catcher = True
    return ob


def main():
    args = vc.script_args()
    out = arg(args, "--out")
    if not out:
        raise SystemExit("--out DIR is required")
    os.makedirs(out, exist_ok=True)
    frames = arg(args, "--frames", 60, int)
    w, h = (int(v) for v in arg(args, "--size", "1200x630").split("x"))
    samples = arg(args, "--samples", 96, int)

    scene = vc.reset_scene()
    col = bpy.data.collections.new("Share")
    scene.collection.children.link(col)
    T = vt_terminal.build(col)
    K = vt_keyboard.build(col)
    kb = K["Keyboard"]
    kb.location = bs.KB_LOC
    kb.rotation_euler = (0.0, 0.0, bs.KB_YAW)
    bpy.context.view_layer.update()
    notch = kb.matrix_world @ K["cable_notch"]["right"]
    out_dir_v = (kb.matrix_world.to_3x3() @ Vector((1, 0, 0))).normalized()
    cable, _, _ = bs.build_cable(col, notch, out_dir_v, T["kb_jack"])
    bpy.context.view_layer.update()

    screen_material(T["TubeRef"], screen_image(out))
    led = bpy.data.materials["PowerLED"].node_tree.nodes["Principled BSDF"]
    led.inputs["Emission Strength"].default_value = max(led.inputs["Emission Strength"].default_value, 4.0)

    meshes = [o for o in col.objects if o.type == "MESH"]
    lo = Vector([min((o.matrix_world @ Vector(c))[k] for o in meshes for c in o.bound_box) for k in range(3)])
    hi = Vector([max((o.matrix_world @ Vector(c))[k] for o in meshes for c in o.bound_box) for k in range(3)])
    pivot = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, 0.0))
    print("SHARE bounds", tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi), "pivot", tuple(round(v, 3) for v in pivot))

    spin = bpy.data.objects.new("Spin", None)
    col.objects.link(spin)
    spin.location = pivot
    for o in list(col.objects):
        if o is spin or o.parent is not None:
            continue
        mw = o.matrix_world.copy()
        o.parent = spin
        o.matrix_world = mw
    # one turn, counter-clockwise seen from above, frame frames+1 == frame 1
    spin.rotation_euler = (0, 0, 0)
    spin.keyframe_insert("rotation_euler", index=2, frame=1)
    spin.rotation_euler = (0, 0, 2 * math.pi)
    spin.keyframe_insert("rotation_euler", index=2, frame=frames + 1)
    for fc in spin.animation_data.action.fcurves if hasattr(spin.animation_data.action, "fcurves") else []:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    try:
        for layer in spin.animation_data.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for fc in bag.fcurves:
                        for kp in fc.keyframe_points:
                            kp.interpolation = "LINEAR"
    except AttributeError:
        pass

    shadow_floor(scene.collection, pivot)
    lights(scene, pivot)

    vc.setup_cycles(scene, samples=samples, denoise=True)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -1.1
    scene.render.film_transparent = True
    scene.cycles.film_transparent_glass = False
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    cam = vc.add_camera(scene, pivot + CAM_OFFSET, pivot + CAM_TARGET, LENS)
    cam.data.sensor_width = 36.0
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.clip_start = 0.01

    # The still: frame 1 at twice the size, for the platforms that never animate.
    scene.frame_set(1)
    scene.render.resolution_percentage = 200 if w <= 1200 else 100
    scene.render.filepath = os.path.join(out, "share_still.png")
    bpy.ops.render.render(write_still=True)
    scene.render.resolution_percentage = 100
    if "--still-only" in args:
        return

    a, b = 1, frames
    if "--frame-range" in args:
        a, b = (int(v) for v in arg(args, "--frame-range").split("-"))
    for f in range(a, b + 1):
        path = os.path.join(out, "share_%04d.png" % f)
        if os.path.exists(path) and "--force" not in args:
            continue
        scene.frame_set(f)
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        print("SHARE frame %d/%d" % (f, frames))


if __name__ == "__main__":
    main()

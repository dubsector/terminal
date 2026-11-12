"""Shared helpers for the scene build scripts. Blender 5.2, run headless:

    blender -b --factory-startup --python tools/blender/<script>.py -- [args]

Conventions used by every module here:
  - Units are metres, Z is up, the desk top is the plane z = 0.
  - The viewer sits at -Y looking toward +Y; +X is the viewer's right.
  - Objects that the web page addresses by name carry custom properties
    ("extras" in glTF); see README.md in this folder.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

# One tube unit in the web scene (src/scene.js) is this many metres: the
# 4 x 3 unit glass opening is a 12 inch diagonal.
TUBE_UNIT = 0.06096


def script_args():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    return scene


def setup_cycles(scene, samples=64, denoise=True):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
            found = False
            for d in prefs.devices:
                d.use = d.type == kind
                found = found or d.use
            if found:
                scene.cycles.device = "GPU"
                break
        except Exception:
            continue
    else:
        scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = denoise
    # Renders are judged by eye and baked into textures: no filmic curve.
    scene.view_settings.view_transform = "Standard"


def material(name, color, roughness=0.6, metallic=0.0, emission=None, strength=0.0):
    """Principled material. `color` is linear RGB (3 floats)."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def srgb(hex_string):
    """'#DDD8C6' -> linear RGB tuple."""
    h = hex_string.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def new_object(name, mesh, collection, mat=None):
    mesh.name = name
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    if mat is not None:
        mesh.materials.clear()
        mesh.materials.append(mat)
    return obj


def smooth(obj, angle_deg=30.0):
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(angle_deg))


def apply_modifiers(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    obj.select_set(False)


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_camera(scene, location, target, lens=50.0):
    cam = bpy.data.objects.new("PreviewCam", bpy.data.cameras.new("PreviewCam"))
    scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.location = location
    look_at(cam, target)
    scene.camera = cam
    return cam


def studio_light(scene):
    """Neutral soft light for judging a model on its own."""
    world = bpy.data.worlds.new("Studio")
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.5, 0.5, 0.5, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    scene.world = world
    for name, loc, power, size in (
        ("Key", (-0.9, -1.2, 1.1), 90.0, 0.8),
        ("Fill", (1.2, -0.8, 0.5), 25.0, 1.0),
        ("Rim", (0.4, 1.2, 0.9), 40.0, 0.6),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = power
        data.size = size
        light = bpy.data.objects.new(name, data)
        scene.collection.objects.link(light)
        light.location = loc
        look_at(light, (0, 0, 0.12))


def render_previews(scene, out_dir, views, size=(1280, 960), samples=64):
    """views: {name: (camera_location, target, lens_mm)}. Writes <name>.png."""
    os.makedirs(out_dir, exist_ok=True)
    setup_cycles(scene, samples=samples)
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    cam = add_camera(scene, (0, -1, 0.3), (0, 0, 0))
    for name, (loc, target, lens) in views.items():
        cam.location = loc
        cam.data.lens = lens
        look_at(cam, target)
        scene.render.filepath = os.path.join(out_dir, name + ".png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)

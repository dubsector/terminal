# Scene build scripts

These generate the 3D scene for the `?gl=1` view (terminal, keyboard, desk and
room) with Blender 5.2 running headless. Nothing here ships to the site; the
outputs land in `src/assets/`.

    blender -b --factory-startup --python tools/blender/<script>.py -- [args]

## Conventions

- Metres. Z up. The desk top is the plane z = 0.
- The viewer sits at -Y looking toward +Y; +X is the viewer's right.
- Each `vt_*.py` model module exposes `build(collection) -> dict` and can be
  run on its own with `-- --preview <dir>` to render check images.
- Base colour is not exported as a texture. Lighting is baked "with colour",
  so every surface's colour and wear lives in the baked maps. The first UV
  layer (`UVMap`) is only meaningful on keyboard keys, where it addresses the
  legend atlas the page draws at load. The assembly script adds the second
  layer (`Lightmap`).

## Contract with the web page (`src/gl/model.js`)

Objects are found by name; custom properties become glTF `extras`.

| Object | Meaning |
|---|---|
| `TubeRef` | Empty at the centre of the glass opening. Local +X right, +Z up the face, -Y out of the screen. Scale `TUBE_UNIT` (0.06096), so its local space is the tube space of `src/scene.js`: opening is x ±2.0, z ±1.5; the glass apex is at local y = -0.05. The page moves the whole model so this empty sits at its origin. |
| `PowerButton` | Front push switch. Property `travel` (m) along TubeRef local +Y when pressed in. |
| `PowerLED` | Power lamp lens. The page recolours it; it is not in the baked maps. |
| `Lamp_Switch` | Push switch on the desk lamp's base. Property `travel` (m), straight down (room -Z) when pressed. Baked like any other part (env atlas); every face is kept. |
| `Key_<id>` | One per key. Properties: `code` (KeyboardEvent.code, or `VT_<Name>` for keys with no modern twin), `legend`, `legend2` (shifted/second line, may be empty), `cell` (index into the 16 x 8 legend atlas), `w`, `h` (cap size in key units), `tone` (`cream` or `taupe`), `travel` (m, along the keyboard's local -Z). Also `top_w`, `top_h` (m): the rectangle of the cap top that the atlas cell, inset 6%, is stretched over; draw the legend with the aspect `top_w / top_h`, not `w / h` (1u is 14.15 x 14.6 mm, 2u is 33.2 x 14.6 mm; for the L-shaped Return it is the bounding box). `stack` says what `legend2` is: `"shift"` (shifted glyph, drawn above `legend`), `"line"` (second line of a word legend) or `""`. The 20 function-row keys have an empty `legend` and carry `strip` (the text printed on the legend strip above them) and `strip_u` (0..1 position of the key's centre along `LegendStrip`). Side faces of a cap all use the UV point 90% across, 90% down the cell, which the page must leave blank. |
| `Keyboard` | Keyboard case; parent of every `Key_*`, `LegendStrip`, `Kbd_*`. Rests on z = 0, front edge y = 0, rear y = +0.171 in its own space. |
| `LegendStrip` | Grey label strip above the function row. `UVMap` spans 0..1 (u left to right, v = 0 at the edge nearest the keys in Blender, so v = 1 there after the glTF flip). Properties `x0`, `x1` (m, keyboard local x of its ends). Its grey and red rule are in the baked maps; the page may draw the label text over it. |
| `Kbd_LED_Hold`, `Kbd_LED_Lock`, `Kbd_LED_Compose`, `Kbd_LED_Wait` | The four indicator lenses on the strip. Like `PowerLED`, the page recolours them; treat them as not in the baked maps (material `KbdLED`, dark green when off). |
| `Kbd_StripWindow`, `Kbd_Feet` | Static keyboard parts, baked only. |
| `GlassProxy` | Stand-in for the tube face, used for baking and the reflection render only. Property `role = "proxy"`; never exported. |
| `Cam_*` | Empties marking authored camera positions and targets. |

Anything with `role = "proxy"` is excluded from export.

## Building the assets (`build_scene.py`)

    blender -b --factory-startup --python tools/blender/build_scene.py -- --bake-dir <scratch dir> [--preview <dir>]

One run rebuilds the three modules, places the keyboard and its coiled cable,
bakes the lighting and writes everything below into `src/assets/`. A full run
is 2048 px with 1024 samples for the hero atlas and 4096 for the env atlas
(about 34 minutes on the GPU this was written on; `--skip-bake --no-beauty`
re-encodes and re-exports from the masters in about 2.5 minutes). Flags:

| Flag | Meaning |
|---|---|
| `--samples N` | Bake samples per texel for the hero atlas (default 1024). |
| `--env-samples N` | Same for the env atlas (default 4 x `--samples`; the wall near the lamp is grainy below that). |
| `--reflect-samples N` | Samples of the reflection render (default 512). |
| `--size N` | Atlas size (default 2048). |
| `--skip-bake` | Reuse the EXR masters in `--bake-dir` (only valid while the lightmap layout is unchanged; the script checks). |
| `--no-smooth` | Skip the grain filter on the baked maps. |
| `--preview DIR` | Also render the check images: `beauty_*` (path traced ground truth), `baked_*` (only the shipped maps, as emission; magenta = a back face, i.e. a hole), `noglass_*` (the same with the glass hidden: the opening must be solid blue, which is `ScreenBacking`), `bakedhalf_*` (env atlas at half size), `atlas_*`. |
| `--preview-samples N`, `--no-beauty` | Quality of, or skip, the beauty renders. |
| `--out DIR`, `--bake-dir DIR` | Asset directory (default `src/assets`) and where the EXR masters, `reflect_debug.png` and `report.json` go (default: system temp). |
| `--no-export`, `--blend` | Stop before the glb; save `scene.blend` in the bake dir. |

Quick look: `--samples 32 --size 1024 --no-beauty --preview <dir>` (about 3 minutes).

### Outputs

| File | Content |
|---|---|
| `scene.glb` | Geometry only, one plain material, no images. `EXT_meshopt_compression` (required). Every mesh has `TEXCOORD_0` (`UVMap`, meaningful on keys and `LegendStrip` only) and `TEXCOORD_1` (`Lightmap`). |
| `lm_hero_room.webp`, `lm_hero_lamp.webp`, `lm_hero_screen.webp` | Atlas "hero": terminal, keyboard case, keys, strip, cable. |
| `lm_env_room.webp`, `lm_env_lamp.webp`, `lm_env_screen.webp` | Atlas "env": desk, desk wall, left wall, floor, skirting, props, lamp. |
| `reflect.webp`, `reflect_off.webp` | 512 px view out of the screen, for the glass reflection: desk lamp on, and off. |

Faces no visitor's camera can see (tested from a set of eye positions around
`Cam_Seat`: sideways parallax, pulled back for a portrait phone, raised to
look down at the keys) are removed after baking. Objects left with no faces
are not exported: the rear panel, keyboard feet, right wall, ceiling, back
wall, window, door and the lamp bulb (hidden inside the shade). The left
wall is exported (a low, wide framing from the right catches it).

### Node properties added by the build

| Property | On | Meaning |
|---|---|---|
| `atlas` | every lightmapped mesh | `"hero"` or `"env"`: which pair of maps its `TEXCOORD_1` addresses. |
| `role = "led"` | `PowerLED`, `Kbd_LED_*` | Drawn unlit in a colour the page chooses. No `atlas`; their `TEXCOORD_1` is zero. |
| `role = "emissive"`, `emissive = [r, g, b]` | `Lamp_ShadeGlow`; `Lamp_Bulb` when it is exported | Drawn unlit in that linear display colour (already clamped to 1). `Lamp_ShadeGlow` is the part of the lamp shade's inside next to the bulb, which is brighter than the env map's range; it also carries `emissive_radiance`, the unclamped mean radiance, for a bloom pass, and `emissive_off`, its mean radiance from the room light alone (the colour to draw it with the lamp switched off). No `atlas`; `TEXCOORD_1` is zero. Only eyes below about z = 0.3 m see it. |
| `role = "backing"` | `ScreenBacking` | Opaque cap 2 mm behind the glass surface, a little larger than the opening (x ±2.06, z ±1.56 tube units). `GlassProxy` is not exported and the cabinet is hollow, so without it the opening shows the wall behind the terminal. Draw it unlit black (or leave it out only if the page's own tube mesh is opaque and reaches the collar lip everywhere). No `atlas`; `TEXCOORD_1` is zero. |

### Lightmaps

The three maps of an atlas share the same texels. They hold outgoing radiance
with the surface colour already multiplied in (Cycles diffuse direct +
indirect + colour), stored as 8-bit sRGB of `radiance / range`. "room" is
lit by the window and the dusk sky, "lamp" by the desk lamp alone, "screen"
by the picture alone; light adds, so

    colour = decode(lm_X_room) * room_range_X + decode(lm_X_lamp) * lamp_range_X * L
           + decode(lm_X_screen) * screen_range_X * E

with `L` 1 for the lamp on and 0 for off, where `decode` is the sRGB to linear conversion (`SRGBColorSpace` does it),
`X` is the mesh's `atlas`, and `E` is the linear RGB radiance of the lit
picture averaged over the picture area (phosphor colour x mean picture
level). The screen maps were baked with the picture area (the centre
88% x 84% of the opening) emitting white at radiance 1 and everything else
dark. Load the images with `flipY = false`, `channel = 1`. The result is the
final display-linear colour; nothing else multiplies it except key legends.

In three.js terms, with `MeshBasicMaterial.lightMap` (which multiplies by
`lightMapIntensity / PI`): `lightMapIntensity = Math.PI * room_range_X`, and
the screen map added inside the patched shader as
`texture(screenMap).rgb * E * screen_range_X / room_range_X`.

Each range is the map's brightest texel when that is at most 1.5 x the 99.9th
percentile (nothing clips), otherwise the 99.9th percentile. One exception:
the inside of `Lamp_Shade`, a few centimetres from the bulb and ten times
brighter than anything else, is left out when the ranges are chosen.
Its faces above the range are moved to `Lamp_ShadeGlow` (unlit, see above);
the rim of faces next to them clips (0.16% of that map). Last build: room
0.9445 (hero) and 0.8202 (env), screen 0.1662 (hero) and 0.03019 (env),
reflect 1.0; nothing but the lamp shade clips. Read them from the scene
extras, not from here.

Before encoding, bake grain is removed with a small Gaussian (1 texel sigma
on keys, terminal, keyboard case, cable, lamp; 1.5 on desk body and
skirting; 2.5 on the walls and floor), normalised per object so nothing
bleeds between objects. Surfaces with printed or grained colour (desk top,
nameplate, wall note, props) are not filtered. `--no-smooth` turns it off.

Islands are at least 10 px apart at 2048 and colour is grown 12 px into the
gaps (neighbours meet half way, so each island has 5 px of its own colour
round it). Mip levels 0 to 2 are safe; do not sample smaller mips (clamp the
LOD or use `LinearFilter`).

A half-size (1024) env atlas was tested against the full one in the baked
look: about 0.6 sRGB codes mean difference from the seat, but the desk's wood
grain and the notepad's writing are visibly softer in the look-down and
desk close-ups, so 2048 ships. `lm_env_room_half.webp` and
`lm_env_screen_half.webp` in the bake directory are that variant (same UVs
and ranges) if a low-memory fallback is wanted.

### Scene extras (glTF `scenes[0].extras`)

| Key | Meaning |
|---|---|
| `room_range_hero`, `room_range_env` | Range of the two room maps. |
| `screen_range_hero`, `screen_range_env` | Range of the two screen maps. |
| `lamp_range_hero`, `lamp_range_env` | Range of the two lamp maps. |
| `reflect_range`, `reflect_range_off` | Range of `reflect.webp` and `reflect_off.webp`. |
| `tube_unit` | Metres per tube unit (0.06096), the scale of `TubeRef`. |
| `lightmap_size` | Atlas size in pixels. |
| `picture_scale` | `[0.88, 0.84]`, the lit part of the opening used for the screen bake. |
| `reflect_fov_deg` | 90. |
| `glass_light` | Linear RGB radiance a matt white surface at the glass apex would have (irradiance / pi), integrated over the full hemisphere from a 180 degree fisheye render with the glass hidden. Lights the unlit phosphor. |
| `glass_light_dir` | Luminance-weighted mean direction that light arrives from, TubeRef local axes (x right, z up the face, -y out of the screen). |
| `glass_light_off`, `glass_light_dir_off` | The same two with the desk lamp switched off. |

### Reflection image

`reflect.webp` is a square pinhole render with a 90 degree field of view,
taken from the glass apex (TubeRef local (0, -0.05, 0)) looking along TubeRef
local -Y with local +Z up, room lights on, the glass itself hidden, blurred
with a 2.5 px Gaussian. It stores sRGB8 of `radiance / reflect_range`.

For a reflected ray direction `d = (dx, dy, dz)` in TubeRef local space
(x right, z up the face, -y out of the screen; only `dy < 0` is covered):

    u = 0.5 + 0.5 * dx / dy
    v = 0.5 + 0.5 * dz / dy
    radiance = decode(texture(reflect, vec2(u, v))) * reflect_range

`u` runs left to right across the image and `v` top to bottom, with (0, 0)
the top-left pixel of the file; that is what a three.js texture with
`flipY = false` samples. (With the default `flipY = true`, use `1 - v`.)
Clamp to edge. So +X (the screen's right) is on the image's LEFT, as in a
view out of the screen, and +Z is at the top. The dusk window, which is to
the viewer's left and above, appears right of centre and above the middle.
`reflect_debug.png` in the bake directory is the same image with labelled
corners and axes.

### The same things in glTF / three.js axes

Everything above is in Blender axes (Z up). The exporter converts to glTF's
Y up: `(x, y, z)_gltf = (x, z, -y)_blender`, for node-local axes too. In the
loaded scene:

- `TubeRef` local: +X right, +Y up the face, **+Z out of the screen** (toward
  the viewer). Opening x ±2.0, y ±1.5; glass apex at local z = +0.05.
- Reflection lookup for a reflected direction `d` in TubeRef local space
  (three.js axes), valid for `d.z > 0`:

      u = 0.5 - 0.5 * d.x / d.z
      v = 0.5 - 0.5 * d.y / d.z

  same `u`, `v` as above (origin top-left of the file, `flipY = false`).
  Rays more than 45 degrees off the axis fall outside the image: clamp.
- `Key_*` `travel` is along the `Keyboard` node's local **-Y**.
- `PowerButton` `travel` is along TubeRef local **-Z** (into the cabinet).
- `LegendStrip` `x0`, `x1` are along the `Keyboard` node's local X (unchanged).

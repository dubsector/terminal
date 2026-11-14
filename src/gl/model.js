// The modelled set: terminal, keyboard, desk and room, built and baked in
// Blender by tools/blender/build_scene.py. Everything here is read from the
// files at load - node names and their properties, the ranges the light maps
// were stored with - so a re-bake needs no change on this side.
import {
  Box3,
  BoxGeometry,
  ClampToEdgeWrapping,
  Color,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

// What build.mjs put in dist/assets: `files` maps each asset's name to the
// content-hashed name it is served under, `sizes` lists the atlas sizes the
// light maps come in, smallest first.
/* global __ASSETS__ */
var ASSETS = __ASSETS__;

var ATLASES = ["hero", "env"];
// The light passes baked into each atlas; they add up (see bakedMaterial).
var PASSES = ["room", "lamp", "screen"];
// The six maps take 64 MB each on the GPU at 4096, a quarter of that at
// 2048. A phone or a small machine stops here.
var SMALL_DEVICE_MAP_SIZE = 2048;

// The atlas size to end up with, of those the build has: the largest the
// GPU takes and the device can afford. ?lm=1024 (or any size) caps it, for
// looking at a smaller set on a big machine.
export function pickMapSize(maxTextureSize) {
  var cap = maxTextureSize;
  var asked = /[?&]lm=(\d+)(&|$)/.exec(window.location.search);
  var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (asked) cap = Math.min(cap, +asked[1]);
  else if (coarse || navigator.deviceMemory <= 4) cap = Math.min(cap, SMALL_DEVICE_MAP_SIZE);
  var best = ASSETS.sizes[0];
  ASSETS.sizes.forEach(function (size) {
    if (size <= cap) best = size;
  });
  return best;
}

// Indicator colours. Period LEDs were dim yellow-green GaP parts, not the
// saturated green of the phosphor; unlit, the lens is a dark olive.
var LED_ON = 0xb4d23a;
var LED_OFF = 0x262b10;

// How far an emissive surface's colour is eased from its light's hue toward
// white (see the "emissive" role below).
var EMISSIVE_TOWARD_WHITE = 0.35;

// The power switch is small on a phone, so the area that takes the click is
// this many times the size of the cap.
var BUTTON_COLLIDER_SCALE = 2.6;
// Same for the desk lamp's cord switch, body and rocker together.
var LAMP_SWITCH_COLLIDER_SCALE = 1.25;

// Starts the downloads for a first frame at once: the model, the reflection
// images and the smallest light maps. `promise` resolves with the parsed
// glTF and those textures. `better` follows it with the light maps at
// `mapSize`, fetched once the first set is in so they do not hold it up
// (null when the first set is already that size). dispose() stops whatever
// is still downloading and frees whatever has arrived, for a load that is
// abandoned half way (a visitor on a link slow enough to hit the timeout
// should not go on paying for it).
export function loadModel(base, mapSize) {
  var textures = [];
  var cancelled = false;
  var abort = new AbortController();

  // Say which file it was, and keep what went wrong with it.
  function failed(file) {
    return function (err) {
      var why = err && err.message ? err.message : "";
      throw new Error("could not load " + file + (why ? ": " + why : ""));
    };
  }

  function fetchFile(file, as) {
    if (!ASSETS.files[file]) return Promise.reject(new Error("not in this build"));
    return fetch(base + ASSETS.files[file], { signal: abort.signal }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r[as]();
    });
  }

  // The model goes out gzipped by the build (the CDN compresses scripts but
  // not this), to be unpacked here; a browser that can't gets the plain file.
  function fetchModel() {
    var packed = typeof DecompressionStream === "function" && ASSETS.files["scene.glb.gz"];
    return fetchFile(packed ? "scene.glb.gz" : "scene.glb", "arrayBuffer").then(function (buf) {
      var head = new Uint8Array(buf, 0, 2);
      // Already unpacked on the way here, if something served it as an encoding.
      if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
      return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    });
  }

  function texture(file) {
    return fetchFile(file, "blob")
      .then(function (blob) {
        // Decoded off the main thread, as the image would be drawn: no
        // flip (glTF texture coordinates start at the top-left) and no
        // colour management, since the shader treats it as sRGB itself.
        return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      })
      .then(function (bitmap) {
        var t = new Texture(bitmap);
        t.colorSpace = SRGBColorSpace;
        t.flipY = false;
        // The atlases leave only a few texels between islands, so small mip
        // levels would mix neighbours; none of these are minified much.
        t.generateMipmaps = false;
        t.minFilter = LinearFilter;
        t.magFilter = LinearFilter;
        t.wrapS = t.wrapT = ClampToEdgeWrapping;
        t.needsUpdate = true;
        if (cancelled) t.dispose();
        else textures.push(t);
        return t;
      })
      .catch(failed(file));
  }

  function lightMap(file) {
    return texture(file).then(function (t) {
      // The second UV set addresses the atlas.
      t.channel = 1;
      return t;
    });
  }

  // Every atlas's maps at one size: { hero: { room, lamp, screen }, env: ... }.
  function mapSet(size) {
    var jobs = [];
    ATLASES.forEach(function (name) {
      PASSES.forEach(function (pass) {
        jobs.push(lightMap("lm_" + name + "_" + pass + "_" + size + ".webp"));
      });
    });
    return Promise.all(jobs).then(function (r) {
      var maps = {};
      var k = 0;
      ATLASES.forEach(function (name) {
        maps[name] = {};
        PASSES.forEach(function (pass) {
          maps[name][pass] = r[k++];
        });
      });
      return maps;
    });
  }

  var firstSize = ASSETS.sizes[0];
  var first = Promise.all([
    fetchModel()
      .then(function (buf) {
        return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf, base);
      })
      .catch(failed("scene.glb")),
    texture("reflect.webp"),
    texture("reflect_off.webp"),
    mapSet(firstSize),
  ]).then(function (r) {
    return { gltf: r[0], reflect: r[1], reflectOff: r[2], maps: r[3] };
  });

  return {
    promise: first,
    better: first.then(function () {
      return mapSize > firstSize && !cancelled ? mapSet(mapSize) : null;
    }),
    // Frees a set of maps that has been replaced.
    release: function (maps) {
      ATLASES.forEach(function (name) {
        PASSES.forEach(function (pass) {
          var t = maps[name][pass];
          textures.splice(textures.indexOf(t), 1);
          t.dispose();
          if (t.image && t.image.close) t.image.close();
        });
      });
    },
    dispose: function () {
      cancelled = true;
      abort.abort();
      textures.forEach(function (t) {
        t.dispose();
        if (t.image && t.image.close) t.image.close();
      });
      textures.length = 0;
    },
  };
}

// MeshBasicMaterial's light map (the room's own light), scaled by how far up
// that light is (the ceiling light's start-up, in scene.js), plus two more
// maps on the same texels: the light of the desk lamp, scaled by how
// far on the lamp is, and the light the lit picture throws, scaled by its
// colour and level. Both scales are uniforms shared by every material.
// three multiplies the light map by lightMapIntensity / PI, and the room map
// stores radiance / range, so the intensity is PI * range; the other maps
// have their own ranges, hence the ratios.
function bakedMaterial(maps, ranges, light, legend) {
  var mat = new MeshBasicMaterial({
    lightMap: maps.room,
    lightMapIntensity: Math.PI * ranges.room,
    map: legend || null,
  });
  var screenScale = { value: ranges.screen / ranges.room };
  var lampScale = { value: ranges.lamp / ranges.room };
  var screenMap = { value: maps.screen };
  var lampMap = { value: maps.lamp };
  // The same three maps at another size.
  mat.userData.setMaps = function (next) {
    mat.lightMap = next.room;
    screenMap.value = next.screen;
    lampMap.value = next.lamp;
  };
  mat.onBeforeCompile = function (shader) {
    shader.uniforms.screenLightMap = screenMap;
    shader.uniforms.screenLight = light.screen;
    shader.uniforms.screenScale = screenScale;
    shader.uniforms.lampLightMap = lampMap;
    shader.uniforms.lampLevel = light.lamp;
    shader.uniforms.lampScale = lampScale;
    shader.uniforms.roomLevel = light.room;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <lightmap_pars_fragment>",
        "#include <lightmap_pars_fragment>\nuniform sampler2D screenLightMap;\nuniform vec3 screenLight;\nuniform float screenScale;\nuniform sampler2D lampLightMap;\nuniform float lampLevel;\nuniform float lampScale;\nuniform float roomLevel;"
      )
      .replace(
        "vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );",
        "vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );\n\t\tlightMapTexel.rgb *= roomLevel;\n\t\tlightMapTexel.rgb += texture2D( lampLightMap, vLightMapUv ).rgb * lampLevel * lampScale;\n\t\tlightMapTexel.rgb += texture2D( screenLightMap, vLightMapUv ).rgb * screenLight * screenScale;"
      );
    // three's shader text is not an API. If an upgrade moves the anchor the
    // set would silently lose its glow, so fail loudly instead.
    if (shader.fragmentShader.indexOf("lampLightMap, vLightMapUv") < 0) throw new Error("light map patch did not apply");
  };
  mat.customProgramCacheKey = function () {
    return "screenLight3";
  };
  return mat;
}

// What the room does to the glass, as the bake measured it over the whole
// hemisphere in front of the screen: the radiance a matt white surface in
// the glass's place would have, and the direction most of that light comes
// from. The direction is stored in TubeRef local axes (x right, z up the
// face, -y out of the screen); tube space here has y up and +z out.
function roomLight(extras, suffix) {
  var c = need(extras["glass_light" + suffix], "glass_light" + suffix);
  var d = need(extras["glass_light_dir" + suffix], "glass_light_dir" + suffix);
  return {
    color: new Color(c[0], c[1], c[2]),
    direction: new Vector3(d[0], d[2], -d[1]).normalize(),
  };
}

function need(value, what) {
  if (value === undefined || value === null || (typeof value === "number" && !isFinite(value))) {
    throw new Error("model is missing " + what);
  }
  return value;
}

// Dresses the loaded scene for drawing. `legends` are the two textures drawn
// by legends.js: { keys, strip }.
export function buildModel(loaded, legends) {
  var root = loaded.gltf.scene;
  var extras = root.userData || {};
  var ranges = {};
  ATLASES.forEach(function (name) {
    ranges[name] = {};
    PASSES.forEach(function (pass) {
      ranges[name][pass] = need(extras[pass + "_range_" + name], pass + "_range_" + name);
    });
  });
  var reflectRange = need(extras.reflect_range, "reflect_range");
  var reflectRangeOff = need(extras.reflect_range_off, "reflect_range_off");
  var tanHalfFov = Math.tan((need(extras.reflect_fov_deg, "reflect_fov_deg") * Math.PI) / 360);

  function node(name) {
    return need(root.getObjectByName(name), name);
  }

  // TubeRef's own space is the tube space the face mesh, the shaders and
  // the hit-testing all work in (x right, y up the face, z out of the
  // screen, the opening 4 x 3 units). The set leans back and is authored in
  // metres, so rather than tilt the tube the whole room is moved to bring
  // TubeRef to the origin; the room's vertical ends up tilted instead.
  var tube = node("TubeRef");
  root.updateMatrixWorld(true);
  var modelToTube = new Matrix4().copy(tube.matrixWorld).invert();
  modelToTube.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);

  var up = new Vector3(0, 1, 0).transformDirection(modelToTube);
  var seat = new Vector3().setFromMatrixPosition(node("Cam_Seat").matrixWorld);
  var target = new Vector3().setFromMatrixPosition(node("Cam_Target").matrixWorld);

  var screenLight = { value: new Color(0, 0, 0) };
  // 0 = lamp off, 1 = on.
  var lampLevel = { value: 1 };
  // 0 = the room's own light out, 1 = up in full.
  var roomLevel = { value: 1 };
  var light = { screen: screenLight, lamp: lampLevel, room: roomLevel };
  // Unlit surfaces lit by the lamp (the inside of the shade, the bulb): their
  // colour with the lamp on and off. The "off" colour is the room's light
  // alone, so it dims with the room; the lamp's share comes on top.
  var glows = [];
  var glowLamp = new Color();
  function applyGlows() {
    glows.forEach(function (g) {
      glowLamp.copy(g.on).sub(g.off).multiplyScalar(lampLevel.value);
      g.material.color.copy(g.off).multiplyScalar(roomLevel.value).add(glowLamp);
    });
  }
  var materials = [];
  function keep(mat) {
    materials.push(mat);
    return mat;
  }
  // Every material drawn with an atlas's light maps, and which atlas.
  var baked = [];
  function lit(atlas, legend) {
    var maps = need(loaded.maps[atlas], "light maps for atlas " + atlas);
    var mat = keep(bakedMaterial(maps, ranges[atlas], light, legend));
    baked.push({ material: mat, atlas: atlas });
    return mat;
  }
  var plain = {};
  var keyed = null;
  var strip = null;
  var leds = {};
  var keys = [];
  var meshes = [];
  var keyboard = node("Keyboard");

  root.traverse(function (o) {
    if (!o.isMesh) return;
    var x = o.userData || {};
    // The file's one placeholder material is not used.
    if (o.material && o.material.dispose) o.material.dispose();
    if (x.role === "led") {
      o.material = leds[o.name] = keep(new MeshBasicMaterial({ color: LED_OFF }));
    } else if (x.role === "emissive") {
      // Far brighter than the screen can show, so it is drawn at full
      // brightness - but in the colour of its light (a warm bulb), not as
      // white paper. Its radiance, scaled so the strongest channel is 1,
      // then eased a little toward white the way an overexposed hot spot is.
      var e = x.emissive_radiance || need(x.emissive, "emissive colour of " + o.name);
      var peak = Math.max(e[0], e[1], e[2]) || 1;
      var glow = new Color(e[0] / peak, e[1] / peak, e[2] / peak).lerp(new Color(1, 1, 1), EMISSIVE_TOWARD_WHITE);
      o.material = keep(new MeshBasicMaterial({ color: glow }));
      if (o.name.indexOf("Lamp_") === 0) {
        // With the lamp off it is an ordinary surface again, lit only by the
        // room: the bake's radiance for it, drawn as is.
        var f = x.emissive_off || [0, 0, 0];
        glows.push({ material: o.material, on: glow.clone(), off: new Color(f[0], f[1], f[2]) });
      }
    } else if (x.role === "backing") {
      // The cabinet is hollow. This cap sits just behind the glass and keeps
      // the wall from showing through wherever the face mesh does not reach
      // the lip; the inside of a tube is dark.
      o.material = keep(new MeshBasicMaterial({ color: 0x000000 }));
    } else {
      var atlas = need(x.atlas, "atlas of " + o.name);
      if (x.code !== undefined) {
        // Keys share one extra texture, the legends, on the first UV set.
        keyed = keyed || lit(atlas, legends.keys);
        o.material = keyed;
      } else if (o.name === "LegendStrip") {
        strip = lit(atlas, legends.strip);
        o.material = strip;
      } else {
        plain[atlas] = plain[atlas] || lit(atlas, null);
        o.material = plain[atlas];
      }
      meshes.push(o);
    }
    if (x.code !== undefined) keys.push(o);
  });

  // Power switch: the modelled cap, and a larger unseen box just in front
  // of it that takes the click.
  var button = node("PowerButton");
  var buttonRest = button.position.clone();
  // Pressing moves the cap into the set, along the tube's axis, by a travel
  // given in metres. Expressed in the space the node's position lives in.
  var toParent = new Matrix4().copy(button.parent.matrixWorld).invert();
  var buttonPush = new Vector3(0, 0, -1)
    .applyMatrix4(toParent)
    .sub(new Vector3().applyMatrix4(toParent))
    .multiplyScalar(need(button.userData.travel, "PowerButton travel") / need(extras.tube_unit, "tube_unit"));
  var box = new Box3().setFromObject(button);
  var size = box.getSize(new Vector3());
  var colliderGeo = new BoxGeometry(size.x * BUTTON_COLLIDER_SCALE, size.y * BUTTON_COLLIDER_SCALE, size.z);
  var collider = new Mesh(colliderGeo, keep(new MeshBasicMaterial()));
  box.getCenter(collider.position);
  collider.position.z += size.z;
  collider.visible = false;
  collider.updateMatrixWorld(true);

  var powerLed = need(leds.PowerLED, "PowerLED");

  // Desk lamp switch: the rocker of the switch on its cord. It is modelled
  // level and tips about an axis through its own origin, one way for on and
  // the other for off. The axis is given in Blender's axes; the file's are
  // (x, z, -y). One larger collider covers the rocker and the switch body.
  var lampSwitch = node("Lamp_Switch");
  var lampSwitchRest = lampSwitch.quaternion.clone();
  var axis = need(lampSwitch.userData.axis, "Lamp_Switch axis");
  var lampSwitchAxis = new Vector3(axis[0], axis[2], -axis[1]).normalize();
  var lampSwitchOn = need(lampSwitch.userData.angle_on, "Lamp_Switch angle_on");
  var lampSwitchOff = need(lampSwitch.userData.angle_off, "Lamp_Switch angle_off");
  var lampSwitchTurn = new Quaternion();
  var sbox = new Box3().setFromObject(lampSwitch);
  var lampSwitchBody = root.getObjectByName("Lamp_SwitchBody");
  if (lampSwitchBody) sbox.expandByObject(lampSwitchBody);
  var ssize = sbox.getSize(new Vector3()).multiplyScalar(LAMP_SWITCH_COLLIDER_SCALE);
  var lampColliderGeo = new BoxGeometry(ssize.x, ssize.y, ssize.z);
  var lampCollider = new Mesh(lampColliderGeo, keep(new MeshBasicMaterial()));
  sbox.getCenter(lampCollider.position);
  lampCollider.visible = false;
  lampCollider.updateMatrixWorld(true);

  var model = {
    root: root,
    collider: collider,
    lampCollider: lampCollider,
    // Metres per tube unit.
    unit: need(extras.tube_unit, "tube_unit"),
    // Room vertical and the authored viewpoint, in tube space.
    up: up,
    seat: seat,
    target: target,
    keyboard: keyboard,
    keys: keys,
    // For extras drawn over the baked set (props.js): the light maps, the
    // ranges they were stored with, and a material lit the same way.
    maps: loaded.maps,
    ranges: ranges,
    makeBakedMaterial: function (maps, atlas, map) {
      return bakedMaterial(maps, ranges[atlas], light, map || null);
    },
    // Draws the set with the same light maps at another size.
    setMaps: function (maps) {
      baked.forEach(function (b) {
        b.material.userData.setMaps(maps[b.atlas]);
      });
      model.maps = maps;
    },
    // 0..1: how much of the lamp's light is in the room.
    setLamp: function (level) {
      lampLevel.value = level;
      applyGlows();
    },
    // 0..1: how much of the room's own light is up.
    setRoom: function (level) {
      roomLevel.value = level;
      applyGlows();
    },
    // 0 = tipped to off, 1 = tipped to on, anything between is on its way over.
    setLampSwitch: function (on) {
      lampSwitchTurn.setFromAxisAngle(lampSwitchAxis, lampSwitchOff + (lampSwitchOn - lampSwitchOff) * on);
      lampSwitch.quaternion.copy(lampSwitchRest).multiply(lampSwitchTurn);
    },
    button: button,
    // Everything a ray can be stopped by.
    meshes: meshes,
    screenLight: screenLight,
    reflect: {
      texture: loaded.reflect,
      range: reflectRange,
      // Half the image per unit of tan(angle off the axis).
      scale: 0.5 / tanHalfFov,
      light: roomLight(extras, ""),
    },
    // What the glass mirrors, and how the room lights it, with the lamp off.
    reflectOff: {
      texture: loaded.reflectOff,
      range: reflectRangeOff,
      scale: 0.5 / tanHalfFov,
      light: roomLight(extras, "_off"),
    },
    setPowerLed: function (on) {
      powerLed.color.set(on ? LED_ON : LED_OFF);
    },
    setKeyboardLed: function (name, on) {
      if (leds[name]) leds[name].color.set(on ? LED_ON : LED_OFF);
    },
    // 0 = out (off), 1 = latched in (on).
    setButton: function (pressed) {
      button.position.copy(buttonRest).addScaledVector(buttonPush, pressed);
    },
    dispose: function () {
      root.traverse(function (o) {
        if (o.isMesh) o.geometry.dispose();
      });
      colliderGeo.dispose();
      lampColliderGeo.dispose();
      materials.forEach(function (m) {
        m.dispose();
      });
    },
  };
  return model;
}

// WebGL CRT prototype, loaded only with ?gl=1 (see the bottom of
// terminal.js). The real xterm.js terminal keeps running, invisible, as the
// thing that takes keystrokes and owns the shell; this file redraws its
// character buffer as a video signal on a modelled tube and relays pointer
// events back to it. Nothing in here owns terminal state.
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  DataTexture,
  WebGLRenderTarget,
  Raycaster,
  Vector2,
  Vector3,
  Color,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
} from "three";
import { RASTER, RASTER_GLSL, faceToRaster } from "./gl/raster.js";
import { createPainter } from "./gl/painter.js";
import { loadModel, buildModel } from "./gl/model.js";
import { drawLegends } from "./gl/legends.js";
import { createKeys } from "./gl/keys.js";
import { createRig } from "./gl/camera.js";

// Bezel opening (the visible part of the tube face), in scene units. A
// 12-inch 4:3 tube shows roughly 244 x 183 mm, so one unit is about 61 mm.
var FACE_HALF_W = 2.0;
var FACE_HALF_H = 1.5;
// Radius of the spherical faceplate. Tubes of this era were sections of a
// sphere, not cylinders and not flat.
var FACE_RADIUS = 11.0;
var FACE_APEX_Z = 0.05;
// Distance from the outer glass surface to the phosphor layer, already
// divided by the refractive index (about 10 mm of glass, n = 1.5).
var GLASS_DEPTH = 0.11;

// Phosphor decay. P39 (the 5151's phosphor) is long-persistence: most of
// the light is gone within a few frames but a faint tail hangs on for the
// best part of a second, which is what leaves ghosts behind scrolling text.
// It is not a single exponential, so it's modelled as a fast and a slow
// component.
var DECAY_FAST_S = 0.045;
var DECAY_SLOW_S = 0.7;

// Colour of the lit phosphor, how much of its light the tinted faceplate
// lets through, and the drive level of a fully lit dot. Together they are
// the radiance of the picture, which the face shader draws and the room is
// lit by.
var PHOSPHOR_RGB = [0.1, 1.0, 0.2];
var GLASS_T = 0.62;
var EMISSION_GAIN = 1.25;

// The model, its light maps and the reflection image, next to the page.
var ASSET_BASE = "./assets/";
// Past this the visitor is better off with the flat site they already have.
var LOAD_TIMEOUT_MS = 8000;
// Meshes that make up the terminal, for framing it.
var TERMINAL_PARTS = ["Collar", "Housing", "Plinth"];

// The glow the picture throws on the desk and the case comes from the baked
// "screen" light maps, scaled by the picture's mean radiance. On a real set
// showing a few lines of text that glow is faint; this lifts it to where it
// reads on a web page without changing its shape or colour.
var SCREEN_GLOW_GAIN = 3.0;
// The collapsing line at switch-off, in units of mean picture level per
// unit of line brightness: all the beam current, on a sliver of the face.
var COLLAPSE_LINE_LIGHT = 0.06 / 14;
// The room follows the phosphor, not the video signal: its slow component
// keeps giving light for a few tenths of a second after the beam moves on.
var SCREEN_GLOW_LAG_S = 0.3;

// The power switch latches in over about this long.
var BUTTON_PRESS_S = 0.08;
// Pointer in this much of the bottom of the window: look down at the keys.
var LOOK_DOWN_ZONE = 0.18;

var FACE_VERT = [
  "varying vec2 vP;",
  "varying vec3 vWN;",
  "varying vec3 vWP;",
  "void main(){",
  "  vP = position.xy / vec2(" + FACE_HALF_W.toFixed(3) + "," + FACE_HALF_H.toFixed(3) + ");",
  "  vWN = normalize(mat3(modelMatrix) * normal);",
  "  vec4 wp = modelMatrix * vec4(position, 1.0);",
  "  vWP = wp.xyz;",
  "  gl_Position = projectionMatrix * viewMatrix * wp;",
  "}",
].join("\n");

var FACE_FRAG = [
  "uniform sampler2D uSig;",
  "uniform float uBreath;",
  "uniform float uLine;",
  "uniform float uLineV;",
  "uniform float uLineH;",
  "uniform float uSpot;",
  "uniform vec3 uAmbient;",
  "uniform vec3 uAmbientDir;",
  "uniform sampler2D uRoom;",
  "uniform float uRoomRange;",
  "uniform float uRoomScale;",
  "varying vec2 vP;",
  "varying vec3 vWN;",
  "varying vec3 vWP;",
  RASTER_GLSL,
  "const vec2 RES = vec2(" + RASTER.width.toFixed(1) + "," + RASTER.height.toFixed(1) + ");",
  // Light emitted for a stored (fast, slow) phosphor state.
  "float glow(vec2 rg){ return 0.9*rg.r + 0.1*rg.g; }",
  // One scanline, sampled at its centre. The video amplifier has finite
  // bandwidth, so a dot doesn't switch on and off instantly as the beam
  // sweeps left to right: strokes smear slightly along the scan direction,
  // and only that direction, hence the lopsided taps.
  "float scanRow(float u, float lineCentre){",
  "  float v = lineCentre / RES.y;",
  "  float dx = 1.0 / RES.x;",
  "  return 0.58*glow(textureLod(uSig, vec2(u, v), 0.0).rg)",
  "       + 0.30*glow(textureLod(uSig, vec2(u - 0.7*dx, v), 0.0).rg)",
  "       + 0.12*glow(textureLod(uSig, vec2(u - 1.5*dx, v), 0.0).rg);",
  "}",
  "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
  "float noise(vec2 p){",
  "  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0 - 2.0*f);",
  "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),",
  "             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);",
  "}",
  // The room as seen in the glass: a picture of it taken from the middle
  // of the face, looking straight out (a pinhole view, already blurred -
  // the faceplate is etched for glare reduction, so nothing in it has a
  // hard edge). A view out of the screen has the tube's +x on its left, so
  // the picture is addressed mirrored; its first row is the top.
  "vec3 room(vec3 r){",
  "  vec2 d = r.xy / max(r.z, 0.15);",
  "  return texture2D(uRoom, vec2(0.5) - d * uRoomScale).rgb * uRoomRange;",
  "}",
  "void main(){",
  "  vec3 N = normalize(vWN);",
  "  vec3 V = normalize(cameraPosition - vWP);",
  // The picture is on the INSIDE of the glass. Looking at an angle, the
  // phosphor you see through a given point of the surface is displaced,
  // so image and reflection slide against each other as the eye moves.
  "  vec2 p = vP - V.xy / max(V.z, 0.3) * " + GLASS_DEPTH.toFixed(3) + " / vec2(" +
    FACE_HALF_W.toFixed(3) + "," + FACE_HALF_H.toFixed(3) + ");",
  "  vec2 uv = faceToRaster(p, uBreath);",
  "  vec2 e = vec2(0.0015, 0.003);",
  "  float inside = smoothstep(-e.x, e.x, uv.x) * smoothstep(-e.x, e.x, 1.0 - uv.x)",
  "               * smoothstep(-e.y, e.y, uv.y) * smoothstep(-e.y, e.y, 1.0 - uv.y);",
  "  float linesPerPx = fwidth(uv.y * RES.y);",
  // Beam profile. Each scanline is a Gaussian stripe; on this class of
  // display (350 lines) the spot is about as wide as the line pitch, so the
  // lines nearly merge. The structure is only resolved when a line covers
  // a few device pixels - below that it would just alias, so it fades to
  // the plain filtered picture.
  "  float ry = uv.y * RES.y;",
  "  float line0 = floor(ry);",
  "  float beam = 0.0;",
  "  for (int i = -1; i <= 1; i++) {",
  "    float centre = line0 + float(i) + 0.5;",
  "    float d = ry - centre;",
  "    beam += scanRow(uv.x, centre) * exp(-d*d / 0.30);",
  "  }",
  "  float plain = glow(texture2D(uSig, uv).rg);",
  "  float pic = mix(plain, beam, 1.0 - smoothstep(1.0/3.0, 1.0/1.6, linesPerPx)) * inside;",
  // Halation: light scattering sideways inside the faceplate glass gives
  // every lit stroke a soft halo about a character wide, plus a faint
  // veil over the whole face that rises with how much of it is lit.
  "  vec2 huv = clamp(uv, 0.0, 1.0);",
  "  float spill = exp(-distance(uv, huv) * 28.0);",
  "  float halo = (0.10*glow(textureLod(uSig, huv, 3.0).rg) + 0.035*glow(textureLod(uSig, huv, 6.5).rg)) * spill;",
  "  float em = pic + halo;",
  // Power-off: with vertical deflection gone the whole beam current lands
  // on one line, then one spot. Drawn in face space on top of whatever the
  // phosphor is still giving off.
  "  vec2 q = (p - vec2(" + RASTER.offsetX.toFixed(4) + "," + RASTER.offsetY.toFixed(4) + ")) / vec2(" +
    RASTER.scaleX.toFixed(3) + "," + RASTER.scaleY.toFixed(3) + ");",
  "  if (uLine > 0.0) {",
  "    float sv = max(uLineV, 0.004);",
  "    float ends = 1.0 - smoothstep(uLineH * 0.92, uLineH, abs(q.x));",
  "    em += uLine * ends * (exp(-q.y*q.y / (2.0*sv*sv)) + 0.22*exp(-q.y*q.y / (2.0*36.0*sv*sv)));",
  "  }",
  "  if (uSpot > 0.0) {",
  "    float r2 = q.x*q.x*1.78 + q.y*q.y;",
  "    em += uSpot * (exp(-r2 / 0.0002) + 0.16*exp(-r2 / 0.006));",
  "  }",
  // The phosphor coating is a pale powder (zinc silicate reflects most of
  // the light that reaches it). Seen through the tinted faceplate twice it
  // is a dull grey-green, and that - not black - is the darkest the screen
  // can be: emitted light only ever adds to it. The bezel lip shades its
  // edges.
  "  vec2 edge = vec2(1.0) - abs(vP);",
  "  float lip = smoothstep(0.0, 0.10, min(edge.x * " + (FACE_HALF_W / FACE_HALF_H).toFixed(3) + ", edge.y));",
  "  vec3 amb = uAmbient * (0.55 + 0.45*max(dot(N, uAmbientDir), 0.0)) * mix(0.35, 1.0, lip);",
  "  float T = " + GLASS_T.toFixed(2) + ";",
  "  float dust = noise(vP * 90.0) * noise(vP * 11.0 + 3.0);",
  "  vec3 col = T*T * vec3(0.68, 0.72, 0.66) * amb;",
  "  col += T * vec3(" + PHOSPHOR_RGB.map(function (c) { return c.toFixed(2); }).join(", ") + ") * em * " + EMISSION_GAIN.toFixed(2) + ";",
  // Outer glass surface: Fresnel reflection of the room. Unaffected by
  // anything the tube is doing, so it stays when the set is off.
  "  float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);",
  "  col += F * room(reflect(-V, N)) * mix(0.55, 1.0, lip);",
  "  col += vec3(0.010) * dust * amb;",
  "  gl_FragColor = vec4(col, 1.0);",
  "  #include <colorspace_fragment>",
  "}",
].join("\n");

var PERSIST_VERT = "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }";

// Phosphor state update, run at signal resolution. Wherever the beam is
// lighting a dot the phosphor is driven to that level; everywhere else it
// decays by however much real time has passed, so the trails look the same
// on a 60 Hz and a 144 Hz display.
var PERSIST_FRAG = [
  "uniform sampler2D uPrev;",
  "uniform sampler2D uSignal;",
  "uniform float uKeepFast;",
  "uniform float uKeepSlow;",
  "uniform float uGain;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / vec2(" + RASTER.width.toFixed(1) + "," + RASTER.height.toFixed(1) + ");",
  "  vec2 prev = texture2D(uPrev, uv).rg;",
  "  float s = texture2D(uSignal, uv).r * uGain;",
  "  vec2 next = max(vec2(s), prev * vec2(uKeepFast, uKeepSlow));",
  "  gl_FragColor = vec4(step(0.002, next) * next, 0.0, 1.0);",
  "}",
].join("\n");

function start(crt) {
  var term = crt.term;
  var screenEl = document.querySelector("#terminal .xterm-screen");
  if (!screenEl) throw new Error("xterm screen element not found");

  // Everything below that has to be undone if the scene stops registers
  // its undo step here as it is created, so a failure part-way through
  // setting up (or loading) leaves nothing behind.
  var cleanup = [];
  teardown = function () {
    while (cleanup.length) {
      try {
        cleanup.pop()();
      } catch (e) {}
    }
  };
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    cleanup.push(function () {
      target.removeEventListener(type, fn, options);
    });
  }

  var canvas = document.createElement("canvas");
  canvas.id = "glCanvas";
  canvas.setAttribute("aria-hidden", "true");
  var renderer = new WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
  cleanup.push(function () {
    renderer.dispose();
  });
  if (!renderer.capabilities.isWebGL2) throw new Error("WebGL2 required");
  // The phosphor state lives in half-float render targets. three asks for
  // these extensions but doesn't complain when a GPU has neither - the
  // tube would just stay dark - so check here, before anything is hidden.
  if (!renderer.extensions.has("EXT_color_buffer_float") && !renderer.extensions.has("EXT_color_buffer_half_float")) {
    throw new Error("half-float render targets unsupported");
  }
  renderer.debug.onShaderError = function () {
    fallback("shader failed to compile");
  };
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  var painter = createPainter(term);
  cleanup.push(painter.dispose);

  // --- video signal and phosphor state -----------------------------------
  // flipY is left off: the first row of the data is the top scanline, and
  // the shaders address the signal top-down to match.
  var signalTex = new DataTexture(painter.data, RASTER.width, RASTER.height, RedFormat, UnsignedByteType);
  signalTex.minFilter = LinearFilter;
  signalTex.magFilter = LinearFilter;
  signalTex.wrapS = signalTex.wrapT = ClampToEdgeWrapping;
  signalTex.needsUpdate = true;

  function makeTarget() {
    // Half-float so a slow decay can't stall on 8-bit rounding and leave a
    // permanent ghost. Mipmaps give the halation blur for free.
    var t = new WebGLRenderTarget(RASTER.width, RASTER.height, {
      format: RGBAFormat,
      type: HalfFloatType,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      generateMipmaps: true,
      depthBuffer: false,
    });
    return t;
  }
  var targetA = makeTarget();
  var targetB = makeTarget();

  var persistMat = new ShaderMaterial({
    vertexShader: PERSIST_VERT,
    fragmentShader: PERSIST_FRAG,
    uniforms: {
      uPrev: { value: null },
      uSignal: { value: signalTex },
      uKeepFast: { value: 0 },
      uKeepSlow: { value: 0 },
      uGain: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  var persistScene = new Scene();
  var persistQuad = new Mesh(new PlaneGeometry(2, 2), persistMat);
  persistQuad.frustumCulled = false;
  persistScene.add(persistQuad);
  var persistCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // --- scene ---------------------------------------------------------------
  var scene = new Scene();
  scene.background = new Color(0x0b0c0d);

  var faceMat = new ShaderMaterial({
    vertexShader: FACE_VERT,
    fragmentShader: FACE_FRAG,
    uniforms: {
      uSig: { value: targetA.texture },
      uBreath: { value: 1 },
      uLine: { value: 0 },
      uLineV: { value: 1 },
      uLineH: { value: 1 },
      uSpot: { value: 0 },
      // The room's light on the glass and its picture in it; filled in from
      // the reflection image once the model has loaded.
      uAmbient: { value: new Color(0, 0, 0) },
      uAmbientDir: { value: new Vector3(0, 0, 1) },
      uRoom: { value: null },
      uRoomRange: { value: 1 },
      uRoomScale: { value: 0.5 },
    },
  });
  // Larger than the bezel opening so its edges are hidden behind the lip.
  var faceGeo = new PlaneGeometry(FACE_HALF_W * 2 + 0.5, FACE_HALF_H * 2 + 0.5, 64, 48);
  var pos = faceGeo.attributes.position;
  for (var i = 0; i < pos.count; i++) {
    var x = pos.getX(i);
    var y = pos.getY(i);
    pos.setZ(i, Math.sqrt(FACE_RADIUS * FACE_RADIUS - x * x - y * y) - FACE_RADIUS + FACE_APEX_Z);
  }
  faceGeo.computeVertexNormals();
  var face = new Mesh(faceGeo, faceMat);
  scene.add(face);

  cleanup.push(function () {
    targetA.dispose();
    targetB.dispose();
    signalTex.dispose();
    persistQuad.geometry.dispose();
    persistMat.dispose();
    faceGeo.dispose();
    faceMat.dispose();
  });

  // Near and far planes in tube units (about 61 mm): a few centimetres to
  // well past the far wall.
  var camera = new PerspectiveCamera(28, 1, 0.5, 300);
  // Pointer position across the window, -1..1: where the head drifts to.
  var parallaxGoal = new Vector2(0, 0);
  var lookDown = false;

  // --- the modelled set ----------------------------------------------------
  // Arrives later: the terminal, keyboard, desk and room, their baked light
  // and the reflection image all download while the flat site carries on
  // underneath. Nothing is drawn, and the canvas is not shown, until all of
  // it is here and compiled.
  var model = null;
  var rig = null;
  var keys = null;
  var pickable = [];
  var ready = false;

  function modelLoaded(loaded) {
    var root = loaded.gltf.scene;
    var keyNodes = [];
    root.traverse(function (o) {
      if (o.userData && o.userData.code !== undefined) keyNodes.push(o);
    });
    var strip = root.getObjectByName("LegendStrip");
    if (!strip) throw new Error("model is missing LegendStrip");
    var legends = drawLegends(keyNodes, strip, renderer.capabilities.getMaxAnisotropy());
    cleanup.push(function () {
      legends.keys.dispose();
      legends.strip.dispose();
    });

    model = buildModel(loaded, legends);
    cleanup.push(model.dispose);
    scene.add(model.root);
    scene.add(model.collider);
    scene.updateMatrixWorld(true);

    var u = faceMat.uniforms;
    u.uRoom.value = model.reflect.texture;
    u.uRoomRange.value = model.reflect.range;
    u.uRoomScale.value = model.reflect.scale;
    u.uAmbient.value.copy(model.reflect.light.color);
    u.uAmbientDir.value.copy(model.reflect.light.direction);

    var terminal = TERMINAL_PARTS.map(function (name) {
      return root.getObjectByName(name);
    }).filter(Boolean);
    if (!terminal.length) throw new Error("model has no terminal to frame");
    rig = createRig(camera, model, terminal, [model.keyboard], 2 * FACE_HALF_H * RASTER.scaleY);

    keys = createKeys(
      model.keys,
      function (data) {
        // The same entry point a real keystroke takes inside xterm, so the
        // shell (and whatever has disabled input) treats it the same.
        term.input(data, true);
      },
      function (lit) {
        model.setKeyboardLed("Kbd_LED_Lock", lit);
      },
      function () {
        wake(0.2);
      }
    );

    pickable = [face, model.collider].concat(model.meshes);
    model.setPowerLed(powerState === "on" || powerState === "warming");
    model.setButton(buttonPos);
    layout();

    // Decode and upload the big textures now rather than in the first
    // visible frame.
    [legends.keys, legends.strip, model.reflect.texture].forEach(function (t) {
      renderer.initTexture(t);
    });
    for (var name in loaded.maps) {
      renderer.initTexture(loaded.maps[name].room);
      renderer.initTexture(loaded.maps[name].screen);
    }
  }

  function layout() {
    // Re-read every time: browser zoom and moving the window to another
    // display both change the pixel ratio.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (rig) rig.layout(w / h);
    wake(0.2);
  }

  // --- power ---------------------------------------------------------------
  // The DOM power button stays the source of truth (terminal.js toggles
  // classes on .crt); this only plays the tube's side of it.
  var powerState = crt.isPowerOn() ? "on" : "off";
  var powerT = 0;
  var beamGain = powerState === "on" ? 1 : 0;
  // How much beam there was at the moment of switch-off. A tube switched
  // off while still warming up has little emission to collapse.
  var collapseGain = 1;
  var apl = 0;
  // What the room is being lit by: the picture level, lagged.
  var screenLevel = 0;
  // Push-push switch: latched in while the set is on. 0 = out, 1 = in.
  var buttonGoal = powerState === "on" ? 1 : 0;
  var buttonPos = buttonGoal;

  function setPower(on) {
    if (!on) collapseGain = beamGain;
    powerState = on ? "warming" : "collapsing";
    powerT = 0;
    if (model) model.setPowerLed(on);
    buttonGoal = on ? 1 : 0;
    wake(6);
  }

  function stepPower(dt) {
    var u = faceMat.uniforms;
    powerT += dt;
    if (powerState === "collapsing") {
      // Vertical deflection dies first: the raster folds to a line in a
      // fraction of a second while the gun is still emitting, so the same
      // beam current lands on a tiny area and the line is far brighter than
      // the picture was. Horizontal scan follows, leaving a spot that the
      // still-hot cathode and the charge left on the tube keep feeding for
      // a second or two. The picture itself isn't squeezed - what's left
      // of it is just phosphor afterglow fading where it was drawn.
      beamGain = 0;
      var a = Math.min(powerT / 0.16, 1);
      var b = Math.min(Math.max((powerT - 0.16) / 0.3, 0), 1);
      u.uLineV.value = Math.max(Math.pow(1 - a, 2.2), 0.004);
      u.uLineH.value = Math.max(1 - b * b * 0.985, 0.015);
      // Same beam current on a shrinking area: brightness goes up as the
      // lit area goes down, until the phosphor saturates. So nothing
      // flashes at the start - the line only becomes bright as it narrows.
      var area = u.uLineV.value * u.uLineH.value;
      u.uLine.value = b < 1 ? Math.min((0.02 + apl * 0.9) / area, 4.5) * collapseGain : 0;
      var s = powerT - 0.46;
      u.uSpot.value = s > 0 ? (2.2 * Math.exp(-s / 0.5) + 0.25 * Math.exp(-s / 1.8)) * collapseGain : 0;
      if (s > 6) {
        u.uSpot.value = 0;
        powerState = "off";
      }
    } else if (powerState === "warming") {
      // The scan circuits are at full size almost at once, but the cathode
      // has to heat before there is any beam: a dark, full-size raster,
      // then brightness coming up. While the high voltage is still settling
      // the picture is a touch oversized.
      // Switched back on mid-collapse: what's left of the line and spot
      // dies away rather than vanishing.
      u.uLine.value *= Math.exp(-dt / 0.05);
      u.uSpot.value *= Math.exp(-dt / 0.3);
      var w = Math.min(Math.max((powerT - 1.3) / 1.6, 0), 1);
      beamGain = w * w * (3 - 2 * w);
      u.uBreath.value = 1 + 0.015 * (1 - beamGain);
      if (w >= 1) {
        powerState = "on";
        u.uBreath.value = 1;
      }
    }
  }

  var powerObserver = new MutationObserver(function () {
    var cls = crt.crt.classList;
    if (cls.contains("powering-off") && powerState !== "collapsing" && powerState !== "off") setPower(false);
    else if (cls.contains("powering-on") && powerState !== "warming" && powerState !== "on") setPower(true);
  });
  powerObserver.observe(crt.crt, { attributes: true, attributeFilter: ["class"] });
  cleanup.push(function () {
    powerObserver.disconnect();
  });

  // The flat site's occasional vertical-hold glitch is deliberately not
  // reproduced here: a set in good adjustment holds sync, and the whole
  // picture rolling every half minute read as a bug rather than character.

  // --- pointer -------------------------------------------------------------
  var raycaster = new Raycaster();
  var ndc = new Vector2();
  var overFace = false;

  // What is under a point of the window. The ray is tested against the
  // whole model, not just the things that respond, so the mug or the edge
  // of the case in front of something takes the click instead of it.
  function hitTest(ev) {
    if (!ready) return null;
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects(pickable, false);
    if (!hits.length) return null;
    var obj = hits[0].object;
    if (obj === model.collider || obj === model.button) return { button: true };
    if (obj.userData.code !== undefined) return { key: obj };
    if (obj === model.keyboard || obj.parent === model.keyboard) return { keyboard: true };
    if (obj !== face) return null;
    var pt = hits[0].point;
    // Same glass-depth correction as the shader, so a click lands on the
    // character that is actually drawn under the pointer.
    var dir = raycaster.ray.direction;
    var px = (pt.x + (dir.x / Math.max(-dir.z, 0.3)) * GLASS_DEPTH) / FACE_HALF_W;
    var py = (pt.y + (dir.y / Math.max(-dir.z, 0.3)) * GLASS_DEPTH) / FACE_HALF_H;
    if (Math.abs(pt.x) > FACE_HALF_W || Math.abs(pt.y) > FACE_HALF_H) return { bezel: true };
    var uv = faceToRaster(px, py);
    if (uv.u < 0 || uv.u >= 1 || uv.v < 0 || uv.v >= 1) return { glass: true };
    return { col: Math.floor(uv.u * RASTER.cols), row: Math.floor(uv.v * RASTER.rows) };
  }

  // xterm's link handling listens for ordinary mouse events on its screen
  // element and works out the cell from clientX/Y. Handing it events aimed
  // at the centre of the right cell of the (invisible) DOM terminal makes
  // the existing ls links work without xterm knowing anything changed.
  function relay(type, cell, ev) {
    var rect = screenEl.getBoundingClientRect();
    screenEl.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
        buttons: type === "mousedown" ? 1 : 0,
        clientX: rect.left + ((cell.col + 0.5) * rect.width) / term.cols,
        clientY: rect.top + ((cell.row + 0.5) * rect.height) / term.rows,
        ctrlKey: ev.ctrlKey,
        shiftKey: ev.shiftKey,
        altKey: ev.altKey,
        metaKey: ev.metaKey,
      })
    );
  }

  function leaveFace() {
    if (!overFace) return;
    overFace = false;
    screenEl.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, view: window }));
  }

  function inLookDownZone(ev) {
    return ev.clientY > window.innerHeight * (1 - LOOK_DOWN_ZONE);
  }
  function onKeyboard(hit) {
    return !!hit && (hit.key !== undefined || hit.keyboard === true);
  }

  canvas.addEventListener("pointermove", function (ev) {
    parallaxGoal.set((ev.clientX / window.innerWidth) * 2 - 1, (ev.clientY / window.innerHeight) * 2 - 1);
    wake(1.5);
    var hit = hitTest(ev);
    // The bottom of the window brings the keyboard up; once it is up, the
    // view holds for as long as the pointer is over the keyboard, which by
    // then fills the middle of the window.
    lookDown = inLookDownZone(ev) || (lookDown && onKeyboard(hit));
    if (hit && hit.col !== undefined && powerState === "on") {
      overFace = true;
      relay("mousemove", hit, ev);
      canvas.style.cursor = screenEl.classList.contains("xterm-cursor-pointer") ? "pointer" : "text";
    } else {
      leaveFace();
      canvas.style.cursor = hit && (hit.button || hit.key) ? "pointer" : "default";
    }
  });
  canvas.addEventListener("pointerleave", function (ev) {
    leaveFace();
    parallaxGoal.set(0, 0);
    // A finger lifting also "leaves"; only a mouse going off the window
    // should send the view back up.
    if (ev.pointerType !== "touch") lookDown = false;
    wake(1.5);
  });

  var downCell = null;
  // True from a press on a modelled key until the next press anywhere.
  var pressedKey = false;
  canvas.addEventListener("pointerdown", function (ev) {
    // Keep the browser from moving focus to the canvas: keystrokes belong
    // to xterm's own input element.
    ev.preventDefault();
    var hit = hitTest(ev);
    // A tap on a modelled key is typing already. Focusing the terminal as
    // well would raise the phone's own keyboard over the one being tapped.
    var tappedKey = !!hit && hit.key !== undefined && ev.pointerType === "touch";
    if (!tappedKey) term.focus();
    if (ev.button !== 0) return;
    downCell = null;
    pressedKey = false;
    // A touch has no hover, so where it lands decides the view.
    var wasDown = lookDown;
    lookDown = inLookDownZone(ev) || onKeyboard(hit);
    wake(1.5);
    if (!hit) return;
    // In a tall window the seated view already shows the keys, but too
    // small to aim at: the first tap on one brings them up close rather
    // than typing whatever it happened to land on.
    if (hit.key && ev.pointerType === "touch" && !wasDown && rig && rig.showsKeys()) return;
    if (hit.button) {
      crt.powerBtn.click();
      return;
    }
    if (hit.key) {
      pressedKey = true;
      keys.pointerDown(hit.key);
      // Capture, so the key comes back up wherever the pointer is let go.
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (e) {}
      return;
    }
    if (hit.col !== undefined && powerState === "on") {
      downCell = hit;
      // Capture, so the matching release reaches us even if the pointer
      // leaves the window: xterm starts document-level listeners and a
      // timer on mousedown and only stops them on mouseup.
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (e) {}
      relay("mousemove", hit, ev);
      relay("mousedown", hit, ev);
    }
  });
  function release(ev) {
    if (pressedKey) {
      keys.pointerUp();
      return;
    }
    // Phones only raise the on-screen keyboard for a focus() made while a
    // touch is ending, so focus here too, whatever was tapped.
    term.focus();
    if (!downCell) return;
    var hit = ev.type === "pointerup" ? hitTest(ev) : null;
    // Release on the cell the press started on, the way a click works; a
    // drag off it still gets a mouseup so xterm's selection logic ends.
    relay("mouseup", hit && hit.col !== undefined ? hit : downCell, ev);
    downCell = null;
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);
  // xterm scrolls its buffer from wheel events on its own element, which
  // the canvas now covers.
  canvas.addEventListener(
    "wheel",
    function (ev) {
      if (!ev.deltaY) return;
      ev.preventDefault();
      term.scrollLines(ev.deltaY > 0 ? 3 : -3);
    },
    { passive: false }
  );

  // --- keyboard ------------------------------------------------------------
  // The modelled keys follow the real ones. Watched in the capture phase
  // and never touched: xterm's own handler stops the event from bubbling,
  // and the keystroke is its business, not ours.
  function keyEvent(ev) {
    if (!keys) return;
    keys.setHeld(ev.code, ev.type === "keydown");
    if (ev.getModifierState) keys.setCapsLock(ev.getModifierState("CapsLock"));
  }
  listen(window, "keydown", keyEvent, true);
  listen(window, "keyup", keyEvent, true);
  // With the window out of focus the keyups never come.
  function releaseKeys() {
    if (keys) keys.releaseAll();
  }
  listen(window, "blur", releaseKeys);

  // --- frame loop ----------------------------------------------------------
  // Nothing is drawn unless something is changing: the phosphor is still
  // decaying, the camera is easing, a key is moving, or a power animation
  // is running.
  var activeUntil = 0;
  var lastTime = 0;
  // Asks for frames for the next `seconds`. Read from the clock rather
  // than from the last frame's timestamp: in a hidden tab there are no
  // frames, and a stale timestamp would put the deadline in the past.
  function wake(seconds) {
    activeUntil = Math.max(activeUntil, performance.now() / 1000 + seconds);
  }
  listen(document, "visibilitychange", function () {
    if (document.hidden) releaseKeys();
    else wake(0.5);
  });

  var first = true;
  function frame(ms) {
    if (dead) return;
    rafId = requestAnimationFrame(frame);
    var now = ms / 1000;
    var dt = Math.min(now - lastTime, 0.25);
    lastTime = now;
    if (document.hidden || !ready) return;

    // While the set is off the beam isn't drawing anything, so there is
    // nothing to repaint; the painter stays dirty and catches up at power-on.
    if (painter.isDirty() && powerState !== "off") {
      apl = painter.paint();
      signalTex.needsUpdate = true;
      // Long enough for the slow phosphor component to fade out.
      wake(DECAY_SLOW_S * 6);
    }
    if (now > activeUntil && !first) return;

    if (powerState === "collapsing" || powerState === "warming") {
      stepPower(dt);
      wake(0.5);
    }

    persistMat.uniforms.uPrev.value = targetA.texture;
    persistMat.uniforms.uKeepFast.value = Math.exp(-dt / DECAY_FAST_S);
    persistMat.uniforms.uKeepSlow.value = Math.exp(-dt / DECAY_SLOW_S);
    persistMat.uniforms.uGain.value = beamGain;
    renderer.setRenderTarget(targetB);
    renderer.render(persistScene, persistCam);
    renderer.setRenderTarget(null);
    var swap = targetA;
    targetA = targetB;
    targetB = swap;
    faceMat.uniforms.uSig.value = targetA.texture;

    // The tube lighting its own surroundings, by how much of the picture
    // is lit (and, at switch-off, by the collapsing line).
    var level = apl * beamGain + COLLAPSE_LINE_LIGHT * faceMat.uniforms.uLine.value;
    var moving = false;
    screenLevel += (level - screenLevel) * (1 - Math.exp(-dt / SCREEN_GLOW_LAG_S));
    if (Math.abs(level - screenLevel) < 0.0002) screenLevel = level;
    else moving = true;
    model.screenLight.value
      .setRGB(PHOSPHOR_RGB[0], PHOSPHOR_RGB[1], PHOSPHOR_RGB[2])
      .multiplyScalar(GLASS_T * EMISSION_GAIN * screenLevel * SCREEN_GLOW_GAIN);

    if (buttonPos !== buttonGoal) {
      buttonPos += (buttonGoal - buttonPos) * (1 - Math.exp((-3 * dt) / BUTTON_PRESS_S));
      if (Math.abs(buttonGoal - buttonPos) < 0.01) buttonPos = buttonGoal;
      else moving = true;
      model.setButton(buttonPos);
    }
    if (keys.step(dt)) moving = true;
    if (rig.step(dt, parallaxGoal.x, parallaxGoal.y, lookDown)) moving = true;
    if (moving) wake(0.1);

    renderer.render(scene, camera);

    // A shader error during that render already sent us to the flat site.
    if (dead) return;
    if (first) {
      first = false;
      document.body.appendChild(canvas);
      document.body.classList.add("gl-on");
    }
  }

  listen(canvas, "webglcontextlost", function (ev) {
    ev.preventDefault();
    fallback("WebGL context lost");
  });

  listen(window, "resize", layout);
  if (window.visualViewport) listen(window.visualViewport, "resize", layout);
  layout();
  var rafId = requestAnimationFrame(frame);
  cleanup.push(function () {
    cancelAnimationFrame(rafId);
  });

  // --- loading -------------------------------------------------------------
  var load = loadModel(ASSET_BASE);
  cleanup.push(load.dispose);
  var loadTimer = setTimeout(function () {
    fallback("model took too long to load");
  }, LOAD_TIMEOUT_MS);
  cleanup.push(function () {
    clearTimeout(loadTimer);
  });
  load.promise
    .then(function (loaded) {
      if (dead) return;
      modelLoaded(loaded);
      // Only the main scene: the persistence pass draws into a render
      // target, and three keys its program on that, so compiling it here
      // (for the canvas) would only be thrown away on the first frame.
      return renderer.compileAsync(scene, camera);
    })
    .then(function () {
      if (dead) return;
      clearTimeout(loadTimer);
      ready = true;
      wake(1);
    })
    .catch(function (err) {
      fallback(err && err.message ? err.message : String(err));
    });

  // Debug handle for automated checks: where things end up on the page, so
  // a test can click them, and what state the scene is in.
  function toClient(v3) {
    v3.project(camera);
    var rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((v3.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v3.y) / 2) * rect.height,
    };
  }
  window.__crtGL = {
    cellToClient: function (col, row) {
      var u = (col + 0.5) / RASTER.cols;
      var v = (row + 0.5) / RASTER.rows;
      // Invert faceToRaster numerically (it is close to linear).
      var px = (u * 2 - 1) * RASTER.scaleX;
      var py = (1 - v * 2) * RASTER.scaleY;
      for (var k = 0; k < 8; k++) {
        var got = faceToRaster(px, py);
        px += (u - got.u) * 2 * RASTER.scaleX;
        py -= (v - got.v) * 2 * RASTER.scaleY;
      }
      // (px,py) is the spot on the phosphor; the point of the glass surface
      // it is seen through is displaced by the glass depth, same as in the
      // shader and hitTest.
      var ix = px * FACE_HALF_W;
      var iy = py * FACE_HALF_H;
      var x = ix;
      var y = iy;
      var z = 0;
      for (var n = 0; n < 3; n++) {
        z = Math.sqrt(FACE_RADIUS * FACE_RADIUS - x * x - y * y) - FACE_RADIUS + FACE_APEX_Z;
        var d = new Vector3(x, y, z).sub(camera.position).normalize();
        var kk = GLASS_DEPTH / Math.max(-d.z, 0.3);
        x = ix - d.x * kk;
        y = iy - d.y * kk;
      }
      return toClient(new Vector3(x, y, z));
    },
    // Middle of a modelled key's top face, by KeyboardEvent.code, or null.
    // (The node's origin is at the foot of the cap, which in a shallow view
    // projects onto the key in front.)
    keyToClient: function (code) {
      if (!model) return null;
      for (var i = 0; i < model.keys.length; i++) {
        var k = model.keys[i];
        if (k.userData.code !== code) continue;
        if (!k.geometry.boundingBox) k.geometry.computeBoundingBox();
        var b = k.geometry.boundingBox;
        var top = new Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
        return toClient(top.applyMatrix4(k.matrixWorld));
      }
      return null;
    },
    buttonToClient: function () {
      return model ? toClient(new Vector3().setFromMatrixPosition(model.collider.matrixWorld)) : null;
    },
    hitTest: function (x, y) {
      var hit = hitTest({ clientX: x, clientY: y });
      // Report a key by what it is rather than handing out the mesh.
      return hit && hit.key ? { key: hit.key.userData.code } : hit;
    },
    state: function () {
      return {
        power: powerState,
        apl: apl,
        beamGain: beamGain,
        modelReady: ready,
        screenLevel: screenLevel,
        camera: rig ? rig.info() : null,
      };
    },
  };
  cleanup.push(function () {
    delete window.__crtGL;
  });
}

// Anything going wrong puts the visitor back on the flat CSS monitor, which
// has been running underneath the whole time: stop drawing, let go of
// everything the scene subscribed to, and have terminal.js drop the 80x25
// pin so the flat terminal fits its box again.
var dead = false;
var teardown = null;
function fallback(reason) {
  if (dead) return;
  dead = true;
  document.body.classList.remove("gl-on");
  var c = document.getElementById("glCanvas");
  if (c && c.parentNode) c.parentNode.removeChild(c);
  if (teardown) {
    // Let go of it as well, or its closure keeps the renderer, the model
    // and the legend canvases alive for the rest of the visit.
    var undo = teardown;
    teardown = null;
    try {
      undo();
    } catch (e) {}
  }
  if (window.__crt && window.__crt.release) window.__crt.release();
  if (window.console) console.warn("[crt] 3D view disabled: " + reason);
}

try {
  if (!window.__crt) throw new Error("terminal bridge missing");
  start(window.__crt);
} catch (err) {
  fallback(err && err.message ? err.message : String(err));
}

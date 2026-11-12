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
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  ExtrudeGeometry,
  Shape,
  Path,
  ShaderMaterial,
  MeshStandardMaterial,
  MeshBasicMaterial,
  DataTexture,
  WebGLRenderTarget,
  HemisphereLight,
  DirectionalLight,
  PointLight,
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
  "uniform float uAmbient;",
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
  // The room as seen in the glass: a window up and to the left behind the
  // viewer, a desk lamp to the right, dim walls. The faceplate is etched
  // for glare reduction, so nothing here has a hard edge.
  "vec3 room(vec3 r){",
  "  vec2 d = r.xy / max(r.z, 0.15);",
  "  vec2 w = abs(d - vec2(-0.20, 0.17)) - vec2(0.085, 0.115);",
  "  float win = 1.0 - smoothstep(-0.035, 0.045, max(w.x, w.y));",
  "  float bars = smoothstep(0.0, 0.02, abs(d.x + 0.20)) * smoothstep(0.0, 0.02, abs(d.y - 0.17));",
  "  vec3 col = vec3(0.70, 0.82, 1.0) * 1.9 * win * mix(0.6, 1.0, bars);",
  "  float lamp = exp(-dot(d - vec2(0.27, 0.12), d - vec2(0.27, 0.12)) / 0.003);",
  "  col += vec3(1.0, 0.78, 0.50) * 1.3 * lamp;",
  "  col += vec3(0.030, 0.032, 0.036) * (0.6 + 0.5*clamp(d.y, -1.0, 1.0));",
  "  return col;",
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
  // The phosphor coating is a pale powder. Lit by the room it is a dull
  // grey-green, and that - not black - is the darkest the screen can be:
  // emitted light only ever adds to it. The bezel lip shades its edges.
  "  vec2 edge = vec2(1.0) - abs(vP);",
  "  float lip = smoothstep(0.0, 0.10, min(edge.x * " + (FACE_HALF_W / FACE_HALF_H).toFixed(3) + ", edge.y));",
  "  float amb = uAmbient * (0.55 + 0.45*max(dot(N, normalize(vec3(-0.5, 0.45, 0.74))), 0.0)) * mix(0.35, 1.0, lip);",
  "  float T = 0.62;",
  "  float dust = noise(vP * 90.0) * noise(vP * 11.0 + 3.0);",
  "  vec3 col = T*T * vec3(0.30, 0.33, 0.29) * amb;",
  "  col += T * vec3(0.10, 1.0, 0.20) * em * 1.25;",
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

  var canvas = document.createElement("canvas");
  canvas.id = "glCanvas";
  canvas.setAttribute("aria-hidden", "true");
  var renderer = new WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
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
      uAmbient: { value: 0.5 },
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

  // Placeholder case: plain moulded-plastic colour, no texture, no vents.
  // The real unit gets modelled later; this only has to hold the tube and
  // give the glass something to sit behind.
  var plastic = new MeshStandardMaterial({ color: 0xb9ae93, roughness: 0.72, metalness: 0.0 });
  var bezelShape = new Shape();
  bezelShape.moveTo(-2.65, -2.45);
  bezelShape.lineTo(2.65, -2.45);
  bezelShape.lineTo(2.65, 2.05);
  bezelShape.lineTo(-2.65, 2.05);
  bezelShape.closePath();
  var hole = new Path();
  var hw = FACE_HALF_W;
  var hh = FACE_HALF_H;
  var rad = 0.28;
  hole.moveTo(-hw + rad, -hh);
  hole.lineTo(hw - rad, -hh);
  hole.quadraticCurveTo(hw, -hh, hw, -hh + rad);
  hole.lineTo(hw, hh - rad);
  hole.quadraticCurveTo(hw, hh, hw - rad, hh);
  hole.lineTo(-hw + rad, hh);
  hole.quadraticCurveTo(-hw, hh, -hw, hh - rad);
  hole.lineTo(-hw, -hh + rad);
  hole.quadraticCurveTo(-hw, -hh, -hw + rad, -hh);
  bezelShape.holes.push(hole);
  var bezelGeo = new ExtrudeGeometry(bezelShape, {
    depth: 0.82,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 3,
    curveSegments: 12,
  });
  bezelGeo.translate(0, 0, -0.4);
  scene.add(new Mesh(bezelGeo, plastic));

  var body = new Mesh(new BoxGeometry(5.2, 4.4, 4.2), plastic);
  body.position.set(0, -0.2, -2.55);
  scene.add(body);
  var foot = new Mesh(new BoxGeometry(3.0, 0.3, 3.0), plastic);
  foot.position.set(0, -2.6, -1.6);
  scene.add(foot);

  var desk = new Mesh(
    new PlaneGeometry(60, 30),
    new MeshStandardMaterial({ color: 0x3a2a1f, roughness: 0.55 })
  );
  desk.rotation.x = -Math.PI / 2;
  desk.position.set(0, -2.75, 6);
  scene.add(desk);
  var wall = new Mesh(
    new PlaneGeometry(80, 40),
    new MeshStandardMaterial({ color: 0x4a4c48, roughness: 0.95 })
  );
  wall.position.set(0, 6, -7);
  scene.add(wall);

  // Push-push switch and its indicator. Period indicator LEDs were dim
  // yellow-green GaP parts, not the saturated green of the phosphor.
  var btnMat = new MeshStandardMaterial({ color: 0xa39a82, roughness: 0.5 });
  var btn = new Mesh(new CylinderGeometry(0.13, 0.13, 0.14, 28), btnMat);
  btn.rotation.x = Math.PI / 2;
  btn.position.set(2.2, -1.98, 0.45);
  scene.add(btn);
  var ledMat = new MeshBasicMaterial({ color: 0xb4d23a });
  var led = new Mesh(new SphereGeometry(0.035, 12, 8), ledMat);
  led.position.set(1.85, -1.98, 0.47);
  scene.add(led);

  scene.add(new HemisphereLight(0xcdd6e6, 0x2c2218, 0.55));
  var key = new DirectionalLight(0xfff0dc, 1.15);
  key.position.set(-6, 5, 7);
  scene.add(key);
  // The tube lighting its own surroundings, driven by how much of the
  // picture is lit.
  var screenLight = new PointLight(0x40ff60, 0, 14, 2);
  screenLight.position.set(0, 0, 1.4);
  scene.add(screenLight);

  var camera = new PerspectiveCamera(28, 1, 0.1, 100);
  var camBase = new Vector3(0, 0.15, 10);
  var camTarget = new Vector3(0, -0.22, 0);
  var parallax = new Vector2(0, 0);
  var parallaxGoal = new Vector2(0, 0);

  function layout() {
    // Re-read every time: browser zoom and moving the window to another
    // display both change the pixel ratio.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    var t = Math.tan((camera.fov * Math.PI) / 360);
    var dist = Math.max(2.3 / t, 2.75 / (t * camera.aspect));
    camBase.set(0, -0.1, dist + 0.45);
    camera.updateProjectionMatrix();
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

  function setPower(on) {
    if (!on) collapseGain = beamGain;
    powerState = on ? "warming" : "collapsing";
    powerT = 0;
    ledMat.color.set(on ? 0xb4d23a : 0x262b10);
    btn.position.z = on ? 0.45 : 0.5;
    wake(6);
  }
  btn.position.z = powerState === "on" ? 0.45 : 0.5;
  if (powerState !== "on") ledMat.color.set(0x262b10);

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

  // The flat site's occasional vertical-hold glitch is deliberately not
  // reproduced here: a set in good adjustment holds sync, and the whole
  // picture rolling every half minute read as a bug rather than character.

  // --- pointer -------------------------------------------------------------
  var raycaster = new Raycaster();
  var ndc = new Vector2();
  var overFace = false;

  function hitTest(ev) {
    var rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    var hits = raycaster.intersectObjects([face, btn], false);
    if (!hits.length) return null;
    if (hits[0].object === btn) return { button: true };
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

  canvas.addEventListener("pointermove", function (ev) {
    parallaxGoal.set((ev.clientX / window.innerWidth) * 2 - 1, (ev.clientY / window.innerHeight) * 2 - 1);
    wake(1.5);
    var hit = hitTest(ev);
    if (hit && hit.col !== undefined && powerState === "on") {
      overFace = true;
      relay("mousemove", hit, ev);
      canvas.style.cursor = screenEl.classList.contains("xterm-cursor-pointer") ? "pointer" : "text";
    } else {
      leaveFace();
      canvas.style.cursor = hit && hit.button ? "pointer" : "default";
    }
  });
  canvas.addEventListener("pointerleave", function () {
    leaveFace();
    parallaxGoal.set(0, 0);
    wake(1.5);
  });

  var downCell = null;
  canvas.addEventListener("pointerdown", function (ev) {
    // Keep the browser from moving focus to the canvas: keystrokes belong
    // to xterm's own input element.
    ev.preventDefault();
    term.focus();
    if (ev.button !== 0) return;
    var hit = hitTest(ev);
    downCell = null;
    if (!hit) return;
    if (hit.button) {
      crt.powerBtn.click();
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

  // --- frame loop ----------------------------------------------------------
  // Nothing is drawn unless something is changing: the phosphor is still
  // decaying, the camera is easing, or a power/roll animation is running.
  var activeUntil = 0;
  var lastTime = 0;
  var now = 0;
  function wake(seconds) {
    activeUntil = Math.max(activeUntil, now + seconds);
  }

  var first = true;
  function frame(ms) {
    if (dead) return;
    rafId = requestAnimationFrame(frame);
    now = ms / 1000;
    var dt = Math.min(now - lastTime, 0.25);
    lastTime = now;
    if (document.hidden) return;

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

    screenLight.intensity = 14 * apl * beamGain + 3 * faceMat.uniforms.uLine.value * 0.02;

    parallax.lerp(parallaxGoal, 1 - Math.exp(-dt * 5));
    camera.position.set(camBase.x + parallax.x * 0.38, camBase.y - parallax.y * 0.22, camBase.z);
    camera.lookAt(camTarget);

    renderer.render(scene, camera);

    // A shader error during that render already sent us to the flat site.
    if (dead) return;
    if (first) {
      first = false;
      document.body.appendChild(canvas);
      document.body.classList.add("gl-on");
    }
  }

  canvas.addEventListener("webglcontextlost", function (ev) {
    ev.preventDefault();
    fallback("WebGL context lost");
  });

  window.addEventListener("resize", layout);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", layout);
  layout();
  wake(1);
  var rafId = requestAnimationFrame(frame);

  teardown = function () {
    cancelAnimationFrame(rafId);
    window.removeEventListener("resize", layout);
    if (window.visualViewport) window.visualViewport.removeEventListener("resize", layout);
    powerObserver.disconnect();
    painter.dispose();
    targetA.dispose();
    targetB.dispose();
    signalTex.dispose();
    renderer.dispose();
  };

  // Debug handle for automated checks: where a given character cell ends up
  // on the page, so a test can click it.
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
      var v3 = new Vector3(x, y, z).project(camera);
      var rect = canvas.getBoundingClientRect();
      return {
        x: rect.left + ((v3.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - v3.y) / 2) * rect.height,
      };
    },
    hitTest: function (x, y) {
      return hitTest({ clientX: x, clientY: y });
    },
    state: function () {
      return { power: powerState, apl: apl, beamGain: beamGain };
    },
  };
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
    try {
      teardown();
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

// Small touches on the desk props that the bake can't carry: the printed
// spine label on the binder, and steam off the coffee. Both are added at
// load on top of the baked model, so neither needs a re-bake.
import {
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  Vector3,
} from "three";

// ---------------------------------------------------------------- binder
// The bake drew pencil scribble on the spine label, and since the light maps
// carry colour as well as light, the scribble is in them. The label is
// redrawn as its own quad just in front of the old one: the paper and print
// come from a canvas, the light from the same atlas texels with the
// scribble lifted out (each texel takes the brightest of its neighbours, so
// the dark strokes fill in with the paper around them).

// Paper colour the bake used for the label (BinderLabel in vt_room.py). The
// canvas is drawn relative to it: white on the canvas is that paper, as lit.
var PAPER = "#dcd8cb";
// How far in front of the baked label the new one sits, metres.
var LABEL_LIFT = 0.0003;

function hexLinear(hex) {
  return new Color(hex).convertSRGBToLinear();
}

// A colour drawn on the label canvas, as a fraction of the paper's albedo,
// re-encoded so a texture read hands back that fraction.
function onPaper(hex) {
  var c = hexLinear(hex);
  var p = hexLinear(PAPER);
  return new Color(Math.min(c.r / p.r, 1), Math.min(c.g / p.g, 1), Math.min(c.b / p.b, 1)).convertLinearToSRGB().getStyle();
}

// Width and height in canvas pixels; the face is 130 x 24 mm.
var LABEL_W = 1300;
var LABEL_H = 240;

function drawLabel(maxAniso) {
  var c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  var g = c.getContext("2d");
  var sans = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  var ink = onPaper("#1b1b1e");
  var accent = onPaper("#b5481f");
  var muted = onPaper("#57524a");

  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, LABEL_W, LABEL_H);

  // A printed band down the left end, with the edition in it reversed out.
  g.fillStyle = accent;
  g.fillRect(0, 0, 230, LABEL_H);
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "bold 92px " + sans;
  g.fillText("26.04", 115, 108);
  g.font = "bold 40px " + sans;
  g.fillText("LTS", 115, 178);

  // Title and subtitle.
  g.textAlign = "left";
  g.fillStyle = ink;
  g.font = "bold 104px " + sans;
  g.fillText("DUBUNTU", 268, 96);
  g.fillStyle = muted;
  g.font = "38px " + sans;
  g.fillText("System Administrator’s Handbook", 272, 176);

  // A rule and the volume number at the right end.
  g.fillStyle = ink;
  g.fillRect(1090, 34, 4, LABEL_H - 68);
  g.textAlign = "center";
  g.font = "bold 30px " + sans;
  g.fillText("VOL.", 1195, 80);
  g.font = "bold 92px " + sans;
  g.fillText("1", 1195, 160);

  var t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  return t;
}

// Copies the label's texels out of a light map, lifts the scribble out of
// them, and returns them as a small texture with a function that maps the
// atlas UVs to its own.
function cleanRegion(atlasTex, uvMin, uvMax) {
  var img = atlasTex.image;
  var W = img.width;
  var H = img.height;
  var PAD = 3;
  var x0 = Math.max(0, Math.floor(uvMin[0] * W) - PAD);
  var y0 = Math.max(0, Math.floor(uvMin[1] * H) - PAD);
  var x1 = Math.min(W, Math.ceil(uvMax[0] * W) + PAD);
  var y1 = Math.min(H, Math.ceil(uvMax[1] * H) + PAD);
  var w = x1 - x0;
  var h = y1 - y0;
  var c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  var g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  var src = g.getImageData(0, 0, w, h);
  var out = g.createImageData(w, h);
  // Only texels inside the label's own rectangle are trusted; the padding
  // may hold a neighbouring island.
  var ix0 = Math.ceil(uvMin[0] * W) - x0;
  var iy0 = Math.ceil(uvMin[1] * H) - y0;
  var ix1 = Math.floor(uvMax[0] * W) - x0 - 1;
  var iy1 = Math.floor(uvMax[1] * H) - y0 - 1;
  var R = 3;
  var s = src.data;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var best = -1;
      var bi = 0;
      var cx = Math.min(Math.max(x, ix0), ix1);
      var cy = Math.min(Math.max(y, iy0), iy1);
      for (var dy = -R; dy <= R; dy++) {
        var yy = cy + dy;
        if (yy < iy0 || yy > iy1) continue;
        for (var dx = -R; dx <= R; dx++) {
          var xx = cx + dx;
          if (xx < ix0 || xx > ix1) continue;
          var i = (yy * w + xx) * 4;
          var lum = s[i] * 0.3 + s[i + 1] * 0.59 + s[i + 2] * 0.11;
          if (lum > best) {
            best = lum;
            bi = i;
          }
        }
      }
      var o = (y * w + x) * 4;
      out.data[o] = s[bi];
      out.data[o + 1] = s[bi + 1];
      out.data[o + 2] = s[bi + 2];
      out.data[o + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  var t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.flipY = false;
  t.generateMipmaps = false;
  t.minFilter = t.magFilter = LinearFilter;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.channel = 1;
  return {
    texture: t,
    map: function (u, v) {
      return [(u * W - x0) / w, (v * H - y0) / h];
    },
  };
}

function binderLabel(binder, maps, range, makeMaterial, maxAniso) {
  var geo = binder.geometry;
  var pos = geo.attributes.position;
  var uv1 = geo.attributes.uv1;
  // The label is the face furthest out on the spine (local -x).
  var minX = Infinity;
  for (var i = 0; i < pos.count; i++) minX = Math.min(minX, pos.getX(i));
  var corners = [];
  for (i = 0; i < pos.count; i++) {
    if (pos.getX(i) < minX + 1e-4) corners.push(i);
  }
  if (corners.length !== 4) return null;

  var lo = [Infinity, Infinity];
  var hi = [-Infinity, -Infinity];
  var yLo = Infinity;
  var yHi = -Infinity;
  var zLo = Infinity;
  var zHi = -Infinity;
  corners.forEach(function (k) {
    lo[0] = Math.min(lo[0], uv1.getX(k));
    lo[1] = Math.min(lo[1], uv1.getY(k));
    hi[0] = Math.max(hi[0], uv1.getX(k));
    hi[1] = Math.max(hi[1], uv1.getY(k));
    yLo = Math.min(yLo, pos.getY(k));
    yHi = Math.max(yHi, pos.getY(k));
    zLo = Math.min(zLo, pos.getZ(k));
    zHi = Math.max(zHi, pos.getZ(k));
  });

  var room = cleanRegion(maps.room, lo, hi);
  var screen = cleanRegion(maps.screen, lo, hi);

  // Two triangles over the same corners, facing out of the spine. Seen from
  // the desk the label reads left to right along local +z, bottom to top
  // along +y.
  var order = corners.slice().sort(function (a, b) {
    return pos.getY(a) - pos.getY(b) || pos.getZ(a) - pos.getZ(b);
  });
  // order: bottom-left, bottom-right, top-left, top-right (by y then z)
  var p = [];
  var t0 = [];
  var t1 = [];
  order.forEach(function (k) {
    p.push(pos.getX(k) - LABEL_LIFT, pos.getY(k), pos.getZ(k));
    t0.push((pos.getZ(k) - zLo) / (zHi - zLo), (pos.getY(k) - yLo) / (yHi - yLo));
    var m = room.map(uv1.getX(k), uv1.getY(k));
    t1.push(m[0], m[1]);
  });
  var g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(p, 3));
  g.setAttribute("uv", new Float32BufferAttribute(t0, 2));
  g.setAttribute("uv1", new Float32BufferAttribute(t1, 2));
  // Facing -x: counter-clockwise seen from there.
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.computeVertexNormals();

  var label = drawLabel(maxAniso);
  var mat = makeMaterial({ room: room.texture, screen: screen.texture }, label);
  var mesh = new Mesh(g, mat);
  mesh.name = "BinderLabelPrint";
  binder.add(mesh);
  return {
    mesh: mesh,
    textures: [label, room.texture, screen.texture],
    material: mat,
  };
}

// ---------------------------------------------------------------- steam
// Two soft sheets of drifting noise over the cup, turned to face the camera
// about the mug's own vertical. Heights are metres in the mug's space; its
// rim is at 0.095 and the coffee at 0.068.
var STEAM_BASE = 0.082;
var STEAM_HEIGHT = 0.17;
var STEAM_WIDTH = 0.11;

var STEAM_VERT = [
  "varying vec2 vUv;",
  "void main() {",
  "  vUv = uv;",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
  "}",
].join("\n");

var STEAM_FRAG = [
  "uniform float uTime;",
  "uniform float uSeed;",
  "uniform vec3 uColor;",
  "uniform float uAlpha;",
  "varying vec2 vUv;",
  "float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
  "float noise(vec2 p) {",
  "  vec2 i = floor(p), f = fract(p);",
  "  vec2 u = f * f * (3.0 - 2.0 * f);",
  "  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);",
  "}",
  "float fbm(vec2 p) {",
  "  float a = 0.5, s = 0.0;",
  "  for (int k = 0; k < 4; k++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }",
  "  return s;",
  "}",
  "void main() {",
  "  float y = vUv.y;",
  "  float t = uTime * 0.55 + uSeed * 10.0;",
  // The column wanders more the higher it rises, and drifts as it goes.
  "  float sway = (fbm(vec2(y * 2.2 - t * 0.35, uSeed * 3.0)) - 0.5) * 0.55 * y;",
  "  float x = (vUv.x - 0.5) - sway;",
  // Narrow over the cup, spreading as it climbs.
  "  float halfW = mix(0.16, 0.42, y);",
  "  float body = 1.0 - smoothstep(halfW * 0.25, halfW, abs(x));",
  // Wisps: noise stretched along the rise, scrolled up.
  "  vec2 q = vec2(x * 5.0, y * 2.4 - t);",
  "  float w = fbm(q + vec2(fbm(q * 1.7 + t * 0.2), 0.0));",
  "  w = smoothstep(0.36, 0.8, w);",
  "  float fade = smoothstep(0.0, 0.18, y) * (1.0 - smoothstep(0.45, 1.0, y));",
  "  float a = body * w * fade * uAlpha;",
  "  if (a < 0.002) discard;",
  "  gl_FragColor = vec4(uColor, a);",
  "  #include <colorspace_fragment>",
  "}",
].join("\n");

function mugSteam(mug, reducedMotion) {
  var group = [];
  var mats = [];
  var geo = new PlaneGeometry(STEAM_WIDTH, STEAM_HEIGHT);
  geo.translate(0, STEAM_HEIGHT / 2, 0);
  [0.0, 0.37].forEach(function (seed, i) {
    var mat = new ShaderMaterial({
      vertexShader: STEAM_VERT,
      fragmentShader: STEAM_FRAG,
      uniforms: {
        uTime: { value: 3.0 },
        uSeed: { value: seed },
        // Warmish grey: steam lit by the desk lamp, against a dusk room.
        uColor: { value: new Color(0.78, 0.74, 0.69) },
        uAlpha: { value: i === 0 ? 0.42 : 0.3 },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    var m = new Mesh(geo, mat);
    m.name = "MugSteam" + i;
    m.position.set(0, STEAM_BASE, (i - 0.5) * 0.012);
    m.renderOrder = 2;
    // Never stops a click or a pointer ray.
    m.raycast = function () {};
    mug.add(m);
    group.push(m);
    mats.push(mat);
  });

  var camLocal = new Vector3();
  return {
    meshes: group,
    geometry: geo,
    materials: mats,
    // Turns the sheets to the camera about the mug's vertical, and moves the
    // wisps along. Returns true while it wants more frames.
    step: function (dt, camera) {
      camLocal.copy(camera.position);
      mug.worldToLocal(camLocal);
      var yaw = Math.atan2(camLocal.x, camLocal.z);
      group.forEach(function (m) {
        m.rotation.set(0, yaw, 0);
      });
      if (reducedMotion) return false;
      mats.forEach(function (mat) {
        mat.uniforms.uTime.value += dt;
      });
      return true;
    },
  };
}

// ---------------------------------------------------------------- public
// `model` is what buildModel returned. Anything the file doesn't have (an
// older bake without the binder, say) is quietly skipped.
export function dressProps(model, maxAniso) {
  var textures = [];
  var materials = [];
  var geometries = [];
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var binder = model.root.getObjectByName("Binder");
  if (binder && binder.isMesh && binder.userData.atlas) {
    var atlas = binder.userData.atlas;
    var label = binderLabel(
      binder,
      model.maps[atlas],
      model.ranges[atlas],
      function (maps, map) {
        return model.makeBakedMaterial(maps, atlas, map);
      },
      maxAniso
    );
    if (label) {
      textures = textures.concat(label.textures);
      materials.push(label.material);
      geometries.push(label.mesh.geometry);
    }
  }

  var steam = null;
  var mug = model.root.getObjectByName("Mug");
  if (mug) {
    steam = mugSteam(mug, reduce);
    materials = materials.concat(steam.materials);
    geometries.push(steam.geometry);
  }

  return {
    textures: textures,
    step: function (dt, camera) {
      return steam ? steam.step(dt, camera) : false;
    },
    dispose: function () {
      textures.forEach(function (t) {
        t.dispose();
      });
      materials.forEach(function (m) {
        m.dispose();
      });
      geometries.forEach(function (g) {
        g.dispose();
      });
    },
  };
}

// Where the picture sits on the tube face. One set of constants feeds both
// the fragment shader (face point -> which dot of the video signal is lit
// there) and the pointer code (clicked face point -> which character cell),
// so the two can never disagree about where a character is.
//
// The numbers model an MDA / IBM 5151-class text display: 80x25 characters
// in a 9x14 dot cell = 720x350 dots. A real terminal underscans - the raster
// stops well short of the bezel, leaving a border of unlit phosphor - and is
// never geometrically perfect: a touch of residual pincushion, a fraction of
// a degree of yoke tilt, slightly off-centre. Those errors are fixed
// properties of one particular set's adjustment, so they are constants here
// and never animated.
export var RASTER = {
  cols: 80,
  rows: 25,
  cellW: 9,
  cellH: 14,
  width: 720,
  height: 350,
  // Fraction of the visible face (the bezel opening) the raster covers.
  scaleX: 0.88,
  scaleY: 0.84,
  // Centring error, in face half-widths.
  offsetX: 0.006,
  offsetY: -0.004,
  // Yoke tilt in radians (about a quarter of a degree).
  tilt: 0.0044,
  // Residual pincushion: corners pulled outward by about 1%.
  pincushion: 0.012,
  aspect: 4 / 3,
};

// Face coordinates: (-1,-1) is the bottom-left corner of the bezel opening,
// (1,1) the top-right. Returns signal coordinates with (0,0) at the TOP-left
// dot of the raster and (1,1) at the bottom-right, i.e. the order the beam
// scans and the order terminal rows are numbered.
export function faceToRaster(px, py) {
  var r = RASTER;
  var x = (px - r.offsetX) * r.aspect;
  var y = py - r.offsetY;
  var c = Math.cos(r.tilt);
  var s = Math.sin(r.tilt);
  var rx = (c * x + s * y) / r.aspect;
  var ry = -s * x + c * y;
  rx /= r.scaleX;
  ry /= r.scaleY;
  var k = 1 - r.pincushion * (rx * rx + ry * ry);
  rx *= k;
  ry *= k;
  return { u: rx * 0.5 + 0.5, v: 0.5 - ry * 0.5 };
}

function f(n) {
  return n.toFixed(6);
}

// Same mapping as faceToRaster above, as GLSL. `breath` scales the raster
// about its centre: EHT sag makes the picture grow slightly when the beam
// current rises, and the power-on settle starts a little oversized.
export var RASTER_GLSL =
  "vec2 faceToRaster(vec2 p, float breath){\n" +
  "  vec2 q = p - vec2(" + f(RASTER.offsetX) + "," + f(RASTER.offsetY) + ");\n" +
  "  q.x *= " + f(RASTER.aspect) + ";\n" +
  "  float c = " + f(Math.cos(RASTER.tilt)) + ";\n" +
  "  float s = " + f(Math.sin(RASTER.tilt)) + ";\n" +
  "  q = vec2(c*q.x + s*q.y, -s*q.x + c*q.y);\n" +
  "  q.x /= " + f(RASTER.aspect) + ";\n" +
  "  q /= vec2(" + f(RASTER.scaleX) + "," + f(RASTER.scaleY) + ") * breath;\n" +
  "  q *= 1.0 - " + f(RASTER.pincushion) + " * dot(q, q);\n" +
  "  return vec2(q.x*0.5 + 0.5, 0.5 - q.y*0.5);\n" +
  "}\n";

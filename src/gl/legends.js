// Key legends. The baked maps carry the colour of the plastic; the printing
// on it is drawn here at load, on a canvas, from the properties each key
// node carries, and multiplied over the baked colour. White therefore means
// "nothing printed".
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from "three";

// The atlas the keys' first UV set addresses: 16 x 8 cells, numbered left to
// right, top row first. A cap's top face is stretched over its cell less a
// 6% border; every side face of the cap samples the single point 90% across
// and 90% down the cell, which must stay white.
var COLS = 16;
var ROWS = 8;
var CELL_PX = 128;
var INSET = 0.06;
var SIDE_POINT = 0.9;

// Printing on these caps is small, thin and sits in the top-left corner.
// Sizes are in millimetres on the cap. (Medium weight, not light: at the
// size a key has on screen a lighter face filters away to nothing.)
var FONT = 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';
var INK = "#262422";
var MARGIN_X = 1.7;
var MARGIN_Y = 1.5;
var GLYPH_MM = 4.6; // a lone letter or figure
var PAIR_MM = 3.7; // shifted glyph above, plain glyph below
var WORD_MM = 2.7; // "Shift", "Return", "Prev / Screen"
var LINE = 1.22; // line pitch, in font sizes

// Function-strip labels: one line of small type centred over each key.
var STRIP_PX = 4096;
var STRIP_TEXT_MM = 2.4;
var STRIP_MAX_MM = 17;

function isWord(s) {
  return s.length > 1;
}

function drawKey(ctx, k) {
  var legend = k.legend || "";
  var second = k.legend2 || "";
  if (!legend && !second) return;
  var wMm = k.top_w * 1000;
  var hMm = k.top_h * 1000;
  var cell = CELL_PX * (1 - 2 * INSET);
  var x0 = ((k.cell % COLS) + INSET) * CELL_PX;
  var y0 = (Math.floor(k.cell / COLS) + INSET) * CELL_PX;
  ctx.save();
  // Millimetres on the cap from here on. The cell is square but the cap is
  // not, so the two axes scale differently and the type comes out
  // undistorted on the key.
  ctx.setTransform(cell / wMm, 0, 0, cell / hMm, x0, y0);
  // Stop short of the corner the side faces sample.
  var sideX = ((SIDE_POINT - INSET) / (1 - 2 * INSET)) * wMm;
  var maxW = sideX - MARGIN_X - 1.2;

  var lines;
  var size;
  if (k.stack === "shift") {
    lines = [second, legend];
    size = PAIR_MM;
  } else if (isWord(legend) || second) {
    lines = second ? [legend, second] : [legend];
    size = WORD_MM;
  } else {
    lines = [legend];
    size = GLYPH_MM;
  }
  ctx.font = "500 " + size + "px " + FONT;
  for (var i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], MARGIN_X, MARGIN_Y + i * size * LINE, maxW);
  }
  ctx.restore();
}

function finish(canvas, anisotropy) {
  var tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  // glTF texture coordinates have their origin at the top-left, like the
  // canvas.
  tex.flipY = false;
  // Seen small and at a slant, fine print shimmers without these.
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = anisotropy;
  return tex;
}

function blank(w, h) {
  var canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = INK;
  ctx.textBaseline = "top";
  return ctx;
}

// `keys` are the key nodes (their userData is the glTF extras); `strip` is
// the LegendStrip mesh. Returns { keys, strip } textures.
export function drawLegends(keys, strip, anisotropy) {
  var ctx = blank(COLS * CELL_PX, ROWS * CELL_PX);
  ctx.textAlign = "left";
  keys.forEach(function (key) {
    drawKey(ctx, key.userData);
  });

  // The strip's UV runs 0..1 along its length and across its depth, with
  // the edge nearest the keys at the bottom of the canvas.
  strip.geometry.computeBoundingBox();
  var box = strip.geometry.boundingBox;
  var lengthMm = (strip.userData.x1 - strip.userData.x0) * 1000;
  var depthMm = (box.max.z - box.min.z) * 1000;
  var pxPerMm = STRIP_PX / lengthMm;
  // Next power of two that gives the depth at least the same resolution.
  var stripH = Math.pow(2, Math.ceil(Math.log(depthMm * pxPerMm) / Math.LN2));
  var sctx = blank(STRIP_PX, stripH);
  sctx.setTransform(pxPerMm, 0, 0, stripH / depthMm, 0, 0);
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.font = "500 " + STRIP_TEXT_MM + "px " + FONT;
  keys.forEach(function (key) {
    var k = key.userData;
    if (k.strip) sctx.fillText(k.strip, k.strip_u * lengthMm, depthMm / 2, STRIP_MAX_MM);
  });

  return {
    keys: finish(ctx.canvas, anisotropy),
    strip: finish(sctx.canvas, anisotropy),
  };
}

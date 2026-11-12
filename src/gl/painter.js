import { RASTER } from "./raster.js";
import { FONT_W, FONT_H, GLYPHS } from "./font9x14.js";

// Turns the terminal's character buffer into the video signal a text
// display's character generator would produce: for every dot of the
// 720x350 raster, how hard the beam is driven (0-255).
//
// A monochrome terminal has no fonts and no weights. The character ROM
// holds one dot pattern per character; "bold" and "dim" are the video
// amplifier driving the same dots harder or softer, and underline is one
// extra lit scanline near the bottom of the cell. That is why the
// attributes are intensities here rather than different glyph shapes.
var LEVEL_NORMAL = 184;
var LEVEL_BOLD = 255;
var LEVEL_DIM = 97;
var UNDERLINE_ROW = 12;
var CURSOR_BLINK_MS = 530;

export function createPainter(term) {
  var W = RASTER.width;
  var H = RASTER.height;
  var data = new Uint8Array(W * H);
  var glyphCache = {};
  var fallbackCtx = null;

  // Characters the ROM above doesn't have (cmatrix's half-width katakana,
  // anything a visitor pastes) are rasterised once from a system font and
  // thresholded to dots. Not authentic to any real character generator, but
  // better than a blank cell.
  function fallbackGlyph(ch) {
    if (!fallbackCtx) {
      var c = document.createElement("canvas");
      c.width = FONT_W;
      c.height = FONT_H;
      fallbackCtx = c.getContext("2d", { willReadFrequently: true });
      fallbackCtx.textBaseline = "alphabetic";
      fallbackCtx.textAlign = "center";
    }
    var ctx = fallbackCtx;
    ctx.clearRect(0, 0, FONT_W, FONT_H);
    ctx.fillStyle = "#fff";
    ctx.font = "11px monospace";
    ctx.fillText(ch, (FONT_W - 1) / 2, 11);
    var px = ctx.getImageData(0, 0, FONT_W, FONT_H).data;
    var bits = new Uint8Array(FONT_W * FONT_H);
    for (var i = 0; i < bits.length; i++) bits[i] = px[i * 4 + 3] > 96 ? 1 : 0;
    return bits;
  }

  function glyphFor(ch) {
    var g = glyphCache[ch];
    if (g) return g;
    var rows = GLYPHS[ch];
    if (rows) {
      g = new Uint8Array(FONT_W * FONT_H);
      for (var y = 0; y < FONT_H; y++) {
        for (var x = 0; x < FONT_W; x++) {
          if (rows[y].charCodeAt(x) === 35) g[y * FONT_W + x] = 1;
        }
      }
    } else {
      g = fallbackGlyph(ch);
    }
    glyphCache[ch] = g;
    return g;
  }

  var cursorVisible = true;
  var blinkOn = true;
  var dirty = true;

  // Whether the application has hidden the cursor (cmatrix does) isn't part
  // of xterm's public state, so watch the escape sequences that change it.
  // Returning false lets xterm's own handler run as well.
  function watchCursorMode(final, value) {
    return term.parser.registerCsiHandler({ prefix: "?", final: final }, function (params) {
      for (var i = 0; i < params.length; i++) {
        if (params[i] === 25) {
          cursorVisible = value;
          dirty = true;
        }
      }
      return false;
    });
  }
  var cursorHooks = [watchCursorMode("h", true), watchCursorMode("l", false)];

  function markDirty() {
    dirty = true;
  }
  // A blink only changes the picture if the cursor is actually on screen.
  function blink() {
    blinkOn = !blinkOn;
    var buf = term.buffer.active;
    if (cursorVisible && buf.viewportY === buf.baseY) dirty = true;
  }
  var blinkTimer = setInterval(blink, CURSOR_BLINK_MS);
  var subscriptions = [
    term.onWriteParsed(markDirty),
    term.onScroll(markDirty),
    term.onResize(markDirty),
    term.onCursorMove(function () {
      // A real terminal's cursor doesn't blink out mid-keystroke either:
      // moving it restarts the blink from "on".
      blinkOn = true;
      dirty = true;
      clearInterval(blinkTimer);
      blinkTimer = setInterval(blink, CURSOR_BLINK_MS);
    }),
  ];

  var cell = null;

  // Repaints the whole raster. 80x25 cells of 126 dots is small enough that
  // tracking dirty rows isn't worth the bookkeeping. Returns the average
  // picture level (0-1): how much of the screen is lit, which is what the
  // beam current - and so the light the tube throws on the desk - follows.
  function paint() {
    dirty = false;
    data.fill(0);
    var buf = term.buffer.active;
    if (!cell) cell = buf.getNullCell();
    var cols = Math.min(RASTER.cols, term.cols);
    var rows = Math.min(RASTER.rows, term.rows);
    var atBottom = buf.viewportY === buf.baseY;
    // After printing into the last column the cursor is parked one past
    // it until the next character wraps; draw it on the last column, as
    // xterm's own renderer does.
    var cursorX = Math.min(buf.cursorX, cols - 1);
    var sum = 0;

    for (var row = 0; row < rows; row++) {
      var line = buf.getLine(buf.viewportY + row);
      if (!line) continue;
      for (var col = 0; col < cols; col++) {
        line.getCell(col, cell);
        var chars = cell.getChars();
        var isCursor =
          cursorVisible && blinkOn && atBottom && row === buf.cursorY && col === cursorX;
        if (!chars && !isCursor && !cell.isInverse()) continue;

        var level = cell.isBold() ? LEVEL_BOLD : cell.isDim() ? LEVEL_DIM : LEVEL_NORMAL;
        var inverse = !!cell.isInverse() !== isCursor;
        var underline = !!cell.isUnderline();
        var glyph = chars && chars !== " " && !cell.isInvisible() ? glyphFor(chars) : null;

        var x0 = col * FONT_W;
        var y0 = row * FONT_H;
        for (var gy = 0; gy < FONT_H; gy++) {
          var off = (y0 + gy) * W + x0;
          for (var gx = 0; gx < FONT_W; gx++) {
            var lit = glyph ? glyph[gy * FONT_W + gx] === 1 : false;
            if (underline && gy === UNDERLINE_ROW) lit = true;
            if (inverse) lit = !lit;
            if (lit) {
              data[off + gx] = level;
              sum += level;
            }
          }
        }
      }
    }
    return sum / (255 * W * H);
  }

  return {
    data: data,
    paint: paint,
    isDirty: function () {
      return dirty;
    },
    dispose: function () {
      clearInterval(blinkTimer);
      subscriptions.concat(cursorHooks).forEach(function (d) {
        d.dispose();
      });
    },
  };
}

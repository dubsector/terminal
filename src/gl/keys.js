// The modelled keyboard: keys dip when the matching real key goes down, and
// a key clicked or tapped on the model types into the terminal.
//
// Each Key_* node carries `code` (the KeyboardEvent.code it stands for, or
// VT_<name> for keys a modern keyboard has no twin of), its legends, and
// `travel`, in metres, along the keyboard's own downward axis.

// A keystroke bottoms out in a few hundredths of a second and the spring
// takes about twice as long to return the cap.
var DOWN_S = 0.03;
var UP_S = 0.07;

// What xterm sends for the keys that are not printable, so a click arrives
// at the shell exactly as the real key would.
var SEQUENCES = {
  Enter: "\r",
  NumpadEnter: "\r",
  // The key above Return (the LK201's <x] delete key).
  Backspace: "\x7f",
  Tab: "\t",
  Space: " ",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  // The editing block sends what its legends say, as a VT220 does. The
  // codes are the modern keys in the same places (what the real keyboard
  // dips), not what is printed on the caps.
  Insert: "\x1b[1~", // Find
  Home: "\x1b[2~", // Insert Here
  PageUp: "\x1b[3~", // Remove
  Delete: "\x1b[4~", // Select
  End: "\x1b[5~", // Prev Screen
  PageDown: "\x1b[6~", // Next Screen
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  // Labelled ESC, BS and LF on the strip above them.
  F11: "\x1b",
  F12: "\b",
  F13: "\n",
};

function isShift(code) {
  return code === "ShiftLeft" || code === "ShiftRight";
}
function isControl(code) {
  return code === "ControlLeft" || code === "ControlRight";
}

// The character a key prints, from its legends: keys with a shifted glyph
// carry both; letters carry one capital.
function printable(k, shift, lock) {
  var legend = k.legend || "";
  if (k.stack === "shift") return shift ? k.legend2 : legend;
  if (legend.length !== 1) return null;
  var lower = legend.toLowerCase();
  if (lower === legend.toUpperCase()) return legend;
  return shift !== lock ? legend.toUpperCase() : lower;
}

// Ctrl with a letter or one of @ [ \ ] ^ _ gives the control code five bits
// wide, as on any ASCII terminal.
function withControl(ch) {
  if (ch === " ") return "\x00";
  var c = ch.toUpperCase().charCodeAt(0);
  return ch.length === 1 && c >= 64 && c <= 95 ? String.fromCharCode(c - 64) : ch;
}

// `nodes` are the Key_* objects; `type(data)` sends input to the terminal;
// `onLock(lit)` is told when the Lock indicator should change; `wake()` asks
// for frames while caps are moving.
export function createKeys(nodes, type, onLock, wake) {
  var keys = nodes.map(function (node) {
    return {
      node: node,
      code: node.userData.code,
      rest: node.position.y,
      travel: node.userData.travel || 0,
      pos: 0,
      held: false, // by the real keyboard
      latched: false, // sticky modifier clicked on the model
    };
  });
  var byCode = {};
  keys.forEach(function (k) {
    byCode[k.code] = k;
  });

  var pointerKey = null;
  var stickyShift = false;
  var stickyControl = false;
  var lock = false;
  var capsLock = false;
  var lockLit = false;

  function refreshLock() {
    var lit = lock || capsLock;
    if (lit !== lockLit) {
      lockLit = lit;
      onLock(lit);
      wake();
    }
  }

  function latch(test, on) {
    keys.forEach(function (k) {
      if (test(k.code)) k.latched = on;
    });
  }

  function typeKey(k) {
    var code = k.code;
    if (isShift(code)) {
      stickyShift = !stickyShift;
      latch(isShift, stickyShift);
      return;
    }
    if (isControl(code)) {
      stickyControl = !stickyControl;
      latch(isControl, stickyControl);
      return;
    }
    if (code === "CapsLock") {
      lock = !lock;
      refreshLock();
      return;
    }
    var data = SEQUENCES[code];
    if (data === undefined) {
      data = printable(k.node.userData, stickyShift, lock || capsLock);
      if (data && stickyControl) data = withControl(data);
    } else if (data === " " && stickyControl) {
      data = withControl(data);
    } else if (code === "Tab" && stickyShift) {
      data = "\x1b[Z";
    }
    // Keys with no modern meaning only move.
    if (!data) return;
    // A sticky Shift or Ctrl applies to one keystroke.
    unlatch();
    type(data);
  }

  function unlatch() {
    stickyShift = stickyControl = false;
    latch(function (c) {
      return isShift(c) || isControl(c);
    }, false);
  }

  return {
    // Real keyboard, by KeyboardEvent.code. Only the picture changes: the
    // keystroke itself reaches the terminal the usual way.
    setHeld: function (code, down) {
      var k = byCode[code];
      if (!k || k.held === down) return;
      k.held = down;
      // A real keystroke is the one a sticky modifier was waiting for, and
      // it never saw it, so let go rather than catch the one after.
      if (down && !isShift(code) && !isControl(code) && (stickyShift || stickyControl)) unlatch();
      wake();
    },
    // From any event that can report it.
    setCapsLock: function (on) {
      capsLock = on;
      refreshLock();
    },
    pointerDown: function (node) {
      pointerKey = byCode[node.userData.code] || null;
      if (!pointerKey) return;
      typeKey(pointerKey);
      wake();
    },
    pointerUp: function () {
      if (!pointerKey) return;
      pointerKey = null;
      wake();
    },
    // Focus went elsewhere, so the keyups will never arrive.
    releaseAll: function () {
      keys.forEach(function (k) {
        k.held = false;
      });
      pointerKey = null;
      wake();
    },
    // Moves the caps; true while any is still travelling.
    step: function (dt) {
      var moving = false;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var goal = k.held || k.latched || k === pointerKey ? 1 : 0;
        if (k.pos === goal) continue;
        // Three time constants in the quoted time: an ease that is all but
        // complete by then.
        k.pos += (goal - k.pos) * (1 - Math.exp((-3 * dt) / (goal ? DOWN_S : UP_S)));
        if (Math.abs(goal - k.pos) < 0.01) k.pos = goal;
        else moving = true;
        k.node.position.y = k.rest - k.travel * k.pos;
      }
      return moving;
    },
  };
}

// Where the viewer sits, worked out from the model rather than typed in: a
// seated view with the terminal and the whole keyboard in frame, so every
// key can be clicked without the view moving. The camera drifts a little
// with the pointer, the way a head moves. A tall window (a phone) cannot fit
// the keyboard at a size a finger can hit, so there a tap on the keys eases
// to a closer look down at them.
import { Vector3 } from "three";

// Focal length on a 36 mm frame, measured along the window's longer side.
// In a landscape window the terminal's height decides how far back the eye
// sits, so the lens changes the perspective and not how big the terminal
// is. A longer lens, from further back, flattens the desk between the
// terminal and the keyboard and so brings the keys up into the bottom of
// the frame; a wide one would push them out of it.
var LENS_MM = 60;
// In a tall window it is the width that decides, and that lens along the
// long side would put the eye metres away, behind where the room was built
// to be seen from. A shorter one keeps it at the desk.
var LENS_TALL_MM = 40;
// The window shape from which the tall arrangement applies in full; it
// fades in below square.
var TALL_ASPECT = 0.8;

// In a landscape window the line of sight starts this much (metres) below
// the model's Cam_Seat. A flatter line squashes the keyboard's depth on
// screen and leaves more of the height to the terminal; the eye then steps
// back along it until everything fits. The model only has the faces that
// can be seen from the eye positions its bake tried (viewpoints() in
// tools/blender/build_scene.py), whose lower limit is a line rising from
// 0.24 m above the desk at 0.62 m back to 0.45 m at 1.62 m, and the eye has
// to stay above it, head movement (about 1.3 cm) included, out to 21:9.
var EYE_DROP_M = 0.05;


// The seated view looks along the line the model's Cam_Seat and Cam_Target
// mark out; how far back the eye sits along it depends on the window. The
// terminal and the whole keyboard always fit, with this much of the frame
// spare around them.
var SEAT_MARGIN = 0.015;
// In a tall window the keyboard is much the wider of the two, and fitting
// all of it would halve the size of the picture; what is fitted across the
// window there is the terminal and the typing keys, Ctrl to Return (these
// mark that block's right-hand edge). The editing keys and the keypad run
// off the right.
var TYPING_EDGE = ["Enter", "Backspace", "ShiftRight"];
// This share of the height still spare goes above the terminal, as wall,
// and the rest below the keyboard, as desk.
var SPARE_ABOVE = 0.5;

// Looking down at the keys: the seated line of sight tipped this much
// further down, from wherever shows the whole keyboard. In a tall window the
// whole keyboard across would make the keys too small to tap, so only the
// typing keys (see TYPING_EDGE) are fitted across it, from close enough that
// the steep tip stays inside the eye positions the model was baked for.
var LOOK_DOWN_RAD = (30 * Math.PI) / 180;
var LOOK_DOWN_MARGIN = 0.06;
// The keyboard sits low in that view, with this share of the spare height
// above it, so the foot of the terminal stays in sight. (A tall window
// keeps the whole terminal in sight above the keyboard instead.)
var LOOK_DOWN_ABOVE = 0.85;
var LOOK_EASE_S = 0.22;

// Head movement with the pointer, in tube units (one is about 61 mm).
var PARALLAX_X = 0.38;
var PARALLAX_Y = 0.22;
var PARALLAX_RATE = 5;

function vertices(objects) {
  var out = [];
  var v = new Vector3();
  objects.forEach(function (o) {
    var p = o.geometry && o.geometry.attributes.position;
    if (!p) return;
    for (var i = 0; i < p.count; i++) out.push(v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).clone());
  });
  return out;
}

// For a camera looking along a fixed direction, the limits a set of points
// puts on where its eye can be. With the eye at (cx, cy, cz) in the camera's
// own right/up/forward axes and a half-field whose tangent is t, a point is
// in frame while |x - cx| <= (z - cz) t, which rearranges to
//   lo + cz t <= cx <= hi - cz t
// and the same for y. All the points fit once cz <= (hi - lo) / 2t.
function span(points, axis, forward, t) {
  var lo = -Infinity;
  var hi = Infinity;
  for (var i = 0; i < points.length; i++) {
    var a = points[i].dot(axis);
    var z = points[i].dot(forward);
    lo = Math.max(lo, a - z * t);
    hi = Math.min(hi, a + z * t);
  }
  return { lo: lo, hi: hi, mid: (lo + hi) / 2, depth: (hi - lo) / (2 * t) };
}

function mix(a, b, k) {
  return a + (b - a) * k;
}

// `model` is what buildModel returns. `terminal` and `keyboard` are the
// meshes that make up each (the keyboard's without its keys).
export function createRig(camera, model, terminal, keyboard) {
  var up = model.up;
  // Seat and target are both on the set's centre line, so which way is
  // "right" does not depend on how high the eye is.
  var right = new Vector3().subVectors(model.target, model.seat).cross(up).normalize();

  var terminalPts = vertices(terminal);
  var keyPts = model.keys.map(function (k) {
    return new Vector3().setFromMatrixPosition(k.matrixWorld);
  });
  var keyboardPts = vertices(keyboard).concat(keyPts);
  // The typing keys: everything not to the right of Return. Should a model
  // name none of the keys that mark that edge, all of them count.
  var edge = -Infinity;
  model.keys.forEach(function (k) {
    if (TYPING_EDGE.indexOf(k.userData.code) >= 0) edge = Math.max(edge, k.position.x);
  });
  var typingPts = vertices(
    model.keys.filter(function (k) {
      return edge === -Infinity || k.position.x <= edge + 1e-4;
    })
  );
  var keyCentre = new Vector3();
  keyPts.forEach(function (p) {
    keyCentre.addScaledVector(p, 1 / keyPts.length);
  });

  var seat = { eye: new Vector3(), target: new Vector3() };
  var down = { eye: new Vector3(), target: new Vector3() };
  var forward = new Vector3();
  var top = new Vector3();
  var downForward = new Vector3();
  var downTop = new Vector3();
  var tall = 0;
  var laidOut = false;
  var look = 0;
  var parallax = { x: 0, y: 0 };
  var eye = new Vector3();
  var aim = new Vector3();

  function place(pose, fwd, upward, cx, cy, cz, aimAt) {
    pose.eye.set(0, 0, 0).addScaledVector(right, cx).addScaledVector(upward, cy).addScaledVector(fwd, cz);
    // Aim at the point on the line of sight level with `aimAt`, so that
    // parallax turns the head about something in the scene.
    pose.target.copy(pose.eye).addScaledVector(fwd, aimAt.dot(fwd) - cz);
  }

  function layout(aspect) {
    tall = Math.min(Math.max((1 - aspect) / (1 - TALL_ASPECT), 0), 1);
    tall = tall * tall * (3 - 2 * tall);
    var tLong = 18 / mix(LENS_MM, LENS_TALL_MM, tall);
    var tx = aspect >= 1 ? tLong : tLong * aspect;
    var ty = aspect >= 1 ? tLong / aspect : tLong;
    camera.aspect = aspect;
    camera.fov = (Math.atan(ty) * 360) / Math.PI;
    camera.updateProjectionMatrix();

    var from = model.seat.clone().addScaledVector(up, (-EYE_DROP_M * (1 - tall)) / model.unit);
    forward.subVectors(model.target, from).normalize();
    top.crossVectors(right, forward);

    // Seated: from as far back as fits the terminal and the whole keyboard
    // both ways (in a tall window, only the typing keys across).
    var sx = tx * (1 - SEAT_MARGIN);
    var sy = ty * (1 - SEAT_MARGIN);
    var h = span(terminalPts.concat(keyboardPts), right, forward, sx);
    var wide = span(terminalPts.concat(typingPts), right, forward, sx);
    var all = span(terminalPts.concat(keyboardPts), top, forward, sy);
    var cz = Math.min(mix(h.depth, wide.depth, tall), all.depth);
    // Whatever height is still spare is shared out above and below.
    var cy = mix(all.lo + cz * sy, all.hi - cz * sy, SPARE_ABOVE);
    place(seat, forward, top, mix(h.mid, wide.mid, tall), cy, cz, new Vector3());

    // Looking down: the whole keyboard, side to side and front to back.
    var tip = LOOK_DOWN_RAD;
    downForward.copy(forward).multiplyScalar(Math.cos(tip)).addScaledVector(top, -Math.sin(tip));
    downTop.crossVectors(right, downForward);
    var dx = tx * (1 - LOOK_DOWN_MARGIN);
    var dy = ty * (1 - LOOK_DOWN_MARGIN);
    var kh = span(keyboardPts, right, downForward, dx);
    var th = span(typingPts, right, downForward, dx);
    var kv = span(keyboardPts, downTop, downForward, dy);
    var kz = Math.min(mix(kh.depth, th.depth, tall), kv.depth);
    var ky = mix(kv.lo + kz * dy, kv.hi - kz * dy, LOOK_DOWN_ABOVE);
    // With height to spare, the terminal as well, the pair in the middle.
    var both = span(terminalPts.concat(keyboardPts), downTop, downForward, dy);
    var blo = both.lo + kz * dy;
    var bhi = both.hi - kz * dy;
    if (blo <= bhi) ky = mix(ky, mix(blo, bhi, SPARE_ABOVE), tall);
    place(down, downForward, downTop, mix(kh.mid, th.mid, tall), ky, kz, keyCentre);
    laidOut = true;
  }

  // Advances the easing and points the camera. `px`, `py` are the pointer
  // position, -1..1 across the window; `lookDown` is which view is wanted.
  // Returns true while the camera is still moving. Does nothing until the
  // window has had a size to lay out for.
  function step(dt, px, py, lookDown) {
    if (!laidOut) return false;
    var k = 1 - Math.exp(-dt * PARALLAX_RATE);
    parallax.x += (px - parallax.x) * k;
    parallax.y += (py - parallax.y) * k;
    var goal = lookDown ? 1 : 0;
    look += (goal - look) * (1 - Math.exp(-dt / LOOK_EASE_S));
    if (Math.abs(goal - look) < 0.0005) look = goal;
    // Ease in and out of the move as well as along it.
    var s = look * look * (3 - 2 * look);
    eye.lerpVectors(seat.eye, down.eye, s);
    aim.lerpVectors(seat.target, down.target, s);
    camera.up.copy(up);
    camera.position.copy(eye).addScaledVector(right, parallax.x * PARALLAX_X).addScaledVector(up, -parallax.y * PARALLAX_Y);
    camera.lookAt(aim);
    return look !== goal || Math.abs(px - parallax.x) > 0.002 || Math.abs(py - parallax.y) > 0.002;
  }

  return {
    layout: layout,
    step: step,
    // False until layout() has run.
    ready: function () {
      return laidOut;
    },
    // Whether the seated view already has the typing keys in it (a tall
    // window), so that using them needs no change of view.
    showsKeys: function () {
      return tall > 0.5;
    },
    info: function () {
      return {
        fov: camera.fov,
        aspect: camera.aspect,
        position: camera.position.toArray(),
        target: aim.toArray(),
        up: up.toArray(),
        lookDown: look,
      };
    },
  };
}

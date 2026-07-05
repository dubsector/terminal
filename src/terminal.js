import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

var HOSTNAME = "websvr";
var USER = "root";
var OS_NAME = "Dubuntu";
var OS_VERSION = "26.04.1 LTS";
var KERNEL_VERSION = "6.14.0-15-generic";

var term = new Terminal({
  fontFamily: "'Courier New', monospace",
  fontSize: 18,
  cursorBlink: true,
  cursorStyle: "block",
  convertEol: true,
  disableStdin: false,
  theme: {
    background: "#00100000",
    foreground: "#30f030",
    cursor: "#30f030",
  },
});

var fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));

var terminalEl = document.getElementById("terminal");

// FitAddon only ever adjusts cols/rows to whatever font size is already
// set - it won't shrink the font itself. The CRT box is now responsive
// (see .crt in style.css), so without this every viewport would get the
// same ~18px font and either waste a huge desktop screen on ~60 columns
// or badly overflow a phone. Targeting a column count from the actual
// container width keeps the full boot output legible and unwrapped on
// desktop while still shrinking gracefully on small screens.
function resizeTerminal() {
  var targetCols = 92;
  var fontSize = terminalEl.clientWidth / (targetCols * 0.6);
  fontSize = Math.max(8, Math.min(19, fontSize));
  term.options.fontSize = fontSize;
  fitAddon.fit();
}

resizeTerminal();
window.addEventListener("resize", resizeTerminal);

// Re-anchors the CRT to the top (and shrinks it to fit) when the mobile
// on-screen keyboard is open, instead of leaving it vertically centered
// and half-covered by the keyboard. There's no direct "keyboard opened"
// event - visualViewport shrinking noticeably from the page's normal
// height is the standard way to detect it.
if (window.visualViewport) {
  var monitorEl = document.querySelector(".monitor");
  var layoutHeight = window.innerHeight;
  var handleViewportResize = function () {
    var vh = window.visualViewport.height;
    var keyboardOpen = layoutHeight - vh > 120;
    document.body.classList.toggle("keyboard-open", keyboardOpen);

    if (keyboardOpen) {
      // Same width/aspect-ratio math as .monitor in CSS, computed here
      // instead so it can also be capped by whatever space is actually
      // left above the keyboard - width:auto + aspect-ratio doesn't
      // reliably shrink below the terminal's own content size.
      var normalWidth = Math.min(window.innerWidth * 0.94, 1040);
      var normalHeight = normalWidth * 0.75;
      var height = Math.min(normalHeight, vh - 24);
      var width = (height * 4) / 3;
      monitorEl.style.width = width + "px";
      monitorEl.style.height = height + "px";
    } else {
      monitorEl.style.width = "";
      monitorEl.style.height = "";
    }

    resizeTerminal();
  };
  window.visualViewport.addEventListener("resize", handleViewportResize);
}

// Purely a display toggle, like a real monitor's power button - the
// terminal session underneath (history, cwd, whatever's mid-typed) is
// completely untouched by this, on purpose. Nothing here touches term,
// inputBuffer, or disables stdin.
//
// The visual collapse/expand is a CSS keyframe animation (crtPowerOff/
// crtPowerOn in style.css), played by adding .powering-off/.powering-on
// for its duration - these two durations must match the ones set on
// those keyframes there. They're deliberately different: powering off
// (raster collapse) is near-instant on real hardware, while powering on
// is a slower brightness warm-up, so it needs more time to play out
// before it's safe to settle into the resting state and accept another
// click.
var POWER_OFF_ANIM_MS = 620;
var POWER_ON_ANIM_MS = 550;
var powerOn = true;
var powerAnimating = false;
var powerLed = document.getElementById("powerLed");
var powerBtnEl = document.getElementById("powerBtn");
var crtEl = document.querySelector(".crt");
powerBtnEl.classList.add("pressed"); // starts on, so starts latched in
powerBtnEl.addEventListener("click", function () {
  if (powerAnimating) return;
  powerAnimating = true;
  powerOn = !powerOn;
  powerLed.classList.toggle("off", !powerOn);
  // Old push-push CRT buttons latch in when on, click back out when off -
  // not a spring-back momentary press.
  powerBtnEl.classList.toggle("pressed", powerOn);

  if (powerOn) crtEl.classList.remove("screen-off");
  crtEl.classList.toggle("powering-on", powerOn);
  crtEl.classList.toggle("powering-off", !powerOn);

  setTimeout(function () {
    crtEl.classList.remove("powering-on", "powering-off");
    crtEl.classList.toggle("screen-off", !powerOn);
    powerAnimating = false;
  }, powerOn ? POWER_ON_ANIM_MS : POWER_OFF_ANIM_MS);
});

// Rare, irregularly-timed vertical-hold hiccup (a bright band rolling down
// the tube while the picture jitters) - reads as an analog fault precisely
// because it's not on a fixed loop. Skipped while the screen is off or
// mid power-toggle so it never fights the power animation for the same
// #terminal transform.
var glitchEl = document.querySelector(".crt-glitch");
function scheduleGlitch() {
  setTimeout(function () {
    if (powerOn && !powerAnimating) {
      glitchEl.classList.add("active");
      terminalEl.classList.add("glitching");
      setTimeout(function () {
        glitchEl.classList.remove("active");
        terminalEl.classList.remove("glitching");
      }, 900);
    }
    scheduleGlitch();
  }, randBetween(18000, 42000));
}
scheduleGlitch();

function randomFakeIp() {
  function octet() {
    return 1 + Math.floor(Math.random() * 223);
  }
  return octet() + "." + octet() + "." + octet() + "." + octet();
}

// Kicked off immediately so it has the whole multi-second boot animation
// to resolve in - by the time the MOTD is actually written, this has
// almost always already settled. Falls back to a plausible fake IP if
// the endpoint is slow, missing (e.g. a fork deployed somewhere that
// isn't Cloudflare, or plain static hosting with no Worker), or errors.
var visitorIpPromise = new Promise(function (resolve) {
  var settled = false;
  var timer = setTimeout(function () {
    settled = true;
    resolve(randomFakeIp());
  }, 1500);
  fetch("/api/whoami")
    .then(function (res) {
      return res.ok ? res.json() : null;
    })
    .then(function (data) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data && data.ip && data.ip !== "unknown" ? data.ip : randomFakeIp());
    })
    .catch(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(randomFakeIp());
    });
});

var cwd = "~";
var inputBuffer = "";
// Index into inputBuffer where the next typed character lands - xterm.js
// only renders/tracks its own screen cursor, it has no idea what "the
// current input line" even is (that's normally a real shell's job).
// Every edit below has to move this in lockstep with the terminal's own
// visual cursor via explicit escape codes.
var cursorPos = 0;

// Command history for this session (not persisted across reloads).
// historyIndex points one past the end when not currently browsing.
var history = [];
var historyIndex = 0;

// Replaces the whole line, cursor landing at the end - matches real bash
// on history recall.
function setInputLine(text) {
  var forward = inputBuffer.length - cursorPos;
  if (forward > 0) term.write("\x1b[" + forward + "C");
  for (var i = 0; i < inputBuffer.length; i++) {
    term.write("\b \b");
  }
  inputBuffer = text;
  cursorPos = text.length;
  term.write(text);
}

function promptString() {
  return USER + "@" + HOSTNAME + ":" + cwd + "# ";
}

function writePrompt() {
  term.write("\r\n" + promptString());
}

// Clickable directory names in `ls` output. Each entry pins an exact
// (line, column) range in the buffer to the directory name that was
// printed there, so the link provider below can look up "what did the
// visitor click" without re-parsing rendered text.
var dirLinks = [];

// True while a clicked link's "cd" + "ls -a" replay is mid-animation.
// disableStdin only blocks keyboard input, not further link clicks, so
// without this guard clicking a second link before the first one finishes
// typing starts two overlapping typeLine/runCommand sequences writing to
// the terminal at once - garbled output. Clicks are simply ignored while
// one is already in flight, rather than queued.
var navigating = false;

term.registerLinkProvider({
  provideLinks: function (bufferLineNumber, callback) {
    var matches = dirLinks.filter(function (l) {
      return l.line === bufferLineNumber;
    });
    if (!matches.length) {
      callback(undefined);
      return;
    }
    callback(
      matches.map(function (l) {
        return {
          text: l.name,
          range: {
            start: { x: l.startCol, y: bufferLineNumber },
            end: { x: l.endCol, y: bufferLineNumber },
          },
          activate: function () {
            if (l.url) {
              window.open(l.url, "_blank", "noopener,noreferrer");
            } else if (!navigating) {
              navigateTo(l.name, l.origin);
            }
          },
        };
      })
    );
  },
});

function clearInputLine() {
  setInputLine("");
}

// Splits an absolute path into segments for comparison in computeHops
// below. "~" is a separate root (root's own home dir, distinct from "/" -
// see FS above) with no segments in common with anything under "/", so it
// gets a sentinel null rather than being treated as a zero-length path.
function pathSegments(p) {
  return p === "~" ? null : p.split("/").filter(Boolean);
}

// Relative "cd" hops to walk from one absolute path to another: up to
// their common ancestor, then down into the target - the way a person
// would navigate there without knowing (or typing) the full absolute
// path. Each hop is a single plain segment or "..", so every hop is a
// valid argument to the existing single-segment cd resolution (no need to
// teach resolveCd about compound "../.." paths). Falls back to a single
// absolute-path hop when "~" is on either end, since there's no relative
// path between the two root systems.
function computeHops(from, to) {
  var fromParts = pathSegments(from);
  var toParts = pathSegments(to);
  if (!fromParts || !toParts) return [to];
  var i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  var hops = [];
  for (var u = i; u < fromParts.length; u++) hops.push("..");
  for (var d = i; d < toParts.length; d++) hops.push(toParts[d]);
  return hops;
}

// Same "type it, then run it" flow as the scripted intro, but triggered by
// clicking a directory link instead of playing on a timer. Clears out any
// partially-typed input first so a stray in-progress command can't get
// mixed in with the click. Works for any folder added to FS later, not
// just projects.
//
// origin is the directory this link was printed from. Combined with the
// current cwd, computeHops decides how many "cd" steps are needed: if the
// link came from the directory the visitor is standing in right now,
// that's just one plain "cd <name>", same as typing it, which fails the
// same way typing it would if something's actually wrong. If it's a stale
// link from elsewhere in the scrollback, a single relative "cd <name>"
// would often fail even though the directory obviously still exists - so
// instead this walks there hop by hop, which (since both ends are real FS
// paths) can't fail. Either way "ls -a" only replays after the final hop
// succeeds - a failed cd already reported its own bash error and left cwd
// untouched, so re-listing afterward would just be a pointless (and
// confusing) repeat of whatever's already on screen.
function navigateTo(name, origin) {
  navigating = true;
  term.options.disableStdin = true;
  clearInputLine();

  var hops = computeHops(cwd, resolveCd(name, origin));
  // Zero hops means this (stale) link resolves to the exact directory the
  // visitor is already standing in - there's no sensible walk to animate,
  // so fall back to the literal clicked name. Every hop below runs through
  // the exact same cd resolution manual typing would use, so this isn't a
  // special case logically: it fails for the same reason typing
  // "cd <name>" from inside that directory would - there's no subdirectory
  // by that name in *this* directory, only a same-named one elsewhere.
  if (!hops.length) hops = [name];

  function finish() {
    navigating = false;
    term.options.disableStdin = false;
    term.focus();
  }

  function runHop(i) {
    typeLine(
      "cd " + hops[i],
      function () {
        wait(randBetween(150, 350), function () {
          var ok = runCommand("cd " + hops[i]);
          writePrompt();
          if (!ok) {
            finish();
            return;
          }
          if (i + 1 < hops.length) {
            runHop(i + 1);
            return;
          }
          typeLine(
            "ls -a",
            function () {
              wait(randBetween(150, 350), function () {
                runCommand("ls -a");
                writePrompt();
                finish();
              });
            },
            700,
            1300
          );
        });
      },
      150,
      400
    );
  }

  runHop(0);
}

// Records where each directory/file-link name landed on screen after an
// `ls` write completes, so the link provider can find it later. list/entries
// mirror what was just printed: list is the full displayed row (may include
// "." and ".."), entries is the subset that are real, cd-able directories.
// linkNames is the subset of entries whose name IS an external URL (rather
// than a plain directory name) - clicking one opens that URL instead of
// cd-ing, since it isn't a real directory. atCwd is the directory this
// listing was printed from, stored as each entry's origin so navigateTo
// can later tell a live "cd <name>" apart from a stale, elsewhere-printed
// one (see navigateTo/computeHops for why that distinction matters). oneLine
// mirrors the same flag the `ls` handler used to decide layout - when false,
// each name landed on its own row instead of sharing one, so line has to
// advance per entry instead of column.
function registerDirLinks(list, entries, linkNames, atCwd, oneLine) {
  var lastLine = term.buffer.active.baseY + term.buffer.active.cursorY + 1;
  var startLine = oneLine ? lastLine : lastLine - (list.length - 1);
  var col = 1;
  for (var i = 0; i < list.length; i++) {
    var name = list[i];
    var line = oneLine ? startLine : startLine + i;
    if (entries.indexOf(name) !== -1) {
      var isLink = linkNames && linkNames.indexOf(name) !== -1;
      dirLinks.push({
        line: line,
        startCol: col,
        endCol: col + name.length - 1,
        name: name,
        url: isLink ? name : undefined,
        origin: isLink ? undefined : atCwd,
      });
    }
    col = oneLine ? col + name.length + 2 : 1;
  }
}

// Resolves a cd target against a working directory (defaults to the
// current one) - passing an explicit base lets callers (navigateTo, via
// computeHops) resolve a path against a directory other than wherever the
// visitor is right now.
function resolveCd(target, base) {
  var from = base === undefined ? cwd : base;
  if (!target || target === "~") return "~";
  if (target === "..") {
    if (from === "~" || from === "/") return from;
    var parts = from.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? "/" + parts.join("/") : "/";
  }
  if (target.charAt(0) === "/") return target;
  var baseStr = from === "~" ? "" : from;
  return baseStr + "/" + target;
}

// Minimal virtual filesystem: path -> list of entries in that directory.
// "~" is root's empty home dir, separate from "/" (filesystem root) - cd ..
// from a top-level dir like /var lands at "/", not "~", same as a real box.
// cd/ls both read from this single source of truth so a directory only
// needs to be added here to become real.
var FS = {
  "~": [],
  "/": ["var"],
  "/var": ["www"],
  "/var/www": ["dubsector.dev"],
  "/var/www/dubsector.dev": ["projects", "github", "caffeine"],
  "/var/www/dubsector.dev/projects": [
    "https://dubsector.github.io/mcmmo-builds",
    "https://dubsector.github.io/video-shrinker",
  ],
  "/var/www/dubsector.dev/github": ["https://github.com/dubsector"],
  "/var/www/dubsector.dev/caffeine": ["https://buymeacoffee.com/dubsector"],
};

// Files that are really external links: cwd -> array of entry names (from
// FS above) that open a new tab instead of cd-ing when clicked. The entry
// name itself IS the target URL, not a separate label pointing at one.
var FILE_LINKS = {
  "/var/www/dubsector.dev/projects": [
    "https://dubsector.github.io/mcmmo-builds",
    "https://dubsector.github.io/video-shrinker",
  ],
  "/var/www/dubsector.dev/github": ["https://github.com/dubsector"],
  "/var/www/dubsector.dev/caffeine": ["https://buymeacoffee.com/dubsector"],
};

// True while the fake `cmatrix` is running full-screen. While active, onData
// below stops routing keystrokes to the normal line editor entirely - the
// real cmatrix (ncurses, cbreak mode) isn't reading a line of input, it's
// just watching for a keypress, and the only one it acts on is the SIGINT
// a real terminal sends for Ctrl+C. Everything else is swallowed, same as
// real cmatrix ignoring ordinary typing while it's running.
var matrixActive = false;
var matrixInterval = null;
var matrixCols = [];

// Digits + half-width katakana, the standard "Matrix rain" glyph set every
// terminal port of this uses.
var MATRIX_CHARS =
  "0123456789ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ";

function randomMatrixChar() {
  return MATRIX_CHARS.charAt(Math.floor(Math.random() * MATRIX_CHARS.length));
}

// Each column is an independent falling "drop": y is the head's row
// (negative until it scrolls on-screen, which staggers columns' start times
// instead of every column beginning in lockstep), speed/tick slow some
// columns down relative to others, and len is how many rows of trail follow
// the head before the column resets from above the top with fresh random
// timing - a comet rather than a permanent streak, matching real cmatrix
// rather than a JS canvas knockoff.
function newMatrixColumn(rows) {
  return {
    y: -Math.floor(Math.random() * rows * 2),
    speed: 1 + Math.floor(Math.random() * 3),
    tick: 0,
    len: 6 + Math.floor(Math.random() * Math.max(6, rows - 4)),
  };
}

function initMatrixColumns() {
  matrixCols = [];
  for (var x = 0; x < term.cols; x++) {
    matrixCols.push(newMatrixColumn(term.rows));
  }
}

// Real cmatrix is an ncurses program: it takes over the whole screen via the
// terminal's alternate buffer and hides the cursor, then hands both back on
// exit - the visitor's prior scrollback (prompt, history, everything) is
// untouched underneath and reappears exactly as it was. \x1b[2J clears the
// alt buffer up front so a previous cmatrix run (the alt buffer persists
// hidden, not destroyed, when swapped out) can't bleed into this one.
function startMatrix() {
  matrixActive = true;
  term.write("\x1b[?25l\x1b[?1049h\x1b[2J\x1b[H");
  initMatrixColumns();
  matrixInterval = setInterval(drawMatrixFrame, 50);
}

// Ctrl+C is the only exit, matching real cmatrix's SIGINT handler (which
// restores the terminal via endwin() before exiting) rather than any-key-
// to-quit. Leaving the alt buffer and re-showing the cursor is the exact
// inverse of startMatrix's setup, then a fresh prompt is printed - same as
// a real shell reprompting once the foreground process it was waiting on
// exits.
function stopMatrix() {
  matrixActive = false;
  clearInterval(matrixInterval);
  matrixInterval = null;
  term.write("\x1b[?1049l\x1b[?25h");
  writePrompt();
}

function drawMatrixFrame() {
  var cols = term.cols;
  var rows = term.rows;
  // Window resized mid-run: real cmatrix redraws on SIGWINCH rather than
  // running off the edge of a buffer sized for the old dimensions.
  if (matrixCols.length !== cols) {
    term.write("\x1b[2J");
    initMatrixColumns();
  }

  var out = "";
  for (var x = 0; x < cols; x++) {
    var col = matrixCols[x];
    col.tick++;
    if (col.tick < col.speed) continue;
    col.tick = 0;
    col.y++;

    var headRow = col.y;
    var prevRow = headRow - 1;
    var tailRow = headRow - col.len;

    if (headRow >= 0 && headRow < rows) {
      out +=
        "\x1b[" + (headRow + 1) + ";" + (x + 1) + "H\x1b[1m" +
        randomMatrixChar() + "\x1b[0m";
    }
    if (prevRow >= 0 && prevRow < rows) {
      // Re-rolled (not just dimmed) each pass through here - real cmatrix's
      // trail glyphs shimmer/change over time rather than freezing solid.
      out +=
        "\x1b[" + (prevRow + 1) + ";" + (x + 1) + "H\x1b[2m" +
        randomMatrixChar() + "\x1b[0m";
    }
    if (tailRow >= 0 && tailRow < rows) {
      out += "\x1b[" + (tailRow + 1) + ";" + (x + 1) + "H ";
    }
    if (tailRow > rows) {
      matrixCols[x] = newMatrixColumn(rows);
    }
  }
  if (out) term.write(out);
}

function runCommand(line) {
  var trimmed = line.trim();
  if (trimmed === "") return;

  // Every path that runs a command funnels through here - manual typing,
  // the scripted intro, and clicked directory links alike - so history
  // captures all of them, not just what the visitor typed themselves.
  history.push(trimmed);
  historyIndex = history.length;

  var parts = trimmed.split(/\s+/);
  var cmd = parts[0];
  var args = parts.slice(1);
  var arg = args.join(" ");

  if (cmd === "clear") {
    term.clear();
    return;
  }

  if (cmd === "cd") {
    var target = resolveCd(arg);
    if (target === "~" || FS.hasOwnProperty(target)) {
      cwd = target;
      return true;
    }
    term.write(
      "\r\nbash: cd: " + (arg || "~") + ": No such file or directory"
    );
    return false;
  }

  if (cmd === "ls") {
    var flags = args
      .filter(function (a) {
        return a.charAt(0) === "-";
      })
      .join("");
    var showAll = flags.indexOf("a") !== -1;
    // Captured up front rather than read as `cwd` inside the write callback
    // below - registerDirLinks needs the directory this listing was
    // actually printed from, not wherever cwd happens to point by the time
    // the callback runs.
    var atCwd = cwd;
    // Sorted rather than trusting FS's own array order - real `ls` (no -f)
    // always lists alphabetically regardless of a directory's on-disk
    // order, and FS's arrays are just written in whatever order read
    // naturally when a directory was added.
    var entries = (FS[atCwd] || []).slice().sort();
    var linkNames = FILE_LINKS[atCwd] || [];
    var list = showAll ? [".", ".."].concat(entries) : entries;
    if (list.length) {
      // Real `ls` never splits a single filename across two rows - it lays
      // entries out in columns sized to the terminal, falling back to one
      // name per line once nothing fits side by side. There are never more
      // than a handful of entries in any directory here, so that full
      // fallback (rather than a real multi-column grid) is close enough:
      // one shared row if it fits, else one entry per row.
      var oneLine = list.join("  ").length <= term.cols;
      // Underline every real directory name (and file-link name) so it
      // reads as clickable even before a visitor hovers it (hover-only
      // affordance doesn't exist on touchscreens). "." and ".." stay plain -
      // not worth linking.
      var display = list
        .map(function (name) {
          return entries.indexOf(name) !== -1 ? "\x1b[4m" + name + "\x1b[24m" : name;
        })
        .join(oneLine ? "  " : "\r\n");
      term.write("\r\n" + display, function () {
        registerDirLinks(list, entries, linkNames, atCwd, oneLine);
      });
    }
    return;
  }

  if (cmd === "cmatrix") {
    startMatrix();
    return "cmatrix";
  }

  if (cmd === "exit" || cmd === "logout") {
    startLogout();
    return "logout";
  }

  term.write("\r\nbash: " + cmd + ": command not found");
}

function wait(ms, cb) {
  setTimeout(cb, ms);
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

// A real person doesn't start typing the instant a prompt appears - there's
// a beat while they read it and reach for the keyboard, then an uneven
// per-keystroke cadence (with the occasional small hesitation), not a
// metronome. reactionMin/Max is that "before I start typing" pause.
function humanType(count, onKeystroke, cb, reactionMin, reactionMax) {
  var i = 0;
  function step() {
    onKeystroke(i);
    i++;
    if (i >= count) {
      cb();
      return;
    }
    var delay = randBetween(80, 190);
    if (Math.random() < 0.18) delay += randBetween(120, 320);
    setTimeout(step, delay);
  }
  setTimeout(step, randBetween(reactionMin, reactionMax));
}

function typeLine(text, cb, reactionMin, reactionMax) {
  humanType(
    text.length,
    function (i) {
      term.write(text.charAt(i));
    },
    cb,
    reactionMin,
    reactionMax
  );
}

// Same cadence as typeLine, but nothing is echoed to the screen -
// mimics a real password prompt while still taking as long as typing one.
function typeInvisible(length, cb, reactionMin, reactionMax) {
  humanType(length, function () {}, cb, reactionMin, reactionMax);
}

function writeLines(lines) {
  term.write(lines.join("\r\n"));
}

var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Mimics the default `date` command format, e.g. "Fri Jul  3 14:32:07 UTC 2026".
function formatDate(d) {
  var day = d.getUTCDate();
  var dayStr = (day < 10 ? " " : "") + day;
  var pad = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  return (
    DAYS[d.getUTCDay()] + " " + MONTHS[d.getUTCMonth()] + " " + dayStr +
    " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" +
    pad(d.getUTCSeconds()) + " UTC " + d.getUTCFullYear()
  );
}

// Built right before display (not at boot start) so "as of" reflects the
// actual time it's shown, and so it can use the resolved visitor IP.
function buildMotd(visitorIp) {
  var now = new Date();
  var lastLogin = new Date(now.getTime() - (2 + Math.random() * 6) * 3600000);
  var load = (Math.random() * 0.3).toFixed(2);
  var mem = (15 + Math.random() * 15).toFixed(0);
  var disk = (30 + Math.random() * 20).toFixed(1);
  var procs = 95 + Math.floor(Math.random() * 40);

  // The classic Ubuntu MOTD lays system stats out in two columns, but
  // that only fits on an 80-column terminal. Below that, stack them
  // one per line so nothing wraps mid-word.
  var wide = term.cols >= 76;
  var sysinfo = wide
    ? [
        "  System load:  " + load + "               Processes:             " + procs,
        "  Usage of /:   " + disk + "% of 24.55GB   Users logged in:       1",
        "  Memory usage: " + mem + "%                IPv4 address for eth0: 10.13.37.4",
        "  Swap usage:   0%",
      ]
    : [
        "  System load:    " + load,
        "  Usage of /:     " + disk + "% of 24.55GB",
        "  Memory usage:   " + mem + "%",
        "  Swap usage:     0%",
        "  Processes:      " + procs,
        "  Users logged in: 1",
        "  IPv4 (eth0):    10.13.37.4",
      ];

  return [
    "Welcome to " + OS_NAME + " " + OS_VERSION + " (GNU/Linux " + KERNEL_VERSION + " x86_64)",
    "",
    " * Documentation:  https://help.ubuntu.com",
    " * Management:     https://landscape.canonical.com",
    " * Support:        https://ubuntu.com/pro",
    "",
    "System information as of " + formatDate(now),
    "",
  ]
    .concat(sysinfo)
    .concat([
      "",
      "0 updates can be applied immediately.",
      "",
      "Last login: " + formatDate(lastLogin) + " from " + visitorIp,
      "You have mail.",
      "",
    ]);
}

// Null except between `exit`/`logout` and a page reload, when it's
// "username" or "password" - which of the two the next keystrokes are
// building up in loginBuffer. Deliberately a dead end: there is no
// credential check anywhere on this page, not even a real password
// string (see bootSequence's pwLength - it's only ever a character
// *count* for the invisible-typing animation, never an actual value).
// The "root" login on first load is typed by that scripted animation,
// the visitor never types it themselves - so once they exit, they're
// standing at a real login prompt for a machine whose password they
// were never given, same as it'd go in real life. Every attempt fails,
// forever; the only way back in is reloading the page (the boot
// sequence rerunning is the "power cycle").
var loginMode = null;
var loginBuffer = "";

// fail2ban-style lockout after repeated failures - counts across every
// attempt made at this trapped prompt (there's no successful-login path
// to ever reset it on, see above), same jail/ban semantics fail2ban
// itself applies per source IP rather than per single connection.
var LOGIN_MAX_ATTEMPTS = 3;
var loginAttempts = 0;

// True for good once the ban lands - checked directly in onData (same as
// matrixActive below) rather than left to term.options.disableStdin alone,
// since disableStdin only stops the DOM from generating keystrokes and
// isn't a substitute for actually refusing to act on input at the code
// level. A real fail2ban DROP doesn't come back until the ban expires;
// here that's never, short of reloading the page.
var banned = false;

function writeLoginBanner() {
  term.write(OS_NAME + " " + OS_VERSION + " " + HOSTNAME + " tty1\r\n\r\n");
  term.write(HOSTNAME + " login: ");
}

// `exit`/`logout` prints "logout" and hands control back to getty, which
// respawns the login prompt from scratch - same banner as first boot,
// since this is a fresh getty, not a retry within the same login attempt
// (see handleLoginKeystroke for why a failed *attempt* doesn't repeat it).
function startLogout() {
  term.options.disableStdin = true;
  cwd = "~";
  dirLinks = [];
  term.write("\r\nlogout\r\n");
  wait(randBetween(300, 600), function () {
    term.clear();
    writeLoginBanner();
    loginMode = "username";
    loginBuffer = "";
    term.options.disableStdin = false;
    term.focus();
  });
}

// Minimal real (non-scripted) line input for the post-exit login prompt -
// no arrow keys, no history, no tab completion, since a real login
// program's readline doesn't support any of that either. Username echoes
// normally; password never echoes anything, including backspace, exactly
// like a real terminal's password prompt (the keystroke still removes
// from loginBuffer, it's just invisible, same trick as typeInvisible above
// but driven by real keystrokes instead of a scripted delay).
function handleLoginKeystroke(data) {
  if (data === "\r") {
    if (loginMode === "username") {
      loginBuffer = "";
      term.write("\r\nPassword: ");
      loginMode = "password";
      return;
    }
    term.write("\r\n");
    term.options.disableStdin = true;
    wait(randBetween(300, 600), function () {
      loginAttempts++;
      if (loginAttempts >= LOGIN_MAX_ATTEMPTS) {
        // Same visitor IP (or fallback fake one) already resolved for the
        // MOTD's "Last login: ... from" line - reused here so the ban
        // targets the same address that "connected" in the first place.
        // Set before the promise resolves, not inside its callback, so
        // nothing typed during that brief gap can slip through.
        banned = true;
        visitorIpPromise.then(function (ip) {
          var port = 1024 + Math.floor(Math.random() * 64511);
          term.write(
            "\r\nLogin incorrect\r\n" +
              "Disconnected from authenticating user root " + ip +
              " port " + port + " [preauth]\r\n" +
              "fail2ban: Ban " + ip + "\r\n"
          );
        });
        return;
      }
      term.write("\r\nLogin incorrect\r\n" + HOSTNAME + " login: ");
      loginMode = "username";
      loginBuffer = "";
      term.options.disableStdin = false;
    });
    return;
  }

  if (data.charCodeAt(0) === 127) {
    if (loginBuffer.length > 0) {
      loginBuffer = loginBuffer.slice(0, -1);
      if (loginMode === "username") term.write("\b \b");
    }
    return;
  }

  // Ignore escape sequences (arrows etc.) and other control chars - a
  // real login prompt doesn't act on them either.
  if (data.length !== 1 || data.charCodeAt(0) < 32) return;

  loginBuffer += data;
  if (loginMode === "username") term.write(data);
}

// Real getty/sshd behavior: the banner and login prompt are printed
// instantly by the system, only the username is "typed" by a human,
// the password is never echoed, and the MOTD is dumped in one shot
// right after auth succeeds (not typed character by character).
function bootSequence(done) {
  var pwLength = 8 + Math.floor(Math.random() * 6);

  writeLoginBanner();
  // This is a webpage, not a real console - a visitor's attention is on
  // the page as a whole first, not glued to this prompt. Give them room
  // to notice the CRT, read a little, before anything starts typing.
  typeLine("root", function () {
    // Beat before hitting Enter once the word is fully typed.
    wait(randBetween(200, 450), function () {
      term.write("\r\nPassword: ");
      typeInvisible(pwLength, function () {
        wait(randBetween(200, 450), function () {
          term.write("\r\n");
          // The system verifying credentials and assembling the MOTD. By
          // now visitorIpPromise has almost always already resolved.
          wait(randBetween(350, 750), function () {
            visitorIpPromise.then(function (ip) {
              writeLines(buildMotd(ip));
              done();
            });
          });
        });
      }, 450, 950);
    });
  }, 2600, 3600);
}

// Tab completion for `cd <partial>`, matched against the current
// directory's entries in FS. Only completes at the end of the line -
// mid-line tab completion is a much fussier problem and isn't the case
// being asked for here.
function handleTab() {
  if (cursorPos !== inputBuffer.length) return;

  var parts = inputBuffer.split(/\s+/);
  if (parts[0] !== "cd" || parts.length < 2) return;

  var partial = parts[parts.length - 1];
  var entries = FS[cwd] || [];
  var matches = entries.filter(function (name) {
    return name.indexOf(partial) === 0;
  });
  if (matches.length === 0) return;

  var completion =
    matches.length === 1
      ? matches[0]
      : matches.reduce(function (a, b) {
          var i = 0;
          while (i < a.length && i < b.length && a[i] === b[i]) i++;
          return a.slice(0, i);
        });

  if (completion.length <= partial.length) {
    // Ambiguous and no further common prefix to fill in - list the
    // options (real bash behavior) instead of silently doing nothing,
    // then reprint the prompt with what was typed so far so the visitor
    // can keep disambiguating.
    if (matches.length > 1) {
      term.write("\r\n" + matches.join("  "));
      writePrompt();
      term.write(inputBuffer);
    }
    return;
  }

  var toAppend = completion.slice(partial.length);
  inputBuffer += toAppend;
  cursorPos += toAppend.length;
  term.write(toAppend);
}

term.onData(function (data) {
  if (banned) return;

  if (matrixActive) {
    if (data === "\x03") stopMatrix();
    return;
  }

  if (loginMode) {
    handleLoginKeystroke(data);
    return;
  }

  if (data === "\t") {
    handleTab();
    return;
  }

  if (data === "\x1b[A") {
    // Up: step back through history, stopping at the oldest entry.
    if (historyIndex > 0) {
      historyIndex--;
      setInputLine(history[historyIndex]);
    }
    return;
  }

  if (data === "\x1b[B") {
    // Down: step forward, landing back on a blank line past the newest entry.
    if (historyIndex < history.length - 1) {
      historyIndex++;
      setInputLine(history[historyIndex]);
    } else if (historyIndex < history.length) {
      historyIndex = history.length;
      setInputLine("");
    }
    return;
  }

  if (data === "\x1b[D") {
    // Left: xterm moves its own screen cursor fine on its own, we just
    // need our logical index to agree with it.
    if (cursorPos > 0) {
      cursorPos--;
      term.write("\x1b[D");
    }
    return;
  }

  if (data === "\x1b[C") {
    if (cursorPos < inputBuffer.length) {
      cursorPos++;
      term.write("\x1b[C");
    }
    return;
  }

  var code = data.charCodeAt(0);

  if (data === "\r") {
    var line = inputBuffer;
    inputBuffer = "";
    cursorPos = 0;
    var result = runCommand(line);
    if (result !== "cmatrix" && result !== "logout") writePrompt();
    return;
  }

  if (code === 127) {
    // Backspace deletes the character behind the cursor, not necessarily
    // the last character in the buffer. Redraw everything after the
    // cursor shifted one column left, plus a trailing space to erase
    // what used to be the last character on the line, then walk the
    // screen cursor back to where it logically belongs.
    if (cursorPos > 0) {
      var beforeDel = inputBuffer.slice(0, cursorPos - 1);
      var afterDel = inputBuffer.slice(cursorPos);
      inputBuffer = beforeDel + afterDel;
      cursorPos--;
      term.write("\b" + afterDel + " ");
      term.write("\x1b[" + (afterDel.length + 1) + "D");
    }
    return;
  }

  if (code < 32) return; // ignore other control chars (Home/End/etc.)

  // Insert at the cursor rather than always appending, same idea as
  // backspace above: redraw the shifted tail, then walk back to it.
  var beforeIns = inputBuffer.slice(0, cursorPos);
  var afterIns = inputBuffer.slice(cursorPos);
  inputBuffer = beforeIns + data + afterIns;
  cursorPos += data.length;
  term.write(data + afterIns);
  if (afterIns.length) term.write("\x1b[" + afterIns.length + "D");
});

// A first-time visitor has no way to know `cd`/`ls` do anything here, so
// the terminal demonstrates itself: type the same two commands the old
// static version already showed as "done", then reveal the projects
// folder, then hand control back. Stdin is disabled while this plays so
// a visitor mashing keys early can't get interleaved with the scripted
// input and desync the prompt.
function runIntro() {
  term.options.disableStdin = true;
  writePrompt();
  typeLine(
    "cd var/www/dubsector.dev",
    function () {
      wait(randBetween(150, 350), function () {
        runCommand("cd var/www/dubsector.dev");
        writePrompt();
        typeLine(
          "ls -a",
          function () {
            wait(randBetween(150, 350), function () {
              runCommand("ls -a");
              writePrompt();
              term.options.disableStdin = false;
              term.focus();
            });
          },
          900,
          1800
        );
      });
    },
    1000,
    2000
  );
}

bootSequence(runIntro);

// Test hook: lets automated checks feed synthetic keystrokes without
// needing real DOM key events.
window.__debugType = function (str) {
  for (var i = 0; i < str.length; i++) {
    term._core._onData
      ? term._core._onData.fire(str[i])
      : term.write(str[i]);
  }
};

// Test hook: fires a raw escape sequence as a single atomic event (real
// arrow-key presses arrive this way - __debugType above sends one
// character per call, which would split "\x1b[A" into three separate,
// meaningless events).
window.__debugKey = function (seq) {
  term._core._onData.fire(seq);
};

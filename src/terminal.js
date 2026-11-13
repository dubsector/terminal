import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { initAnalytics, trackCommand, trackClick, trackLink } from "./analytics.js";
import { createLineEditor, splitKeys } from "./readline.js";

initAnalytics();

var HOSTNAME = "websvr";
var USER = "root";
var HOME = "/root";
var OS_NAME = "Dubuntu";
var OS_VERSION = "26.04.1 LTS";
var KERNEL_VERSION = "6.14.0-15-generic";

// The figures the login banner reports. The shell is given the same ones,
// so `free`, `df`, `uptime` and `ps` agree with what the visitor was told
// when they logged in.
var MACHINE = {
  load: Math.random() * 0.3,
  memoryPercent: Math.round(15 + Math.random() * 15),
  diskPercent: Math.round((30 + Math.random() * 20) * 10) / 10,
  diskGb: 24.55,
  processes: 95 + Math.floor(Math.random() * 40),
  address: "10.13.37.4",
  bootedAt: Date.now() - (3 + Math.random() * 40) * 86400000,
};

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
  // `ls` prints directories and URLs as terminal hyperlinks (see
  // src/shell/ls.js), and xterm hands a click on one to this. A URL opens
  // in a new tab; a directory is a "cd:" link, which only means something
  // here, hence allowNonHttpProtocols.
  linkHandler: {
    allowNonHttpProtocols: true,
    activate: function (event, uri) {
      if (/^https?:\/\//.test(uri)) {
        trackLink(uri);
        window.open(uri, "_blank", "noopener,noreferrer");
      } else if (uri.indexOf("cd:") === 0 && canNavigate()) {
        var target = decodeURI(uri.slice(3));
        trackClick(baseName(target));
        navigateTo(target);
      }
    },
  },
});

var fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));

var terminalEl = document.getElementById("terminal");

// The WebGL view (src/scene.js) is the default. In that mode this DOM
// terminal is still the real one - it takes the keystrokes and runs the
// shell - but it's invisible once the scene is up, and the scene redraws its
// buffer on a modelled tube. A text display of the kind being modelled has a
// fixed 80x25 character grid, so the terminal is pinned to that instead of
// being fitted to the window. Until the scene is ready, and for good if it
// can't run, this flat terminal is what the visitor sees.
//
// ?gl=0 always gives the flat site and ?gl=1 always tries the scene.
// Otherwise visitors who ask for reduced motion (the view moves with the
// pointer) or to save data (it downloads about 1.1 MB for its first frame
// and up to 2.7 MB of sharper light maps after it) get the flat site.
var GL_MODE = (function () {
  var q = window.location.search;
  if (/[?&]gl=0(&|$)/.test(q)) return false;
  if (/[?&]gl=1(&|$)/.test(q)) return true;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var saveData = navigator.connection && navigator.connection.saveData;
  return !reduceMotion && !saveData;
})();
// While the scene loads the flat monitor stays hidden, so the visitor does
// not see it appear and then be swapped out. release() below shows it again
// if the scene can't run.
if (GL_MODE) document.body.classList.add("gl-loading");
var GL_COLS = 80;
var GL_ROWS = 25;

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
  if (GL_MODE) {
    if (term.cols !== GL_COLS || term.rows !== GL_ROWS) term.resize(GL_COLS, GL_ROWS);
    return;
  }
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
// the line being typed, or disables stdin.
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

// The shell: a bash interpreter and the disk it works on (src/shell.js).
// xterm.js only emulates a terminal - it draws characters and reports
// keystrokes - so this is what actually runs what a visitor types. It is a
// separate script because it is several times the size of everything else
// here; the login animation covers the time it takes to arrive. Resolves to
// null if it can't be loaded. Every command waits on it, so one failed
// download would otherwise leave a prompt where nothing works: it is tried
// three times before giving up.
var shellReady = new Promise(function (resolve) {
  var failures = 0;
  function load() {
    var script = document.createElement("script");
    script.src = "./shell.js";
    script.async = true;
    script.onload = function () {
      resolve(
        window.__createShell
          ? window.__createShell({
              user: USER,
              hostname: HOSTNAME,
              os: { name: OS_NAME, version: OS_VERSION },
              kernel: KERNEL_VERSION,
              stats: MACHINE,
              cmatrix: startMatrix,
              linux: !!__LINUX__,
            })
          : null
      );
    };
    script.onerror = function () {
      script.remove();
      failures++;
      if (failures < 3) setTimeout(load, 1500 * failures);
      else resolve(null);
    };
    document.body.appendChild(script);
  }
  load();
});

// The shell's working directory, as of the last command to finish. The
// shell owns it; this copy is for the prompt and for working out where a
// clicked link leads.
var cwd = HOME;

// Set while a command is in the foreground: the AbortController that
// Ctrl+C trips.
var running = null;

// Command history for this session (not persisted across reloads).
var history = [];

// Earlier lines of a command that isn't finished yet - an open quote, an
// `if` waiting for its `fi` - while the "> " prompt asks for the rest.
var continued = [];

// Keys that arrived while nothing could take them (a command running, the
// prompt not yet drawn), in the order they were typed. A real terminal
// holds typing the same way, so nothing typed ahead is lost.
var typeahead = [];
// True whenever the prompt is not ready for a key.
var busy = true;

// The line being typed (src/readline.js): the editing, history recall and
// Tab completion bash's readline provides.
var editor = createLineEditor(term, {
  history: history,
  complete: function (line, cursor, cols) {
    return shellReady.then(function (shell) {
      return shell ? shell.complete(line, cursor, cols) : null;
    });
  },
  onLine: enterLine,
  // Ctrl+C throws the line away, with any earlier lines of the same
  // command.
  onInterrupt: function () {
    continued = [];
    shellReady.then(function (shell) {
      if (shell) shell.interrupt();
    });
    showPrompt();
  },
  // Ctrl+D on an empty line is end of input: a login shell logs out, and a
  // half-typed command is abandoned as a syntax error.
  onEnd: function () {
    if (continued.length) {
      continued = [];
      term.write("\r\nbash: syntax error: unexpected end of file\r\n");
      showPrompt();
    } else {
      typeahead = [];
      startLogout();
    }
  },
});

// Draws the prompt and starts a new line after it.
function showPrompt() {
  busy = true;
  return editor.begin(continued.length ? "> " : promptString()).then(function () {
    busy = false;
    drain();
  });
}

// Hands the editor the keys that are waiting, for as long as it can take
// them.
function drain() {
  while (typeahead.length && !busy && !running && !loginMode && !banned && !term.options.disableStdin) {
    var pending = editor.handle(typeahead.shift());
    if (pending) {
      busy = true;
      pending.then(function () {
        busy = false;
        drain();
      });
    }
  }
}

// The path the way bash's default prompt shows it: the home directory, and
// anything under it, as "~".
function promptPath() {
  if (cwd === HOME) return "~";
  if (cwd.indexOf(HOME + "/") === 0) return "~" + cwd.slice(HOME.length);
  return cwd;
}

function promptString() {
  return USER + "@" + HOSTNAME + ":" + promptPath() + "# ";
}

// True while a clicked link's "cd" + "ls -a" replay is mid-animation.
// disableStdin only blocks keyboard input, not further link clicks, so
// without this guard clicking a second link before the first one finishes
// typing starts two overlapping typeLine/runCommand sequences writing to
// the terminal at once - garbled output. Clicks are simply ignored while
// one is already in flight, rather than queued.
var navigating = false;

// A directory link can only be followed from an idle prompt: not mid-
// replay, not while a command (cmatrix included) has the terminal or is
// half typed over several lines, and not from the login screen, where
// links left in the scrollback mean nothing.
function canNavigate() {
  return !navigating && !running && !busy && !continued.length && !loginMode && !banned && !linux;
}

function clearInputLine() {
  editor.clear();
}

function pathSegments(p) {
  return p.split("/").filter(Boolean);
}

function baseName(p) {
  var parts = pathSegments(p);
  return parts.length ? parts[parts.length - 1] : "/";
}

function underHome(p) {
  return p === HOME || p.indexOf(HOME + "/") === 0;
}

// What a person would type after `cd` for this name: as is, unless the
// shell would split or expand it.
function shellQuote(name) {
  if (/^[A-Za-z0-9_.\/:@%+,-]+$/.test(name)) return name;
  return "'" + name.replace(/'/g, "'\\''") + "'";
}

// Relative "cd" hops to walk from one absolute path to another: up to
// their common ancestor, then down into the target - the way a person
// would navigate there without knowing (or typing) the full absolute
// path. Each hop is a single plain segment or "..". Falls back to a single
// absolute-path hop when exactly one end is inside the home directory:
// nobody walks out of ~ a ".." at a time.
function computeHops(from, to) {
  if (underHome(from) !== underHome(to)) return [to];
  var fromParts = pathSegments(from);
  var toParts = pathSegments(to);
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
// mixed in with the click. Works for any directory `ls` prints, not just
// the site's own.
//
// target is the directory the link stands for, as an absolute path - where
// it was when `ls` printed it. Combined with the current cwd, computeHops
// decides how many "cd" steps are needed: if the link came from the
// directory the visitor is standing in right now, that's just one plain
// "cd <name>", same as typing it. If it's a stale link from elsewhere in
// the scrollback, a single relative "cd <name>" would often fail even
// though the directory obviously still exists - so instead this walks
// there hop by hop. Either way "ls -a" only replays after the final hop
// succeeds - a failed cd (the directory may have been removed since) has
// already reported its own bash error and left cwd untouched, so re-listing
// afterward would just be a pointless (and confusing) repeat of whatever's
// already on screen.
function navigateTo(target) {
  navigating = true;
  term.options.disableStdin = true;
  clearInputLine();

  var hops = computeHops(cwd, target);
  // Zero hops means this (stale) link leads to the exact directory the
  // visitor is already standing in - there's no sensible walk to animate,
  // so fall back to the literal clicked name. It runs through the same cd
  // as everything else, so it fails for the same reason typing "cd <name>"
  // from inside that directory would - there's no subdirectory by that
  // name in *this* directory, only a same-named one elsewhere.
  if (!hops.length) hops = [baseName(target)];

  function finish() {
    navigating = false;
    term.options.disableStdin = false;
    term.focus();
  }

  function runHop(i) {
    var command = "cd " + shellQuote(hops[i]);
    typeLine(
      command,
      function () {
        wait(randBetween(150, 350), function () {
          submitLine(command).then(function (result) {
            if (result.logout || result.status !== 0) {
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
                  submitLine("ls -a").then(finish);
                });
              },
              700,
              1300
            );
          });
        });
      },
      150,
      400
    );
  }

  runHop(0);
}

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
//
// The shell runs this as its `cmatrix` command and waits on the returned
// promise, the way a real shell waits on a foreground process.
var matrixExited = null;
function startMatrix() {
  matrixActive = true;
  term.write("\x1b[?25l\x1b[?1049h\x1b[2J\x1b[H");
  initMatrixColumns();
  matrixInterval = setInterval(drawMatrixFrame, 50);
  return new Promise(function (resolve) {
    matrixExited = resolve;
  });
}

// Ctrl+C is the only exit, matching real cmatrix's SIGINT handler (which
// restores the terminal via endwin() before exiting) rather than any-key-
// to-quit. Leaving the alt buffer and re-showing the cursor is the exact
// inverse of startMatrix's setup; the shell prints its next prompt once it
// sees the program has exited.
function stopMatrix() {
  matrixActive = false;
  clearInterval(matrixInterval);
  matrixInterval = null;
  term.write("\x1b[?1049l\x1b[?25h");
  var exited = matrixExited;
  matrixExited = null;
  if (exited) exited();
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

// Ubuntu's default: a command isn't kept if it repeats the one before it
// or starts with a space.
function remember(command) {
  if (command.charAt(0) === " " || command === history[history.length - 1]) return;
  history.push(command);
}

// A command typed over several lines is kept in history as one, joined the
// way bash joins it: straight on after a backslash, with a space after a
// word or operator that expects more, with "; " otherwise.
function joinLines(lines) {
  return lines.reduce(function (text, line) {
    if (/\\$/.test(text)) return text.slice(0, -1) + line;
    return text + (/(^|[\s;])(do|then|else|\{|\()$|(\||&&)$/.test(text.trim()) ? " " : "; ") + line;
  });
}

// `!!` stands for the previous command, except inside single quotes or
// after a backslash. Returns null when there is no previous command.
function expandHistory(text) {
  var out = "";
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text.charAt(i);
    if (c === "'") quoted = !quoted;
    if (c === "\\" && !quoted) {
      out += c + text.charAt(++i);
    } else if (c === "!" && text.charAt(i + 1) === "!" && !quoted) {
      if (!history.length) return null;
      out += history[history.length - 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Runs a command in the shell and prints what it wrote. Resolves, once the
// output is on screen, to the shell's result: { status, logout, ... }.
// remembered is how it goes into history, when that isn't the text itself.
function runCommand(line, remembered) {
  if (line.trim() === "") return Promise.resolve({ status: 0, logout: false });

  // Every path that runs a command funnels through here - manual typing,
  // the scripted intro, and clicked directory links alike - so history
  // captures all of them, not just what the visitor typed themselves.
  remember(remembered || line.trim());

  var abort = new AbortController();
  running = abort;
  return shellReady
    .then(function (shell) {
      if (!shell) {
        return { output: "-bash: /bin/bash: Input/output error\n", status: 126, logout: false };
      }
      return shell.run(line, {
        cols: term.cols,
        rows: term.rows,
        history: history,
        signal: abort.signal,
      });
    })
    .catch(function (error) {
      return { output: "-bash: " + ((error && error.message) || error) + "\n", status: 1, logout: false };
    })
    .then(function (result) {
      running = null;
      if (result.cwd) cwd = result.cwd;
      return new Promise(function (resolve) {
        term.write(result.output, function () {
          resolve(result);
        });
      });
    });
}

// What follows a command: the next prompt - or, if it ended the session,
// the login screen, or the machine going down.
function afterCommand(result) {
  if (result.power) {
    typeahead = [];
    powerDown(result.power);
    return result;
  }
  if (result.logout) {
    typeahead = [];
    startLogout();
    return result;
  }
  return showPrompt().then(function () {
    return result;
  });
}

// Runs a line that is already on screen after the prompt, as the scripted
// intro and clicked links leave it: move below it, run it, prompt again.
function submitLine(line) {
  busy = true;
  term.write("\r\n");
  return runCommand(line).then(afterCommand);
}

// Enter on a typed line. The shell says whether what has been typed so far
// is a whole command; if not, bash's "> " prompt asks for the next line of
// it.
function enterLine(line) {
  busy = true;
  var lines = continued.concat([line]);
  var text = lines.join("\n");
  shellReady
    .then(function (shell) {
      return shell ? shell.incomplete(text) : false;
    })
    .catch(function () {
      return false;
    })
    .then(function (more) {
      if (more) {
        continued = lines;
        showPrompt();
        return;
      }
      continued = [];
      var command = expandHistory(text);
      if (command === null) {
        term.write("bash: !!: event not found\r\n");
        showPrompt();
        return;
      }
      // bash shows what it made of a line it expanded before running it.
      if (command !== text) term.write(command + "\r\n");
      trackCommand(command);
      runCommand(command, joinLines(command.trim().split("\n"))).then(afterCommand);
    });
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
  var load = MACHINE.load.toFixed(2);
  var mem = MACHINE.memoryPercent;
  var disk = MACHINE.diskPercent.toFixed(1);
  var size = MACHINE.diskGb + "GB";
  var procs = MACHINE.processes;

  // The classic Ubuntu MOTD lays system stats out in two columns, but
  // that only fits on an 80-column terminal. Below that, stack them
  // one per line so nothing wraps mid-word.
  var wide = term.cols >= 76;
  var sysinfo = wide
    ? [
        "  System load:  " + load + "               Processes:             " + procs,
        "  Usage of /:   " + disk + "% of " + size + "   Users logged in:       1",
        "  Memory usage: " + mem + "%                IPv4 address for eth0: " + MACHINE.address,
        "  Swap usage:   0%",
      ]
    : [
        "  System load:    " + load,
        "  Usage of /:     " + disk + "% of " + size,
        "  Memory usage:   " + mem + "%",
        "  Swap usage:     0%",
        "  Processes:      " + procs,
        "  Users logged in: 1",
        "  IPv4 (eth0):    " + MACHINE.address,
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
    ])
    // The whole boot - login banner, this MOTD, then the intro's cd and
    // ls - is 26 lines with the two-column layout. On a 25-row screen (the
    // fixed 80x25 of the WebGL view) that would scroll the banner off the
    // top just as the intro finishes, so give up one blank line there.
    .concat(wide && term.rows < 26 ? [] : [""])
    .concat([
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
  cwd = HOME;
  term.write("logout\r\n");
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
              var motd = buildMotd(ip);
              writeLines(motd);
              // Where a real login keeps what it just printed.
              shellReady.then(function (shell) {
                if (shell) shell.write("/run/motd.dynamic", motd.join("\n"));
              });
              done();
            });
          });
        });
      }, 450, 950);
    });
  }, 2600, 3600);
}

term.onData(function (data) {
  if (banned) return;

  // With the Linux machine running, the keyboard is its keyboard.
  if (linux) {
    linux.send(data);
    return;
  }

  if (matrixActive) {
    if (data === "\x03") stopMatrix();
    return;
  }

  if (loginMode) {
    handleLoginKeystroke(data);
    return;
  }

  if (running && data === "\x03") {
    // Ctrl+C interrupts whatever is in the foreground; the terminal echoes
    // it as ^C and the shell prompts again once the command has stopped.
    // Like a real terminal, it also forgets anything typed ahead.
    if (!running.signal.aborted) {
      term.write("^C\r\n");
      running.abort();
    }
    typeahead = [];
    return;
  }

  Array.prototype.push.apply(typeahead, splitKeys(data));
  drain();
});

term.onResize(function () {
  editor.reflow();
});

// A first-time visitor has no way to know `cd`/`ls` do anything here, so
// the terminal demonstrates itself: type the same two commands the old
// static version already showed as "done", then reveal the projects
// folder, then hand control back. Stdin is disabled while this plays so
// a visitor mashing keys early can't get interleaved with the scripted
// input and desync the prompt.
function runIntro() {
  term.options.disableStdin = true;
  // Anything typed while the login played is dropped rather than replayed
  // into the middle of the demonstration.
  typeahead = [];
  term.write("\r\n");
  showPrompt().then(function () {
    typeLine(
      "cd /var/www/dubsector.dev",
      function () {
        wait(randBetween(150, 350), function () {
          submitLine("cd /var/www/dubsector.dev").then(function () {
            typeLine(
              "ls -a",
              function () {
                wait(randBetween(150, 350), function () {
                  submitLine("ls -a").then(function () {
                    term.options.disableStdin = false;
                    term.focus();
                    wait(5000, prefetchLinux);
                  });
                });
              },
              900,
              1800
            );
          });
        });
      },
      1000,
      2000
    );
  });
}

// `reboot` does not bring this machine back. It starts a real one: Alpine
// Linux on a PC emulated in the page (src/linux.js), with this terminal on
// its serial console. `poweroff` there, or here, ends up back at this
// machine's login.
//
// The emulator and what it boots from are several megabytes and nothing else
// needs them, so they are only loaded for this. __LINUX__ is null in a
// build with no image (see build.mjs), and then `reboot` restarts this
// machine like `poweroff` does.
var LINUX = __LINUX__;
// The running machine, { send, stop }, while there is one.
var linux = null;

// What systemd prints on the console as an Ubuntu server goes down. Units
// that are in this machine's process list.
var STOPPING = [
  "Stopped target graphical.target - Graphical Interface.",
  "Stopped target multi-user.target - Multi-User System.",
  "Stopped cron.service - Regular background program processing daemon.",
  "Stopped ssh.service - OpenBSD Secure Shell server.",
  "Stopped rsyslog.service - System Logging Service.",
  "Stopped systemd-logind.service - User Login Management.",
  "Stopped target network.target - Network.",
  "Stopped systemd-resolved.service - Network Name Resolution.",
  "Unmounted boot-efi.mount - /boot/efi.",
  "Reached target umount.target - Unmount All Filesystems.",
  "Reached target final.target - Late Shutdown Services.",
];

// Takes this machine down the way `reboot` ("reboot") or `poweroff` asked,
// then starts whatever comes next.
function powerDown(how) {
  busy = true;
  term.options.disableStdin = true;
  var toLinux = how === "reboot" && LINUX;
  var lines = STOPPING.concat(
    how === "reboot"
      ? ["Finished systemd-reboot.service - System Reboot.", "Reached target reboot.target - System Reboot."]
      : ["Finished systemd-poweroff.service - System Power Off.", "Reached target poweroff.target - System Power Off."]
  );
  function next() {
    if (lines.length) {
      term.write("[  \x1b[1mOK\x1b[0m  ] " + lines.shift() + "\r\n");
      wait(randBetween(30, 140), next);
      return;
    }
    // The kernel has the last word, stamped with how long it has been up.
    var up = ((Date.now() - MACHINE.bootedAt) / 1000).toFixed(6);
    term.write("[" + up.padStart(12) + "] reboot: " + (how === "reboot" ? "Restarting system" : "Power down") + "\r\n");
    wait(how === "reboot" ? 900 : 2500, toLinux ? startLinux : bootAgain);
  }
  wait(randBetween(200, 400), next);
}

var linuxLoaded = null;
function loadLinux() {
  if (!linuxLoaded) {
    linuxLoaded = new Promise(function (resolve) {
      var script = document.createElement("script");
      script.src = "./linux.js";
      script.onload = function () {
        resolve(window.__bootLinux || null);
      };
      script.onerror = function () {
        linuxLoaded = null;
        resolve(null);
      };
      document.body.appendChild(script);
    });
  }
  return linuxLoaded;
}

function startLinux() {
  term.reset();
  // What a boot loader shows while it reads the kernel off the disk, which
  // is what the wait here is: the browser fetching it.
  term.write("Loading Linux " + LINUX.kernel + " ...\r\nLoading initial ramdisk ...\r\n");
  loadLinux().then(function (boot) {
    if (!boot) {
      linuxFailed();
      return;
    }
    linux = boot({
      write: function (bytes) {
        term.write(bytes);
      },
      onOff: function () {
        stopLinux();
        wait(2500, bootAgain);
      },
      // `reboot` inside it: a new machine from the same image. Unlike a
      // real one it comes back with its disk as it first was.
      onRestart: function () {
        stopLinux();
        wait(900, startLinux);
      },
      onError: linuxFailed,
    });
    term.options.disableStdin = false;
    term.focus();
  });
}

function stopLinux() {
  if (linux) linux.stop();
  linux = null;
  term.options.disableStdin = true;
}

// The image didn't arrive. Say so the way a boot loader would, and fall
// back to the machine that is known to work.
function linuxFailed() {
  stopLinux();
  term.write("\r\nerror: file not found.\r\n\r\nPress any key to continue...\r\n");
  wait(3000, bootAgain);
}

// This machine starting up again: a fresh login on the same disk.
function bootAgain() {
  term.reset();
  cwd = HOME;
  continued = [];
  typeahead = [];
  shellReady.then(function (shell) {
    if (shell) shell.relogin();
  });
  term.options.disableStdin = false;
  bootSequence(runIntro);
}

// Fetches what the Linux machine needs first into the browser's cache, so
// that `reboot` doesn't begin with a long silence. It is a download nobody
// asked for, so it waits until the page is idle and is skipped for anyone
// who is on a phone, a slow connection, or has asked to save data.
var linuxPrefetched = false;
function prefetchLinux() {
  if (!LINUX || linuxPrefetched) return;
  var connection = navigator.connection || {};
  if (connection.saveData || /2g|3g/.test(connection.effectiveType || "")) return;
  if (window.matchMedia && window.matchMedia("(hover: none)").matches) return;
  linuxPrefetched = true;
  ["./linux.js"].concat(LINUX.preload).forEach(function (url) {
    fetch(url)
      .then(function (response) {
        return response.arrayBuffer();
      })
      .catch(function () {});
  });
}

bootSequence(runIntro);

// Hands the WebGL scene the few things it needs. The scene only observes
// (the terminal buffer, the power classes) and clicks the real power
// button; all state stays here. Loaded as a separate script so visitors who
// don't ask for it never download three.js.
if (GL_MODE) {
  window.__crt = {
    term: term,
    crt: crtEl,
    powerBtn: powerBtnEl,
    isPowerOn: function () {
      return powerOn;
    },
    // Called if the scene can't run (or stops running): drop the 80x25 pin
    // so the flat terminal goes back to fitting its box.
    release: function () {
      GL_MODE = false;
      document.body.classList.remove("gl-loading");
      resizeTerminal();
    },
  };
  var sceneScript = document.createElement("script");
  sceneScript.src = "./scene.js";
  sceneScript.async = true;
  sceneScript.onerror = window.__crt.release;
  document.body.appendChild(sceneScript);
}

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

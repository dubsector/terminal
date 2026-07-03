import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

var HOSTNAME = "websvr";
var USER = "root";

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
fitAddon.fit();
window.addEventListener("resize", function () {
  fitAddon.fit();
});

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
            navigateTo(l.name);
          },
        };
      })
    );
  },
});

function clearInputLine() {
  for (var i = 0; i < inputBuffer.length; i++) {
    term.write("\b \b");
  }
  inputBuffer = "";
}

// Same "type it, then run it" flow as the scripted intro, but triggered
// by clicking a directory link instead of playing on a timer. Clears out
// any partially-typed input first so a stray in-progress command can't
// get mixed in with the click. Always follows up with an auto-typed
// `ls -a` - same as the intro - so a click always shows something (even
// just ". .." for an empty dir) instead of silently landing on a bare
// prompt that looks like the click did nothing. Works for any folder
// added to FS later, not just projects.
function navigateTo(name) {
  term.options.disableStdin = true;
  clearInputLine();
  typeLine(
    "cd " + name,
    function () {
      wait(randBetween(150, 350), function () {
        runCommand("cd " + name);
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
          700,
          1300
        );
      });
    },
    150,
    400
  );
}

// Records where each directory name landed on screen after an `ls` write
// completes, so the link provider can find it later. list/entries mirror
// what was just printed: list is the full displayed row (may include "."
// and ".."), entries is the subset that are real, cd-able directories.
function registerDirLinks(list, entries) {
  var line = term.buffer.active.baseY + term.buffer.active.cursorY + 1;
  var col = 1;
  for (var i = 0; i < list.length; i++) {
    var name = list[i];
    if (entries.indexOf(name) !== -1) {
      dirLinks.push({
        line: line,
        startCol: col,
        endCol: col + name.length - 1,
        name: name,
      });
    }
    col += name.length + 2;
  }
}

// Resolves a cd target against the current working directory.
function resolveCd(target) {
  if (!target || target === "~") return "~";
  if (target === "..") {
    if (cwd === "~" || cwd === "/") return cwd;
    var parts = cwd.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? "/" + parts.join("/") : "/";
  }
  if (target.charAt(0) === "/") return target;
  var base = cwd === "~" ? "" : cwd;
  return base + "/" + target;
}

// Minimal virtual filesystem: path -> list of entries in that directory.
// "~" is root's empty home dir. cd/ls both read from this single source
// of truth so a directory only needs to be added here to become real.
var FS = {
  "~": [],
  "/var": ["www"],
  "/var/www": ["dubsector.dev"],
  "/var/www/dubsector.dev": ["projects"],
  "/var/www/dubsector.dev/projects": [],
};

function runCommand(line) {
  var trimmed = line.trim();
  if (trimmed === "") return;

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
    } else {
      term.write(
        "\r\nbash: cd: " + (arg || "~") + ": No such file or directory"
      );
    }
    return;
  }

  if (cmd === "ls") {
    var flags = args
      .filter(function (a) {
        return a.charAt(0) === "-";
      })
      .join("");
    var showAll = flags.indexOf("a") !== -1;
    var entries = (FS[cwd] || []).slice();
    var list = showAll ? [".", ".."].concat(entries) : entries;
    if (list.length) {
      // Underline every real directory name so it reads as clickable even
      // before a visitor hovers it (hover-only affordance doesn't exist on
      // touchscreens). "." and ".." stay plain - not worth linking.
      var display = list
        .map(function (name) {
          return entries.indexOf(name) !== -1 ? "\x1b[4m" + name + "\x1b[24m" : name;
        })
        .join("  ");
      term.write("\r\n" + display, function () {
        registerDirLinks(list, entries);
      });
    }
    return;
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
    "Welcome to Dubuntu 24.04.2 LTS (GNU/Linux 6.8.0-51-generic x86_64)",
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

// Real getty/sshd behavior: the banner and login prompt are printed
// instantly by the system, only the username is "typed" by a human,
// the password is never echoed, and the MOTD is dumped in one shot
// right after auth succeeds (not typed character by character).
function bootSequence(done) {
  var pwLength = 8 + Math.floor(Math.random() * 6);

  term.write("Dubuntu 24.04.2 LTS " + HOSTNAME + " tty1\r\n\r\n");
  term.write(HOSTNAME + " login: ");
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

term.onData(function (data) {
  var code = data.charCodeAt(0);

  if (data === "\r") {
    var line = inputBuffer;
    inputBuffer = "";
    runCommand(line);
    writePrompt();
    return;
  }

  if (code === 127) {
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      term.write("\b \b");
    }
    return;
  }

  if (code < 32) return; // ignore other control chars (arrows etc.)

  inputBuffer += data;
  term.write(data);
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

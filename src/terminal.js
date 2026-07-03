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

var cwd = "~";
var inputBuffer = "";

function promptString() {
  return USER + "@" + HOSTNAME + ":" + cwd + "# ";
}

function writePrompt() {
  term.write("\r\n" + promptString());
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

var KNOWN_DIRS = ["/var", "/var/www", "/var/www/dubsector.dev"];

function runCommand(line) {
  var trimmed = line.trim();
  if (trimmed === "") return;

  var parts = trimmed.split(/\s+/);
  var cmd = parts[0];
  var arg = parts.slice(1).join(" ");

  if (cmd === "clear") {
    term.clear();
    return;
  }

  if (cmd === "cd") {
    var target = resolveCd(arg);
    if (target === "~" || KNOWN_DIRS.indexOf(target) !== -1) {
      cwd = target;
    } else {
      term.write(
        "\r\nbash: cd: " + (arg || "~") + ": No such file or directory"
      );
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

// Real getty/sshd behavior: the banner and login prompt are printed
// instantly by the system, only the username is "typed" by a human,
// the password is never echoed, and the MOTD is dumped in one shot
// right after auth succeeds (not typed character by character).
function bootSequence(done) {
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

  var motd = [
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
      "Last login: " + formatDate(lastLogin) + " from 10.13.37.1",
      "You have mail.",
      "",
    ]);

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
          // The system verifying credentials and assembling the MOTD.
          wait(randBetween(350, 750), function () {
            writeLines(motd);
            done();
          });
        });
      }, 450, 950);
    });
  }, 2800, 4500);
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

bootSequence(function () {
  writePrompt();
  term.focus();
});

// Test hook: lets automated checks feed synthetic keystrokes without
// needing real DOM key events.
window.__debugType = function (str) {
  for (var i = 0; i < str.length; i++) {
    term._core._onData
      ? term._core._onData.fire(str[i])
      : term.write(str[i]);
  }
};

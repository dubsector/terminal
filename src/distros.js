// The systems on the boot menu that `reboot` brings up, other than the real
// Alpine machine (src/linux.js). They are all this same machine and shell
// under another name: a banner, a message of the day, a colour of phosphor
// and a habit or two. Two of them are jokes about real distributions,
// Hannah Montana Linux (a pink Kubuntu remix, 2009) and Red Star OS (North
// Korea's own, which watermarks files and restarts the computer if you
// touch its system files). Everything here is drawn in text.
//
// Each distribution:
//   menu        its line on the boot menu
//   os          { name, version, codename }, as /etc/os-release and the
//               banners give it
//   hostname, kernel, kernelBuild
//   phosphor    the colour the tube glows, as [r, g, b] for the 3D view
//               and a CSS colour for the flat one
//   bootLines   what the console shows before the login prompt
//   motd(ctx)   the lines printed after login. ctx: { wide, now, ip,
//               stats, lastLogin, date(d) }
//   files       extra files it has on its disk
//   after(line, output)  a habit, run after every command: returns
//               { output } to replace what the command printed, and
//               { restart: true } to take the machine down for it

var DUBUNTU = {
  menu: "Dubuntu 26.04.1 LTS",
  os: { name: "Dubuntu", version: "26.04.1 LTS", codename: "resolute" },
  hostname: "websvr",
  kernel: "6.14.0-15-generic",
  kernelBuild: "#15-Dubuntu SMP PREEMPT_DYNAMIC Fri Mar 20 10:14:32 UTC 2026",
  phosphor: { rgb: [0.1, 1.0, 0.2], css: "#30f030", glow: "48,240,48" },
};

// Puts two columns of lines side by side: art on the left, text on the
// right. Below 76 columns the text goes under the art instead.
function beside(wide, left, right, width) {
  if (!wide) return left.concat([""], right);
  var rows = Math.max(left.length, right.length);
  var out = [];
  for (var i = 0; i < rows; i++) {
    var l = left[i] || "";
    var r = right[i] || "";
    out.push(r ? (l + " ".repeat(Math.max(0, width - l.length)) + r).replace(/\s+$/, "") : l.replace(/\s+$/, ""));
  }
  return out;
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

var HANNAH_HEART = [
  "   .-\"\"\"-. .-\"\"\"-.     *",
  "  /       V       \\",
  " |                 |  .",
  "  \\               /",
  "   '.           .'   *",
  "     '-.     .-'",
  "  *     '-.-'      .",
];

var HANNAH = {
  menu: "Hannah Montana Linux",
  os: { name: "Hannah Montana Linux", version: "26.04 LTS", codename: "sparkle" },
  hostname: "hannah",
  kernel: "6.14.0-15-hannah",
  kernelBuild: "#15-Hannah SMP PREEMPT_GLITTER Fri Mar 20 10:14:32 UTC 2026",
  phosphor: { rgb: [1.0, 0.32, 0.78], css: "#ff6ad5", glow: "255,106,213" },
  bootLines: [
    "[    0.000000] Linux version 6.14.0-15-hannah (built with love)",
    "[    0.000000] Command line: root=/dev/vda1 ro quiet sparkle",
    "[    0.412031] wig0: blonde wig detected, secret identity engaged",
    "[    0.733120] glitter: 4096 MiB of sparkle mapped at 0xff69b4",
    "[    0.951002] tour-bus: 1 bus, 12 backup dancers",
    "[  OK  ] Started secret-identity.service - Keep It Secret.",
    "[  OK  ] Started pinkify.service - Make Everything Pink.",
    "[  OK  ] Started kde4-theme.service - Hearts and Stars Desktop.",
    "[  OK  ] Started paparazzi-shield.service - Sunglasses.",
    "[  OK  ] Reached target concert.target - On Stage.",
  ],
  motd: function (ctx) {
    var s = ctx.stats;
    var text = [
      "* Documentation:  sing it, don't read it",
      "* Management:     her manager is her dad",
      "* Support:        backup dancers, row two",
      "",
      "Desktop:  KDE 4, every shade of pink",
      "Sparkle:  " + Math.round(80 + s.load * 60) + "% and rising",
      "Disguise: on (wig, sunglasses)",
    ];
    return ["Welcome to Hannah Montana Linux 26.04 LTS (GNU/Linux 6.14.0-15-hannah x86_64)", ""]
      .concat(beside(ctx.wide, HANNAH_HEART, text, 30))
      .concat([
        "",
        "System information as of " + ctx.date(ctx.now),
        "",
        "  System load:  " + s.load.toFixed(2) + "    Glitter in /: " + s.diskPercent.toFixed(1) + "% of " + s.diskGb + "GB",
        "  Fans online:  " + (1000 + s.processes * 37) + "    Secret identity: safe",
        "",
        "0 updates can be applied immediately. She's perfect already.",
        "Last login: " + ctx.date(ctx.lastLogin) + " from " + ctx.ip + " (in disguise)",
        "You have fan mail.",
        "",
      ]);
  },
  files: {
    "/root/fan-mail.txt":
      "Dear Hannah,\n\n" +
      "Your Linux is the most fabulous thing on the internet. I installed it on\n" +
      "my dad's server and now the whole data centre is pink.\n\n" +
      "Love, your #1 fan\n",
    "/root/.secret-identity": "Don't tell anyone.\n",
  },
  after: function (line, output) {
    if (/command not found/.test(output)) {
      return { output: output.replace(/command not found$/gm, "command not found. Sweet niblets!") };
    }
    return null;
  },
};

var RED_STAR_ART = [
  "           .",
  "          / \\",
  "   ______/   \\______",
  "   '-.           .-'",
  "      '>       <'",
  "      /  .-'-.  \\",
  "     /.-'     '-.\\",
];

// Red Star counts years from 1912, as its calendar does: 2026 is Juche 115.
function jucheDate(d) {
  var kst = new Date(d.getTime() + 9 * 3600000);
  var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return (
    days[kst.getUTCDay()] + " " + months[kst.getUTCMonth()] + " " + kst.getUTCDate() + " " +
    pad2(kst.getUTCHours()) + ":" + pad2(kst.getUTCMinutes()) + ":" + pad2(kst.getUTCSeconds()) +
    " KST Juche " + (kst.getUTCFullYear() - 1911)
  );
}

// Commands that change files, and the files Red Star won't let them change.
var WRITES = /(^|[\s;&|(])(touch|cp|mv|mkdir|tee|install|ln|truncate|dd|nano|vi|vim)(\s|$)|[^&2]>>?\s*[^&\s]|^>/;
var CHANGES = /(^|[\s;&|(])(rm|rmdir|mv|cp|chmod|chown|chgrp|touch|tee|ln|truncate|dd|install|shred|sed\s+-i\S*)\s|>>?\s*\//;
var PROTECTED = /(^|[\s='"<>])\/(etc|usr|bin|sbin|lib|lib64|boot)(\/|\s|$|['"])|(^|\s)\/(\s|$)|\/\*/;

function serial() {
  var hex = "0123456789ABCDEF";
  var out = "";
  for (var i = 0; i < 8; i++) out += hex.charAt(Math.floor(Math.random() * 16));
  return out.slice(0, 4) + "-" + out.slice(4);
}

var REDSTAR = {
  menu: "Red Star OS 3.0",
  os: { name: "Red Star OS", version: "3.0 Server", codename: "juche" },
  hostname: "redstar",
  kernel: "2.6.38.8-24.rs3.0.i686",
  kernelBuild: "#1 SMP Juche 101",
  phosphor: { rgb: [1.0, 0.1, 0.06], css: "#ff3a2a", glow: "255,58,42" },
  bootLines: [
    "[    0.000000] Linux version 2.6.38.8-24.rs3.0.i686 (gcc version 4.4.4, approved)",
    "[    0.000000] Command line: ro root=/dev/sda1 rhgb quiet watched",
    "[    0.318204] kwangmyong: national intranet found, internet not found",
    "[    0.602117] integrity: 4217 protected files fingerprinted",
    "[  OK  ] Started opprc.service - Integrity Protection.",
    "[  OK  ] Started scnprc.service - File Watermarking.",
    "[  OK  ] Started securityd.service - Security Monitoring.",
    "[  OK  ] Started naenara.service - Naenara Browser Home Page.",
    "[  OK  ] Reached target juche.target - Self-Reliance.",
  ],
  motd: function (ctx) {
    var s = ctx.stats;
    var text = [
      "* Documentation:  issued on request",
      "* Management:     it is already managed",
      "* Support:        not required",
      "",
      "Network:   Kwangmyong (domestic intranet)",
      "Watermark: on, for your protection",
      "Integrity: guarded by opprc",
    ];
    return ["Welcome to Red Star OS 3.0 Server (GNU/Linux 2.6.38.8-24.rs3.0.i686)", ""]
      .concat(beside(ctx.wide, RED_STAR_ART, text, 26))
      .concat([
        "",
        "System information as of " + jucheDate(ctx.now),
        "",
        "  System load:  " + s.load.toFixed(2) + "      Usage of /:  100% (as planned)",
        "  Processes:    " + String(s.processes).padEnd(10) + "All of them: watched",
        "",
        "0 updates can be applied. Updates are delivered by hand.",
        "Last login: " + jucheDate(ctx.lastLogin) + " from " + ctx.ip + " (recorded)",
        "You have mail. It has already been read.",
        "",
      ]);
  },
  files: {
    "/etc/redstar-release": "Red Star OS release 3.0 (Juche)\n",
    "/root/README":
      "Welcome, comrade.\n\n" +
      "Every file you create is watermarked by scnprc so it can be returned to\n" +
      "you if lost. System files are protected by opprc: changing them restarts\n" +
      "the computer, for your safety.\n",
  },
  after: function (line, output) {
    if (CHANGES.test(line) && PROTECTED.test(line)) {
      return {
        output:
          output +
          "\x1b[1mopprc: an unauthorised change to a protected system file was detected.\x1b[0m\n" +
          "opprc: the system will now restart to restore its integrity.\n",
        restart: true,
      };
    }
    if (/command not found/.test(output)) {
      return { output: output.replace(/command not found$/gm, "command not found. This incident will be reported.") };
    }
    if (WRITES.test(line)) {
      return { output: output + "scnprc: new files watermarked, serial RS3-" + serial() + "\n" };
    }
    return null;
  },
};

export var DISTROS = { dubuntu: DUBUNTU, hannah: HANNAH, redstar: REDSTAR };
Object.keys(DISTROS).forEach(function (key) {
  DISTROS[key].key = key;
});

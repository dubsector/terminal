import { defineCommand } from "just-bash";
import { NOT_A_TTY_FD } from "./ls.js";

// The commands a bash interpreter doesn't come with: the ones that report on
// the machine itself. Each prints what the real program prints on a stock
// Ubuntu server, column for column, from the figures in machine.js.

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAY = 86400000;

function ok(stdout) {
  return Promise.resolve({ stdout: stdout, stderr: "", exitCode: 0 });
}

function fail(stderr, exitCode) {
  return Promise.resolve({ stdout: "", stderr: stderr, exitCode: exitCode || 1 });
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clock(time, seconds) {
  var d = new Date(time);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + (seconds ? ":" + pad2(d.getUTCSeconds()) : "");
}

function day(time) {
  var d = new Date(time);
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

// Single-letter options from every argument that starts with a dash, and
// whatever is left.
function split(args) {
  var out = { letters: "", long: [], rest: [] };
  args.forEach(function (arg) {
    if (arg.indexOf("--") === 0 && arg.length > 2) out.long.push(arg.slice(2));
    else if (arg.charAt(0) === "-" && arg.length > 1) out.letters += arg.slice(1);
    else out.rest.push(arg);
  });
  return out;
}

function invalidOption(name, letter) {
  return fail(name + ": invalid option -- '" + letter + "'\nTry '" + name + " --help' for more information.\n");
}

// procps and coreutils both print sizes this way with -h: powers of 1024,
// one decimal below ten. They differ in the suffix and in rounding.
function human(kb, suffixes, roundUp) {
  if (!kb) return suffixes[0];
  var value = kb;
  var unit = 1;
  while (value >= 1024 && unit < suffixes.length - 1) {
    value /= 1024;
    unit++;
  }
  var round = roundUp ? Math.ceil : Math.round;
  if (value < 10) return (round(value * 10) / 10).toFixed(1) + suffixes[unit];
  return round(value) + suffixes[unit];
}

export function createCommands(host, machine, shellPid) {
  var user = host.user;
  var address = host.stats.address;
  var subnet = address.split(".").slice(0, 3).join(".");
  var mac = "52:54:00:" + [0, 0, 0].map(function () {
    return pad2(Math.floor(Math.random() * 256).toString(16));
  }).join(":");
  var processes = machine.buildProcesses(shellPid);
  var lastPid = shellPid;

  function uptimeLine() {
    var minutes = Math.floor(machine.uptimeSeconds() / 60);
    var days = Math.floor(minutes / 1440);
    var hours = Math.floor((minutes % 1440) / 60);
    var up = days ? days + " day" + (days === 1 ? "" : "s") + ", " : "";
    up += hours ? String(hours).padStart(2) + ":" + pad2(minutes % 60) : (minutes % 60) + " min";
    return (
      " " + clock(Date.now(), true) + " up " + up + ",  1 user,  load average: " +
      machine.load.map(function (n) {
        return n.toFixed(2);
      }).join(", ") + "\n"
    );
  }

  function uname(args) {
    var opts = split(args);
    var order = "snrvmpio";
    var names = {
      "kernel-name": "s", nodename: "n", "kernel-release": "r", "kernel-version": "v",
      machine: "m", processor: "p", "hardware-platform": "i", "operating-system": "o", all: "a",
    };
    var letters = opts.letters;
    for (var i = 0; i < opts.long.length; i++) {
      if (!names[opts.long[i]]) {
        return fail("uname: unrecognized option '--" + opts.long[i] + "'\nTry 'uname --help' for more information.\n");
      }
      letters += names[opts.long[i]];
    }
    if (opts.rest.length) {
      return fail("uname: extra operand '" + opts.rest[0] + "'\nTry 'uname --help' for more information.\n");
    }
    for (var k = 0; k < letters.length; k++) {
      if ((order + "a").indexOf(letters.charAt(k)) === -1) return invalidOption("uname", letters.charAt(k));
    }
    if (!letters) letters = "s";
    if (letters.indexOf("a") !== -1) letters = order;
    var values = {
      s: "Linux", n: host.hostname, r: host.kernel, v: machine.kernelBuild(),
      m: "x86_64", p: "x86_64", i: "x86_64", o: "GNU/Linux",
    };
    return ok(
      order.split("").filter(function (letter) {
        return letters.indexOf(letter) !== -1;
      }).map(function (letter) {
        return values[letter];
      }).join(" ") + "\n"
    );
  }

  function id(args) {
    var opts = split(args);
    if (opts.rest.length && opts.rest[0] !== user) {
      return fail("id: \u2018" + opts.rest[0] + "\u2019: no such user\n");
    }
    var name = /n/.test(opts.letters);
    if (/[ugG]/.test(opts.letters)) return ok((name ? user : "0") + "\n");
    return ok("uid=0(" + user + ") gid=0(" + user + ") groups=0(" + user + ")\n");
  }

  function free(args) {
    var opts = split(args);
    var m = machine.memory;
    var convert = function (kb) {
      if (/h/.test(opts.letters)) return human(kb, ["0B", "Ki", "Mi", "Gi", "Ti"], false);
      if (/g/.test(opts.letters)) return String(Math.floor(kb / 1048576));
      if (/m/.test(opts.letters)) return String(Math.floor(kb / 1024));
      if (/b/.test(opts.letters)) return String(kb * 1024);
      return String(kb);
    };
    function row(label, values) {
      return (
        label.padEnd(7) +
        values.map(function (value, i) {
          return convert(value).padStart(i ? 12 : 13);
        }).join("") + "\n"
      );
    }
    return ok(
      "               total        used        free      shared  buff/cache   available\n" +
        row("Mem:", [m.total, m.used, m.free, m.shared, m.cache, m.available]) +
        row("Swap:", [0, 0, 0])
    );
  }

  async function df(args, ctx) {
    var opts = split(args);
    var readable = /h/.test(opts.letters);
    var shown = machine.filesystems;
    var stderr = "";
    if (opts.rest.length) {
      shown = [];
      for (var i = 0; i < opts.rest.length; i++) {
        var path = ctx.fs.resolvePath(ctx.cwd, opts.rest[i]);
        if (!(await ctx.fs.exists(path))) {
          stderr += "df: " + opts.rest[i] + ": No such file or directory\n";
          continue;
        }
        // The filesystem a path is on is the one mounted deepest above it.
        var best = null;
        machine.filesystems.forEach(function (fs) {
          var mount = fs[3];
          var inside = mount === "/" || path === mount || path.indexOf(mount + "/") === 0;
          if (inside && (!best || mount.length > best[3].length)) best = fs;
        });
        shown.push(best);
      }
    }
    var show = function (kb) {
      return readable ? human(kb, ["0", "K", "M", "G", "T"], true) : String(kb);
    };
    var rows = [["Filesystem", readable ? "Size" : "1K-blocks", "Used", readable ? "Avail" : "Available", "Use%", "Mounted on"]];
    shown.forEach(function (fs) {
      rows.push([fs[0], show(fs[1]), show(fs[2]), show(fs[1] - fs[2]), Math.ceil((fs[2] * 100) / fs[1]) + "%", fs[3]]);
    });
    var widths = [14, readable ? 5 : 0, readable ? 5 : 0, readable ? 5 : 0, 4];
    rows.forEach(function (row) {
      for (var c = 0; c < 5; c++) widths[c] = Math.max(widths[c], row[c].length);
    });
    var stdout = rows.length > 1
      ? rows.map(function (row) {
          return (
            row[0].padEnd(widths[0]) + " " + row[1].padStart(widths[1]) + " " + row[2].padStart(widths[2]) + " " +
            row[3].padStart(widths[3]) + " " + row[4].padStart(widths[4]) + " " + row[5]
          );
        }).join("\n") + "\n"
      : "";
    return { stdout: stdout, stderr: stderr, exitCode: stderr ? 1 : 0 };
  }

  function uptime(args) {
    var opts = split(args);
    if (/s/.test(opts.letters) || opts.long.indexOf("since") !== -1) {
      return ok(day(machine.bootedAt) + " " + clock(machine.bootedAt, true) + "\n");
    }
    if (/p/.test(opts.letters) || opts.long.indexOf("pretty") !== -1) {
      var minutes = Math.floor(machine.uptimeSeconds() / 60);
      var parts = [
        [Math.floor(minutes / 10080), "week"], [Math.floor((minutes % 10080) / 1440), "day"],
        [Math.floor((minutes % 1440) / 60), "hour"], [minutes % 60, "minute"],
      ].filter(function (part) {
        return part[0];
      }).map(function (part) {
        return part[0] + " " + part[1] + (part[0] === 1 ? "" : "s");
      });
      return ok("up " + parts.join(", ") + "\n");
    }
    return ok(uptimeLine());
  }

  function who() {
    return ok(user.padEnd(8) + " tty1         " + day(machine.loggedInAt) + " " + clock(machine.loggedInAt) + "\n");
  }

  function w() {
    return ok(
      uptimeLine() +
        "USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU  WHAT\n" +
        user.padEnd(8) + " tty1     -                " + clock(machine.loggedInAt) + "    0.00s  0.04s  0.00s w\n"
    );
  }

  // The name the kernel keeps for a process: its program, cut to 15
  // characters.
  function shortName(process) {
    var command = process.command;
    var name;
    if (process.kernel) name = command;
    else if (command === "/sbin/init") name = "systemd";
    else if (command.indexOf("unattended-upgrade") !== -1) name = "unattended-upgr";
    else name = command.replace(/^[-@]/, "").split(/[ :]/)[0].split("/").pop();
    return name.slice(0, 15);
  }

  function ps(args, ctx) {
    var letters = args.join("").replace(/-/g, "");
    var everything = /[aexA]/.test(letters);
    var format = /u/.test(letters) ? "user" : /[fF]/.test(letters) ? "full" : "basic";
    var now = Date.now();
    lastPid += 1 + Math.floor(Math.random() * 3);
    var list = processes.concat([{
      pid: lastPid, ppid: shellPid, user: user, tty: "tty1", state: "R+", rss: 4480, vsz: 12188,
      command: ["ps"].concat(args).join(" "), started: now,
    }]);
    if (!everything) {
      list = list.filter(function (process) {
        return process.tty === "tty1";
      });
    }
    function started(process) {
      if (now - process.started < DAY) return clock(process.started);
      var d = new Date(process.started);
      return MONTHS[d.getUTCMonth()] + pad2(d.getUTCDate());
    }
    // Processor time used: nothing to speak of on an idle machine.
    function seconds(process) {
      return process.kernel || process.started > machine.bootedAt ? 0 : process.pid % 9;
    }
    function full(process) {
      return process.kernel ? "[" + process.command + "]" : process.command;
    }
    var lines;
    if (format === "user") {
      lines = ["USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND"].concat(
        list.map(function (p) {
          return (
            p.user.padEnd(8) + " " + String(p.pid).padStart(7) + "  0.0 " +
            ((p.rss * 100) / machine.memory.total).toFixed(1).padStart(4) + " " + String(p.vsz).padStart(6) + " " +
            String(p.rss).padStart(5) + " " + p.tty.padEnd(8) + " " + p.state.padEnd(4) + " " + started(p) + " " +
            ("0:" + pad2(seconds(p))).padStart(6) + " " + full(p)
          );
        })
      );
    } else if (format === "full") {
      lines = ["UID          PID    PPID  C STIME TTY          TIME CMD"].concat(
        list.map(function (p) {
          return (
            p.user.padEnd(8) + " " + String(p.pid).padStart(7) + " " + String(p.ppid).padStart(7) + "  0 " +
            started(p) + " " + p.tty.padEnd(8) + " 00:00:" + pad2(seconds(p)) + " " + full(p)
          );
        })
      );
    } else {
      lines = ["    PID TTY          TIME CMD"].concat(
        list.map(function (p) {
          return String(p.pid).padStart(7) + " " + p.tty.padEnd(8) + " 00:00:" + pad2(seconds(p)) + " " + shortName(p);
        })
      );
    }
    // On a terminal ps cuts each line to the width of the screen.
    if (!ctx.fileDescriptors || !ctx.fileDescriptors.has(NOT_A_TTY_FD)) {
      var width = parseInt(ctx.env.get("COLUMNS"), 10) || 80;
      lines = lines.map(function (line) {
        return line.slice(0, width);
      });
    }
    return ok(lines.join("\n") + "\n");
  }

  function lsbRelease(args) {
    var opts = split(args);
    var fields = [
      ["i", "Distributor ID", host.os.name], ["d", "Description", host.os.name + " " + host.os.version],
      ["r", "Release", machine.release()], ["c", "Codename", host.os.codename || "resolute"],
    ];
    var all = /a/.test(opts.letters);
    var short = /s/.test(opts.letters);
    var out = fields.filter(function (field) {
      return all || opts.letters.indexOf(field[0]) !== -1;
    }).map(function (field) {
      return (short ? "" : field[1] + ":\t") + field[2] + "\n";
    }).join("");
    return Promise.resolve({ stdout: out, stderr: "No LSB modules are available.\n", exitCode: 0 });
  }

  function ip(args) {
    var object = args.filter(function (arg) {
      return arg.charAt(0) !== "-";
    })[0];
    if (!object) {
      return fail(
        "Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\n" +
          "where  OBJECT := { address | link | route }\n",
        255
      );
    }
    function matches(name) {
      return name.indexOf(object) === 0;
    }
    var lo = "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n" +
      "    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n";
    var eth = "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\n" +
      "    link/ether " + mac + " brd ff:ff:ff:ff:ff:ff\n";
    if (matches("address")) {
      var lease = 86400 - (machine.uptimeSeconds() % 43200);
      return ok(
        lo.replace(" mode DEFAULT", "") +
          "    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n" +
          "    inet6 ::1/128 scope host noprefixroute \n       valid_lft forever preferred_lft forever\n" +
          eth.replace(" mode DEFAULT", "") +
          "    inet " + address + "/24 metric 100 brd " + subnet + ".255 scope global dynamic eth0\n" +
          "       valid_lft " + lease + "sec preferred_lft " + lease + "sec\n" +
          "    inet6 fe80::5054:ff:fe" + mac.slice(9, 11) + ":" + mac.slice(12).replace(":", "") + "/64 scope link \n" +
          "       valid_lft forever preferred_lft forever\n"
      );
    }
    if (matches("link")) return ok(lo + eth);
    if (matches("route")) {
      return ok(
        "default via " + subnet + ".1 dev eth0 proto dhcp src " + address + " metric 100 \n" +
          subnet + ".0/24 dev eth0 proto kernel scope link src " + address + " metric 100 \n" +
          subnet + ".1 dev eth0 proto dhcp scope link src " + address + " metric 100 \n"
      );
    }
    return fail('Object "' + object + '" is unknown, try "ip help".\n');
  }

  function hostname(args, ctx) {
    if (!args.length || args[0] === "-s" || args[0] === "-f") return ok(host.hostname + "\n");
    if (args[0] === "-I") return ok(address + " \n");
    return ctx.origCommand(args);
  }

  // bash's own `env` and `printenv` list every shell variable; the real
  // ones only see what has been exported.
  function environment(ctx) {
    var exported = ctx.exportedEnv || {};
    return Object.keys(exported).map(function (name) {
      return name + "=" + exported[name] + "\n";
    }).join("");
  }

  function env(args, ctx) {
    return args.length ? ctx.origCommand(args) : ok(environment(ctx) + "_=/usr/bin/env\n");
  }

  function printenv(args, ctx) {
    if (!args.length) return ok(environment(ctx) + "_=/usr/bin/printenv\n");
    var exported = ctx.exportedEnv || {};
    var out = "";
    var missing = false;
    args.forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(exported, name)) out += exported[name] + "\n";
      else missing = true;
    });
    return Promise.resolve({ stdout: out, stderr: "", exitCode: missing ? 1 : 0 });
  }

  // What `man` is on a minimal server image: a script that says the pages
  // were left out.
  function man(args) {
    if (!args.length) return fail("What manual page do you want?\nFor example, try 'man man'.\n");
    return ok(
      "This system has been minimized by removing packages and content that are\n" +
        "not required on a system that users do not log into.\n\n" +
        "To restore this content, including manpages, you can run the 'unminimize'\n" +
        "command. You will still need to ensure the 'man-db' package is installed.\n"
    );
  }

  // Already root, so there is nothing to ask for: sudo runs the command.
  function sudo(args, ctx) {
    var command = args.slice();
    while (command.length && command[0].charAt(0) === "-") command.shift();
    if (!args.length) {
      return fail(
        "usage: sudo -h | -K | -k | -V\n" +
          "usage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\n" +
          "usage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\n" +
          "usage: sudo [-ABbEHkNnPS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n" +
          "usage: sudo -e [-ABkNnS] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] file ...\n"
      );
    }
    if (!command.length) return ok("");
    var line = command.map(function (arg) {
      return "'" + arg.replace(/'/g, "'\\''") + "'";
    }).join(" ");
    // Whether output reaches the terminal is the same for the command as
    // it is for sudo.
    if (ctx.fileDescriptors && ctx.fileDescriptors.has(NOT_A_TTY_FD)) line += " " + NOT_A_TTY_FD + "<<<''";
    return ctx.exec(line, { cwd: ctx.cwd });
  }

  // just-bash's `uniq -c` pads its counts to four columns; the real one
  // uses seven, which is what lines the numbers up in `sort | uniq -c`.
  async function uniq(args, ctx) {
    var result = await ctx.origCommand(args);
    var counting = args.some(function (arg) {
      return /^-[a-z]*c/.test(arg) || arg === "--count";
    });
    if (!counting) return result;
    return Object.assign({}, result, {
      stdout: result.stdout.replace(/^ *(\d+) /gm, function (match, count) {
        return count.padStart(7) + " ";
      }),
    });
  }

  // just-bash's `xargs` only takes an option's value as a separate word;
  // `-n1` and `-I{}` are how they are usually typed.
  function xargs(args, ctx) {
    var split = [];
    var i = 0;
    for (; i < args.length && args[i].charAt(0) === "-" && args[i] !== "--"; i++) {
      var joined = /^-([InPd])(.+)$/.exec(args[i]);
      if (joined) split.push("-" + joined[1], joined[2]);
      else {
        split.push(args[i]);
        if (/^-[InPd]$/.test(args[i]) && i + 1 < args.length) split.push(args[++i]);
      }
    }
    return ctx.origCommand(split.concat(args.slice(i)));
  }

  var commands = {
    uname: uname, id: id, free: free, df: df, uptime: uptime, who: who, w: w, ps: ps,
    lsb_release: lsbRelease, ip: ip, hostname: hostname, env: env, printenv: printenv, man: man, sudo: sudo,
    uniq: uniq, xargs: xargs,
    whoami: function () {
      return ok(user + "\n");
    },
    groups: function () {
      return ok(user + "\n");
    },
    tty: function () {
      return ok("/dev/tty1\n");
    },
    nproc: function () {
      return ok(machine.cores + "\n");
    },
    // What `clear` sends an xterm: home, erase the screen, erase scrollback.
    clear: function () {
      return ok("\x1b[H\x1b[2J\x1b[3J");
    },
    cmatrix: function () {
      return host.cmatrix().then(function () {
        return { stdout: "", stderr: "", exitCode: 0 };
      });
    },
  };

  return {
    list: Object.keys(commands).map(function (name) {
      return defineCommand(name, commands[name]);
    }),
    // For /proc/loadavg, which reports the count and the newest pid.
    processCount: function () {
      return processes.length + 1;
    },
    lastPid: function () {
      return lastPid;
    },
  };
}

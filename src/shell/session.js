import { Bash, defineCommand, getCommandNames } from "just-bash";
import { HOME, SITE, seedFiles } from "./tree.js";
import { NOT_A_TTY_FD, lsCommand } from "./ls.js";
import { createMachine } from "./machine.js";
import { createCommands } from "./commands.js";
import { createCompleter } from "./complete.js";

// One login session: a bash interpreter (just-bash) over an in-memory disk.
//
// just-bash runs every exec() as a fresh shell. Files persist between calls
// but the working directory, variables, functions and $? do not, which is
// right for running scripts and wrong for someone typing one line at a time.
// Most of this file is about carrying that state from each line to the next.

// Holds the exit status of the line just run; see the plugin below.
var STATUS_VAR = "__status";

function word(text) {
  return { type: "Word", parts: [{ type: "Literal", value: text }] };
}

// The text of a word that is nothing but plain text, else null.
function literal(node) {
  if (!node || node.parts.length !== 1 || node.parts[0].type !== "Literal") return null;
  return node.parts[0].value;
}

function statement(command) {
  return {
    type: "Statement",
    pipelines: [{ type: "Pipeline", commands: [command], negated: false }],
    operators: [],
    background: false,
  };
}

function clone(node) {
  return JSON.parse(JSON.stringify(node));
}

function writesToFile(redirection) {
  return (
    (redirection.fd === null || redirection.fd === 1) &&
    [">", ">>", ">|", "&>", "&>>"].indexOf(redirection.operator) !== -1
  );
}

// just-bash hands each line's syntax tree to this before running it, which
// is the one place to add what an interactive shell needs:
//
// - `ls` behaves differently when its output is a terminal, and a command
//   has no way to ask. The tree says where output goes, so every command
//   that is piped, captured or redirected to a file gets a marker
//   descriptor (see ls.js). Whatever it runs in turn inherits the marker.
// - Functions defined at the prompt are kept and defined again ahead of
//   every later line.
// - A last statement saves $?. The variables come back from exec() only
//   when a script runs to its end, so finding it there also tells a line
//   that finished apart from one that called `exit` or was cut short.
function createPlugin(session) {
  function offTerminal(command) {
    command.redirections = (command.redirections || []).concat([
      { type: "Redirection", fd: NOT_A_TTY_FD, operator: "<<<", target: word("") },
    ]);
  }

  // tty: whether output written here reaches the terminal. main: whether
  // this runs in the login shell itself rather than a subshell, which is
  // what decides if `exit` ends the session.
  function visit(node, tty, main) {
    if (Array.isArray(node)) {
      node.forEach(function (child) {
        visit(child, tty, main);
      });
      return;
    }
    if (!node || typeof node !== "object") return;

    if (node.type === "Statement") {
      node.pipelines.forEach(function (pipeline) {
        var count = pipeline.commands.length;
        pipeline.commands.forEach(function (command, i) {
          var out = tty && i === count - 1 && !(command.redirections || []).some(writesToFile);
          if (tty && !out) offTerminal(command);
          visit(command, out, main && count === 1);
        });
      });
      return;
    }
    if (node.type === "CommandSubstitution" || node.type === "ProcessSubstitution") {
      node.body.statements.forEach(function (inner) {
        inner.pipelines.forEach(function (pipeline) {
          pipeline.commands.forEach(offTerminal);
        });
      });
      visit(node.body.statements, false, false);
      return;
    }
    if (node.type === "Subshell") main = false;
    if (node.type === "SimpleCommand" && main) {
      var name = literal(node.name);
      if (name === "exit" || name === "logout") {
        session.sawExit = true;
        // In a login shell the two do the same thing.
        node.name = word("exit");
      }
    }
    Object.keys(node).forEach(function (key) {
      visit(node[key], tty, main);
    });
  }

  function remember(st, hasExit) {
    if (st.pipelines.length !== 1 || st.pipelines[0].commands.length !== 1) return;
    var command = st.pipelines[0].commands[0];
    if (command.type === "FunctionDef") {
      session.functions[command.name] = { statement: clone(st), hasExit: hasExit };
    } else if (command.type === "SimpleCommand" && literal(command.name) === "unset") {
      var names = command.args.map(literal);
      if (names.indexOf("-f") !== -1) {
        names.forEach(function (name) {
          delete session.functions[name];
        });
      }
    }
  }

  return {
    name: "session",
    transform: function (context) {
      // Commands such as `bash -c` and `xargs` run scripts of their own
      // through the same hook; those are not lines typed at the prompt.
      if (!session.top) {
        visit(context.ast.statements, true, false);
        return { ast: context.ast };
      }
      session.top = false;
      session.parsed = true;

      var kept = Object.keys(session.functions).map(function (name) {
        return session.functions[name];
      });
      session.sawExit = kept.some(function (fn) {
        return fn.hasExit;
      });
      var definitions = kept.map(function (fn) {
        return clone(fn.statement);
      });

      context.ast.statements.forEach(function (st) {
        var before = session.sawExit;
        session.sawExit = false;
        // Run with its output going somewhere other than a terminal, the
        // whole line is in the position a piped command would be.
        if (session.piped) {
          st.pipelines.forEach(function (pipeline) {
            pipeline.commands.forEach(offTerminal);
          });
        }
        visit(st, !session.piped, true);
        var hasExit = session.sawExit;
        session.sawExit = before || hasExit;
        remember(st, hasExit);
      });

      var saveStatus = statement({
        type: "SimpleCommand",
        assignments: [
          {
            type: "Assignment",
            name: STATUS_VAR,
            value: { type: "Word", parts: [{ type: "ParameterExpansion", parameter: "?", operation: null }] },
            append: false,
            array: null,
          },
        ],
        name: null,
        args: [],
        redirections: [],
      });
      return {
        ast: { type: "Script", statements: definitions.concat(context.ast.statements, [saveStatus]) },
      };
    },
  };
}

// just-bash signs a few of its messages, or words them for the people who
// embed it rather than for whoever is at the prompt. Put as bash would.
function inCharacter(output) {
  return output
    .replace(/^just-bash shell builtins$/m, "GNU bash, version 5.1.0(1)-release (x86_64-pc-linux-gnu)")
    .replace(/^bash: (\S+): command not available in browser environments\..*$/gm, "bash: $1: command not found")
    .replace(/(too many [^\n]*?), increase executionLimits\.\w+/g, "$1");
}

// Commands just-bash ships that a stock server doesn't have.
var NOT_INSTALLED = ["sqlite3", "xan", "html-to-markdown"];

// host: who is logged in to what, the figures the login banner showed (see
// machine.js), and cmatrix(), the one program that needs the screen to
// itself - it resolves when the program exits.
export function createSession(host) {
  var machine = createMachine(host);
  var shellPid = 1100 + Math.floor(Math.random() * 600);
  var commands = createCommands(host, machine, shellPid);
  var session = {
    cwd: HOME,
    // HOSTNAME is a shell variable in bash, not part of the environment.
    env: { HOSTNAME: host.hostname },
    status: 0,
    functions: {},
    top: false,
    parsed: false,
    sawExit: false,
    piped: false,
    // "reboot" or "poweroff" once a command has asked for it.
    power: null,
  };

  // The commands that take the machine down. All they do here is say so:
  // the terminal plays out the rest once the line has finished.
  function power(name, decide) {
    return defineCommand(name, function (args) {
      session.power = decide(args);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });
  }
  var powerCommands = [
    // `reboot hannah`, `reboot redstar`: straight into one of the systems on
    // the boot menu, without the menu (host.rebootTargets, from terminal.js).
    power("reboot", function (args) {
      var targets = host.rebootTargets || {};
      for (var i = 0; i < args.length; i++) {
        var name = String(args[i]).toLowerCase().replace(/[^a-z]/g, "");
        if (targets[name]) return { how: "reboot", then: targets[name] };
      }
      return "reboot";
    }),
    power("poweroff", function () {
      return "poweroff";
    }),
    power("halt", function () {
      return "poweroff";
    }),
    power("shutdown", function (args) {
      if (args.indexOf("-c") !== -1) return null;
      return args.indexOf("-r") !== -1 || args.indexOf("--reboot") !== -1 ? "reboot" : "poweroff";
    }),
  ];

  var bash = new Bash({
    cwd: HOME,
    // What login hands a root shell on the console.
    env: {
      SHELL: "/bin/bash",
      LOGNAME: host.user,
      HOME: HOME,
      LANG: "C.UTF-8",
      TERM: "vt220",
      USER: host.user,
      SHLVL: "1",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
      MAIL: "/var/mail/" + host.user,
    },
    files: seedFiles(),
    commands: getCommandNames().filter(function (name) {
      return NOT_INSTALLED.indexOf(name) === -1;
    }),
    processInfo: { pid: shellPid, ppid: shellPid - 31, uid: 0, gid: 0 },
    executionLimits: {
      // A person decides how long a command runs (Ctrl+C), not a deadline.
      maxExecutionTimeMs: Infinity,
      // Output is only shown once a command ends, so runaway output (`yes`)
      // would otherwise build up unseen for a long time before failing.
      maxOutputSize: 1024 * 1024,
    },
    customCommands: [lsCommand].concat(commands.list, powerCommands),
  });
  bash.registerTransformPlugin(createPlugin(session));

  // Runs one line in the login shell and carries its state forward.
  async function execute(line, options) {
    session.top = true;
    session.parsed = false;
    session.piped = options.terminal === false;
    session.power = null;
    // Private to just-bash, and the only way to make $? on this line be the
    // status of the last one. The version is pinned in package.json.
    if (bash.state) bash.state.lastExitCode = session.status;

    var live = machine.liveFiles(commands.processCount(), commands.lastPid());
    Object.keys(live).forEach(function (path) {
      bash.fs.writeFileSync(path, live[path]);
    });

    var env = Object.assign({}, session.env, {
      COLUMNS: String(options.cols),
      LINES: String(options.rows),
      // Where just-bash's `history` reads its list from.
      BASH_HISTORY: JSON.stringify(options.history || []),
    });
    var result;
    try {
      result = await bash.exec(line, { cwd: session.cwd, env: env, signal: options.signal });
    } catch (error) {
      session.top = false;
      session.status = 1;
      return { output: "bash: " + ((error && error.message) || error) + "\n", status: 1, cwd: session.cwd, logout: false };
    }
    session.top = false;

    var stdout = result.stdout || "";
    var stderr = result.stderr || "";
    var logout = false;
    if (!session.parsed) {
      // A syntax error: nothing ran.
      session.status = result.exitCode;
    } else if (result.env && result.env[STATUS_VAR] !== undefined) {
      session.status = parseInt(result.env[STATUS_VAR], 10) || 0;
      var next = Object.assign({}, result.env);
      delete next[STATUS_VAR];
      delete next.BASH_HISTORY;
      delete next["?"];
      session.env = next;
      if (next.PWD) session.cwd = next.PWD;
    } else if (options.signal && options.signal.aborted) {
      session.status = 130;
      stderr = stderr.replace(/^bash: execution aborted\n/m, "");
    } else {
      session.status = result.exitCode;
      // Stopped early, and not by a syntax error or Ctrl+C. That is `exit`
      // unless just-bash gave up on a runaway script.
      logout = session.sawExit && !/^bash: (too many|execution|.*limit)/m.test(stderr);
    }
    stdout = inCharacter(stdout);
    stderr = inCharacter(stderr);
    return {
      output: stdout + stderr,
      stdout: stdout,
      stderr: stderr,
      status: session.status,
      cwd: session.cwd,
      logout: logout,
      power: session.power,
    };
  }

  // Lays out the rest of the disk and starts the shell the way login does.
  async function prepare() {
    var fs = bash.fs;
    machine.directories.concat([HOME]).forEach(function (dir) {
      fs.mkdirSync(dir, { recursive: true });
    });
    Object.keys(machine.files).forEach(function (path) {
      fs.writeFileSync(path, machine.files[path]);
    });

    // Nothing on a server was last touched the moment someone logged in.
    function inside(path, roots) {
      return roots.some(function (root) {
        return path === root || path.indexOf(root + "/") === 0;
      });
    }
    var paths = fs.getAllPaths();
    for (var i = 0; i < paths.length; i++) {
      var when = inside(paths[i], [SITE]) ? machine.deployedAt
        : inside(paths[i], machine.volatile) ? machine.bootedAt
        : machine.installedAt;
      try {
        await fs.utimes(paths[i], new Date(when), new Date(when));
      } catch (error) {}
    }

    var modes = Object.keys(machine.modes);
    for (var m = 0; m < modes.length; m++) {
      try {
        await fs.chmod(modes[m], machine.modes[modes[m]]);
      } catch (error) {}
    }

    // bash only expands aliases when it is interactive, which this is.
    await bash.exec("shopt -s expand_aliases");
    await execute(". ~/.bashrc", { cols: 80, rows: 25 });
  }
  var ready = prepare();

  // Runs one line typed at the prompt. options: { cols, rows, history,
  // signal }, and terminal: false to run it as if its output were piped
  // away. Resolves to what to print, the exit status, the directory the
  // shell is now in, and whether the line ended the session.
  async function run(line, options) {
    await ready;
    return execute(line, options);
  }

  var completer = createCompleter(bash, session);
  async function complete(line, cursor, cols) {
    await ready;
    return completer(line, cursor, cols);
  }

  // Whether `text` is the start of a command rather than a whole one: an
  // open quote, an `if` without its `fi`, a line ending in a pipe or a
  // backslash. bash asks for the rest with its "> " prompt.
  async function incomplete(text) {
    await ready;
    if (/(^|[^\\])(\\\\)*\\$/.test(text)) return true;
    try {
      bash.transform(text);
    } catch (error) {
      var message = String((error && error.message) || error);
      if (/unexpected EOF|got EOF|unterminated here-document/.test(message)) return true;
      // Any other complaint made about the very end of the text is the
      // parser running out of input, not finding something wrong.
      var where = /Parse error at (\d+):(\d+)/.exec(message);
      var lines = text.split("\n");
      return !!where && +where[1] === lines.length && +where[2] > lines[lines.length - 1].length;
    }
    return /(\|\||&&|\|)\s*$/.test(text);
  }

  // Ctrl+C at the prompt: nothing ran, and $? says so.
  function interrupt() {
    session.status = 130;
  }

  // Puts a file on the disk from outside the shell.
  async function write(path, content) {
    await ready;
    bash.fs.writeFileSync(path, content);
  }

  // A new login on the same machine: the disk is as it was left, and the
  // shell starts from nothing, as it does after a reboot.
  function relogin() {
    ready = ready.then(function () {
      session.cwd = HOME;
      session.env = { HOSTNAME: host.hostname };
      session.status = 0;
      session.functions = {};
      return execute(". ~/.bashrc", { cols: 80, rows: 25 });
    });
    return ready;
  }

  // The boot menu has started this machine as another system: host says
  // which (terminal.js has changed it), and extra is the files that system
  // has of its own. The last one's are taken away first.
  var extraFiles = [];
  function rebrand(extra) {
    ready = ready.then(async function () {
      var fs = bash.fs;
      for (var i = 0; i < extraFiles.length; i++) {
        try {
          await fs.rm(extraFiles[i], { force: true });
        } catch (error) {}
      }
      extra = extra || {};
      extraFiles = Object.keys(extra);
      var files = Object.assign(machine.osFiles(), extra);
      Object.keys(files).forEach(function (path) {
        var dir = path.slice(0, path.lastIndexOf("/"));
        if (dir) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path, files[path]);
      });
    });
    return ready;
  }

  return {
    home: HOME,
    rebrand: rebrand,
    run: run,
    complete: complete,
    incomplete: incomplete,
    interrupt: interrupt,
    write: write,
    relogin: relogin,
  };
}

import { Bash, defineCommand } from "just-bash";
import { DIRS, HOME, seedFiles } from "./tree.js";
import { NOT_A_TTY_FD, lsCommand } from "./ls.js";

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
        visit(st, true, true);
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

function text(stdout) {
  return Promise.resolve({ stdout: stdout, stderr: "", exitCode: 0 });
}

// host: { user, hostname, cmatrix() } - who is logged in to what, and the
// one program that needs the screen to itself (it resolves when it exits).
export function createSession(host) {
  var session = {
    cwd: HOME,
    // HOSTNAME is a shell variable in bash, not part of the environment.
    env: { HOSTNAME: host.hostname },
    status: 0,
    functions: {},
    top: false,
    parsed: false,
    sawExit: false,
  };

  var bash = new Bash({
    cwd: HOME,
    env: { HOME: HOME, USER: host.user, LOGNAME: host.user, SHELL: "/bin/bash", TERM: "vt220" },
    files: seedFiles(),
    processInfo: { pid: 900 + Math.floor(Math.random() * 600), ppid: 1, uid: 0, gid: 0 },
    executionLimits: {
      // A person decides how long a command runs (Ctrl+C), not a deadline.
      maxExecutionTimeMs: Infinity,
      // Output is only shown once a command ends, so runaway output (`yes`)
      // would otherwise build up unseen for a long time before failing.
      maxOutputSize: 1024 * 1024,
    },
    customCommands: [
      lsCommand,
      defineCommand("whoami", function () {
        return text(host.user + "\n");
      }),
      defineCommand("hostname", function (args, ctx) {
        return args.length ? ctx.origCommand(args) : text(host.hostname + "\n");
      }),
      // What `clear` sends an xterm: home, erase the screen, erase scrollback.
      defineCommand("clear", function () {
        return text("\x1b[H\x1b[2J\x1b[3J");
      }),
      defineCommand("cmatrix", function () {
        return host.cmatrix().then(function () {
          return { stdout: "", stderr: "", exitCode: 0 };
        });
      }),
    ],
  });
  DIRS.forEach(function (dir) {
    bash.fs.mkdirSync(dir, { recursive: true });
  });
  bash.registerTransformPlugin(createPlugin(session));

  // bash only expands aliases when it is interactive, which this is.
  var ready = bash.exec("shopt -s expand_aliases");

  // Runs one line typed at the prompt. options: { cols, rows, history,
  // signal }. Resolves to what to print, the exit status, the directory the
  // shell is now in, and whether the line ended the session.
  async function run(line, options) {
    await ready;
    session.top = true;
    session.parsed = false;
    // Private to just-bash, and the only way to make $? on this line be the
    // status of the last one. The version is pinned in package.json.
    if (bash.state) bash.state.lastExitCode = session.status;

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
    return { output: stdout + stderr, status: session.status, cwd: session.cwd, logout: logout };
  }

  // The directories inside `path` (relative to the shell's own), for
  // completing `cd`.
  async function directories(path) {
    try {
      var dir = bash.fs.resolvePath(session.cwd, path.replace(/^~(?=\/|$)/, HOME) || ".");
      var names = await bash.fs.readdir(dir);
      var found = [];
      for (var i = 0; i < names.length; i++) {
        if ((await bash.fs.stat(dir + "/" + names[i])).isDirectory) found.push(names[i]);
      }
      return found.sort();
    } catch (error) {
      return [];
    }
  }

  return { home: HOME, run: run, directories: directories };
}

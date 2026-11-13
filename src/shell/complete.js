import { columns } from "./ls.js";
import { HOME } from "./tree.js";

// Tab completion, as bash does it on a stock Ubuntu install: command names
// where a command goes, file names elsewhere (directories only after `cd`),
// and variable names after a `$`.

var BUILTINS = [
  ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen",
  "complete", "compopt", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec",
  "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let",
  "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type",
  "typeset", "ulimit", "umask", "unalias", "unset", "wait",
];
var KEYWORDS = [
  "!", "[[", "]]", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function",
  "if", "in", "select", "then", "time", "until", "while", "{", "}",
];
var DIRECTORIES_ONLY = { cd: true, pushd: true, rmdir: true };
// Commands whose first argument is itself a command.
var TAKES_A_COMMAND = {
  sudo: true, command: true, exec: true, time: true, type: true, which: true, man: true, xargs: true, nohup: true,
};

// Reads the line up to the cursor the way the shell would split it, and
// reports on the word being typed: where it starts, what it says once quotes
// and backslashes are taken off, the quote it is still inside, the words of
// the command before it, and whether it follows a redirection.
function wordAtCursor(line) {
  var state = { start: 0, word: "", quote: "", words: [], redirect: false };
  var started = false;
  function endWord(index) {
    if (started) state.words.push(state.word);
    if (started) state.redirect = false;
    state.word = "";
    state.start = index + 1;
    started = false;
  }
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (state.quote === "'") {
      if (c === "'") state.quote = "";
      else state.word += c;
    } else if (state.quote === '"') {
      if (c === '"') state.quote = "";
      else if (c === "\\" && '"\\$`'.indexOf(line.charAt(i + 1)) !== -1) state.word += line.charAt(++i);
      else state.word += c;
    } else if (c === "\\") {
      state.word += line.charAt(++i);
      started = true;
    } else if (c === "'" || c === '"') {
      state.quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      endWord(i);
    } else if ("|;&(".indexOf(c) !== -1) {
      endWord(i);
      state.words = [];
      state.redirect = false;
    } else if (c === "<" || c === ">") {
      endWord(i);
      state.redirect = true;
    } else {
      state.word += c;
      started = true;
    }
  }
  return state;
}

// Text as it has to be typed for the shell to read it back as itself.
function escape(text, quote) {
  if (quote === "'") return text;
  if (quote === '"') return text.replace(/(["$`\\])/g, "\\$1");
  return text.replace(/([^A-Za-z0-9_\-.,:+@%\/=~])/g, "\\$1");
}

function commonPrefix(names) {
  return names.reduce(function (a, b) {
    var i = 0;
    while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
    return a.slice(0, i);
  });
}

export function createCompleter(bash, session) {
  var fs = bash.fs;

  async function commands(prefix) {
    var names = {};
    BUILTINS.concat(KEYWORDS, Object.keys(session.functions)).forEach(function (name) {
      names[name] = true;
    });
    Object.keys(session.env).forEach(function (name) {
      if (name.indexOf("BASH_ALIAS_") === 0) names[name.slice(11)] = true;
    });
    var path = (session.env.PATH || bash.getEnv().PATH || "").split(":");
    for (var i = 0; i < path.length; i++) {
      try {
        (await fs.readdir(path[i])).forEach(function (name) {
          names[name] = true;
        });
      } catch (error) {}
    }
    return Object.keys(names).filter(function (name) {
      return name.indexOf(prefix) === 0;
    }).map(function (name) {
      return { name: name, value: name, directory: false };
    });
  }

  async function files(word, directoriesOnly) {
    var slash = word.lastIndexOf("/");
    var typedDir = word.slice(0, slash + 1);
    var prefix = word.slice(slash + 1);
    var dir = fs.resolvePath(session.cwd, typedDir.replace(/^~(?=\/)/, HOME) || ".");
    var names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      return [];
    }
    var found = [];
    for (var i = 0; i < names.length; i++) {
      // Hidden files only once the dot has been typed.
      if (names[i].indexOf(prefix) !== 0 || (names[i].charAt(0) === "." && prefix.charAt(0) !== ".")) continue;
      var directory = false;
      try {
        directory = (await fs.stat(dir + "/" + names[i])).isDirectory;
      } catch (error) {}
      if (directory || !directoriesOnly) found.push({ name: names[i], value: typedDir + names[i], directory: directory });
    }
    return found;
  }

  function variables(word) {
    var names = {};
    Object.keys(session.env).concat(Object.keys(bash.getEnv())).forEach(function (name) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.indexOf("BASH_ALIAS_") !== 0) names[name] = true;
    });
    return Object.keys(names).filter(function (name) {
      return ("$" + name).indexOf(word) === 0;
    }).map(function (name) {
      return { name: "$" + name, value: "$" + name, directory: false };
    });
  }

  // Resolves to what Tab does for `line` with the cursor at `cursor`:
  // `insert` is text to add at the cursor (empty when there is nothing more
  // to add), `count` how many candidates there are, and `listing` those
  // candidates laid out for a terminal `cols` wide.
  return async function complete(line, cursor, cols) {
    var state = wordAtCursor(line.slice(0, cursor));
    var word = state.word;
    var before = state.words.filter(function (earlier) {
      return !/^[A-Za-z_][A-Za-z0-9_]*=/.test(earlier);
    });
    var wantsCommand = before.every(function (earlier) {
      return TAKES_A_COMMAND[earlier];
    });

    var found;
    if (state.quote !== "'" && /^\$[A-Za-z0-9_]*$/.test(word)) found = variables(word);
    else if (!state.redirect && wantsCommand && word.indexOf("/") === -1) found = word ? await commands(word) : [];
    else found = await files(word, !state.redirect && DIRECTORIES_ONLY[before[0]]);
    if (!found.length) return { insert: "", count: 0, listing: "" };

    found.sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    var insert;
    if (found.length === 1) {
      insert = escape(found[0].value.slice(word.length), state.quote) + (found[0].directory ? "/" : state.quote + " ");
    } else {
      var shared = commonPrefix(found.map(function (item) {
        return item.value;
      }));
      insert = escape(shared.slice(word.length), state.quote);
    }
    var items = found.map(function (item) {
      var text = item.name + (item.directory ? "/" : "");
      return { text: text, shown: text };
    });
    return { insert: insert, count: found.length, listing: columns(items, cols || 80).join("\n") };
  };
}

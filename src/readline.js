// The line being typed at the prompt, edited the way bash's readline does
// it. xterm.js only draws characters and reports keys; it has no idea what
// "the current input line" is, so the text, the cursor within it and the
// picture of both on screen are all kept here.

// What the terminal sends, split into keys: an escape sequence is one key,
// and so is anything else, one character at a time (a paste arrives as one
// long string).
var KEY = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO.|\x1b.|./gsu;

export function splitKeys(data) {
  return data.match(KEY) || [];
}

var KEYS = {
  "\r": "accept",
  "\x7f": "backspace", "\b": "backspace",
  "\x1b[3~": "delete",
  "\x1b[D": "left", "\x1bOD": "left", "\x02": "left",
  "\x1b[C": "right", "\x1bOC": "right", "\x06": "right",
  "\x1b[H": "home", "\x1bOH": "home", "\x1b[1~": "home", "\x01": "home",
  "\x1b[F": "end", "\x1bOF": "end", "\x1b[4~": "end", "\x05": "end",
  "\x1b[A": "previous", "\x1bOA": "previous", "\x10": "previous",
  "\x1b[B": "next", "\x1bOB": "next", "\x0e": "next",
  "\x1b[1;5D": "wordLeft", "\x1b[1;3D": "wordLeft", "\x1bb": "wordLeft",
  "\x1b[1;5C": "wordRight", "\x1b[1;3C": "wordRight", "\x1bf": "wordRight",
  "\x0b": "killToEnd", "\x15": "killToStart", "\x17": "killWord", "\x1b\x7f": "killWordBack",
  "\x1bd": "killWordForward", "\x19": "yank",
  "\x0c": "clearScreen", "\x03": "interrupt", "\x04": "endOfFile", "\t": "complete", "\x12": "search",
};

// hooks:
//   history            the commands run so far, oldest first
//   complete(line, cursor, cols)
//                      resolves to { insert, count, listing } (see
//                      src/shell/complete.js)
//   onLine(text)       Enter was pressed
//   onInterrupt()      Ctrl+C
//   onEnd()            Ctrl+D on an empty line
export function createLineEditor(term, hooks) {
  var prompt = "";
  var buffer = "";
  var cursor = 0;
  // Where the picture is on screen: the column the prompt began in (not
  // always the first - the last command may not have ended its output with
  // a newline), and how many rows below the prompt's the cursor now is.
  var offset = 0;
  var row = 0;

  var historyIndex = 0;
  // The line as it was before history was stepped into, to come back to.
  var stash = "";
  var killed = "";
  // bash lists the candidates on the second Tab in a row, not the first.
  var tabbed = false;
  // Ctrl+R: { query, index, original }.
  var search = null;
  // The listing held back while "Display all N possibilities?" is asked.
  var asking = null;

  function searchMatch() {
    return search.index < hooks.history.length ? hooks.history[search.index] : null;
  }

  // What is on screen right now, and where in it the cursor belongs.
  function picture() {
    if (!search) return { text: prompt + buffer, at: prompt.length + cursor };
    var match = searchMatch();
    var label = (match === null && search.query ? "(failed reverse-i-search)`" : "(reverse-i-search)`") + search.query + "': ";
    var shown = match === null ? buffer : match;
    return { text: label + shown, at: label.length + Math.max(0, match === null ? 0 : match.indexOf(search.query)) };
  }

  // Redraws from the prompt: back to where it began, erase everything after
  // that, print it again, then put the cursor where it belongs. A line
  // longer than the screen is wide wraps, so rows are counted, not assumed.
  function render() {
    var cols = term.cols;
    var view = picture();
    var out = (row ? "\x1b[" + row + "A" : "") + "\x1b[" + (offset + 1) + "G\x1b[J" + view.text;
    var end = offset + view.text.length;
    // Text that exactly fills a row leaves the cursor waiting on its last
    // column. A space pushes it on to the next row for real.
    if (end && end % cols === 0) out += " \r";
    var at = offset + view.at;
    var up = Math.floor(end / cols) - Math.floor(at / cols);
    if (up) out += "\x1b[" + up + "A";
    out += "\x1b[" + ((at % cols) + 1) + "G";
    row = Math.floor(at / cols);
    term.write(out);
  }

  // Moves from the end of the line to the start of the row below it. If the
  // text filled its last row, render has already gone there.
  function below() {
    cursor = buffer.length;
    render();
    var end = offset + picture().text.length;
    term.write(end && end % term.cols === 0 ? "\x1b[K" : "\r\n");
  }

  // Leaves the line as it stands and moves below it, for output to follow.
  function leave() {
    search = null;
    below();
  }

  function set(text, at) {
    buffer = text;
    cursor = at === undefined ? text.length : at;
    render();
  }

  function insert(text) {
    set(buffer.slice(0, cursor) + text + buffer.slice(cursor), cursor + text.length);
  }

  function remove(from, to) {
    var cut = buffer.slice(from, to);
    set(buffer.slice(0, from) + buffer.slice(to), from);
    return cut;
  }

  function isWord(index) {
    return /[A-Za-z0-9]/.test(buffer.charAt(index));
  }

  function wordStart() {
    var i = cursor;
    while (i > 0 && !isWord(i - 1)) i--;
    while (i > 0 && isWord(i - 1)) i--;
    return i;
  }

  function wordEnd() {
    var i = cursor;
    while (i < buffer.length && !isWord(i)) i++;
    while (i < buffer.length && isWord(i)) i++;
    return i;
  }

  function recall(index) {
    if (index < 0 || index > hooks.history.length) return;
    if (historyIndex === hooks.history.length) stash = buffer;
    historyIndex = index;
    set(index === hooks.history.length ? stash : hooks.history[index]);
  }

  // Prints text below the line, then draws the prompt and line again under
  // it with the cursor where it was.
  function printBelow(text) {
    var at = cursor;
    below();
    term.write(text + "\r\n");
    offset = 0;
    row = 0;
    cursor = at;
    render();
  }

  function complete() {
    var line = buffer;
    var at = cursor;
    return hooks.complete(line, at, term.cols).then(function (result) {
      if (!result || buffer !== line || cursor !== at) return;
      if (result.insert) {
        insert(result.insert);
      } else if (result.count > 1 && !tabbed) {
        tabbed = true;
      } else if (result.count > 100) {
        asking = result.listing;
        below();
        term.write("Display all " + result.count + " possibilities? (y or n)");
        cursor = at;
      } else if (result.count > 1) {
        printBelow(result.listing);
      }
    });
  }

  // The answer to "Display all N possibilities?".
  function answer(key) {
    var listing = asking;
    asking = null;
    term.write("\r\n" + (/^[yY ]$/.test(key) ? listing + "\r\n" : ""));
    offset = 0;
    row = 0;
    render();
  }

  // Ctrl+R: each key narrows or moves an incremental search back through
  // history. Returns true if the key was the search's own.
  function searchKey(key) {
    var from = search.index;
    if (key === "\x12") from = search.index - 1;
    else if (key === "\x7f" || key === "\b") {
      search.query = search.query.slice(0, -1);
      from = hooks.history.length - 1;
    } else if (key.length === 1 && key >= " ") search.query += key;
    else if (key === "\x07") {
      search = null;
      render();
      return true;
    } else {
      // Anything else takes the line that was found and acts on it.
      var match = searchMatch();
      if (match !== null) {
        buffer = match;
        cursor = Math.max(0, match.indexOf(search.query));
      }
      search = null;
      render();
      return key === "\x1b";
    }
    var index = hooks.history.length;
    for (var i = Math.min(from, hooks.history.length - 1); i >= 0 && search.query; i--) {
      if (hooks.history[i].indexOf(search.query) !== -1) {
        index = i;
        break;
      }
    }
    // Ctrl+R with nothing older to find stays on what it has.
    if (key !== "\x12" || index < hooks.history.length) search.index = index;
    render();
    return true;
  }

  var actions = {
    accept: function () {
      leave();
      hooks.onLine(buffer);
    },
    backspace: function () {
      if (cursor > 0) remove(cursor - 1, cursor);
    },
    delete: function () {
      if (cursor < buffer.length) remove(cursor, cursor + 1);
    },
    left: function () {
      if (cursor > 0) set(buffer, cursor - 1);
    },
    right: function () {
      if (cursor < buffer.length) set(buffer, cursor + 1);
    },
    home: function () {
      set(buffer, 0);
    },
    end: function () {
      set(buffer);
    },
    previous: function () {
      recall(historyIndex - 1);
    },
    next: function () {
      recall(historyIndex + 1);
    },
    wordLeft: function () {
      set(buffer, wordStart());
    },
    wordRight: function () {
      set(buffer, wordEnd());
    },
    killToEnd: function () {
      if (cursor < buffer.length) killed = remove(cursor, buffer.length);
    },
    killToStart: function () {
      if (cursor > 0) killed = remove(0, cursor);
    },
    // Ctrl+W takes everything back to the last space; Alt+Backspace stops
    // at punctuation as well.
    killWord: function () {
      var i = cursor;
      while (i > 0 && buffer.charAt(i - 1) === " ") i--;
      while (i > 0 && buffer.charAt(i - 1) !== " ") i--;
      if (i < cursor) killed = remove(i, cursor);
    },
    killWordBack: function () {
      var i = wordStart();
      if (i < cursor) killed = remove(i, cursor);
    },
    killWordForward: function () {
      var i = wordEnd();
      if (i > cursor) killed = remove(cursor, i);
    },
    yank: function () {
      if (killed) insert(killed);
    },
    clearScreen: function () {
      term.write("\x1b[H\x1b[2J");
      offset = 0;
      row = 0;
      render();
    },
    interrupt: function () {
      search = null;
      cursor = buffer.length;
      render();
      term.write("^C\r\n");
      hooks.onInterrupt();
    },
    endOfFile: function () {
      if (buffer.length) actions.delete();
      else hooks.onEnd();
    },
    complete: complete,
    search: function () {
      search = { query: "", index: hooks.history.length };
      render();
    },
  };

  return {
    // Starts a new line after `text`. Resolves once the prompt is on
    // screen, which is when keys can be taken.
    begin: function (text) {
      prompt = text;
      buffer = "";
      cursor = 0;
      row = 0;
      historyIndex = hooks.history.length;
      stash = "";
      tabbed = false;
      search = null;
      asking = null;
      return new Promise(function (resolve) {
        term.write(prompt, function () {
          var cols = term.cols;
          offset = (((term.buffer.active.cursorX - prompt.length) % cols) + cols) % cols;
          resolve();
        });
      });
    },

    // Takes one key. Returns a promise if the key needs time (completion);
    // no more keys should be given until it settles.
    handle: function (key) {
      if (asking !== null) return answer(key);
      if (search && searchKey(key)) return;
      var name = KEYS[key];
      if (name !== "complete") tabbed = false;
      if (name) return actions[name]();
      // Printable characters; unknown escape sequences and control codes
      // do nothing.
      if (key.charAt(0) !== "\x1b" && key >= " ") insert(key);
    },

    // Empties the line in place.
    clear: function () {
      search = null;
      set("");
    },

    // The screen changed width: xterm has re-wrapped the line, so the row
    // the cursor is on has to be worked out again.
    reflow: function () {
      row = Math.floor((offset + picture().at) / term.cols);
    },
  };
}

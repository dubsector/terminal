import { defineCommand } from "just-bash";

// `ls`, written to match GNU ls on the points a visitor will notice: names
// in columns when writing to a terminal, the long format's alignment, sizes,
// link counts and dates, and its error messages. It also does two things of
// its own for this site: link trees are listed as the URLs they stand for,
// and directories and URLs are clickable. Options it doesn't know are handed
// to just-bash's `ls`.

// A command can't ask whether its output is a terminal here, so the session
// tells it: every command whose output is piped, captured or sent to a file
// is run with this descriptor open (see the plugin in session.js). The
// number only has to be one nobody would type.
export var NOT_A_TTY_FD = 199;

// Directory names that hold a tree of links, stored at the path their URL
// spells (see tree.js).
var LINK_ROOTS = { "http:": true, "https:": true };

var OPTIONS = /^[aAl1hFprtSdgonC]*$/;
// Long spellings of those. --color is accepted and changes nothing: this
// terminal has one colour.
var LONG_OPTIONS = {
  all: "a", "almost-all": "A", "human-readable": "h", classify: "F", reverse: "r", directory: "d",
  "numeric-uid-gid": "n", "no-group": "o", color: "",
};
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var SIX_MONTHS_MS = 15778476000;

// An OSC 8 hyperlink, underlined so it reads as clickable before it is
// hovered (there is no hover on a touchscreen). xterm keeps the target with
// the cells themselves, so the link survives scrolling and wrapping;
// terminal.js decides what a click does.
function hyperlink(uri, text) {
  return "\x1b]8;;" + uri + "\x1b\\\x1b[4m" + text + "\x1b[24m\x1b]8;;\x1b\\";
}

function parse(args) {
  var parsed = { operands: [], letters: "", known: true };
  var rest = false;
  args.forEach(function (arg) {
    if (rest || arg === "-" || arg.charAt(0) !== "-") parsed.operands.push(arg);
    else if (arg === "--") rest = true;
    else if (arg.charAt(1) === "-") {
      var name = arg.slice(2).split("=")[0];
      if (LONG_OPTIONS.hasOwnProperty(name)) parsed.letters += LONG_OPTIONS[name];
      else parsed.known = false;
    } else parsed.letters += arg.slice(1);
  });
  if (!OPTIONS.test(parsed.letters)) parsed.known = false;
  return parsed;
}

async function lstat(fs, path) {
  try {
    return await fs.lstat(path);
  } catch (e) {
    return null;
  }
}

// One thing to list: `name` is what gets printed for it.
async function entry(fs, name, path, extra) {
  var stat = await lstat(fs, path);
  if (!stat) return null;
  var found = { name: name, path: path, stat: stat, directory: stat.isDirectory, symlink: stat.isSymbolicLink };
  if (found.symlink) {
    try {
      found.target = await fs.readlink(path);
    } catch (e) {
      found.target = "";
    }
  }
  return Object.assign(found, extra);
}

// Every file under a link root, as the URL its path spells.
async function linkEntries(fs, root, scheme) {
  var links = [];
  async function walk(path, rel) {
    var names = await fs.readdir(path);
    for (var i = 0; i < names.length; i++) {
      var child = path + "/" + names[i];
      var stat = await lstat(fs, child);
      if (stat && stat.isDirectory) await walk(child, rel + "/" + names[i]);
      else if (stat) links.push(await entry(fs, scheme + "/" + rel + "/" + names[i], child, { url: true }));
    }
  }
  await walk(root, "");
  return links;
}

async function readDirectory(fs, dir, letters) {
  var all = /a/.test(letters);
  var almostAll = all || /A/.test(letters);
  var entries = [];
  if (all) {
    entries.push(await entry(fs, ".", dir, { dots: true }));
    entries.push(await entry(fs, "..", fs.resolvePath(dir, ".."), { dots: true }));
  }
  var names = await fs.readdir(dir);
  for (var i = 0; i < names.length; i++) {
    if (names[i].charAt(0) === "." && !almostAll) continue;
    var found = await entry(fs, names[i], fs.resolvePath(dir, names[i]));
    if (!found) continue;
    if (found.directory && LINK_ROOTS[names[i]]) {
      entries = entries.concat(await linkEntries(fs, found.path, names[i]));
    } else {
      entries.push(found);
    }
  }
  return entries;
}

function size(item) {
  if (item.directory) return 4096;
  if (item.symlink) return item.target.length;
  return item.stat.size;
}

// Byte order, which is how ls sorts in the C locale this machine uses.
function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function sort(entries, letters) {
  var sorted = entries.slice().sort(function (a, b) {
    if (/t/.test(letters)) return b.stat.mtime - a.stat.mtime || byName(a, b);
    if (/S/.test(letters)) return size(b) - size(a) || byName(a, b);
    return byName(a, b);
  });
  return /r/.test(letters) ? sorted.reverse() : sorted;
}

// -F and -p mark what kind of thing a name is.
function indicator(item, letters) {
  if (/[Fp]/.test(letters) && item.directory) return "/";
  if (!/F/.test(letters)) return "";
  if (item.symlink) return "@";
  return item.stat.isFile && item.stat.mode & 73 ? "*" : "";
}

// What is shown for a name, plain and as written to a terminal.
function label(item, letters, tty) {
  var text = item.name + indicator(item, letters);
  var shown = text;
  if (tty && item.url) shown = hyperlink(item.name, text);
  else if (tty && item.directory && !item.dots) shown = hyperlink("cd:" + encodeURI(item.path), text);
  return { text: text, shown: shown };
}

// The way GNU ls fills a terminal: down each column first, in as many
// columns as fit, two spaces apart. When nothing fits side by side that
// comes out as one name per line.
function columns(items, width) {
  var count = items.length;
  for (var cols = Math.min(count, Math.max(1, Math.floor(width / 3))); cols >= 1; cols--) {
    var rows = Math.ceil(count / cols);
    var widths = [];
    var total = 0;
    for (var start = 0; start < count; start += rows) {
      var widest = 0;
      for (var i = start; i < Math.min(start + rows, count); i++) {
        widest = Math.max(widest, items[i].text.length);
      }
      widths.push(widest);
      total += widest + (start + rows < count ? 2 : 0);
    }
    if (total >= width && cols > 1) continue;

    var lines = [];
    for (var row = 0; row < rows; row++) {
      var line = "";
      for (var col = 0; col * rows + row < count; col++) {
        var item = items[col * rows + row];
        var last = (col + 1) * rows + row >= count;
        line += item.shown;
        if (!last) line += " ".repeat(widths[col] - item.text.length + 2);
      }
      lines.push(line);
    }
    return lines;
  }
  return [];
}

function shortListing(entries, opts, ctx, tty) {
  if (!entries.length) return "";
  var items = entries.map(function (item) {
    return label(item, opts.letters, tty);
  });
  var rows = null;
  if (tty && !/1/.test(opts.letters)) {
    rows = columns(items, parseInt(ctx.env.get("COLUMNS"), 10) || 80);
    // The one departure from GNU's layout: URLs that don't all fit on one
    // row go one to a line. They are there to be read and tapped, and a
    // grid of them is neither easy to scan nor to hit on a phone.
    var hasLinks = entries.some(function (item) {
      return item.url;
    });
    if (hasLinks && rows.length > 1) rows = null;
  }
  if (!rows) {
    rows = items.map(function (item) {
      return item.shown;
    });
  }
  return rows.join("\n") + "\n";
}

function permissions(item) {
  var bits = "rwxrwxrwx";
  var out = item.directory ? "d" : item.symlink ? "l" : "-";
  var mode = item.symlink ? 511 : item.stat.mode;
  for (var i = 0; i < 9; i++) out += mode & (256 >> i) ? bits.charAt(i) : "-";
  // The sticky bit (/tmp) shows in place of the last x.
  if (mode & 512) out = out.slice(0, 9) + (mode & 1 ? "t" : "T");
  return out;
}

// Sizes the way -h prints them: powers of 1024, rounded up, one decimal
// below ten.
function human(bytes) {
  var units = ["", "K", "M", "G", "T"];
  var value = bytes;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (!unit) return String(bytes);
  if (value < 10) return (Math.ceil(value * 10) / 10).toFixed(1) + units[unit];
  return Math.ceil(value) + units[unit];
}

// A file touched in the last six months shows its time of day, anything
// older (or dated in the future) its year.
function date(mtime, now) {
  var day = mtime.getUTCDate();
  var age = now - mtime;
  var tail =
    age >= 0 && age < SIX_MONTHS_MS
      ? String(mtime.getUTCHours()).padStart(2, "0") + ":" + String(mtime.getUTCMinutes()).padStart(2, "0")
      : " " + mtime.getUTCFullYear();
  return MONTHS[mtime.getUTCMonth()] + " " + String(day).padStart(2, " ") + " " + tail;
}

// A directory's link count is itself, its "." and the ".." of each
// directory inside it.
async function linkCount(fs, item) {
  if (!item.directory) return 1;
  var count = 2;
  try {
    var names = await fs.readdir(item.path);
    for (var i = 0; i < names.length; i++) {
      var stat = await lstat(fs, item.path + "/" + names[i]);
      if (stat && stat.isDirectory) count++;
    }
  } catch (e) {}
  return count;
}

async function longListing(entries, opts, ctx, tty, withTotal) {
  var letters = opts.letters;
  var owner = /n/.test(letters) ? "0" : "root";
  var now = Date.now();
  var rows = [];
  var blocks = 0;
  for (var i = 0; i < entries.length; i++) {
    var item = entries[i];
    var bytes = size(item);
    // What the file takes on disk, in 1K units of 4K blocks.
    if (!item.symlink) blocks += Math.ceil(bytes / 4096) * 4;
    var name = label(item, letters, tty).shown;
    if (item.symlink) name = item.name + " -> " + item.target;
    rows.push({
      permissions: permissions(item),
      links: String(await linkCount(ctx.fs, item)),
      size: /h/.test(letters) ? human(bytes) : String(bytes),
      date: date(item.stat.mtime, now),
      name: name,
    });
  }
  function widest(key) {
    return rows.reduce(function (max, row) {
      return Math.max(max, row[key].length);
    }, 0);
  }
  var linkWidth = widest("links");
  var sizeWidth = widest("size");
  var out = withTotal ? "total " + (/h/.test(letters) ? human(blocks * 1024) : blocks) + "\n" : "";
  rows.forEach(function (row) {
    var fields = [row.permissions, row.links.padStart(linkWidth)];
    if (!/g/.test(letters)) fields.push(owner);
    if (!/o/.test(letters)) fields.push(owner);
    fields.push(row.size.padStart(sizeWidth), row.date, row.name);
    out += fields.join(" ") + "\n";
  });
  return out;
}

// just-bash prints every file as owned by "user"; on this machine there is
// only root.
function ownedByRoot(text) {
  return text.replace(/^(\S{10}\s+\d+\s+)user(\s+)user(\s)/gm, "$1root$2root$3");
}

async function ls(args, ctx) {
  var opts = parse(args);
  if (!opts.known) {
    var raw = await ctx.origCommand(args);
    return Object.assign({}, raw, { stdout: ownedByRoot(raw.stdout) });
  }

  var fs = ctx.fs;
  var tty = !(ctx.fileDescriptors && ctx.fileDescriptors.has(NOT_A_TTY_FD));
  var long = /[lgon]/.test(opts.letters);
  var listing = long ? longListing : shortListing;
  var operands = opts.operands.length ? opts.operands : ["."];

  var stderr = "";
  var files = [];
  var dirs = [];
  for (var i = 0; i < operands.length; i++) {
    var found = await entry(fs, operands[i], fs.resolvePath(ctx.cwd, operands[i]));
    if (!found) stderr += "ls: cannot access '" + operands[i] + "': No such file or directory\n";
    else if (found.directory && !/d/.test(opts.letters)) dirs.push(found);
    else files.push(found);
  }

  var stdout = await listing(sort(files, opts.letters), opts, ctx, tty, false);
  var headers = operands.length > 1;
  dirs = sort(dirs, opts.letters);
  for (var d = 0; d < dirs.length; d++) {
    if (stdout) stdout += "\n";
    if (headers) stdout += dirs[d].name + ":\n";
    var entries = sort(await readDirectory(fs, dirs[d].path, opts.letters), opts.letters);
    stdout += await listing(entries, opts, ctx, tty, true);
  }
  return { stdout: stdout, stderr: stderr, exitCode: stderr ? 2 : 0 };
}

export var lsCommand = defineCommand("ls", ls);

import { defineCommand } from "just-bash";

// just-bash's own `ls` does the listing. This wraps it to add the three
// things a real `ls` only does when it is writing to a terminal, and that
// this site leans on: names laid out in columns, link trees printed as the
// URLs they stand for, and directories and URLs made clickable.

// A command can't ask whether its output is a terminal here, so the session
// tells it: every command whose output is piped, captured or sent to a file
// is run with this descriptor open (see the plugin in session.js). The
// number only has to be one nobody would type.
export var NOT_A_TTY_FD = 199;

// Directory names that hold a tree of links, stored at the path their URL
// spells (see tree.js).
var LINK_ROOTS = { "http:": true, "https:": true };

// permissions, link count | owner | gap | group | size, date | name
var LONG_LINE = /^(\S{10}\s+\d+\s+)(\S+)(\s+)(\S+)(\s+\S+\s+\S+\s+\d+\s+[\d:]+\s)(.*)$/;

// An OSC 8 hyperlink, underlined so it reads as clickable before it is
// hovered (there is no hover on a touchscreen). xterm keeps the target with
// the cells themselves, so the link survives scrolling and wrapping;
// terminal.js decides what a click does.
function hyperlink(uri, text) {
  return "\x1b]8;;" + uri + "\x1b\\\x1b[4m" + text + "\x1b[24m\x1b]8;;\x1b\\";
}

function directoryLink(path, text) {
  return hyperlink("cd:" + encodeURI(path), text);
}

function parse(args) {
  var parsed = { flags: [], operands: [], letters: "", plain: true };
  var rest = false;
  args.forEach(function (arg) {
    if (rest || arg === "-" || arg.charAt(0) !== "-") parsed.operands.push(arg);
    else if (arg === "--") rest = true;
    else {
      parsed.flags.push(arg);
      if (arg.charAt(1) === "-") parsed.plain = false;
      else parsed.letters += arg.slice(1);
    }
  });
  // Recursive and directory-itself listings, and anything spelled as a long
  // option, are left exactly as just-bash prints them.
  if (/[Rd]/.test(parsed.letters)) parsed.plain = false;
  return parsed;
}

async function isDirectory(fs, path) {
  try {
    return (await fs.stat(path)).isDirectory;
  } catch (e) {
    return false;
  }
}

// Every file under a link root, as the URL its path spells.
async function collectLinks(fs, root, scheme) {
  var links = [];
  async function walk(path, rel) {
    var names = await fs.readdir(path);
    for (var i = 0; i < names.length; i++) {
      var child = path + "/" + names[i];
      if (await isDirectory(fs, child)) await walk(child, rel + "/" + names[i]);
      else links.push({ url: scheme + "/" + rel + "/" + names[i], path: child });
    }
  }
  await walk(root, "");
  return links.sort(function (a, b) {
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
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

async function shortBlock(lines, dir, opts, ctx, tty) {
  var fs = ctx.fs;
  var indicators = /[Fp]/.test(opts.letters);
  var items = [];
  var hasLinks = false;
  for (var i = 0; i < lines.length; i++) {
    var text = lines[i];
    if (text === "." || text === "..") {
      items.push({ text: text, shown: text });
      continue;
    }
    var name = indicators ? text.replace(/[\/*@|=]$/, "") : text;
    var path = fs.resolvePath(dir, name);
    var directory = await isDirectory(fs, path);
    if (directory && LINK_ROOTS[name]) {
      (await collectLinks(fs, path, name)).forEach(function (link) {
        hasLinks = true;
        items.push({ text: link.url, shown: tty ? hyperlink(link.url, link.url) : link.url });
      });
    } else {
      items.push({ text: text, shown: tty && directory ? directoryLink(path, text) : text });
    }
  }
  if (!items.length) return "";
  var rows = null;
  if (tty && !/1/.test(opts.letters)) {
    rows = columns(items, parseInt(ctx.env.get("COLUMNS"), 10) || 80);
    // The one departure from GNU's layout: URLs that don't all fit on one
    // row go one to a line. They are there to be read and tapped, and a
    // grid of them is neither easy to scan nor to hit on a phone.
    if (hasLinks && rows.length > 1) rows = null;
  }
  if (!rows) {
    rows = items.map(function (item) {
      return item.shown;
    });
  }
  return rows.join("\n") + "\n";
}

// just-bash prints every file as owned by "user"; on this machine there is
// only root.
function ownedByRoot(match) {
  var owner = match[2] === "user" ? "root" : match[2];
  var group = match[4] === "user" ? "root" : match[4];
  return match[1] + owner + match[3] + group + match[5];
}

function fixOwners(text) {
  return text
    .split("\n")
    .map(function (line) {
      var match = LONG_LINE.exec(line);
      return match ? ownedByRoot(match) + match[6] : line;
    })
    .join("\n");
}

async function longBlock(lines, dir, opts, ctx, tty) {
  var fs = ctx.fs;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var match = LONG_LINE.exec(lines[i]);
    if (!match) {
      out.push(lines[i]);
      continue;
    }
    var name = match[6];
    var directory = match[1].charAt(0) === "d";
    var path = fs.resolvePath(dir, name);
    if (directory && LINK_ROOTS[name]) {
      var links = await collectLinks(fs, path, name);
      for (var k = 0; k < links.length; k++) {
        var listed = await ctx.origCommand(opts.flags.concat(["--", links[k].path]));
        var entry = LONG_LINE.exec(listed.stdout.split("\n")[0]);
        if (!entry) continue;
        out.push(ownedByRoot(entry) + (tty ? hyperlink(links[k].url, links[k].url) : links[k].url));
      }
    } else if (tty && directory && name !== "." && name !== "..") {
      out.push(ownedByRoot(match) + directoryLink(path, name));
    } else {
      out.push(ownedByRoot(match) + name);
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}

async function ls(args, ctx) {
  var tty = !(ctx.fileDescriptors && ctx.fileDescriptors.has(NOT_A_TTY_FD));
  var opts = parse(args);
  var long = /[lgon]/.test(opts.letters);
  var dirs = opts.operands.length ? opts.operands.slice().sort() : ["."];

  var plain = opts.plain;
  for (var i = 0; plain && i < dirs.length; i++) {
    plain = await isDirectory(ctx.fs, ctx.fs.resolvePath(ctx.cwd, dirs[i]));
  }
  // Files, missing paths and the options above: nothing to lay out or link.
  if (!plain) {
    var raw = await ctx.origCommand(args);
    return Object.assign({}, raw, { stdout: fixOwners(raw.stdout) });
  }

  var stdout = "";
  var stderr = "";
  var exitCode = 0;
  for (var d = 0; d < dirs.length; d++) {
    var result = await ctx.origCommand(opts.flags.concat(["--", dirs[d]]));
    stderr += result.stderr;
    exitCode = Math.max(exitCode, result.exitCode);
    var lines = result.stdout.split("\n").filter(function (line) {
      return line !== "";
    });
    var dir = ctx.fs.resolvePath(ctx.cwd, dirs[d]);
    if (dirs.length > 1) stdout += (d ? "\n" : "") + dirs[d] + ":\n";
    stdout += await (long ? longBlock : shortBlock)(lines, dir, opts, ctx, tty);
  }
  return { stdout: stdout, stderr: stderr, exitCode: exitCode };
}

export var lsCommand = defineCommand("ls", ls);

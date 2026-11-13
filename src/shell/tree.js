// The site's own files on the machine's disk. The system around them is in
// machine.js.

export var HOME = "/root";
export var SITE = "/var/www/dubsector.dev";

// The site's content: each folder under SITE holds links out to somewhere
// else. Adding a URL here is all it takes for it to show up in `ls`.
var LINKS = {
  projects: [
    "https://dubsector.github.io/mcmmo-builds",
    "https://dubsector.github.io/video-shrinker",
    "https://dubsector.github.io/mc-server-stats",
    "https://grandtot.al",
    "https://github.com/getchunes",
  ],
  github: ["https://github.com/dubsector"],
  caffeine: ["https://buymeacoffee.com/dubsector"],
};

// A file name can't contain a slash, so a URL can't be one. It can be a
// path, though: "https://grandtot.al" names the file "grandtot.al" in a
// directory called "https:" (the doubled slash collapses, as it does in any
// path). So every link is stored at the path its own URL spells, which makes
// `cat https://grandtot.al` work from the folder that lists it. `ls` prints
// such a tree back as the whole URLs (see ls.js). The one thing this layout
// can't hold is two links where one is the other plus more path.
export function seedFiles() {
  var files = {};
  Object.keys(LINKS).forEach(function (folder) {
    LINKS[folder].forEach(function (url) {
      files[SITE + "/" + folder + "/" + url.replace("://", ":/")] = url + "\n";
    });
  });
  return files;
}

// Turns the frames tools/blender/render_share.py writes into the link-share
// images the page points at: src/share/terminal.gif (the spinning terminal,
// og:image) and src/share/terminal.jpg (its first frame, twitter:image and
// the fallback). Needs ffmpeg on the PATH.
//
//   node tools/share/make.mjs <frames dir> [--width 640] [--fps 15]
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--"));
if (!dir) {
  console.error("usage: node tools/share/make.mjs <frames dir> [--width 640] [--fps 15]");
  process.exit(1);
}
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : Number(args[i + 1]);
};
const width = opt("--width", 640);
const fps = opt("--fps", 15);
const out = "src/share";
mkdirSync(out, { recursive: true });

// The backdrop the frames are laid over: render_share.py's BACKDROP at the
// edges, a little lighter behind the terminal. Same for every frame, so the
// GIF only stores the part that moves.
const glow = "max(0,1-hypot((X-W/2)/(W*0.55),(Y-H*0.52)/(H*0.75)))";
const backdrop = (w, h) =>
  `color=c=black:s=${w}x${h},format=rgb24,geq=` +
  `r='11+9*${glow}':g='13+11*${glow}':b='12+10*${glow}'`;

const ffmpeg = (list) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...list], { stdio: "inherit" });

const height = Math.round((width * 630) / 1200 / 2) * 2;
ffmpeg([
  "-f", "lavfi", "-i", backdrop(1200, 630),
  "-framerate", String(fps), "-i", join(dir, "share_%04d.png"),
  "-filter_complex",
  `[0][1]overlay=shortest=1,scale=${width}:${height}:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=128:stats_mode=full[p];` +
    `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  "-loop", "0",
  join(out, "terminal.gif"),
]);

ffmpeg([
  "-f", "lavfi", "-i", backdrop(2400, 1260),
  "-i", join(dir, "share_still.png"),
  "-filter_complex", "[0][1]overlay,scale=1200:630:flags=lanczos",
  "-frames:v", "1", "-q:v", "3",
  join(out, "terminal.jpg"),
]);

for (const name of ["terminal.gif", "terminal.jpg"]) {
  console.log(`${join(out, name)}  ${(statSync(join(out, name)).size / 1024).toFixed(0)} KiB`);
}

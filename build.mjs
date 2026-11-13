import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { gzipSync } from "zlib";

const watch = process.argv.includes("--watch");

// Empty dist/ rather than removing the directory itself: `wrangler dev`
// holds a watch on it, and on Windows a watched directory can't be deleted.
if (existsSync("dist")) {
  for (const entry of readdirSync("dist")) rmSync(`dist/${entry}`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} else {
  mkdirSync("dist");
}

cpSync("src/style.css", "dist/style.css");
cpSync("src/favicon.svg", "dist/favicon.svg");

// The 3D view's model and baked maps (tools/blender/build_scene.py writes
// them); fetched by scene.js at run time, not bundled. Each goes out under a
// name with a hash of its content in it, so it can be cached for good (see
// _headers below) and a new bake is still picked up at once. scene.js gets
// the names through __ASSETS__.
mkdirSync("dist/assets");
const assets = { files: {}, sizes: [] };
function emit(name, data) {
  const dot = name.indexOf(".");
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 10);
  assets.files[name] = `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
  writeFileSync(`dist/assets/${assets.files[name]}`, data);
}
for (const name of readdirSync("src/assets").sort()) {
  const data = readFileSync(`src/assets/${name}`);
  emit(name, data);
  // Cloudflare does not compress model/gltf-binary on the way out, and the
  // file shrinks to about a third: ship a gzipped copy for the page to unpack.
  if (name === "scene.glb") emit("scene.glb.gz", gzipSync(data, { level: 9 }));
  const size = /^lm_[a-z]+_[a-z]+_(\d+)\.webp$/.exec(name);
  if (size && !assets.sizes.includes(+size[1])) assets.sizes.push(+size[1]);
}
assets.sizes.sort((a, b) => a - b);
if (!assets.sizes.length) throw new Error("src/assets has no light maps (lm_<atlas>_<pass>_<size>.webp)");
writeFileSync("dist/_headers", "/assets/*\n  Cache-Control: public, max-age=31556952, immutable\n");

// What the 3D view needs for its first frame, for index.html to start
// fetching before terminal.js and scene.js have even arrived.
const first = Object.keys(assets.files).filter(
  (name) => name === "scene.glb.gz" || name.startsWith("reflect") || name.endsWith(`_${assets.sizes[0]}.webp`)
);
const preload = [{ href: "./scene.js", as: "script" }].concat(
  first.map((name) => ({ href: `./assets/${assets.files[name]}`, as: "fetch" }))
);
const html = readFileSync("src/index.html", "utf8");
if (!html.includes("/*PRELOAD*/[]")) throw new Error("src/index.html has lost its /*PRELOAD*/[] marker");
writeFileSync("dist/index.html", html.replace("/*PRELOAD*/[]", JSON.stringify(preload)));

const options = {
  entryPoints: ["src/terminal.js", "src/scene.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  minify: !watch,
  sourcemap: watch,
  format: "iife",
  loader: { ".css": "css" },
  define: { __ASSETS__: JSON.stringify(assets) },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(options);
  console.log("Build complete.");
}

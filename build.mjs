import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { readTar } from "./tools/alpine/tar.mjs";

const watch = process.argv.includes("--watch");

// Empty dist/ rather than removing the directory itself: `wrangler dev`
// holds a watch on it, and on Windows a watched directory can't be deleted.
// dist/linux is left for linuxImage() below, which only rewrites its fifteen
// hundred files when the image has changed.
if (existsSync("dist")) {
  for (const entry of readdirSync("dist")) {
    if (entry !== "linux") rmSync(`dist/${entry}`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  mkdirSync("dist");
}

cpSync("src/style.css", "dist/style.css");
cpSync("src/favicon.svg", "dist/favicon.svg");
// Link-share preview images (tools/share/make.mjs), named in index.html's og: tags.
cpSync("src/share", "dist/share", { recursive: true });
cpSync("src/icon-512.png", "dist/icon-512.png");
cpSync("src/robots.txt", "dist/robots.txt");
cpSync("src/sitemap.xml", "dist/sitemap.xml");

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

// The Linux machine that `reboot` starts in the page (see tools/alpine and
// src/linux.js). Its image is far too big to keep in git, so the build takes
// it from the release named in tools/alpine/image.json, checks it is the
// file that was pinned there, and unpacks it into dist/linux/<id>/ where
// <id> is taken from its hash, so that it too can be cached for good.
// ALPINE_IMAGE=<path to an image.tar> uses a local build instead. With
// neither there is no Linux machine, and `reboot` only starts this one again.
async function linuxImage() {
  const pin = JSON.parse(readFileSync("tools/alpine/image.json", "utf8"));
  const sha256 = (data) => createHash("sha256").update(data).digest("hex");
  let archive;
  if (process.env.ALPINE_IMAGE) {
    archive = readFileSync(process.env.ALPINE_IMAGE);
  } else if (pin.url) {
    const cached = `node_modules/.cache/alpine/${pin.sha256}.tar`;
    if (!existsSync(cached)) {
      const response = await fetch(pin.url);
      if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (sha256(data) !== pin.sha256) throw new Error(`${pin.url} is not the image pinned in tools/alpine/image.json`);
      mkdirSync("node_modules/.cache/alpine", { recursive: true });
      writeFileSync(cached, data);
    }
    archive = readFileSync(cached);
  } else {
    rmSync("dist/linux", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return null;
  }

  // The emulator's own code, from the v86 package.
  const wasmData = readFileSync("node_modules/v86/build/v86.wasm");
  const id = sha256(archive).slice(0, 10);
  const base = `./linux/${id}/`;
  const wasm = `./linux/v86.${sha256(wasmData).slice(0, 10)}.wasm`;

  // image.json is written last, so finding it means the rest is in place.
  const about = `dist/${base}image.json`;
  if (!existsSync(about) || !existsSync(`dist/${wasm}`)) {
    rmSync("dist/linux", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(`dist/${base}flat`, { recursive: true });
    let facts;
    readTar(archive, (name, data) => {
      if (name === "image.json") facts = data;
      else writeFileSync(`dist/${base}${name}`, data);
    });
    writeFileSync(`dist/${wasm}`, wasmData);
    writeFileSync(about, facts);
  }

  // What a boot always fetches first, for the page to have ready: the
  // kernel and its initramfs are two thirds of what a boot downloads.
  const boot = JSON.parse(readFileSync(`dist/${base}fs.json`, "utf8")).fsroot.find((entry) => entry[0] === "boot")[6];
  const stored = (name) => `${base}flat/${boot.find((entry) => entry[0] === name)[6]}`;
  const preload = [wasm, `${base}seabios.bin`, `${base}vgabios.bin`, `${base}fs.json`, stored("vmlinuz-virt"), stored("initramfs-virt")];
  return { ...JSON.parse(readFileSync(about, "utf8")), base, wasm, preload };
}
const linux = await linuxImage();

writeFileSync(
  "dist/_headers",
  ["/assets/*", "/linux/*"].map((path) => `${path}\n  Cache-Control: public, max-age=31556952, immutable\n`).join("")
);

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
// The site's links (the file the shell lays out as directories), in words
// for search engines and screen readers, and as sameAs in the JSON-LD.
const links = JSON.parse(readFileSync("src/shell/links.json", "utf8"));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const linkHtml = Object.entries(links)
  .map(([group, urls]) => {
    const items = urls.map((u) => `<li><a href="${esc(u)}">${esc(u.replace(/^https?:\/\//, ""))}</a></li>`);
    return `<h2>${esc(group)}</h2><ul>${items.join("")}</ul>`;
  })
  .join("");
// The owner's own profiles, not the projects.
const sameAs = Object.entries(links)
  .filter(([group]) => group !== "projects")
  .flatMap(([, urls]) => urls);
for (const marker of ["<!--LINKS-->", "/*SAMEAS*/[]"]) {
  if (!html.includes(marker)) throw new Error(`src/index.html has lost its ${marker} marker`);
}
writeFileSync(
  "dist/index.html",
  html
    .replace("/*PRELOAD*/[]", JSON.stringify(preload))
    .replace("<!--LINKS-->", linkHtml)
    .replace("/*SAMEAS*/[]", JSON.stringify(sameAs))
);

const options = {
  entryPoints: ["src/terminal.js", "src/scene.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  minify: !watch,
  sourcemap: watch,
  format: "iife",
  loader: { ".css": "css" },
  define: { __ASSETS__: JSON.stringify(assets), __LINUX__: JSON.stringify(linux) },
};

// The shell is built on its own because just-bash's browser build still
// leans on two pieces of Node for its gzip and tar commands: the zlib
// module and the Buffer global. Injecting Buffer into the other bundles
// would add it to each for nothing (their libraries only test for it).
const shellOptions = {
  ...options,
  entryPoints: ["src/shell.js"],
  alias: { "node:zlib": "./src/shell/zlib.js" },
  inject: ["./src/shell/buffer.js"],
};

// The emulator is also built on its own: v86 runs under Node too, and the
// Node modules it reaches for there (never in a browser) have to be left as
// they are rather than looked for.
const linuxOptions = {
  ...options,
  entryPoints: ["src/linux.js"],
  external: ["crypto", "fs", "perf_hooks", "node:*"],
};

const bundles = [options, shellOptions].concat(linux ? [linuxOptions] : []);
if (watch) {
  for (const each of bundles) await (await context(each)).watch();
  console.log("Watching for changes...");
} else {
  await Promise.all(bundles.map((each) => build(each)));
  console.log("Build complete.");
}

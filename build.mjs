import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";

const watch = process.argv.includes("--watch");

// Empty dist/ rather than removing the directory itself: `wrangler dev`
// holds a watch on it, and on Windows a watched directory can't be deleted.
if (existsSync("dist")) {
  for (const entry of readdirSync("dist")) rmSync(`dist/${entry}`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
} else {
  mkdirSync("dist");
}

cpSync("src/index.html", "dist/index.html");
cpSync("src/style.css", "dist/style.css");
cpSync("src/favicon.svg", "dist/favicon.svg");

const options = {
  entryPoints: ["src/terminal.js", "src/scene.js"],
  bundle: true,
  outdir: "dist",
  entryNames: "[name]",
  minify: !watch,
  sourcemap: watch,
  format: "iife",
  loader: { ".css": "css" },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await build(options);
  console.log("Build complete.");
}

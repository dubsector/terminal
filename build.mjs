import { build, context } from "esbuild";
import { cpSync, mkdirSync, existsSync, rmSync } from "fs";

const watch = process.argv.includes("--watch");

if (existsSync("dist")) rmSync("dist", { recursive: true });
mkdirSync("dist");

cpSync("src/index.html", "dist/index.html");
cpSync("src/style.css", "dist/style.css");
cpSync("src/favicon.svg", "dist/favicon.svg");

const options = {
  entryPoints: ["src/terminal.js"],
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

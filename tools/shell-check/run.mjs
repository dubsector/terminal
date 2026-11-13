// Runs every case in cases.mjs twice - in real bash and in the site's shell
// (src/shell) - and reports where what they print or their exit status
// differ.
//
//     npm run check:shell [-- --only <text>] [-- --show]
//
// --only keeps the cases whose name contains the text; --show prints both
// outputs for every case that differs, known or not.
//
// Real bash is `bash` on Linux and macOS and WSL's on Windows (set
// SHELL_CHECK_WSL to pick a distribution other than the default). Without
// either, the check is skipped, except in CI, where that is a failure.

import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { build } from "esbuild";
import { cases as allCases, files } from "./cases.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const show = args.includes("--show");
const cases = allCases.filter((c) => c.name.includes(only));

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";

// One script for real bash: each case in a fresh directory with the same
// files, its output between markers that carry its exit status.
function driver() {
  let script = 'work=$(mktemp -d) || exit 1\nseed() {\n';
  for (const [path, content] of Object.entries(files)) {
    if (path.includes("/")) script += `  mkdir -p ${quote(dirname(path))}\n`;
    script += `  printf %s ${base64(content)} | base64 -d > ${quote(path)}\n`;
  }
  script += "}\n";
  cases.forEach((c, i) => {
    script +=
      `rm -rf "$work/case"; mkdir "$work/case"; cd "$work/case" || exit 1; seed\n` +
      `printf %s ${base64(c.script)} | base64 -d > "$work/script"\n` +
      `printf '\\n@@BEGIN ${i}@@\\n'\n` +
      `env -i PATH="$PATH" HOME="$work/case" LC_ALL=C TZ=UTC bash --noprofile --norc "$work/script" 2>/dev/null </dev/null\n` +
      `printf '\\n@@END ${i} %s@@\\n' $?\n`;
  });
  return script + 'cd /; rm -rf "$work"\n';
}

function runBash() {
  const flags = ["--noprofile", "--norc", "-s"];
  const distro = process.env.SHELL_CHECK_WSL;
  const [command, argv] =
    process.platform === "win32"
      ? ["wsl", (distro ? ["-d", distro] : []).concat(["--", "bash"], flags)]
      : ["bash", flags];
  const result = spawnSync(command, argv, { input: driver(), encoding: "utf8", maxBuffer: 1 << 26, timeout: 300000 });
  if (result.error || result.status !== 0) return null;
  const found = new Map();
  for (const m of result.stdout.matchAll(/\n@@BEGIN (\d+)@@\n([\s\S]*?)\n@@END \1 (\d+)@@\n/g)) {
    found.set(+m[1], { stdout: m[2], status: +m[3] });
  }
  return found.size === cases.length ? found : null;
}

// The shell as the page builds it, bundled for Node. just-bash is left as an
// import, so the bundle has to sit where node_modules can be found from.
async function loadShell() {
  const outfile = join(root, "node_modules", ".cache", "shell-check", "session.mjs");
  await build({
    entryPoints: [join(root, "src", "shell", "session.js")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["just-bash"],
    logLevel: "silent",
  });
  return (await import(pathToFileURL(outfile).href)).createSession;
}

async function runOurs(createSession, c) {
  const shell = createSession({
    user: "root",
    hostname: "websvr",
    os: { name: "Dubuntu", version: "26.04.1 LTS" },
    kernel: "6.14.0-15-generic",
    stats: { load: 0.1, memoryPercent: 20, diskPercent: 40, diskGb: 24.55, processes: 100, address: "10.13.37.4", bootedAt: Date.now() - 864e5 },
    cmatrix: () => Promise.resolve(),
  });
  const options = { cols: 80, rows: 24, terminal: false };
  for (const [path, content] of Object.entries(files)) await shell.write("/tmp/case/" + path, content);
  await shell.run("cd /tmp/case", options);
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ stdout: "(timed out)", status: -1 }), 10000));
  const result = await Promise.race([shell.run(c.script, options), timeout]);
  return { stdout: result.stdout, status: result.status };
}

const real = runBash();
if (!real) {
  console.log("No working bash to compare with" + (process.platform === "win32" ? " (WSL is needed on Windows)." : "."));
  process.exit(process.env.CI ? 1 : 0);
}
const createSession = await loadShell();

const differ = [];
const known = [];
const fixed = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const ours = await runOurs(createSession, c);
  const want = real.get(i);
  const same = ours.stdout === want.stdout && ours.status === want.status;
  if (same && c.gap) fixed.push(c);
  if (!same) (c.gap ? known : differ).push({ c, want, ours });
}

function report(entry) {
  console.log(`\n  ${entry.c.name}${entry.c.gap ? "  (" + entry.c.gap + ")" : ""}`);
  console.log(`    script: ${JSON.stringify(entry.c.script)}`);
  console.log(`    bash:   ${JSON.stringify(entry.want.stdout)} exit ${entry.want.status}`);
  console.log(`    ours:   ${JSON.stringify(entry.ours.stdout)} exit ${entry.ours.status}`);
}

console.log(`${cases.length} cases: ${cases.length - differ.length - known.length} match, ${known.length} known gaps, ${differ.length} differ.`);
if (differ.length) {
  console.log("\nDiffer from bash:");
  differ.forEach(report);
}
if (show && known.length) {
  console.log("\nKnown gaps:");
  known.forEach(report);
}
if (fixed.length) {
  console.log("\nMarked as gaps in cases.mjs but now match bash; remove the mark:");
  fixed.forEach((c) => console.log(`  ${c.name}`));
}
process.exit(differ.length || fixed.length ? 1 : 0);

// Turns the root filesystem rootfs.sh builds into the image the site serves.
// (The site's links are not in it: src/linux.js adds them at boot.)
//
//     node tools/alpine/pack.mjs image <rootfs.tar> <image.tar>
//
// v86 doesn't read a disk image. It serves the guest its files one at a time
// over 9p, fetching each from the web server the first time it is opened, so
// the image is a directory of files named by their hash plus an index of
// what is where. v86's own two scripts make those; they are Python, and run
// through uv. The result is packed into one tar, together with the BIOS the
// emulated PC starts from, to be published as a release and unpacked into
// dist/ by build.mjs.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readTar, writeTar } from "./tar.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// v86's tools and BIOS images, at one commit of github.com/copy/v86.
const V86_COMMIT = "315b2b0b758703ef0e6cc7b4088d6068f83f3c20";
const V86_FILES = {
  "tools/fs2json.py": "546b0ce7d0b172fa855587209318a8d473bce6de23fa327ceeb5b6c115fda23f",
  "tools/copy-to-sha256.py": "7bfb94736afbb9753b6deea922184eec2f9b205be0214bc5f9866cf990bfa77c",
  "bios/seabios.bin": "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
  "bios/vgabios.bin": "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
};

// How the machine is started. It travels with the image because it has to
// match it: the kernel is told its root is the 9p share and its console the
// serial port, and 128 MB is the least this kernel and userland boot in.
// reboot=k has the kernel restart through the keyboard controller first.
// That is a reset the page can see coming and stop (see src/linux.js); the
// way the kernel tries first by default crashes the emulator outright.
const BOOT = {
  memory: 128,
  cmdline: "rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose tsc=reliable console=ttyS0 reboot=k",
};

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function v86File(path, cache) {
  const file = join(cache, path.replace("/", "-"));
  if (!existsSync(file) || sha256(readFileSync(file)) !== V86_FILES[path]) {
    const response = await fetch(`https://raw.githubusercontent.com/copy/v86/${V86_COMMIT}/${path}`);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (sha256(data) !== V86_FILES[path]) throw new Error(`${path}: not the file that was pinned`);
    writeFileSync(file, data);
  }
  return file;
}

function python(script, args) {
  const result = spawnSync("uv", ["run", "--no-project", "--with", "zstandard", "python", script, ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.error) throw new Error(`could not run uv: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${script} failed`);
}

async function image(rootfs, out) {
  const cache = join(root, "node_modules", ".cache", "alpine-pack");
  const flat = join(cache, "flat");
  rmSync(flat, { recursive: true, force: true });
  mkdirSync(flat, { recursive: true });

  const index = join(cache, "fs.json");
  python(await v86File("tools/fs2json.py", cache), ["--zstd", "--out", index, rootfs]);
  python(await v86File("tools/copy-to-sha256.py", cache), ["--zstd", rootfs, flat]);

  const facts = {};
  readTar(
    readFileSync(rootfs),
    (name, data) => (facts[name] = data.toString("utf8").trim()),
    (name) => name === "boot/kernel.release" || name === "etc/alpine-release"
  );
  const about = { alpine: facts["etc/alpine-release"], kernel: facts["boot/kernel.release"], ...BOOT };
  if (!about.alpine || !about.kernel) throw new Error("the root filesystem has no kernel or release file");

  const entries = [
    { name: "image.json", data: Buffer.from(JSON.stringify(about, null, 2) + "\n") },
    { name: "fs.json", data: readFileSync(index) },
    { name: "seabios.bin", data: readFileSync(await v86File("bios/seabios.bin", cache)) },
    { name: "vgabios.bin", data: readFileSync(await v86File("bios/vgabios.bin", cache)) },
  ];
  for (const name of readdirSync(flat).sort()) entries.push({ name: "flat/" + name, data: readFileSync(join(flat, name)) });

  const archive = writeTar(entries);
  writeFileSync(out, archive);
  console.log(`Alpine ${about.alpine}, Linux ${about.kernel}: ${entries.length - 4} files`);
  console.log(`${out}: ${archive.length} bytes, sha256 ${sha256(archive)}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "image" && args.length === 2) await image(args[0], args[1]);
else {
  console.error("usage: pack.mjs image <rootfs.tar> <image.tar>");
  process.exit(2);
}

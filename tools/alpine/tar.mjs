// Just enough of the tar format to move the Linux image around as one file
// without a dependency: plain files with short names, written and read back.

const BLOCK = 512;

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

// entries: [{ name, data: Buffer }]. Returns the archive as a Buffer.
export function writeTar(entries) {
  const blocks = [];
  for (const { name, data } of entries) {
    if (Buffer.byteLength(name) > 100) throw new Error(`name too long for tar: ${name}`);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0);
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(data.length, 12), 124);
    // No timestamps, so the same files always make the same archive.
    header.write(octal(0, 12), 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 7) + " ", 148);
    blocks.push(header, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
}

// Calls each(name, data) for every plain file in the archive. Other kinds of
// entry (directories, links, the long-name records GNU tar adds) are passed
// over; `wanted`, if given, says which names are worth reading.
export function readTar(archive, each, wanted) {
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const text = (from, length) => header.toString("utf8", from, from + length).replace(/\0.*$/s, "");
    const size = parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1);
    const prefix = text(345, 155);
    const name = (prefix ? prefix + "/" : "") + text(0, 100);
    at += BLOCK;
    if ((type === "0" || type === "") && (!wanted || wanted(name))) each(name, archive.subarray(at, at + size));
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
}

// just-bash's gzip and tar commands use Node's Buffer, which a browser
// doesn't have. build.mjs injects this wherever a bundle refers to it. The
// trailing slash picks the npm package over Node's own module of that name.
export { Buffer } from "buffer/";

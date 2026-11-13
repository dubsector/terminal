import { gzipSync as deflate, gunzipSync as inflate } from "fflate";

// just-bash's browser build still imports node:zlib for gzip, gunzip, zcat
// and `rg -z`. build.mjs points that import here, so those commands work in
// the page instead of taking the whole bundle down at load.

export var constants = {
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
};

function checkLength(out, options) {
  if (options && options.maxOutputLength && out.length > options.maxOutputLength) {
    throw new RangeError("Cannot create a Buffer larger than " + options.maxOutputLength + " bytes");
  }
  return out;
}

export function gunzipSync(data, options) {
  return checkLength(inflate(data), options);
}

export function gzipSync(data, options) {
  var level = options && options.level >= 0 ? options.level : 6;
  return checkLength(deflate(data, { level: level }), options);
}

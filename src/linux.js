import { V86 } from "v86";
import LINKS from "./shell/links.json";

// The real machine behind `reboot`: v86 emulates a 32-bit PC in the page
// and boots the Alpine Linux image that tools/alpine builds. This is its own
// script, loaded only when someone asks for it. terminal.js stays in charge
// of the screen and keyboard; this connects them to the machine's serial
// port, which is the only console it has.
//
// __LINUX__ is filled in by build.mjs: where the image and the emulator are
// served from, and how the machine is to be started.

var image = __LINUX__;

// What the kernel prints last, on the way down. The emulated PC has no power
// switch for it to throw, so this is how the page knows it has stopped.
var STOPPED = /reboot: (Power down|System halted|Power off not available)/;
var RESTARTING = /reboot: Restarting system/;

// v86 can't restart a machine it booted straight from a kernel image: the
// processor is reset, and then the emulator crashes in the BIOS. So a reset
// is not allowed to happen. The processor is stopped where it stands by
// throwing this out through it, and the page starts a new machine instead.
var RESET = new Error("machine reset");
window.addEventListener("error", function (event) {
  if (event.error === RESET) event.preventDefault();
});

// The site's folders, laid onto the machine's disk as it starts, from the
// same links.json the other machine's `ls` reads (see src/shell/tree.js).
// They are not in the image, so adding a link never means building a new
// one. Each link is a file at the path its URL spells: "https://grandtot.al"
// is the file grandtot.al in a directory called "https:".
var SITE = ["var", "www", "dubsector.dev"];
function addSiteLinks(fs) {
  var encoder = new TextEncoder();
  function dir(parent, name) {
    var id = fs.Search(parent, name);
    return id === -1 ? fs.CreateDirectory(name, parent) : id;
  }
  var writes = [];
  Object.keys(LINKS).forEach(function (folder) {
    LINKS[folder].forEach(function (url) {
      var parts = SITE.concat(folder, url.replace("://", ":/").split("/")).filter(Boolean);
      var name = parts.pop();
      var parent = parts.reduce(dir, 0);
      if (fs.Search(parent, name) === -1) writes.push(fs.CreateBinaryFile(name, parent, encoder.encode(url + "\n")));
    });
  });
  return Promise.all(writes);
}

// hooks:
//   write(bytes)   output from the machine, as a Uint8Array
//   onOff()        the machine has shut itself down
//   onRestart()    the machine has asked to be restarted
//   onError()      it could not be started
window.__bootLinux = function (hooks) {
  var emulator = new V86({
    wasm_path: image.wasm,
    memory_size: image.memory * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { url: image.base + "seabios.bin" },
    vga_bios: { url: image.base + "vgabios.bin" },
    // The root filesystem: an index of every file, and each file fetched
    // from flat/ the first time the machine opens it.
    filesystem: { baseurl: image.base + "flat/", basefs: image.base + "fs.json" },
    bzimage_initrd_from_filesystem: true,
    cmdline: image.cmdline,
    autostart: true,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  var running = true;

  emulator.add_listener("emulator-ready", function () {
    // v86 forgets a file's contents when the machine closes it and fetches
    // it again on the next open. Every program run opens the C library, so
    // a boot made some fourteen thousand requests; held on to, it makes
    // about a hundred and fifty.
    var storage = emulator.fs9p && emulator.fs9p.storage;
    if (storage && storage.uncache) storage.uncache = function () {};

    // Long before the kernel gets as far as mounting the disk.
    if (emulator.fs9p) addSiteLinks(emulator.fs9p).catch(function () {});

    var cpu = emulator.v86 && emulator.v86.cpu;
    if (cpu) {
      cpu.reboot_internal = function () {
        throw RESET;
      };
    }
  });
  emulator.add_listener("download-error", function () {
    if (running) hooks.onError();
  });

  // Bytes arrive one at a time; pass them on once per turn of the event
  // loop, in the order they came.
  var pending = [];
  var tail = "";
  emulator.add_listener("serial0-output-byte", function (byte) {
    if (!pending.length) setTimeout(flush, 0);
    pending.push(byte);
  });
  function flush() {
    var bytes = new Uint8Array(pending);
    pending = [];
    if (!running) return;
    hooks.write(bytes);
    tail = (tail + String.fromCharCode.apply(null, bytes.subarray(-200))).slice(-200);
    if (STOPPED.test(tail)) {
      tail = "";
      hooks.onOff();
    } else if (RESTARTING.test(tail)) {
      tail = "";
      hooks.onRestart();
    }
  }

  var encoder = new TextEncoder();
  return {
    // Keys, as the terminal reports them, to the machine.
    send: function (data) {
      if (!running) return;
      var bytes = encoder.encode(data);
      for (var i = 0; i < bytes.length; i++) emulator.bus.send("serial0-input", bytes[i]);
    },
    stop: function () {
      running = false;
      Promise.resolve()
        .then(function () {
          return emulator.destroy();
        })
        .catch(function () {});
    },
  };
};

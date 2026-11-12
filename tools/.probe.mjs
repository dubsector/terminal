// Temporary numeric probe of scene.glb (deleted after use).
import { readFileSync } from "fs";
import { Matrix4, Vector3, Box3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
globalThis.self = globalThis;
const buf = readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
loader.parse(ab, "", (gltf) => {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const tube = scene.getObjectByName("TubeRef");
  const inv = new Matrix4().copy(tube.matrixWorld).invert();
  console.log("tube world", tube.matrixWorld.elements.map((v) => +v.toFixed(5)).join(" "));
  const up = new Vector3(0, 1, 0).transformDirection(inv);
  console.log("room up in tube space", up.toArray().map((v) => +v.toFixed(5)));
  const v = new Vector3();
  function pts(name) {
    const o = scene.getObjectByName(name);
    const p = o.geometry.attributes.position;
    const out = [];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      out.push(v.clone());
    }
    return out;
  }
  let tris = 0;
  scene.traverse((o) => {
    if (o.isMesh) tris += o.geometry.index.count / 3;
  });
  console.log("triangles", tris, "posType", scene.getObjectByName("Collar").geometry.attributes.position.array.constructor.name,
    "uv1 type", scene.getObjectByName("Collar").geometry.attributes.uv1.array.constructor.name);
  for (const n of ["Collar", "Housing", "Plinth", "Keyboard", "PowerButton", "PowerLED", "LegendStrip", "Kbd_StripWindow", "Desk_Top", "Wall_Desk", "Floor", "Lamp_Shade", "Kbd_LED_Lock"]) {
    const b = new Box3().setFromPoints(pts(n));
    console.log(n, "tube-space bbox", b.min.toArray().map((x) => +x.toFixed(3)), b.max.toArray().map((x) => +x.toFixed(3)));
  }
  // Collar opening: vertices close to the glass surface.
  const R = 11, APEX = 0.05;
  const faceZ = (x, y) => Math.sqrt(R * R - x * x - y * y) - R + APEX;
  const cp = pts("Collar");
  let near = cp.filter((p) => Math.abs(p.x) < 2.3 && Math.abs(p.y) < 1.8 && Math.abs(p.z - faceZ(p.x, p.y)) < 0.12);
  let minx = 9, maxx = -9, miny = 9, maxy = -9;
  // innermost ring: for vertices near y=0, smallest |x|; near x=0, smallest |y|
  const ringX = cp.filter((p) => Math.abs(p.y) < 0.3).map((p) => p.x);
  const ringY = cp.filter((p) => Math.abs(p.x) < 0.3).map((p) => p.y);
  console.log("collar inner x (|y|<0.3): min +x", Math.min(...ringX.filter((x) => x > 0)).toFixed(4), "max -x", Math.max(...ringX.filter((x) => x < 0)).toFixed(4));
  console.log("collar inner y (|x|<0.3): min +y", Math.min(...ringY.filter((x) => x > 0)).toFixed(4), "max -y", Math.max(...ringY.filter((x) => x < 0)).toFixed(4));
  // gap between innermost collar verts and the face
  const inner = cp.filter((p) => Math.abs(p.x) <= 2.06 && Math.abs(p.y) <= 1.56);
  let dmin = 9, dmax = -9;
  const samples = [];
  for (const p of inner) {
    const d = p.z - faceZ(p.x, p.y);
    dmin = Math.min(dmin, d);
    dmax = Math.max(dmax, d);
    if (samples.length < 400) samples.push(p);
  }
  console.log("inner collar verts", inner.length, "z - faceZ range", dmin.toFixed(4), dmax.toFixed(4));
  // per region
  for (const [nm, f] of [["corner", (p) => Math.abs(p.x) > 1.7 && Math.abs(p.y) > 1.2], ["side", (p) => Math.abs(p.y) < 0.2], ["top", (p) => Math.abs(p.x) < 0.2]]) {
    const s = inner.filter(f);
    const ds = s.map((p) => p.z - faceZ(p.x, p.y));
    console.log(" ", nm, s.length, "d range", Math.min(...ds).toFixed(4), Math.max(...ds).toFixed(4), "maxabs x,y", Math.max(...s.map((p) => Math.abs(p.x))).toFixed(3), Math.max(...s.map((p) => Math.abs(p.y))).toFixed(3));
  }
  // deepest collar verts overall (behind the glass?)
  const behind = cp.filter((p) => Math.abs(p.x) < 2.25 && Math.abs(p.y) < 1.75 && p.z < faceZ(p.x, p.y));
  console.log("collar verts behind the face surface within the face mesh:", behind.length, behind.slice(0, 5).map((p) => p.toArray().map((x) => +x.toFixed(3)).join(",")).join(" | "));
  console.log("collar min z", Math.min(...cp.map((p) => p.z)).toFixed(4));
  // key UV orientation
  for (const n of ["Key_A", "Key_Tab", "Key_Enter", "Key_Space", "Key_ArrowUp"]) {
    const o = scene.getObjectByName(n) || scene.children.find((c) => 0);
    if (!o) { console.log("no", n); continue; }
    const g = o.geometry, p = g.attributes.position, uv = g.attributes.uv;
    let rows = [];
    let ymax = -9;
    for (let i = 0; i < p.count; i++) ymax = Math.max(ymax, p.getY(i));
    let umin = 9, umax = -9, vmin = 9, vmax = -9;
    for (let i = 0; i < p.count; i++) {
      umin = Math.min(umin, uv.getX(i)); umax = Math.max(umax, uv.getX(i));
      vmin = Math.min(vmin, uv.getY(i)); vmax = Math.max(vmax, uv.getY(i));
      if (p.getY(i) > ymax - 0.0012) rows.push([p.getX(i), p.getZ(i), uv.getX(i), uv.getY(i)]);
    }
    const cell = o.userData.cell;
    console.log(n, "cell", cell, "col", cell % 16, "row", Math.floor(cell / 16), "uv*16,8 range u", (umin * 16).toFixed(3), (umax * 16).toFixed(3), "v", (vmin * 8).toFixed(3), (vmax * 8).toFixed(3), "local ymax", ymax.toFixed(4));
    rows.sort((a, b) => a[0] - b[0]);
    const f = (r) => r.map((x, i) => (i < 2 ? (x * 1000).toFixed(1) : i == 2 ? (x * 16).toFixed(3) : (x * 8).toFixed(3))).join(" ");
    console.log("   top verts (x mm, z mm, u cells, v cells): leftmost", f(rows[0]), "| rightmost", f(rows[rows.length - 1]));
    rows.sort((a, b) => a[1] - b[1]);
    console.log("   rearmost(-z)", f(rows[0]), "| frontmost(+z)", f(rows[rows.length - 1]), "n", rows.length);
  }
  const names = [];
  scene.traverse((o) => { if (o.name.startsWith("Key_")) names.push(o.name); });
  console.log(names.slice(0, 8).join(" "), names.length);
  // strip
  const s = scene.getObjectByName("LegendStrip");
  const sp = s.geometry.attributes.position, su = s.geometry.attributes.uv;
  s.geometry.computeBoundingBox();
  console.log("strip local bbox", s.geometry.boundingBox.min.toArray(), s.geometry.boundingBox.max.toArray(), "extras", s.userData, "verts", sp.count);
  for (let i = 0; i < Math.min(sp.count, 12); i++) console.log("   ", sp.getX(i).toFixed(4), sp.getY(i).toFixed(4), sp.getZ(i).toFixed(4), "uv", su.getX(i).toFixed(3), su.getY(i).toFixed(3));
  const kb = scene.getObjectByName("Keyboard");
  console.log("keyboard children", kb.children.length, kb.children.filter((c) => !c.name.startsWith("Key_")).map((c) => c.name + ":" + c.position.toArray().map((x) => x.toFixed(3))).join(" "));
  const btn = scene.getObjectByName("PowerButton");
  console.log("button userData", btn.userData, "scene userData", scene.userData);
  for (const n of ["Cam_Seat", "Cam_Target"]) {
    const o = scene.getObjectByName(n);
    console.log(n, v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv).toArray().map((x) => +x.toFixed(3)));
  }
}, (e) => console.error("ERR", e));

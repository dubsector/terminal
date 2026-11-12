// Temporary: evaluate the camera rig numerically (deleted after use).
import { readFileSync } from "fs";
import { Matrix4, Vector3, PerspectiveCamera } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const { createRig } = await import(process.argv[3]);
globalThis.self = globalThis;
const buf = readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(ab, "", (gltf) => {
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const tube = root.getObjectByName("TubeRef");
  const tubeM = tube.matrixWorld.clone(); const inv = new Matrix4().copy(tube.matrixWorld).invert();
  inv.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);
  const keys = [];
  root.traverse((o) => { if (o.userData.code !== undefined) keys.push(o); });
  const model = {
    up: new Vector3(0, 1, 0).transformDirection(inv),
    seat: new Vector3().setFromMatrixPosition(root.getObjectByName("Cam_Seat").matrixWorld),
    target: new Vector3().setFromMatrixPosition(root.getObjectByName("Cam_Target").matrixWorld),
    keys,
  };
  const cam = new PerspectiveCamera(28, 1, 0.5, 400);
  const rig = createRig(cam, model, (process.env.TERM_SET || "Collar,Housing,Plinth").split(",").map((n) => root.getObjectByName(n)), [root.getObjectByName("Keyboard")]);
  // room coordinates (blender metres) of a tube-space point
  const toRoom = tubeM; // tube -> gltf metres
  const room = (p) => { const q = p.clone().applyMatrix4(toRoom); return [q.x, -q.z, q.y].map((v) => +v.toFixed(3)); };
  function measure(aspect, lookDown) {
    rig.layout(aspect);
    for (let i = 0; i < 400; i++) rig.step(0.05, 0, 0, lookDown);
    cam.updateMatrixWorld(true);
    const P = (x, y, z) => new Vector3(x, y, z).project(cam);
    const t = P(0, 1.26, 0), b = P(0, -1.26, 0), l = P(-1.76, 0, 0), r = P(1.76, 0, 0);
    const kf = keys.map((k) => new Vector3().setFromMatrixPosition(k.matrixWorld).project(cam));
    const inFrame = kf.filter((p) => Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1).length;
    return { aspect, fov: +cam.fov.toFixed(1), picH: +((t.y - b.y) / 2).toFixed(3), picW: +((r.x - l.x) / 2).toFixed(3), picTop: +t.y.toFixed(2), picBot: +b.y.toFixed(2), keysInFrame: inFrame, eyeRoom: room(cam.position) };
  }
  for (const a of [21/9, 16/9, 1.6, 4/3, 1, 0.9, 0.75, 390/844]) {
    // old fit
    const tOld = Math.tan((28 * Math.PI) / 360);
    const dist = Math.max(2.3 / tOld, 2.75 / (tOld * a)) + 0.45;
    const oldH = 1.26 / (dist * tOld), oldW = 1.76 / (dist * tOld * a);
    const m = measure(a, false); console.log("   down", JSON.stringify(measure(a, true)));
    console.log(JSON.stringify(m), "old picH", oldH.toFixed(3), "picW", oldW.toFixed(3), "ratio", (m.picH / oldH).toFixed(2));
    
  }
}, (e) => console.error(e));

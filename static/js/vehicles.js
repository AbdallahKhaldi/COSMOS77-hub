/* vehicles.js — the two hero cars (ARENA V2). GTA-silhouette procedural
   builds ship by default; Kenney glb models (loaded by assets.js) hot-swap in
   via swapIn() and the procedural mesh silently stays if they never arrive.

   Structure (the director only ever touches .group):
     group            — position + heading (rotation.y), set by director/replay
       chassis        — lean (z) / pitch (x) motion polish lives here
         carBody      — swap target: procedural meshes OR the kenney model
         [lightbar]   — cop only; survives the swap (re-seated at roof height)
         shadow blob  — radial-gradient contact shadow; survives the swap

   Motion polish: wheels rotate proportional to distance, body yaws smoothly
   (the director owns yaw), leans ~2° into turns, pitches ~1.5° on accel.
   prefers-reduced-motion: strobe + lean/pitch sway off; wheel roll stays. */

import * as THREE from "three";
import { CELL } from "./scene.js";

const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const tmpV = new THREE.Vector3();
const qAxle = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
const qSpin = new THREE.Quaternion();
const qWheel = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const M4 = new THREE.Matrix4();

function shadowBlobCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
  g.addColorStop(0, "rgba(8,9,12,0.55)");
  g.addColorStop(0.62, "rgba(8,9,12,0.30)");
  g.addColorStop(1, "rgba(8,9,12,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return cv;
}

function makeShadowBlob(w, l) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowBlobCanvas()),
      transparent: true, depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.09; // above the road plane (0.06)
  mesh.renderOrder = 1;
  return mesh;
}

function policeDecalCanvas() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = "#10151c";
  ctx.font = "700 40px 'Chakra Petch', 'Arial Narrow', sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("POLICE", 128, 30);
  ctx.fillStyle = "#2b7fff"; ctx.fillRect(24, 52, 208, 6);
  return cv;
}

function stripeDecalCanvas() {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(12,12,14,0.96)";
  ctx.fillRect(28, 0, 26, 128); ctx.fillRect(74, 0, 26, 128); // twin racing stripes
  return cv;
}

/* two planes (front white / rear red) merged into ONE vertex-colored mesh */
function makeLights(w, yF, zF, yR, zR, rearColor) {
  const front = new THREE.PlaneGeometry(w, 0.24);
  front.translate(0, 0, 0.001);
  const mF = new THREE.Matrix4().makeTranslation(0, yF, zF);
  front.applyMatrix4(mF);
  const rear = new THREE.PlaneGeometry(w, 0.22);
  rear.rotateY(Math.PI);
  rear.applyMatrix4(new THREE.Matrix4().makeTranslation(0, yR, zR));
  const cF = new THREE.Color(0xe8f1ff), cR = new THREE.Color(rearColor);
  for (const [g, c] of [[front, cF], [rear, cR]]) {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) c.toArray(arr, i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  }
  // tiny local merge (two planes, same attribute sets)
  const merged = new THREE.BufferGeometry();
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let base = 0;
  for (const g of [front, rear]) {
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    uv.push(...g.attributes.uv.array);
    col.push(...g.attributes.color.array);
    for (const i of g.index.array) idx.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  merged.setIndex(idx);
  return new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
}

function mergeBoxes(parts) { // [[w,h,d,x,y,z], ...] -> one BufferGeometry
  const geos = parts.map(([w, h, d, x, y, z]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  });
  const merged = new THREE.BufferGeometry();
  const pos = [], nor = [], uv = [], idx = [];
  let base = 0;
  for (const g of geos) {
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  return merged;
}

/* procedural wheels: tires + hubs, two InstancedMeshes; matrices recomposed
   for spin (no allocation per frame). rearWide fattens the back axle. */
function makeWheels(x, zF, zR, r, rearWide) {
  const tires = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(r, r, 0.34, 12),
    new THREE.MeshStandardMaterial({ color: 0x0e0e12, roughness: 0.9 }),
    4,
  );
  const hubs = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.36, 8),
    new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.35, metalness: 0.7 }),
    4,
  );
  const slots = [
    { x: -x, z: zF, s: 1 }, { x, z: zF, s: 1 },
    { x: -x, z: zR, s: rearWide }, { x, z: zR, s: rearWide },
  ];
  const sv = new THREE.Vector3();
  function pose(angle) {
    qSpin.setFromAxisAngle(AXIS_Y, angle);
    qWheel.multiplyQuaternions(qAxle, qSpin);
    slots.forEach((s, i) => {
      // widen along the cylinder's LOCAL Y (= the axle after qAxle)
      M4.compose(tmpV.set(s.x, r, s.z), qWheel, sv.set(1, s.s, 1));
      tires.setMatrixAt(i, M4);
      hubs.setMatrixAt(i, M4);
    });
    tires.instanceMatrix.needsUpdate = true;
    hubs.instanceMatrix.needsUpdate = true;
  }
  pose(0);
  return { tires, hubs, pose, r };
}

/* shared motion state + kenney swap plumbing */
function makeRig(group, chassis, carBody, wheels, opts) {
  const state = {
    last: new THREE.Vector3(NaN, 0, 0),
    lastYaw: 0, lastSpeed: 0,
    lean: 0, pitch: 0, spin: 0,
    kenneyWheels: null, kenneyR: 0.3,
  };
  function motion(dt) {
    const p = group.position;
    if (!isFinite(state.last.x)) { state.last.copy(p); state.lastYaw = group.rotation.y; return; }
    if (dt <= 0) return;
    tmpV.copy(p).sub(state.last);
    const dist = Math.hypot(tmpV.x, tmpV.z);
    const speed = dist / dt;
    // signed forward distance for wheel roll direction
    const fwdDist = tmpV.x * Math.sin(group.rotation.y) + tmpV.z * Math.cos(group.rotation.y);
    if (state.kenneyWheels) {
      state.spin += fwdDist / state.kenneyR;
      for (const w of state.kenneyWheels) w.rotation.x = state.spin;
    } else if (wheels) {
      state.spin += fwdDist / wheels.r;
      if (Math.abs(fwdDist) > 1e-5) wheels.pose(state.spin);
    }
    let dYaw = group.rotation.y - state.lastYaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    const yawRate = dYaw / dt;
    const accel = (speed - state.lastSpeed) / dt;
    const leanT = REDUCED ? 0 : THREE.MathUtils.clamp(-yawRate * speed * 0.0035, -0.035, 0.035); // ~2°
    const pitchT = REDUCED ? 0 : THREE.MathUtils.clamp(-accel * 0.0011, -0.026, 0.026);          // ~1.5°
    const k = Math.min(1, dt * 6);
    state.lean += (leanT - state.lean) * k;
    state.pitch += (pitchT - state.pitch) * k;
    chassis.rotation.z = state.lean;
    chassis.rotation.x = state.pitch;
    state.last.copy(p);
    state.lastYaw = group.rotation.y;
    state.lastSpeed = speed;
  }
  /* draw-call diet: everything that is not a wheel merges into ONE mesh
     (single colormap material); the 4 named wheel nodes stay separate so
     they can spin. */
  function compactModel(model) {
    model.updateMatrixWorld(true);
    const wheels = [], rest = [];
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      (o.name && o.name.indexOf("wheel") === 0 ? wheels : rest).push(o);
    });
    const clean = new THREE.Group();
    let material = null;
    if (rest.length) {
      const geos = rest.map((o) => {
        material = material || o.material;
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        for (const name of Object.keys(g.attributes)) {
          if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
        }
        return g;
      });
      const merged = new THREE.BufferGeometry();
      const pos = [], nor = [], uv = [], idx = [];
      let base = 0;
      for (const g of geos) {
        pos.push(...g.attributes.position.array);
        nor.push(...g.attributes.normal.array);
        uv.push(...g.attributes.uv.array);
        if (g.index) for (const i of g.index.array) idx.push(i + base);
        else for (let i = 0; i < g.attributes.position.count; i += 1) idx.push(i + base);
        base += g.attributes.position.count;
      }
      merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      merged.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      merged.setIndex(idx);
      clean.add(new THREE.Mesh(merged, material));
    }
    const kw = [];
    for (const w of wheels) { // kenney wheel nodes carry translation only
      const mesh = new THREE.Mesh(w.geometry, w.material);
      mesh.position.copy(w.position);
      mesh.name = w.name;
      clean.add(mesh);
      kw.push(mesh);
    }
    return { clean, kw };
  }

  function swapIn(model, { castShadow, onRoof }) {
    if (!model) return false;
    const { clean, kw } = compactModel(model);
    const wrap = new THREE.Group();
    wrap.add(clean);
    const box = new THREE.Box3().setFromObject(clean);
    const size = box.getSize(new THREE.Vector3());
    if (size.z < 1e-4 && size.x < 1e-4) return false;
    if (size.x > size.z) clean.rotation.y = Math.PI / 2; // long axis -> travel (+Z)
    const s = (CELL * 0.42) / Math.max(size.x, size.z);   // length ≈ 4.2
    wrap.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(wrap);
    const c = box2.getCenter(new THREE.Vector3());
    wrap.position.set(-c.x, -box2.min.y, -c.z);           // pivot at ground center
    const holder = new THREE.Group();
    holder.add(wrap);
    holder.traverse((o) => {
      if (o.isMesh) { o.castShadow = castShadow; o.receiveShadow = false; }
    });
    if (kw.length === 4) {
      state.kenneyWheels = kw;
      state.kenneyR = 0.3 * s; // kenney wheel centers sit at y=0.3 (model units)
    }
    const box3 = new THREE.Box3().setFromObject(holder);
    chassis.remove(carBody.holder);
    carBody.holder.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    carBody.holder = holder;
    chassis.add(holder);
    if (onRoof) onRoof(box3.max.y);
    return true;
  }
  return { motion, swapIn, state };
}

/* POLICE CRUISER — black/white two-tone, POLICE side text, chrome bumpers,
   red/blue strobing lightbar (emissive halves + ONE owned PointLight whose
   color/intensity animate; the light is never added/removed). */
export function createCruiser(tier) {
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  chassis.position.y = 0.06;
  group.add(chassis);
  const cast = tier !== "low";

  const body = new THREE.Group(); // the swap target
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeff1f4, roughness: 0.32, metalness: 0.5 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.4, metalness: 0.55 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x11161f, roughness: 0.12, metalness: 0.25 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xcdd4dc, roughness: 0.28, metalness: 0.85 });

  const white = new THREE.Mesh(mergeBoxes([[2.5, 0.6, 5.3, 0, 0.62, 0]]), whiteMat);
  const black = new THREE.Mesh(mergeBoxes([
    [2.42, 0.14, 1.6, 0, 0.99, 1.75],    // hood
    [2.42, 0.14, 1.1, 0, 0.99, -2.0],    // trunk
    [2.24, 0.1, 2.42, 0, 1.66, -0.12],   // roof
  ]), blackMat);
  const glass = new THREE.Mesh(mergeBoxes([[2.16, 0.6, 2.36, 0, 1.34, -0.12]]), glassMat);
  const chrome = new THREE.Mesh(mergeBoxes([
    [2.56, 0.26, 0.34, 0, 0.42, 2.6],
    [2.56, 0.26, 0.34, 0, 0.42, -2.6],
  ]), chromeMat);
  const decalTex = new THREE.CanvasTexture(policeDecalCanvas());
  decalTex.colorSpace = THREE.SRGBColorSpace;
  const decalMat = new THREE.MeshBasicMaterial({ map: decalTex, transparent: true, toneMapped: false });
  const decalL = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.46), decalMat);
  decalL.position.set(1.262, 0.66, 0.1); decalL.rotation.y = Math.PI / 2;
  const decalR = decalL.clone();
  decalR.position.x = -1.262; decalR.rotation.y = -Math.PI / 2;
  const lights = makeLights(2.0, 0.74, 2.66, 0.78, -2.66, 0xff3226);
  const wheels = makeWheels(1.18, 1.72, -1.72, 0.46, 1);
  body.add(white, black, glass, chrome, decalL, decalR, lights, wheels.tires, wheels.hubs);
  if (cast) { white.castShadow = true; black.castShadow = true; glass.castShadow = true; }
  chassis.add(body);
  const carBody = { holder: body };

  /* lightbar survives the glb swap; strobe = emissive halves + owned light */
  const bar = new THREE.Group();
  const barBase = new THREE.Mesh(mergeBoxes([[1.32, 0.09, 0.46, 0, 0, 0]]), blackMat);
  const barRed = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.17, 0.42),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false }),
  );
  barRed.position.set(-0.33, 0.12, 0);
  const barBlue = new THREE.Mesh(
    new THREE.BoxGeometry(0.58, 0.17, 0.42),
    new THREE.MeshBasicMaterial({ color: 0x2b7fff, toneMapped: false }),
  );
  barBlue.position.set(0.33, 0.12, 0);
  const strobe = new THREE.PointLight(0xff3b3b, 1.2, 26, 2);
  strobe.position.set(0, 0.6, 0);
  bar.add(barBase, barRed, barBlue, strobe);
  bar.position.set(0, 1.76, -0.12);
  chassis.add(bar);

  const shadow = makeShadowBlob(3.4, 6.2);
  group.add(shadow);

  const rig = makeRig(group, chassis, carBody, wheels, {});
  const RED = new THREE.Color(0xff3b3b), BLUE = new THREE.Color(0x2b7fff);

  return {
    group,
    swapIn(model) {
      return rig.swapIn(model, {
        castShadow: cast,
        onRoof(roofY) { bar.position.y = roofY + 0.06; },
      });
    },
    /* contact blob grounds the car in daylight; night keeps the v1 look
       (and the draw-call budget) with it hidden */
    setPreset(p) { shadow.visible = p !== "night"; },
    update(dt, t) {
      rig.motion(dt);
      if (REDUCED) {
        barRed.material.color.copy(RED).multiplyScalar(1.6);
        barBlue.material.color.copy(BLUE).multiplyScalar(1.6);
        strobe.intensity = 1.0;
        return;
      }
      const hotR = Math.floor(t * 4) % 2 === 0, k = 3.2, dim = 0.25;
      barRed.material.color.copy(RED).multiplyScalar(hotR ? k : dim);
      barBlue.material.color.copy(BLUE).multiplyScalar(hotR ? dim : k);
      strobe.color.copy(hotR ? RED : BLUE);
      strobe.intensity = 0.15 + 2.25 * Math.abs(Math.sin(t * Math.PI * 4));
    },
  };
}

/* THIEF MUSCLE CAR — vivid orange, twin black racing stripes, black spoiler,
   wider rear wheels. This is the "thief car invisible" fix: high-chroma paint
   against gray asphalt in day, tail neon at night. */
export function createRunner(tier) {
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  chassis.position.y = 0.06;
  group.add(chassis);
  const cast = tier !== "low";

  const body = new THREE.Group();
  const paintMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.28, metalness: 0.55 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.45, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1117, roughness: 0.1, metalness: 0.25 });

  const paint = new THREE.Mesh(mergeBoxes([
    [2.55, 0.54, 5.0, 0, 0.6, 0],        // slab
    [2.45, 0.2, 1.35, 0, 0.97, 1.6],     // hood
    [2.6, 0.24, 1.55, 0, 0.98, -1.5],    // rear haunches
    [0.8, 0.13, 0.8, 0, 1.13, 1.45],     // hood scoop
    [2.1, 0.1, 2.05, 0, 1.58, -0.25],    // roof
  ]), paintMat);
  const glass = new THREE.Mesh(mergeBoxes([[2.02, 0.5, 1.9, 0, 1.28, -0.25]]), glassMat);
  const blackTrim = new THREE.Mesh(mergeBoxes([
    [2.35, 0.07, 0.5, 0, 1.5, -2.3],     // spoiler wing
    [0.1, 0.28, 0.28, 0.9, 1.26, -2.36], // struts
    [0.1, 0.28, 0.28, -0.9, 1.26, -2.36],
    [2.5, 0.1, 0.34, 0, 0.32, 2.5],      // splitter
  ]), blackMat);
  const stripeTex = new THREE.CanvasTexture(stripeDecalCanvas());
  const stripeMat = new THREE.MeshBasicMaterial({ map: stripeTex, transparent: true, toneMapped: false });
  const stripeHood = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.32), stripeMat);
  stripeHood.rotation.x = -Math.PI / 2;
  stripeHood.position.set(0, 1.076, 1.6);
  const stripeRoof = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.0), stripeMat);
  stripeRoof.rotation.x = -Math.PI / 2;
  stripeRoof.position.set(0, 1.636, -0.25);
  const stripeTail = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.5), stripeMat);
  stripeTail.rotation.x = -Math.PI / 2;
  stripeTail.position.set(0, 1.106, -1.52);
  const lights = makeLights(1.9, 0.72, 2.51, 0.86, -2.28, 0xff4a1e);
  const wheels = makeWheels(1.2, 1.62, -1.62, 0.46, 1.22);
  body.add(paint, glass, blackTrim, stripeHood, stripeRoof, stripeTail, lights, wheels.tires, wheels.hubs);
  if (cast) { paint.castShadow = true; glass.castShadow = true; }
  chassis.add(body);
  const carBody = { holder: body };

  const shadow = makeShadowBlob(3.4, 6.0);
  group.add(shadow);

  const rig = makeRig(group, chassis, carBody, wheels, {});

  return {
    group,
    swapIn(model) { return rig.swapIn(model, { castShadow: cast }); },
    setPreset(p) { shadow.visible = p !== "night"; },
    update(dt, t) {
      rig.motion(dt);
      void t;
    },
  };
}

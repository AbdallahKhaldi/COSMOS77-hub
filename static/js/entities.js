/* entities.js — everything that moves or believes. Pools preallocated to the
   config's own hard caps (49 cells, 14 barriers, fixed trail ring); per-frame
   work is matrix/color writes only (attribute needsUpdate, never material
   recompiles, never light toggles). LEGALITY IS THE DESIGN: the opponent is
   never drawn — only THE BELIEF GHOST, a labeled hologram of our posterior. */

import * as THREE from "three";
import { cellToWorld, GRID } from "./scene.js";

export const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const ONE = new THREE.Vector3(1, 1, 1);
const Q_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_ID = new THREE.Quaternion();

export function makeLabelSprite(text, cssColor, px = 96) {
  const cv = document.createElement("canvas");
  const ctx = cv.getContext("2d");
  ctx.font = `700 ${px}px "Chakra Petch", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  cv.width = w; cv.height = px + 46;
  const c2 = cv.getContext("2d");
  c2.font = `700 ${px}px "Chakra Petch", sans-serif`;
  c2.textBaseline = "middle";
  c2.shadowColor = cssColor; c2.shadowBlur = 26;
  c2.fillStyle = cssColor;
  c2.fillText(text, 24, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, toneMapped: false,
  }));
  const s = 0.045;
  spr.scale.set(cv.width * s, cv.height * s, 1);
  return spr;
}

function stripeTexture() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#151004"; ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#ffd400"; ctx.lineWidth = 10;
  for (let x = -64; x < 128; x += 26) {
    ctx.beginPath(); ctx.moveTo(x, 70); ctx.lineTo(x + 70, 0); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* all four wheels = ONE InstancedMesh (1 draw call per vehicle) */
function addWheels(group) {
  const inst = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.42, 0.42, 0.36, 10),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0e, roughness: 0.9 }),
    4,
  );
  const pos = [[-1.15, 1.6], [1.15, 1.6], [-1.15, -1.6], [1.15, -1.6]];
  const qz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  pos.forEach(([x, z], i) => {
    tmpM.compose(tmpV.set(x, 0.42, z), qz, ONE);
    inst.setMatrixAt(i, tmpM);
  });
  group.add(inst);
}

/* POLICE CRUISER (~7 draw calls) with emissive strobe lightbar.
   The strobe is emissive color + ONE owned PointLight whose intensity
   animates 0.15..2.4 and whose color flips — the light itself is never
   added/removed/toggled (no shader recompilation, ever). */
export function createCruiser(tier) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 0.85, 5.2),
    new THREE.MeshStandardMaterial({ color: 0x24344f, metalness: 0.55, roughness: 0.35 }),
  );
  body.position.y = 0.85;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.75, 2.5),
    new THREE.MeshStandardMaterial({ color: 0x0b0e14, metalness: 0.2, roughness: 0.15 }),
  );
  cabin.position.set(0, 1.55, -0.2);
  const barRed = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.26, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xff3b3b, toneMapped: false }),
  );
  barRed.position.set(-0.55, 2.05, -0.2);
  const barBlue = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.26, 0.5),
    new THREE.MeshBasicMaterial({ color: 0x2b7fff, toneMapped: false }),
  );
  barBlue.position.set(0.55, 2.05, -0.2);
  const head = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xbfd9ff, toneMapped: false, transparent: true, opacity: 0.9 }),
  );
  head.position.set(0, 0.7, 2.62);
  const strobe = new THREE.PointLight(0xff3b3b, 1.2, 26, 2);
  strobe.position.set(0, 2.6, 0);
  g.add(body, cabin, barRed, barBlue, head, strobe);
  addWheels(g);
  if (tier === "high") { body.castShadow = true; cabin.castShadow = true; }

  const RED = new THREE.Color(0xff3b3b), BLUE = new THREE.Color(0x2b7fff);
  let phase = 0;
  return {
    group: g,
    update(dt, t) {
      if (REDUCED) {
        barRed.material.color.copy(RED).multiplyScalar(1.6);
        barBlue.material.color.copy(BLUE).multiplyScalar(1.6);
        strobe.intensity = 1.0;
        return;
      }
      phase = Math.floor(t * 4) % 2; // steps() strobe, HW6 lightbar DNA
      const hotR = phase === 0, k = 3.2, dim = 0.25;
      barRed.material.color.copy(RED).multiplyScalar(hotR ? k : dim);
      barBlue.material.color.copy(BLUE).multiplyScalar(hotR ? dim : k);
      strobe.color.copy(hotR ? RED : BLUE);
      strobe.intensity = 0.15 + 2.25 * Math.abs(Math.sin(t * Math.PI * 4));
      void dt;
    },
  };
}

/* THIEF RUNNER (~5 draw calls) — low orange coupe with tail neon + underglow. */
export function createRunner(tier) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.7, 4.6),
    new THREE.MeshStandardMaterial({ color: 0xd96a10, metalness: 0.55, roughness: 0.3 }),
  );
  body.position.y = 0.75;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.6, 2.0),
    new THREE.MeshStandardMaterial({ color: 0x120d08, metalness: 0.2, roughness: 0.12 }),
  );
  cabin.position.set(0, 1.35, 0.1);
  const tail = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.3),
    new THREE.MeshBasicMaterial({ color: 0xff5a1e, toneMapped: false }),
  );
  tail.rotation.y = Math.PI;
  tail.position.set(0, 0.75, -2.32);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 5.4),
    new THREE.MeshBasicMaterial({
      color: 0xff8a1e, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  g.add(body, cabin, tail, glow);
  addWheels(g);
  if (tier === "high") body.castShadow = true;
  return {
    group: g,
    update(dt, t) {
      glow.material.opacity = REDUCED ? 0.16 : 0.12 + 0.07 * Math.sin(t * 3);
      void dt;
    },
  };
}

/* THE BELIEF GHOST — the posterior as a holographic presence.
   fuzzy: diffuse multi-cell shimmer (instanced additive quads, 1 call)
   exact: one solid pulsing hologram cell (volume + halo, 2 calls)
   always labeled BELIEF (sprite, 1 call). */
export function createGhost() {
  const group = new THREE.Group();
  const HOLO = 0x7ad7ff;

  const cloud = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(7.6, 7.6),
    new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
    GRID * GRID,
  );
  for (let r = 0; r < GRID; r += 1) {
    for (let c = 0; c < GRID; c += 1) {
      const p = cellToWorld(r, c, 0.36);
      tmpM.compose(p, Q_FLAT, ONE);
      cloud.setMatrixAt(r * GRID + c, tmpM);
      cloud.setColorAt(r * GRID + c, tmpC.set(0x000000));
    }
  }
  cloud.instanceMatrix.needsUpdate = true;

  const volume = new THREE.Mesh(
    new THREE.BoxGeometry(7, 3.4, 7),
    new THREE.MeshBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  volume.position.y = 1.7;
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 9),
    new THREE.MeshBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.4;
  const exactGroup = new THREE.Group();
  exactGroup.add(volume, halo);
  exactGroup.visible = false;

  const label = makeLabelSprite("BELIEF", "#7ad7ff");
  label.position.y = 6.2;
  label.center.set(0.5, 0);

  group.add(cloud, exactGroup, label);

  const target = new Float64Array(GRID * GRID);
  const disp = new Float64Array(GRID * GRID);
  let mode = "none"; // none | fuzzy | exact
  let exactRC = null;

  return {
    group,
    setPosterior(grid49, confidence) {
      let best = 0, bestI = -1;
      for (let i = 0; i < GRID * GRID; i += 1) {
        target[i] = grid49[i];
        if (grid49[i] > best) { best = grid49[i]; bestI = i; }
      }
      if (confidence === "exact" && bestI >= 0) {
        mode = "exact";
        exactRC = [Math.floor(bestI / GRID), bestI % GRID];
      } else if (best > 0) {
        mode = "fuzzy";
        exactRC = bestI >= 0 ? [Math.floor(bestI / GRID), bestI % GRID] : null;
      } else {
        mode = "none";
        exactRC = null;
      }
    },
    update(dt, t) {
      const chase = Math.min(1, dt * 5);
      let peakI = 0, peak = 0;
      for (let i = 0; i < GRID * GRID; i += 1) {
        disp[i] += (target[i] - disp[i]) * chase;
        if (disp[i] > peak) { peak = disp[i]; peakI = i; }
      }
      const shimmerOn = mode === "fuzzy";
      for (let i = 0; i < GRID * GRID; i += 1) {
        let k = shimmerOn ? disp[i] : 0;
        if (k > 0.003) {
          const sh = REDUCED ? 1 : 0.75 + 0.25 * Math.sin(t * 3 + i * 1.7);
          tmpC.set(HOLO).multiplyScalar(Math.min(1.15, k * 1.8) * sh);
        } else tmpC.set(0x000000);
        cloud.setColorAt(i, tmpC);
      }
      cloud.instanceColor.needsUpdate = true;
      exactGroup.visible = mode === "exact";
      if (mode === "exact" && exactRC) {
        const p = cellToWorld(exactRC[0], exactRC[1], 0);
        exactGroup.position.set(p.x, 0, p.z);
        const pulse = REDUCED ? 1 : 0.9 + 0.12 * Math.sin(t * 5);
        exactGroup.scale.set(pulse, 1, pulse);
        volume.material.opacity = 0.13 + (REDUCED ? 0 : 0.08 * (0.5 + 0.5 * Math.sin(t * 5)));
        label.position.set(p.x, 6.2, p.z);
        label.visible = true;
      } else if (mode === "fuzzy") {
        const p = cellToWorld(Math.floor(peakI / GRID), peakI % GRID, 0);
        label.position.set(p.x, 6.2, p.z);
        label.visible = peak > 0.02;
      } else {
        label.visible = false;
      }
    },
  };
}

/* SCENT DECALS — instanced additive quads chasing authoritative values.
   Tinted by whose trail it is (we perceive the OPPONENT's scent). */
export function createScentLayer() {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(8.2, 8.2),
    new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
    GRID * GRID,
  );
  for (let r = 0; r < GRID; r += 1) {
    for (let c = 0; c < GRID; c += 1) {
      const p = cellToWorld(r, c, 0.32);
      tmpM.compose(p, Q_FLAT, ONE);
      mesh.setMatrixAt(r * GRID + c, tmpM);
      mesh.setColorAt(r * GRID + c, tmpC.set(0x000000));
    }
  }
  mesh.instanceMatrix.needsUpdate = true;

  const target = new Float64Array(GRID * GRID);
  const disp = new Float64Array(GRID * GRID);
  let tint = new THREE.Color(0xff8a1e);
  let visible = true;

  return {
    mesh,
    setTint(hex) { tint = new THREE.Color(hex); },
    setVisible(v) { visible = v; mesh.visible = v; },
    setTargets(grid49) { for (let i = 0; i < GRID * GRID; i += 1) target[i] = grid49[i]; },
    update(dt) {
      if (!visible) return;
      const chase = Math.min(1, dt * 3); // recon: disp += (tgt-disp)*min(1,dt*3)
      for (let i = 0; i < GRID * GRID; i += 1) {
        disp[i] += (target[i] - disp[i]) * chase;
        tmpC.copy(tint).multiplyScalar(Math.min(1, disp[i]) * 0.34);
        mesh.setColorAt(i, tmpC);
      }
      mesh.instanceColor.needsUpdate = true; // 49-color upload, cheap
    },
  };
}

/* BARRIER POOL — 14 instanced hazard blocks (config max_barriers), each new
   barrier drops in from the sky; removed set hides below ground. */
export function createBarrierPool() {
  const MAXB = 14;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(6.6, 1.15, 6.6),
    new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.7 }),
    MAXB,
  );
  const slots = []; // {key, r, c, y, vy, landed}
  const hidden = new Array(MAXB).fill(true);
  for (let i = 0; i < MAXB; i += 1) {
    tmpM.compose(tmpV.set(0, -50, 0), Q_ID, ONE);
    mesh.setMatrixAt(i, tmpM);
    slots.push(null);
  }
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    /* authoritative list of [r,c]; new keys animate a drop */
    sync(list) {
      const want = new Set((list || []).map(([r, c]) => r + "," + c));
      for (let i = 0; i < MAXB; i += 1) {
        if (slots[i] && !want.has(slots[i].key)) slots[i] = null;
        if (slots[i]) want.delete(slots[i].key);
      }
      for (const key of want) {
        const idx = slots.findIndex((s) => s === null);
        if (idx === -1) break;
        const j = key.indexOf(",");
        const r = parseInt(key.slice(0, j), 10), c = parseInt(key.slice(j + 1), 10);
        slots[idx] = { key, r, c, y: REDUCED ? 0.85 : 22, vy: 0 };
      }
    },
    reset() { for (let i = 0; i < MAXB; i += 1) slots[i] = null; },
    update(dt) {
      let dirty = false;
      for (let i = 0; i < MAXB; i += 1) {
        const s = slots[i];
        if (!s) {
          if (!hidden[i]) {
            tmpM.compose(tmpV.set(0, -50, 0), Q_ID, ONE);
            mesh.setMatrixAt(i, tmpM);
            hidden[i] = true;
            dirty = true;
          }
          continue;
        }
        hidden[i] = false;
        if (s.y > 0.85) {
          s.vy += 60 * dt;
          s.y = Math.max(0.85, s.y - s.vy * dt);
          const p = cellToWorld(s.r, s.c, s.y);
          tmpM.compose(p, Q_ID, ONE);
          mesh.setMatrixAt(i, tmpM);
          dirty = true;
        } else if (!s.landed) {
          const p = cellToWorld(s.r, s.c, 0.85);
          tmpM.compose(p, Q_ID, ONE);
          mesh.setMatrixAt(i, tmpM);
          s.landed = true;
          dirty = true;
        }
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/* TRAIL — fixed ring buffer of fading dots behind our vehicle. */
export function createTrail(hex = 0x2b7fff, size = 48) {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1.6, 1.6),
    new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
    size,
  );
  const life = new Float64Array(size);
  const base = new THREE.Color(hex);
  let head = 0;
  for (let i = 0; i < size; i += 1) {
    tmpM.compose(tmpV.set(0, -50, 0), Q_FLAT, ONE);
    mesh.setMatrixAt(i, tmpM);
    mesh.setColorAt(i, tmpC.set(0x000000));
  }
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    setTint(hexNew) { base.set(hexNew); },
    push(x, z) {
      tmpM.compose(tmpV.set(x, 0.12, z), Q_FLAT, ONE);
      mesh.setMatrixAt(head, tmpM);
      life[head] = 1;
      head = (head + 1) % size;
      mesh.instanceMatrix.needsUpdate = true;
    },
    update(dt) {
      let dirty = false;
      for (let i = 0; i < size; i += 1) {
        if (life[i] <= 0) continue;
        life[i] = Math.max(0, life[i] - dt * 0.5);
        tmpC.copy(base).multiplyScalar(life[i] * 0.5);
        mesh.setColorAt(i, tmpC);
        dirty = true;
      }
      if (dirty) mesh.instanceColor.needsUpdate = true;
    },
  };
}

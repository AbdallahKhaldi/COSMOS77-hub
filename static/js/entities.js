/* entities.js — everything that believes or blocks (ARENA V2). Vehicles moved
   to vehicles.js; this file keeps the BELIEF ghost, scent decals, the barrier
   pool (now striped ROADBLOCK barricades dropped across intersections) and the
   trail ring. Pools preallocated to the config's hard caps (49 cells, 14
   barriers); per-frame work is matrix/color writes only. LEGALITY IS THE
   DESIGN: the opponent is never drawn — only THE BELIEF GHOST, a labeled
   hologram of our posterior. Each layer has setPreset("day"|"night") gains so
   it reads on bright asphalt AND in the neon night. */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { cellToWorld, GRID } from "./scene.js";

export const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const ONE = new THREE.Vector3(1, 1, 1);
const Q_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const Q_ID = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);

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

/* orange/white work-zone diagonals for the roadblock barricades */
function barricadeTexture() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#f2f3ef"; ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = "#ff6a00"; ctx.lineWidth = 22;
  for (let x = -64; x < 320; x += 56) {
    ctx.beginPath(); ctx.moveTo(x, 76); ctx.lineTo(x + 76, -12); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* THE BELIEF GHOST — the posterior as a holographic presence.
   fuzzy: diffuse multi-cell shimmer (instanced additive quads, 1 call)
   exact: solid hologram = additive volume + BackSide shell (fresnel-ish rim)
          + soft pulsing ring on the intersection (3 calls)
   always labeled BELIEF (sprite). Day preset boosts every gain so the
   hologram pops against sunlit asphalt; it stays clearly non-physical. */
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
    new THREE.BoxGeometry(6.6, 3.2, 6.6),
    new THREE.MeshBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  volume.position.y = 1.7;
  const shell = new THREE.Mesh( // BackSide shell = cheap fresnel-ish rim
    new THREE.BoxGeometry(7.0, 3.5, 7.0),
    new THREE.MeshBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.2, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  shell.position.y = 1.8;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(3.1, 4.15, 40),
    new THREE.MeshBasicMaterial({
      color: HOLO, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.42;
  const exactGroup = new THREE.Group();
  exactGroup.add(volume, shell, ring);
  exactGroup.visible = false;

  const label = makeLabelSprite("BELIEF", "#7ad7ff");
  label.position.y = 6.2;
  label.center.set(0.5, 0);

  group.add(cloud, exactGroup, label);

  const target = new Float64Array(GRID * GRID);
  const disp = new Float64Array(GRID * GRID);
  let mode = "none"; // none | fuzzy | exact
  let exactRC = null;
  /* per-preset gains: the day city is bright — push the hologram harder */
  let G = { cloudGain: 2.6, cloudMax: 1.8, vol: 0.3, volPulse: 0.1, shell: 0.32, ring: 0.6 };

  return {
    group,
    setPreset(p) {
      G = p === "night"
        ? { cloudGain: 1.8, cloudMax: 1.15, vol: 0.13, volPulse: 0.08, shell: 0.2, ring: 0.4 }
        : { cloudGain: 2.6, cloudMax: 1.8, vol: 0.3, volPulse: 0.1, shell: 0.32, ring: 0.6 };
      shell.material.opacity = G.shell;
    },
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
        const k = shimmerOn ? disp[i] : 0;
        if (k > 0.003) {
          const sh = REDUCED ? 1 : 0.75 + 0.25 * Math.sin(t * 3 + i * 1.7);
          tmpC.set(HOLO).multiplyScalar(Math.min(G.cloudMax, k * G.cloudGain) * sh);
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
        const wave = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(t * 5);
        volume.material.opacity = G.vol - G.volPulse / 2 + G.volPulse * wave;
        ring.material.opacity = G.ring * (REDUCED ? 1 : 0.72 + 0.28 * Math.sin(t * 3));
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
   Tinted by whose trail it is (we perceive the OPPONENT's scent). Day mode
   deepens the tint toward its saturated end and raises the gain so decals
   read on sunlit asphalt (spec: deeper orange, alpha-scaled). */
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
  const base = new THREE.Color(0xff8a1e);
  const eff = new THREE.Color(0xff8a1e);
  let gain = 0.62; // day default
  let day = true;
  let visible = true;

  function retone() {
    eff.copy(base);
    if (day) eff.offsetHSL(-0.015, 0.15, -0.08); // deeper, more saturated
    gain = day ? 0.62 : 0.34;
  }
  retone();

  return {
    mesh,
    setTint(hex) { base.set(hex); retone(); },
    setPreset(p) { day = p !== "night"; retone(); },
    setVisible(v) { visible = v; mesh.visible = v; },
    setTargets(grid49) { for (let i = 0; i < GRID * GRID; i += 1) target[i] = grid49[i]; },
    update(dt) {
      if (!visible) return;
      const chase = Math.min(1, dt * 3);
      for (let i = 0; i < GRID * GRID; i += 1) {
        disp[i] += (target[i] - disp[i]) * chase;
        tmpC.copy(eff).multiplyScalar(Math.min(1, disp[i]) * gain);
        mesh.setColorAt(i, tmpC);
      }
      mesh.instanceColor.needsUpdate = true;
    },
  };
}

/* BARRIER POOL — 14 striped ROADBLOCK barricades (two-bar sawhorse geometry,
   orange/white work-zone stripes) dropped ACROSS the intersection; alternate
   orientation by cell parity. New barriers drop in from the sky; removed set
   hides below ground. attachCones() (kenney prop, optional) scatters traffic
   cones around each landed barricade — silently absent if the glb failed. */
export function createBarrierPool() {
  const MAXB = 14;
  const geos = [];
  const bar = (y) => { const g = new THREE.BoxGeometry(4.6, 0.3, 0.16); g.translate(0, y, 0); geos.push(g); };
  bar(0.64); bar(1.04);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.14, 1.16, 0.14);
      g.translate(sx * 2.08, 0.58, sz * 0.22);
      geos.push(g);
    }
  }
  const mesh = new THREE.InstancedMesh(
    mergeGeometries(geos),
    new THREE.MeshStandardMaterial({ map: barricadeTexture(), roughness: 0.65 }),
    MAXB,
  );
  const yawQ = [new THREE.Quaternion(), new THREE.Quaternion().setFromAxisAngle(AXIS_Y, Math.PI / 2)];
  const slots = []; // {key, r, c, y, vy, landed, q}
  const hidden = new Array(MAXB).fill(true);
  for (let i = 0; i < MAXB; i += 1) {
    tmpM.compose(tmpV.set(0, -50, 0), Q_ID, ONE);
    mesh.setMatrixAt(i, tmpM);
    slots.push(null);
  }
  mesh.instanceMatrix.needsUpdate = true;

  /* optional kenney cones: 3 per barricade, deterministic local offsets */
  let cones = null;
  const CONE_OFF = [[-1.75, 0.85], [1.6, -0.75], [0.35, 1.4]];
  const CONE_SCALE = new THREE.Vector3(1.6, 1.6, 1.6);

  function writeSlot(i, x, y, z, q) {
    tmpM.compose(tmpV.set(x, y, z), q, ONE);
    mesh.setMatrixAt(i, tmpM);
    if (cones) {
      const flip = q === yawQ[1];
      for (let k = 0; k < 3; k += 1) {
        const [ox, oz] = CONE_OFF[k];
        const wx = flip ? oz : ox, wz = flip ? ox : oz;
        tmpM.compose(tmpV.set(x + wx, y, z + wz), Q_ID, CONE_SCALE);
        cones.setMatrixAt(i * 3 + k, tmpM);
      }
      cones.instanceMatrix.needsUpdate = true;
    }
  }

  function hideSlot(i) {
    tmpM.compose(tmpV.set(0, -50, 0), Q_ID, ONE);
    mesh.setMatrixAt(i, tmpM);
    if (cones) {
      for (let k = 0; k < 3; k += 1) cones.setMatrixAt(i * 3 + k, tmpM);
      cones.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    mesh,
    attachCones(geometry, material) {
      if (cones || !geometry) return;
      cones = new THREE.InstancedMesh(geometry, material, MAXB * 3);
      for (let i = 0; i < MAXB * 3; i += 1) {
        tmpM.compose(tmpV.set(0, -50, 0), Q_ID, ONE);
        cones.setMatrixAt(i, tmpM);
      }
      cones.instanceMatrix.needsUpdate = true;
      mesh.add(cones); // barricade pool sits at the origin, so local == world
    },
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
        slots[idx] = { key, r, c, y: REDUCED ? 0 : 22, vy: 0, q: yawQ[(r + c) % 2] };
      }
    },
    reset() { for (let i = 0; i < MAXB; i += 1) slots[i] = null; },
    update(dt) {
      let dirty = false;
      for (let i = 0; i < MAXB; i += 1) {
        const s = slots[i];
        if (!s) {
          if (!hidden[i]) { hideSlot(i); hidden[i] = true; dirty = true; }
          continue;
        }
        hidden[i] = false;
        if (s.y > 0) {
          s.vy += 60 * dt;
          s.y = Math.max(0, s.y - s.vy * dt);
          const p = cellToWorld(s.r, s.c, s.y);
          writeSlot(i, p.x, s.y, p.z, s.q);
          dirty = true;
        } else if (!s.landed) {
          const p = cellToWorld(s.r, s.c, 0);
          writeSlot(i, p.x, 0, p.z, s.q);
          s.landed = true;
          dirty = true;
        }
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

/* TRAIL — fixed ring buffer of fading dots behind our vehicle. Day preset
   raises the gain so the additive dots survive sunlit asphalt. */
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
  let gain = 0.8; // day default; night drops to the v1 0.5
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
    setPreset(p) { gain = p === "night" ? 0.5 : 0.8; },
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
        tmpC.copy(base).multiplyScalar(life[i] * gain);
        mesh.setColorAt(i, tmpC);
        dirty = true;
      }
      if (dirty) mesh.instanceColor.needsUpdate = true;
    },
  };
}

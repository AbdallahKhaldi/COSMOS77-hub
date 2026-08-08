/* scene.js — the night-NYC arena (config map_area is literally "New York").
   Recon scene_recipe implemented verbatim: merged/instanced everything,
   fixed 4-light rig (never light-count churn), FogExp2, wet-asphalt trick,
   half-res UnrealBloom + OutputPass, DPR clamp, ?q=low|med|high tiers.
   Draw-call ledger target ~33 — check with arena.info(). */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export const CELL = 10;
export const GRID = 7;
const HALF = (GRID - 1) / 2; // 3

export function cellToWorld(r, c, y = 0) {
  return new THREE.Vector3((c - HALF) * CELL, y, (r - HALF) * CELL);
}

/* deterministic skyline — every viewer sees the same city */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const QUALITY = {
  low: { dpr: 1.0, bloom: false, shadows: false },
  med: { dpr: 1.5, bloom: true, shadows: false },
  high: { dpr: 1.75, bloom: true, shadows: true },
};

export function qualityFromQuery() {
  const q = new URLSearchParams(location.search).get("q");
  return QUALITY[q] ? q : "med";
}

function noiseCanvas(size, rng) {
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(size, size);
  // blotchy value noise: coarse random grid, bilinear-ish smoothing via two passes
  const coarse = 16, cell = size / coarse, vals = [];
  for (let i = 0; i < (coarse + 1) * (coarse + 1); i += 1) vals.push(rng());
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      const fx = (x / cell) - gx, fy = (y / cell) - gy;
      const v00 = vals[gy * (coarse + 1) + gx], v10 = vals[gy * (coarse + 1) + gx + 1];
      const v01 = vals[(gy + 1) * (coarse + 1) + gx], v11 = vals[(gy + 1) * (coarse + 1) + gx + 1];
      const v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      const g = Math.round(90 + v * 150); // wet(dark, smooth) .. dry(light, rough)
      const i = (y * size + x) * 4;
      img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function radialGlowCanvas(size) {
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,220,160,0.85)");
  g.addColorStop(0.4, "rgba(255,200,120,0.28)");
  g.addColorStop(1, "rgba(255,190,100,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  return cv;
}

/* street center between column c and c+1 (same math on rows) */
const streetCenter = (i) => (i - HALF) * CELL + CELL / 2;

export function createArena(container, { quality = "med" } = {}) {
  const tier = QUALITY[quality] || QUALITY.med;
  const rng = mulberry32(770077);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = tier.shadows;
  if (tier.shadows) renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070f);
  scene.fog = new THREE.FogExp2(0x0a0d1a, 0.008);

  const camera = new THREE.PerspectiveCamera(40, 16 / 10, 0.5, 600);
  camera.position.set(0, 95, 55);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 40;
  controls.maxDistance = 160;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.25;

  /* ---- fixed light rig: exactly 4 lights + entities' cruiser point ---- */
  scene.add(new THREE.HemisphereLight(0x2b3a67, 0x0b0d12, 0.9));
  const moon = new THREE.DirectionalLight(0x8fb4ff, 0.55);
  moon.position.set(-70, 120, -40);
  if (tier.shadows) {
    moon.castShadow = true;
    moon.shadow.mapSize.set(1024, 1024);
    const f = 60;
    moon.shadow.camera.left = -f; moon.shadow.camera.right = f;
    moon.shadow.camera.top = f; moon.shadow.camera.bottom = -f;
    moon.shadow.camera.far = 320;
  }
  scene.add(moon);
  const hero1 = new THREE.PointLight(0xffb46b, tier.bloom ? 60 : 40, 60, 2);
  hero1.position.set(-38, 9, -38);
  const hero2 = new THREE.PointLight(0x6bffea, tier.bloom ? 45 : 30, 55, 2);
  hero2.position.set(40, 8, 40);
  scene.add(hero1, hero2);

  /* ---- ground: wet asphalt ---- */
  const roughTex = new THREE.CanvasTexture(noiseCanvas(512, rng));
  roughTex.wrapS = roughTex.wrapT = THREE.RepeatWrapping;
  roughTex.repeat.set(8, 8);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 700),
    new THREE.MeshStandardMaterial({ color: 0x0b0d12, metalness: 0.75, roughness: 0.35, roughnessMap: roughTex }),
  );
  ground.rotation.x = -Math.PI / 2;
  if (tier.shadows) ground.receiveShadow = true;
  scene.add(ground);

  /* ---- 49 slabs merged -> 1 draw call ---- */
  const slabGeos = [];
  for (let r = 0; r < GRID; r += 1) {
    for (let c = 0; c < GRID; c += 1) {
      const g = new THREE.BoxGeometry(8, 0.25, 8);
      const p = cellToWorld(r, c, 0.125);
      g.translate(p.x, p.y, p.z);
      slabGeos.push(g);
    }
  }
  scene.add(new THREE.Mesh(mergeGeometries(slabGeos), new THREE.MeshStandardMaterial({ color: 0x1a1e29, roughness: 0.8 })));

  /* ---- curb glow strips merged -> 1 draw call ---- */
  const curbGeos = [];
  const strip = (x, z, lenX, lenZ) => {
    const g = new THREE.BoxGeometry(lenX, 0.12, lenZ);
    g.translate(x, 0.31, z);
    curbGeos.push(g);
  };
  const SPAN = GRID * CELL + 2;
  for (let i = 0; i < GRID - 1; i += 1) {
    const s = streetCenter(i);
    strip(s - 1, 0, 0.22, SPAN); strip(s + 1, 0, 0.22, SPAN);   // vertical street edges
    strip(0, s - 1, SPAN, 0.22); strip(0, s + 1, SPAN, 0.22);   // horizontal street edges
  }
  const EDGE = HALF * CELL + 4.6;
  strip(-EDGE, 0, 0.22, SPAN); strip(EDGE, 0, 0.22, SPAN);
  strip(0, -EDGE, SPAN, 0.22); strip(0, EDGE, SPAN, 0.22);
  scene.add(new THREE.Mesh(mergeGeometries(curbGeos), new THREE.MeshBasicMaterial({ color: 0x2a3160 })));

  /* ---- lane dashes -> 1 instanced draw call ---- */
  const DASHES_PER = 30;
  const dashCount = (GRID - 1) * 2 * DASHES_PER;
  const dashes = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.18, 1.2),
    new THREE.MeshBasicMaterial({ color: 0x39406b }),
    dashCount,
  );
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const qTurn = new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 2).multiply(qFlat);
    let i = 0;
    for (let s = 0; s < GRID - 1; s += 1) {
      const sc = streetCenter(s);
      for (let d = 0; d < DASHES_PER; d += 1) {
        const t = -SPAN / 2 + (d + 0.5) * (SPAN / DASHES_PER);
        m.compose(new THREE.Vector3(sc, 0.02, t), qFlat, new THREE.Vector3(1, 1, 1));
        dashes.setMatrixAt(i, m); i += 1;
        m.compose(new THREE.Vector3(t, 0.02, sc), qTurn, new THREE.Vector3(1, 1, 1));
        dashes.setMatrixAt(i, m); i += 1;
      }
      // consumes 2*DASHES_PER per street pair — loop bound matches count
      if (i >= dashCount) break;
    }
    dashes.count = i;
  }
  scene.add(dashes);

  /* ---- cell overlay: ALL board-state tinting in 1 draw call ---- */
  const overlay = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(8.6, 8.6),
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1 }),
    GRID * GRID,
  );
  {
    const m = new THREE.Matrix4();
    const qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (let r = 0; r < GRID; r += 1) {
      for (let c = 0; c < GRID; c += 1) {
        const p = cellToWorld(r, c, 0.28);
        m.compose(p, qFlat, new THREE.Vector3(1, 1, 1));
        overlay.setMatrixAt(r * GRID + c, m);
        overlay.setColorAt(r * GRID + c, new THREE.Color(0x000000));
      }
    }
    overlay.instanceMatrix.needsUpdate = true;
  }
  scene.add(overlay);
  const overlayApi = {
    /* additive layer: black = invisible; write RGB scaled by intensity */
    tmp: new THREE.Color(),
    set(r, c, hex, k = 1) {
      this.tmp.set(hex).multiplyScalar(k);
      overlay.setColorAt(r * GRID + c, this.tmp);
    },
    clear() {
      this.tmp.set(0x000000);
      for (let i = 0; i < GRID * GRID; i += 1) overlay.setColorAt(i, this.tmp);
    },
    commit() { overlay.instanceColor.needsUpdate = true; },
  };

  /* ---- building ring (outside the board) -> 1 instanced draw call ---- */
  const B_COUNT = 220;
  const buildings = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x232a3d, roughness: 0.85, emissive: 0x10162a, emissiveIntensity: 0.7 }),
    B_COUNT,
  );
  const towers = []; // remembered for window placement
  {
    const m = new THREE.Matrix4(), qId = new THREE.Quaternion(), col = new THREE.Color();
    let placed = 0, guard = 0;
    while (placed < B_COUNT && guard < 4000) {
      guard += 1;
      const x = (rng() * 2 - 1) * 115, z = (rng() * 2 - 1) * 115;
      const d = Math.max(Math.abs(x), Math.abs(z));
      if (d < 44 || d > 112) continue;
      const w = 4 + rng() * 5, dep = 4 + rng() * 5;
      const h = 6 + ((d - 44) / 68) * (rng() * 34);
      m.compose(new THREE.Vector3(x, h / 2, z), qId, new THREE.Vector3(w, h, dep));
      buildings.setMatrixAt(placed, m);
      col.setHSL(0.62 + rng() * 0.06, 0.3, 0.5 + rng() * 0.35);
      buildings.setColorAt(placed, col);
      towers.push({ x, z, w, d: dep, h });
      placed += 1;
    }
    buildings.count = placed;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
  }
  if (tier.shadows) buildings.castShadow = true;
  scene.add(buildings);

  /* ---- neon windows -> 1 instanced draw call (bloom feeds on these) ---- */
  const PALETTE = [0xffc46b, 0x9fd8ff, 0xff6ba8, 0x6bffea];
  const W_MAX = 1200;
  const windows = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.7, 0.5),
    new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide }),
    W_MAX,
  );
  {
    const m = new THREE.Matrix4(), col = new THREE.Color(), one = new THREE.Vector3(1, 1, 1);
    const qPX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const qNX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const qPZ = new THREE.Quaternion();
    const qNZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    let i = 0;
    for (const t of towers) {
      if (i >= W_MAX) break;
      // facade facing the board = facing origin along the dominant axis
      const px = Math.abs(t.x) > Math.abs(t.z);
      const sign = px ? Math.sign(t.x) : Math.sign(t.z);
      const rows = Math.max(2, Math.floor(t.h / 2.2));
      const cols = Math.max(2, Math.floor((px ? t.d : t.w) / 1.6));
      for (let ry = 0; ry < rows && i < W_MAX; ry += 1) {
        for (let cx = 0; cx < cols && i < W_MAX; cx += 1) {
          if (rng() < 0.55) continue; // ~half the slots stay dark
          const y = 1.2 + ry * (t.h - 2) / rows;
          const off = -((px ? t.d : t.w) / 2) + (cx + 0.5) * ((px ? t.d : t.w) / cols);
          let pos, q;
          if (px) {
            pos = new THREE.Vector3(t.x - sign * (t.w / 2 + 0.03), y, t.z + off);
            q = sign > 0 ? qNX : qPX;
          } else {
            pos = new THREE.Vector3(t.x + off, y, t.z - sign * (t.d / 2 + 0.03));
            q = sign > 0 ? qNZ : qPZ;
          }
          m.compose(pos, q, one);
          windows.setMatrixAt(i, m);
          col.set(PALETTE[Math.floor(rng() * PALETTE.length)]).multiplyScalar(1.5 + rng() * 2.0);
          windows.setColorAt(i, col);
          i += 1;
        }
      }
    }
    windows.count = i;
  }
  scene.add(windows);

  /* ---- hero neon signs (~8 draw calls, 2 flicker) ---- */
  const signs = [];
  {
    const SIGN_COLS = [0xff2e88, 0xffd400, 0x6bffea, 0x9fd8ff, 0xff6ba8, 0xffc46b, 0x2b7fff, 0xff8a1e];
    for (let k = 0; k < 8; k += 1) {
      const t = towers[Math.floor(rng() * towers.length)];
      if (!t) continue;
      const px = Math.abs(t.x) > Math.abs(t.z);
      const sign = px ? Math.sign(t.x) : Math.sign(t.z);
      const wdt = 2.5 + rng() * 4, hgt = 1 + rng() * 2.2;
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(SIGN_COLS[k]).multiplyScalar(2.5 + rng() * 1.5), toneMapped: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wdt, hgt), mat);
      const y = Math.min(t.h - 1, 4 + rng() * (t.h - 4));
      if (px) {
        mesh.position.set(t.x - sign * (t.w / 2 + 0.06), y, t.z);
        mesh.rotation.y = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        mesh.position.set(t.x, y, t.z - sign * (t.d / 2 + 0.06));
        mesh.rotation.y = sign > 0 ? Math.PI : 0;
      }
      mesh.userData.flicker = k < 2; // at most 2 flicker
      mesh.userData.base = mat.color.clone();
      mesh.userData.seed = Math.floor(rng() * 1e6);
      scene.add(mesh);
      signs.push(mesh);
    }
  }

  /* ---- streetlights: merged poles + instanced heads + instanced pools ---- */
  const corners = [];
  for (let i = 0; i < GRID - 1; i += 1) {
    for (let j = 0; j < GRID - 1; j += 1) {
      if ((i + j) % 2 === 0 || rng() < 0.15) corners.push([streetCenter(j) + 0.7, streetCenter(i) + 0.7]);
    }
  }
  {
    const poleGeos = [];
    for (const [x, z] of corners) {
      const g = new THREE.CylinderGeometry(0.06, 0.08, 3.5, 6);
      g.translate(x, 1.75, z);
      poleGeos.push(g);
    }
    scene.add(new THREE.Mesh(mergeGeometries(poleGeos), new THREE.MeshStandardMaterial({ color: 0x1a1d26, roughness: 0.6, metalness: 0.4 })));
    const heads = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.14, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false }),
      corners.length,
    );
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(radialGlowCanvas(128)),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
      corners.length,
    );
    const m = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), qId = new THREE.Quaternion();
    const qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    corners.forEach(([x, z], i) => {
      m.compose(new THREE.Vector3(x, 3.55, z), qId, one);
      heads.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(x, 0.05, z), qFlat, one);
      pools.setMatrixAt(i, m);
    });
    scene.add(heads, pools);
  }

  /* ---- composer: half-res bloom + OutputPass (med/high); raw render on low ---- */
  let composer = null;
  let bloomPass = null;
  if (tier.bloom) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(container.clientWidth / 2, container.clientHeight / 2), 0.55, 0.35, 0.85);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
  }

  function resize() {
    const w = container.clientWidth || 640, h = container.clientHeight || 400;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.resolution.set(w / 2, h / 2);
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  let elapsed = 0;
  function render(dt) {
    elapsed += dt;
    for (const s of signs) {
      if (!s.userData.flicker) continue;
      const on = (Math.sin(elapsed * 9 + s.userData.seed) + Math.sin(elapsed * 23.7 + s.userData.seed * 2)) > -0.6;
      s.material.color.copy(s.userData.base).multiplyScalar(on ? 1 : 0.12);
    }
    controls.update();
    if (composer) composer.render(); else renderer.render(scene, camera);
  }

  return {
    THREE, scene, camera, renderer, controls, composer,
    overlay: overlayApi,
    cellToWorld,
    tier: quality,
    render, resize,
    info: () => renderer.info.render,
    dispose() { ro.disconnect(); renderer.dispose(); },
  };
}

/* world.js — the board IS a city district (ARENA V3). The 7×7 cells are road
   intersections, agents drive ON the road grid, and the 36 spaces between the
   roads are real blocks: low-rise buildings, parks, parking lots. The tall
   skyline stays OUTSIDE the board.

   Determinism: ONE seeded rng builds a PLAN first (every roll happens at plan
   time, in fixed order, regardless of quality tier or preset) — realization
   consumes no randomness. So every viewer sees the same city, and the plan can
   be re-realized later with Kenney glb geometry (upgrade()) without touching
   the rng stream. V3's dressing (street wear, billboards, steam vents) rolls
   on a SECOND seeded stream (rngDetail) so the V2 block plan is bit-identical.

   Draw-call ledger (day, kenney-upgraded): ground 1, road 1, slabs 1, grass 1,
   lots 1, trees 3, interior bake 1, outer-ring bake 1, parked bake 1, poles 1,
   heads 1, posts 1, plates 1, hydrants 1, billboards 1 ≈ 17 world calls. Night
   adds windows, pools, 3 sign meshes, steam 1. Procedural fallback trades the
   3 bakes for ~7 calls. */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const HCAP = 4.3;         // interior blocks are height-capped: chase cam (+4.6) clears
const SLAB_TOP = 0.16;    // sidewalk slab height
const ROAD_Y = 0.06;

/* BoxGeometry re-grouped to 2 materials: [0]=4 sides (facade), [1]=top+bottom */
function twoGroupBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const idx = g.index.array;
  const order = [0, 1, 4, 5, 2, 3]; // px,nx,pz,nz,py,ny
  const out = new Uint16Array(36);
  order.forEach((f, i) => out.set(idx.slice(f * 6, f * 6 + 6), i * 6));
  g.setIndex(new THREE.BufferAttribute(out, 1));
  g.clearGroups();
  g.addGroup(0, 24, 0);
  g.addGroup(24, 12, 1);
  g.translate(0, 0.5, 0); // pivot at ground center
  return g;
}

/* ------------------------------- canvases ------------------------------- */

function speckle(ctx, rng, px, n, dark, light) {
  for (let i = 0; i < n; i += 1) {
    const w = 1 + rng() * 2.5;
    ctx.fillStyle = rng() < 0.5 ? dark : light;
    ctx.fillRect(rng() * px, rng() * px, w, w * (0.5 + rng()));
  }
}

function concreteCanvas(rng) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#98948a"; ctx.fillRect(0, 0, 256, 256); // warm concrete, not blinding
  speckle(ctx, rng, 256, 700, "rgba(88,86,78,0.28)", "rgba(186,182,172,0.30)");
  // V3: subtle paver grid — fixed spacing, no rng (the plan stream is sacred)
  ctx.fillStyle = "rgba(70,68,62,0.16)";
  for (let k = 32; k < 256; k += 32) { ctx.fillRect(k, 0, 1, 256); ctx.fillRect(0, k, 256, 1); }
  ctx.fillStyle = "rgba(60,58,52,0.2)";
  ctx.fillRect(128, 0, 1, 256); ctx.fillRect(0, 128, 256, 1);
  return cv;
}

/* bright-biased noise for roughnessMap jitter (green channel is what counts):
   average ≈ 0.85 so materials keep their base feel, speckled ±0.12 */
function roughNoiseCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#d9d9d9"; ctx.fillRect(0, 0, 128, 128);
  let s = 770079 >>> 0; // tiny local LCG — NOT the plan stream
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 420; i += 1) {
    const w = 1 + r() * 3;
    ctx.fillStyle = r() < 0.5 ? "rgba(178,178,178,0.5)" : "rgba(238,238,238,0.5)";
    ctx.fillRect(r() * 128, r() * 128, w, w * (0.5 + r()));
  }
  return cv;
}

function grassCanvas(rng) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#557a3c"; ctx.fillRect(0, 0, 128, 128);
  speckle(ctx, rng, 128, 500, "rgba(52,86,36,0.5)", "rgba(122,158,84,0.45)");
  return cv;
}

function lotCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#6b6e73"; ctx.fillRect(0, 0, 256, 256); // asphalt
  ctx.fillStyle = "rgba(238,240,234,0.85)";
  // two rows of stalls, aisle in the middle (256px = 5.2 world units)
  for (let k = 0; k < 4; k += 1) {
    const x = 20 + k * 58;
    ctx.fillRect(x, 8, 5, 92);
    ctx.fillRect(x, 156, 5, 92);
  }
  ctx.fillRect(20, 8, 178, 5);
  ctx.fillRect(20, 243, 178, 5);
  return cv;
}

function stopCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  const r = 60, cx = 64, cy = 64;
  for (let i = 0; i < 8; i += 1) {
    const a = (Math.PI / 8) + i * (Math.PI / 4);
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#f2f3ef"; ctx.lineWidth = 6; ctx.stroke();
  ctx.fillStyle = "#f2f3ef"; ctx.font = "700 34px 'Chakra Petch', sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("STOP", 64, 66);
  return cv;
}

function glowCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, "rgba(255,220,160,0.85)");
  g.addColorStop(0.4, "rgba(255,200,120,0.28)");
  g.addColorStop(1, "rgba(255,190,100,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return cv;
}

function facadeCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#d9d2c4"; ctx.fillRect(0, 0, 256, 256);
  for (let ry = 0; ry < 3; ry += 1) {
    for (let cx = 0; cx < 4; cx += 1) {
      const x = 18 + cx * 60, y = 22 + ry * 82;
      ctx.fillStyle = "#3a4048"; ctx.fillRect(x, y, 42, 52);          // inset window
      ctx.fillStyle = "rgba(150,180,205,0.5)"; ctx.fillRect(x + 3, y + 3, 36, 20); // sky glint
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x, y + 49, 42, 3);          // sill shadow
    }
  }
  ctx.fillStyle = "rgba(0,0,0,0.16)"; ctx.fillRect(0, 246, 256, 10);  // base line
  return cv;
}

function towerCanvas() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#b6b2a8"; ctx.fillRect(0, 0, 256, 256);
  for (let cx = 0; cx < 5; cx += 1) {
    ctx.fillStyle = "#76899b";
    ctx.fillRect(14 + cx * 48, 0, 26, 256); // vertical glass bands
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(16 + cx * 48, 0, 6, 256);
  }
  for (let ry = 0; ry < 16; ry += 1) {
    ctx.fillStyle = "rgba(40,44,52,0.35)";
    ctx.fillRect(0, ry * 16, 256, 3); // floor lines
  }
  return cv;
}

/* the whole ground-marking layer, painted once: asphalt grain + white dashed
   center lines + solid edge lines + stop lines + zebra crosswalks at every
   intersection. V3 adds WEAR from the detail stream (rng2): faded crosswalk
   stripes, manhole covers, oil stains — all in this one canvas, zero extra
   draw calls. One 68×68-world-unit plane, one draw call. */
function roadCanvas(rng, roads, rng2) {
  const PX = 1536, W = 68, S = PX / W;
  const u = (v) => (v + W / 2) * S;
  const cv = document.createElement("canvas");
  cv.width = cv.height = PX;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#63666b"; ctx.fillRect(0, 0, PX, PX);
  speckle(ctx, rng, PX, 2600, "rgba(40,42,46,0.35)", "rgba(126,130,136,0.30)");
  const base = document.createElement("canvas"); // grain snapshot for "erasing"
  base.width = base.height = PX;
  base.getContext("2d").drawImage(cv, 0, 0);

  const rect = (x, z, w, h) => ctx.fillRect(u(x), u(z), w * S, h * S);
  ctx.fillStyle = "rgba(238,240,234,0.92)";
  for (const c of roads) {
    // vertical road at x=c: solid edge lines + dashed center, full length
    rect(c - 1.94, -32, 0.12, 64); rect(c + 1.82, -32, 0.12, 64);
    for (let z = -32; z < 32; z += 2.0) rect(c - 0.09, z, 0.18, 1.0);
    // horizontal road at z=c
    rect(-32, c - 1.94, 64, 0.12); rect(-32, c + 1.82, 64, 0.12);
    for (let x = -32; x < 32; x += 2.0) rect(x, c - 0.09, 1.0, 0.18);
  }
  // clear every intersection zone back to raw asphalt (crisp grain restore)
  for (const cx of roads) {
    for (const cz of roads) {
      ctx.drawImage(base, u(cx - 3.15), u(cz - 3.15), 6.3 * S, 6.3 * S,
        u(cx - 3.15), u(cz - 3.15), 6.3 * S, 6.3 * S);
    }
  }
  // zebra crosswalks (4 approaches) + stop lines at every intersection
  for (const cx of roads) {
    for (const cz of roads) {
      ctx.fillStyle = "rgba(238,240,234,0.92)";
      for (let k = 0; k < 6; k += 1) {
        const o = -1.7 + k * 0.62;
        rect(cx + o, cz + 2.15, 0.31, 0.9); rect(cx + o, cz - 3.05, 0.31, 0.9);
        rect(cx + 2.15, cz + o, 0.9, 0.31); rect(cx - 3.05, cz + o, 0.9, 0.31);
      }
      ctx.fillStyle = "rgba(238,240,234,0.85)";
      rect(cx - 1.9, cz + 3.22, 3.8, 0.26); rect(cx - 1.9, cz - 3.48, 3.8, 0.26);
      rect(cx + 3.22, cz - 1.9, 0.26, 3.8); rect(cx - 3.48, cz - 1.9, 0.26, 3.8);
    }
  }

  /* ------------------------- V3 wear (detail stream) ---------------------- */
  // crosswalk fade variation: some approaches half-erased back to grain
  for (const cx of roads) {
    for (const cz of roads) {
      const zones = [
        [cx - 1.75, cz + 2.15, 3.85, 0.95], [cx - 1.75, cz - 3.1, 3.85, 0.95],
        [cx + 2.15, cz - 1.75, 0.95, 3.85], [cx - 3.1, cz - 1.75, 0.95, 3.85],
      ];
      for (const [zx, zz, zw, zh] of zones) {
        if (rng2() < 0.45) {
          ctx.globalAlpha = 0.22 + rng2() * 0.34;
          ctx.drawImage(base, u(zx), u(zz), zw * S, zh * S, u(zx), u(zz), zw * S, zh * S);
          ctx.globalAlpha = 1;
        }
      }
    }
  }
  // manhole covers: dark disc + rim + pick-slots, offset into the lanes
  for (const cx of roads) {
    for (const cz of roads) {
      if (rng2() >= 0.4) continue;
      const mx = u(cx + (rng2() < 0.5 ? -1.15 : 1.15));
      const mz = u(cz + (rng2() < 0.5 ? -1.15 : 1.15));
      const mr = 0.42 * S;
      ctx.fillStyle = "#54565a";
      ctx.beginPath(); ctx.arc(mx, mz, mr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(30,32,35,0.85)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(mx, mz, mr, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "rgba(38,40,44,0.7)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(mx, mz, mr * 0.62, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mx - mr * 0.4, mz); ctx.lineTo(mx + mr * 0.4, mz); ctx.stroke();
    }
  }
  // oil stains: soft dark blobs strung along the road lanes
  for (let i = 0; i < 26; i += 1) {
    const along = (rng2() * 2 - 1) * 31;
    const lane = roads[Math.floor(rng2() * roads.length)] + (rng2() < 0.5 ? -1.0 : 1.0);
    const [ox, oz] = rng2() < 0.5 ? [along, lane] : [lane, along];
    const orad = (0.5 + rng2() * 0.9) * S;
    const g2 = ctx.createRadialGradient(u(ox), u(oz), orad * 0.1, u(ox), u(oz), orad);
    g2.addColorStop(0, "rgba(22,22,26," + (0.22 + rng2() * 0.16).toFixed(2) + ")");
    g2.addColorStop(1, "rgba(22,22,26,0)");
    ctx.fillStyle = g2;
    ctx.fillRect(u(ox) - orad, u(oz) - orad, orad * 2, orad * 2);
  }
  return cv;
}

/* ================================ WORLD ================================= */

export function createWorld({ scene, tier, rng, rngDetail = null, maxAniso = 4, CELL, GRID, cellToWorld }) {
  const rng2 = rngDetail || (() => 0.5); // detail stream (V3 dressing only)
  const HALF = (GRID - 1) / 2;
  const roads = [];
  for (let i = 0; i < GRID; i += 1) roads.push((i - HALF) * CELL);
  const blockC = [];
  for (let i = 0; i < GRID - 1; i += 1) blockC.push((i - HALF) * CELL + CELL / 2);

  const disposables = [];
  const track = (m) => { disposables.push(m); return m; };
  const presetMats = []; // {mat, day, night} — color swapped per preset

  const tex = (canvas, aniso) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    if (aniso) t.anisotropy = maxAniso;
    return t;
  };

  /* ---------- textures (rng order fixed: road, concrete, grass;
                the rng2 detail stream starts inside roadCanvas) ---------- */
  const roadTex = tex(roadCanvas(rng, roads, rng2), true);
  const concreteCv = concreteCanvas(rng);
  const concreteTex = tex(concreteCv, true);
  const grassTex = tex(grassCanvas(rng));
  const lotTex = tex(lotCanvas());
  const stopTex = tex(stopCanvas());
  const glowTex = new THREE.CanvasTexture(glowCanvas());
  const facadeTex = tex(facadeCanvas());
  const towerTex = tex(towerCanvas());
  const roughTex = new THREE.CanvasTexture(roughNoiseCanvas()); // linear (non-color) data

  /* ------------------------------- the PLAN ------------------------------ */
  const plan = { blocks: [], towers: [], corners: [], posts: [], hydrants: [], spots: [] };
  for (let bi = 0; bi < GRID - 1; bi += 1) {
    for (let bj = 0; bj < GRID - 1; bj += 1) {
      const cx = blockC[bj], cz = blockC[bi];
      const roll = rng();
      const b = { cx, cz, type: roll < 0.2 ? "park" : roll < 0.38 ? "lot" : "build" };
      if (b.type === "build") {
        b.buildings = [];
        const two = rng() < 0.45;
        const mk = (x, z, w, d) => b.buildings.push({
          x, z, w, d,
          floors: 1 + Math.floor(rng() * 3),
          yaw: Math.floor(rng() * 4) * (Math.PI / 2),
          tintRoll: rng(), typeRoll: rng(),
          acN: Math.floor(rng() * 3), acR: [rng(), rng()],
          awn: rng() < 0.55, awnC: Math.floor(rng() * 4),
        });
        if (two) {
          const horiz = rng() < 0.5;
          const w = 1.9 + rng() * 0.4, d = 3.4 + rng() * 0.9;
          if (horiz) { mk(cx - 1.16, cz, w, d); mk(cx + 1.16, cz, 1.9 + rng() * 0.4, 3.4 + rng() * 0.9); }
          else { mk(cx, cz - 1.16, d, w); mk(cx, cz + 1.16, 3.4 + rng() * 0.9, 1.9 + rng() * 0.4); }
        } else {
          mk(cx + (rng() - 0.5) * 0.7, cz + (rng() - 0.5) * 0.7, 3.0 + rng() * 1.4, 3.0 + rng() * 1.4);
        }
        for (const bd of b.buildings) bd.h = Math.min(HCAP, bd.floors * 1.3 + 0.15);
      } else if (b.type === "park") {
        b.tintRoll = rng();
        b.trees = [];
        const n = 2 + Math.floor(rng() * 3);
        for (let t = 0; t < n; t += 1) {
          b.trees.push({ x: cx + (rng() * 2 - 1) * 1.8, z: cz + (rng() * 2 - 1) * 1.8, cone: rng() < 0.5, s: 0.85 + rng() * 0.35 });
        }
      } else {
        b.yaw = rng() < 0.5 ? 0 : Math.PI / 2;
        const slots = [[-1.25, -1.05], [1.25, -1.05], [-1.25, 1.05], [1.25, 1.05]];
        const n = 1 + (rng() < 0.6 ? 1 : 0);
        const pick = Math.floor(rng() * 4);
        for (let k = 0; k < n; k += 1) {
          const s = slots[(pick + k * 2) % 4];
          const rot = b.yaw + Math.PI / 2; // cars sit across the aisle
          const px = b.yaw === 0 ? s[0] : s[1];
          const pz = b.yaw === 0 ? s[1] : s[0];
          plan.spots.push({ x: cx + px, z: cz + pz, yaw: rot, y: SLAB_TOP, typeRoll: rng(), tintRoll: rng() });
        }
      }
      plan.blocks.push(b);
    }
  }
  { // outer skyline ring: 2–3 deep, taller with distance
    let placed = 0, guard = 0;
    while (placed < 150 && guard < 4000) {
      guard += 1;
      const x = (rng() * 2 - 1) * 115, z = (rng() * 2 - 1) * 115;
      const d = Math.max(Math.abs(x), Math.abs(z));
      if (d < 42 || d > 110) continue;
      const w = 4.5 + rng() * 5, dep = 4.5 + rng() * 5;
      const h = 7 + ((d - 42) / 68) * (6 + rng() * 34);
      plan.towers.push({ x, z, w, d: dep, h, band: d < 74 ? "near" : "far", typeRoll: rng(), hue: rng(), lit: rng() });
      placed += 1;
    }
  }
  { // streetlights at a seeded subset of intersection corners
    for (let r = 0; r < GRID; r += 1) {
      for (let c = 0; c < GRID; c += 1) {
        if ((r + c) % 2 === 0 || rng() < 0.15) {
          const p = cellToWorld(r, c, 0);
          plan.corners.push([p.x + 2.55, p.z + 2.55]);
        }
      }
    }
    // stop-sign posts at a seeded subset
    for (let r = 0; r < GRID; r += 1) {
      for (let c = 0; c < GRID; c += 1) {
        if (rng() < 0.2 && plan.posts.length < 12) {
          const p = cellToWorld(r, c, 0);
          plan.posts.push({ x: p.x - 2.55, z: p.z + 2.55, yaw: Math.floor(rng() * 4) * (Math.PI / 2) });
        }
      }
    }
    // hydrants on sidewalk corners
    for (const b of plan.blocks) {
      if (rng() < 0.3 && plan.hydrants.length < 16) {
        const sx = rng() < 0.5 ? -2.55 : 2.55, sz = rng() < 0.5 ? -2.55 : 2.55;
        plan.hydrants.push([b.cx + sx, b.cz + sz]);
      }
    }
    // parked cars along the outer streets
    for (let t = -27; t <= 27; t += 6.5) {
      for (const side of [-1, 1]) {
        if (rng() < 0.55) plan.spots.push({ x: t + (rng() - 0.5), z: side * 33.6, yaw: side > 0 ? 0 : Math.PI, y: 0.02, typeRoll: rng(), tintRoll: rng() });
        if (rng() < 0.55) plan.spots.push({ x: side * 33.6, z: t + (rng() - 0.5), yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2, y: 0.02, typeRoll: rng(), tintRoll: rng() });
      }
    }
  }

  /* camera-collision boxes: one conservative AABB per built block. Top sits
     BELOW the 4.6 chase height (buildings max out at 4.05+roof clutter), so
     level chase flight never triggers the pullback — only real dips do. */
  const blockBoxes = [];
  for (const b of plan.blocks) {
    if (b.type === "build") {
      blockBoxes.push(new THREE.Box3(
        new THREE.Vector3(b.cx - 3.2, 0, b.cz - 3.2),
        new THREE.Vector3(b.cx + 3.2, HCAP + 0.1, b.cz + 3.2),
      ));
    }
  }

  /* ----------------------------- realization ----------------------------- */
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();
  const tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  const UP = new THREE.Vector3(0, 1, 0);
  const QF = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const shadows = !!tier.shadows;

  // ground far beyond the district
  const groundRough = tex(concreteCv); groundRough.wrapS = groundRough.wrapT = THREE.RepeatWrapping; groundRough.repeat.set(10, 10);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x585b5f, roughness: 0.95, metalness: 0.02, roughnessMap: groundRough });
  presetMats.push({ mat: groundMat, day: 0x585b5f, night: 0x0b0d12 });
  const ground = track(new THREE.Mesh(new THREE.PlaneGeometry(700, 700), groundMat));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = shadows;
  scene.add(ground);

  // the painted road layer
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.94, metalness: 0.02 });
  presetMats.push({ mat: roadMat, day: 0xffffff, night: 0x99a0b4 });
  const road = track(new THREE.Mesh(new THREE.PlaneGeometry(68, 68), roadMat));
  road.rotation.x = -Math.PI / 2;
  road.position.y = ROAD_Y;
  road.receiveShadow = shadows;
  scene.add(road);

  // sidewalk slabs: 36 block slabs + outer ring, merged
  {
    const geos = [];
    for (const b of plan.blocks) {
      const g = new THREE.BoxGeometry(6, SLAB_TOP, 6);
      g.translate(b.cx, SLAB_TOP / 2, b.cz);
      geos.push(g);
    }
    const strip = (x, z, w, d) => { const g = new THREE.BoxGeometry(w, SLAB_TOP, d); g.translate(x, SLAB_TOP / 2, z); geos.push(g); };
    strip(0, -33.2, 68.8, 2.4); strip(0, 33.2, 68.8, 2.4);
    strip(-33.2, 0, 2.4, 64); strip(33.2, 0, 2.4, 64);
    const slabMat = new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.92 });
    presetMats.push({ mat: slabMat, day: 0xffffff, night: 0x5f6578 });
    const slabs = track(new THREE.Mesh(mergeGeometries(geos), slabMat));
    slabs.receiveShadow = shadows;
    scene.add(slabs);
  }

  // park grass + lot paint (instanced quads on the slabs)
  const parks = plan.blocks.filter((b) => b.type === "park");
  const lots = plan.blocks.filter((b) => b.type === "lot");
  const quadInst = (n, texture, mat0) => {
    const m = mat0 || new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95 });
    return track(new THREE.InstancedMesh(new THREE.PlaneGeometry(5.2, 5.2), m, Math.max(1, n)));
  };
  const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.95 });
  presetMats.push({ mat: grassMat, day: 0xffffff, night: 0x66707e });
  const grass = quadInst(parks.length, grassTex, grassMat);
  parks.forEach((b, i) => {
    tmpM.compose(tmpV.set(b.cx, SLAB_TOP + 0.02, b.cz), QF, tmpS.set(1, 1, 1));
    grass.setMatrixAt(i, tmpM);
    grass.setColorAt(i, tmpC.setScalar(0.9 + b.tintRoll * 0.2));
  });
  grass.count = parks.length;
  scene.add(grass);
  const lotMat = new THREE.MeshStandardMaterial({ map: lotTex, roughness: 0.95 });
  presetMats.push({ mat: lotMat, day: 0xffffff, night: 0x767b88 });
  const lotQuads = quadInst(lots.length, lotTex, lotMat);
  lots.forEach((b, i) => {
    tmpQ.setFromAxisAngle(UP, b.yaw).multiply(QF);
    tmpM.compose(tmpV.set(b.cx, SLAB_TOP + 0.02, b.cz), tmpQ, tmpS.set(1, 1, 1));
    lotQuads.setMatrixAt(i, tmpM);
  });
  lotQuads.count = lots.length;
  scene.add(lotQuads);

  // trees: trunks + cone canopies + sphere canopies
  {
    const trees = [];
    for (const b of parks) for (const t of b.trees) trees.push(t);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6d5136, roughness: 0.9 });
    presetMats.push({ mat: trunkMat, day: 0x6d5136, night: 0x33281d });
    const trunks = track(new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 1, 5), trunkMat, Math.max(1, trees.length)));
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    presetMats.push({ mat: leafMat, day: 0xffffff, night: 0x4c5668 });
    const cones = track(new THREE.InstancedMesh(new THREE.ConeGeometry(0.85, 1.7, 7), leafMat, Math.max(1, trees.length)));
    const spheres = track(new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 7, 6), leafMat, Math.max(1, trees.length)));
    let ci = 0, si = 0;
    trees.forEach((t, i) => {
      tmpM.compose(tmpV.set(t.x, SLAB_TOP + 0.5 * t.s, t.z), tmpQ.identity(), tmpS.set(t.s, t.s, t.s));
      trunks.setMatrixAt(i, tmpM);
      const g = 0.35 + (t.s - 0.85) * 0.8;
      if (t.cone) {
        tmpM.compose(tmpV.set(t.x, SLAB_TOP + (1.0 + 0.85) * t.s, t.z), tmpQ, tmpS.set(t.s, t.s, t.s));
        cones.setMatrixAt(ci, tmpM);
        cones.setColorAt(ci, tmpC.setRGB(0.32 + g * 0.2, 0.52 + g * 0.2, 0.28));
        ci += 1;
      } else {
        tmpM.compose(tmpV.set(t.x, SLAB_TOP + (1.0 + 0.7) * t.s, t.z), tmpQ, tmpS.set(t.s, t.s, t.s));
        spheres.setMatrixAt(si, tmpM);
        spheres.setColorAt(si, tmpC.setRGB(0.3 + g * 0.2, 0.5 + g * 0.2, 0.26));
        si += 1;
      }
    });
    trunks.count = trees.length; cones.count = ci; spheres.count = si;
    trunks.castShadow = cones.castShadow = spheres.castShadow = shadows;
    scene.add(trunks, cones, spheres);
  }

  /* --- interior buildings (procedural realization; kenney bake replaces) --- */
  const interiorMeshes = [];
  {
    const builds = [];
    for (const b of plan.blocks) if (b.type === "build") for (const bd of b.buildings) builds.push(bd);
    // V3: roughnessMap noise (bright-biased, avg ≈ .85) — facade sheen varies
    const facadeMat = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 1.0, roughnessMap: roughTex });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xb2ada2, roughness: 0.95 });
    presetMats.push({ mat: facadeMat, day: 0xffffff, night: 0x6a7080 });
    presetMats.push({ mat: roofMat, day: 0xb2ada2, night: 0x3f4452 });
    const inst = track(new THREE.InstancedMesh(twoGroupBox(), [facadeMat, roofMat], Math.max(1, builds.length)));
    builds.forEach((bd, i) => {
      tmpQ.setFromAxisAngle(UP, bd.yaw);
      tmpM.compose(tmpV.set(bd.x, SLAB_TOP, bd.z), tmpQ, tmpS.set(bd.w, bd.h, bd.d));
      inst.setMatrixAt(i, tmpM);
      const warm = 0.86 + bd.tintRoll * 0.22;
      inst.setColorAt(i, tmpC.setRGB(warm, warm * (0.94 + bd.tintRoll * 0.05), warm * 0.88));
    });
    inst.count = builds.length;
    inst.castShadow = shadows;
    scene.add(inst);
    interiorMeshes.push(inst);
    // AC units + awnings (procedural dressing; dropped when kenney lands)
    const acMat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.8 });
    const ac = track(new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.26, 0.5), acMat, 80));
    let ai = 0;
    const AWN = [0xc94f3e, 0x3e7dc9, 0xd8a531, 0x3f8a5a];
    const awnMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const awn = track(new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 0.08, 0.55), awnMat, 64));
    let wi = 0;
    builds.forEach((bd) => {
      for (let k = 0; k < bd.acN && ai < 80; k += 1) {
        tmpM.compose(tmpV.set(bd.x + (bd.acR[k % 2] - 0.5) * bd.w * 0.5, SLAB_TOP + bd.h + 0.13, bd.z + (bd.acR[(k + 1) % 2] - 0.5) * bd.d * 0.5), tmpQ.identity(), tmpS.set(1, 1, 1));
        ac.setMatrixAt(ai, tmpM); ai += 1;
      }
      if (bd.awn && wi < 64) {
        const side = bd.z >= bd.x ? 1 : -1;
        tmpM.compose(tmpV.set(bd.x, SLAB_TOP + 1.05, bd.z + side * (bd.d / 2 + 0.28)), tmpQ.identity(), tmpS.set(1, 1, 1));
        awn.setMatrixAt(wi, tmpM);
        awn.setColorAt(wi, tmpC.set(AWN[bd.awnC]));
        wi += 1;
      }
    });
    ac.count = ai; awn.count = wi;
    scene.add(ac, awn);
    interiorMeshes.push(ac, awn);
  }

  /* --- outer skyline (procedural; kenney bake replaces to the SAME boxes) --- */
  let towersMesh;
  {
    // V3: glass bands slightly reflective — lower roughness + env cubemap glints
    const sideMat = new THREE.MeshStandardMaterial({ map: towerTex, roughness: 0.6, emissive: 0x000000, emissiveIntensity: 0.7 });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x8f8b82, roughness: 0.95, emissive: 0x000000, emissiveIntensity: 0.7 });
    presetMats.push({ mat: sideMat, day: 0xffffff, night: 0x39404f, emissiveNight: 0x10162a });
    presetMats.push({ mat: topMat, day: 0x8f8b82, night: 0x2a2f3c, emissiveNight: 0x0a0e1c });
    towersMesh = track(new THREE.InstancedMesh(twoGroupBox(), [sideMat, topMat], plan.towers.length));
    plan.towers.forEach((t, i) => {
      tmpM.compose(tmpV.set(t.x, 0, t.z), tmpQ.identity(), tmpS.set(t.w, t.h, t.d));
      towersMesh.setMatrixAt(i, tmpM);
      tmpC.setHSL(0.08 + t.hue * 0.06, 0.14, 0.62 + t.hue * 0.2);
      towersMesh.setColorAt(i, tmpC);
    });
    towersMesh.castShadow = shadows;
    scene.add(towersMesh);
  }

  /* --- neon windows + hero signs: built from PLAN boxes, so they stay valid
         for both procedural towers and the kenney bake (night only) --- */
  let windows, signsStatic;
  const flickers = [];
  {
    const PALETTE = [0xffc46b, 0x9fd8ff, 0xff6ba8, 0x6bffea];
    const W_MAX = 1200;
    windows = track(new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.7, 0.5),
      new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide }),
      W_MAX,
    ));
    const qPX = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2);
    const qNX = new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 2);
    const qPZ = new THREE.Quaternion();
    const qNZ = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
    let i = 0;
    for (const t of plan.towers) {
      if (i >= W_MAX) break;
      const px = Math.abs(t.x) > Math.abs(t.z);
      const sign = px ? Math.sign(t.x) : Math.sign(t.z);
      const rows = Math.max(2, Math.floor(t.h / 2.2));
      const cols = Math.max(2, Math.floor((px ? t.d : t.w) / 1.6));
      for (let ry = 0; ry < rows && i < W_MAX; ry += 1) {
        for (let cx = 0; cx < cols && i < W_MAX; cx += 1) {
          if (rng() < 0.55) continue;
          const y = 1.2 + ry * (t.h - 2) / rows;
          const off = -((px ? t.d : t.w) / 2) + (cx + 0.5) * ((px ? t.d : t.w) / cols);
          if (px) {
            tmpV.set(t.x - sign * (t.w / 2 + 0.05), y, t.z + off);
            tmpQ.copy(sign > 0 ? qNX : qPX);
          } else {
            tmpV.set(t.x + off, y, t.z - sign * (t.d / 2 + 0.05));
            tmpQ.copy(sign > 0 ? qNZ : qPZ);
          }
          tmpM.compose(tmpV, tmpQ, tmpS.set(1, 1, 1));
          windows.setMatrixAt(i, tmpM);
          tmpC.set(PALETTE[Math.floor(rng() * PALETTE.length)]).multiplyScalar(1.5 + rng() * 2.0);
          windows.setColorAt(i, tmpC);
          i += 1;
        }
      }
    }
    windows.count = i;
    scene.add(windows);

    // hero signs: 2 flickering meshes + the rest merged into ONE vertex-colored mesh
    const SIGN_COLS = [0xff2e88, 0xffd400, 0x6bffea, 0x9fd8ff, 0xff6ba8, 0xffc46b, 0x2b7fff, 0xff8a1e];
    const staticGeos = [];
    for (let k = 0; k < 8; k += 1) {
      const t = plan.towers[Math.floor(rng() * plan.towers.length)];
      if (!t) continue;
      const px = Math.abs(t.x) > Math.abs(t.z);
      const sign = px ? Math.sign(t.x) : Math.sign(t.z);
      const wdt = 2.5 + rng() * 4, hgt = 1 + rng() * 2.2;
      const y = Math.min(t.h - 1, 4 + rng() * Math.max(1, t.h - 4));
      const col = new THREE.Color(SIGN_COLS[k]).multiplyScalar(2.5 + rng() * 1.5);
      const seed = Math.floor(rng() * 1e6);
      const g = new THREE.PlaneGeometry(wdt, hgt);
      const m4 = new THREE.Matrix4();
      if (px) {
        tmpQ.setFromAxisAngle(UP, sign > 0 ? -Math.PI / 2 : Math.PI / 2);
        m4.compose(tmpV.set(t.x - sign * (t.w / 2 + 0.08), y, t.z), tmpQ, tmpS.set(1, 1, 1));
      } else {
        tmpQ.setFromAxisAngle(UP, sign > 0 ? Math.PI : 0);
        m4.compose(tmpV.set(t.x, y, t.z - sign * (t.d / 2 + 0.08)), tmpQ, tmpS.set(1, 1, 1));
      }
      g.applyMatrix4(m4);
      if (k < 2) {
        const mat = new THREE.MeshBasicMaterial({ color: col, toneMapped: false, side: THREE.DoubleSide });
        const mesh = track(new THREE.Mesh(g, mat));
        mesh.userData.base = col.clone();
        mesh.userData.seed = seed;
        scene.add(mesh);
        flickers.push(mesh);
      } else {
        const colors = new Float32Array(g.attributes.position.count * 3);
        for (let v = 0; v < g.attributes.position.count; v += 1) col.toArray(colors, v * 3);
        g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        staticGeos.push(g);
      }
    }
    signsStatic = staticGeos.length
      ? track(new THREE.Mesh(mergeGeometries(staticGeos), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide })))
      : null;
    if (signsStatic) scene.add(signsStatic);
  }

  /* --- V3 billboards: 3 ring towers carry NEUTRAL FICTIONAL ads (canvas
         atlas, one merged mesh = one draw call, day and night) --- */
  {
    const cv = document.createElement("canvas");
    cv.width = 768; cv.height = 256;
    const bctx = cv.getContext("2d");
    const frame = (x) => { bctx.strokeStyle = "#14161c"; bctx.lineWidth = 14; bctx.strokeRect(x + 7, 7, 242, 242); };
    // panel 0: COSMOS COLA
    bctx.fillStyle = "#b81a2e"; bctx.fillRect(0, 0, 256, 256);
    bctx.fillStyle = "#f4f1e6";
    bctx.font = "700 44px 'Chakra Petch', sans-serif"; bctx.textAlign = "center";
    bctx.fillText("COSMOS", 128, 108);
    bctx.fillText("COLA", 128, 158);
    bctx.strokeStyle = "#f4f1e6"; bctx.lineWidth = 7;
    bctx.beginPath(); bctx.moveTo(40, 190); bctx.quadraticCurveTo(128, 232, 216, 184); bctx.stroke();
    bctx.font = "700 18px 'Space Mono', monospace"; bctx.fillText("ICE COLD SINCE 2077", 128, 62);
    frame(0);
    // panel 1: 77 FM
    bctx.fillStyle = "#101f4e"; bctx.fillRect(256, 0, 256, 256);
    bctx.fillStyle = "#ffd400";
    bctx.font = "700 96px 'Chakra Petch', sans-serif";
    bctx.fillText("77", 384, 130);
    bctx.font = "700 44px 'Chakra Petch', sans-serif"; bctx.fillText("FM", 384, 180);
    bctx.fillStyle = "#e8eaf0"; bctx.font = "700 17px 'Space Mono', monospace";
    bctx.fillText("ALL-NIGHT PURSUIT RADIO", 384, 218);
    frame(256);
    // panel 2: NY DONUTS
    bctx.fillStyle = "#26101e"; bctx.fillRect(512, 0, 256, 256);
    bctx.strokeStyle = "#ff2e88"; bctx.lineWidth = 22;
    bctx.beginPath(); bctx.arc(640, 104, 52, 0, Math.PI * 2); bctx.stroke();
    bctx.fillStyle = "#ffd9ec"; bctx.font = "700 40px 'Chakra Petch', sans-serif";
    bctx.fillText("NY DONUTS", 640, 204);
    bctx.fillStyle = "#ff8ab8"; bctx.font = "700 16px 'Space Mono', monospace";
    bctx.fillText("HOT · GLAZED · 24H", 640, 234);
    frame(512);
    const billTex = tex(cv, true);
    const candidates = plan.towers.filter((t) => t.band === "near" && t.h >= 9);
    const geos = [];
    const used = new Set();
    for (let k = 0; k < 3 && candidates.length; k += 1) {
      let idx = Math.floor(rng2() * candidates.length);
      let guard = 0;
      while (used.has(idx) && guard < candidates.length) { idx = (idx + 1) % candidates.length; guard += 1; }
      used.add(idx);
      const t = candidates[idx];
      const w = Math.min(5.6, Math.max(3.6, t.w * 0.92));
      const g = new THREE.PlaneGeometry(w, w);
      const uvs = g.attributes.uv;
      for (let vI = 0; vI < uvs.count; vI += 1) uvs.setX(vI, (k + uvs.getX(vI)) / 3);
      const px = Math.abs(t.x) > Math.abs(t.z);
      const sign = px ? Math.sign(t.x) : Math.sign(t.z);
      const y = Math.min(t.h - w / 2 - 0.5, 5.5 + rng2() * 4);
      if (px) {
        tmpQ.setFromAxisAngle(UP, sign > 0 ? -Math.PI / 2 : Math.PI / 2);
        tmpM.compose(tmpV.set(t.x - sign * (t.w / 2 + 0.12), y, t.z), tmpQ, tmpS.set(1, 1, 1));
      } else {
        tmpQ.setFromAxisAngle(UP, sign > 0 ? Math.PI : 0);
        tmpM.compose(tmpV.set(t.x, y, t.z - sign * (t.d / 2 + 0.12)), tmpQ, tmpS.set(1, 1, 1));
      }
      g.applyMatrix4(tmpM);
      geos.push(g);
    }
    if (geos.length) {
      const bill = track(new THREE.Mesh(
        mergeGeometries(geos),
        new THREE.MeshBasicMaterial({ map: billTex, side: THREE.DoubleSide }),
      ));
      scene.add(bill); // basic material: printed board by day, backlit at night
    }
  }

  /* --- V3 steam vents: 3 vents × 3 additive puffs, night only, cheap ---
         (one InstancedMesh = one draw call; hidden under reduced motion) --- */
  let steam = null;
  const steamSeeds = [];
  {
    const scv = document.createElement("canvas");
    scv.width = scv.height = 64;
    const sctx = scv.getContext("2d");
    const sg = sctx.createRadialGradient(32, 32, 3, 32, 32, 31);
    sg.addColorStop(0, "rgba(210,220,235,0.7)");
    sg.addColorStop(0.55, "rgba(190,200,220,0.25)");
    sg.addColorStop(1, "rgba(180,190,210,0)");
    sctx.fillStyle = sg; sctx.fillRect(0, 0, 64, 64);
    const builds = plan.blocks.filter((b) => b.type === "build");
    for (let k = 0; k < 3 && builds.length; k += 1) {
      const b = builds[Math.floor(rng2() * builds.length)];
      const vx = b.cx + (rng2() < 0.5 ? -2.45 : 2.45);
      const vz = b.cz + (rng2() < 0.5 ? -2.45 : 2.45);
      const yaw = rng2() * Math.PI;
      for (let p = 0; p < 3; p += 1) steamSeeds.push({ x: vx, z: vz, yaw, phase: (k * 3 + p) * 0.31 + rng2() * 0.2 });
    }
    if (steamSeeds.length) {
      steam = track(new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: new THREE.CanvasTexture(scv), transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
        }),
        steamSeeds.length,
      ));
      for (let i = 0; i < steamSeeds.length; i += 1) {
        tmpM.compose(tmpV.set(0, -50, 0), tmpQ.identity(), tmpS.set(1, 1, 1));
        steam.setMatrixAt(i, tmpM);
        steam.setColorAt(i, tmpC.set(0x000000));
      }
      steam.instanceMatrix.needsUpdate = true;
      steam.visible = false; // night preset only; never under reduced motion
      scene.add(steam);
    }
  }

  /* ------------------------------ street props --------------------------- */
  let heads, pools;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x6a6f76, roughness: 0.6, metalness: 0.4 });
  presetMats.push({ mat: poleMat, day: 0x6a6f76, night: 0x1a1d26 });
  {
    const poleGeos = [];
    for (const [x, z] of plan.corners) {
      const g = new THREE.CylinderGeometry(0.06, 0.09, 3.5, 6);
      g.translate(x, SLAB_TOP + 1.75, z);
      poleGeos.push(g);
    }
    const poles = track(new THREE.Mesh(mergeGeometries(poleGeos), poleMat));
    poles.castShadow = shadows;
    scene.add(poles);
    const headMat = new THREE.MeshBasicMaterial({ color: 0xc9ccd2, toneMapped: false });
    presetMats.push({ mat: headMat, day: 0xc9ccd2, night: 0xffd9a0 });
    heads = track(new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 8, 8), headMat, plan.corners.length));
    pools = track(new THREE.InstancedMesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
      plan.corners.length,
    ));
    plan.corners.forEach(([x, z], i) => {
      tmpM.compose(tmpV.set(x, SLAB_TOP + 3.55, z), tmpQ.identity(), tmpS.set(1, 1, 1));
      heads.setMatrixAt(i, tmpM);
      // pole stands on the sidewalk slab — pool must float above the slab top
      tmpM.compose(tmpV.set(x, SLAB_TOP + 0.02, z), QF, tmpS.set(1, 1, 1));
      pools.setMatrixAt(i, tmpM);
    });
    scene.add(heads, pools);
  }
  { // stop-sign posts + plates
    const postGeos = [];
    for (const p of plan.posts) {
      const g = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 5);
      g.translate(p.x, SLAB_TOP + 1.2, p.z);
      postGeos.push(g);
    }
    if (postGeos.length) {
      scene.add(track(new THREE.Mesh(mergeGeometries(postGeos), poleMat)));
      const plates = track(new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.62, 0.62),
        new THREE.MeshStandardMaterial({ map: stopTex, transparent: true, side: THREE.DoubleSide, roughness: 0.6 }),
        plan.posts.length,
      ));
      plan.posts.forEach((p, i) => {
        tmpQ.setFromAxisAngle(UP, p.yaw);
        tmpM.compose(tmpV.set(p.x, SLAB_TOP + 2.15, p.z), tmpQ, tmpS.set(1, 1, 1));
        plates.setMatrixAt(i, tmpM);
      });
      scene.add(plates);
    }
  }
  { // hydrants
    const body = new THREE.CylinderGeometry(0.14, 0.17, 0.5, 6);
    body.translate(0, 0.25, 0);
    const cap = new THREE.SphereGeometry(0.13, 6, 5);
    cap.translate(0, 0.52, 0);
    const geo = mergeGeometries([body, cap]);
    const hydMat = new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.55 });
    const hyd = track(new THREE.InstancedMesh(geo, hydMat, Math.max(1, plan.hydrants.length)));
    plan.hydrants.forEach(([x, z], i) => {
      tmpM.compose(tmpV.set(x, SLAB_TOP, z), tmpQ.identity(), tmpS.set(1, 1, 1));
      hyd.setMatrixAt(i, tmpM);
    });
    hyd.count = plan.hydrants.length;
    scene.add(hyd);
  }

  /* --- parked cars (procedural realization; kenney bake replaces) --- */
  let parkedMesh;
  {
    const lower = new THREE.BoxGeometry(1.8, 0.55, 4.0); lower.translate(0, 0.34, 0);
    const upper = new THREE.BoxGeometry(1.6, 0.42, 2.0); upper.translate(0, 0.79, -0.1);
    const geo = mergeGeometries([lower, upper]);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4 });
    const DESAT = [0x8a8f95, 0x6b7076, 0x97836b, 0x5d6b78, 0x7d7a72];
    parkedMesh = track(new THREE.InstancedMesh(geo, mat, Math.max(1, plan.spots.length)));
    plan.spots.forEach((s, i) => {
      tmpQ.setFromAxisAngle(UP, s.yaw);
      tmpM.compose(tmpV.set(s.x, s.y, s.z), tmpQ, tmpS.set(1, 1, 1));
      parkedMesh.setMatrixAt(i, tmpM);
      parkedMesh.setColorAt(i, tmpC.set(DESAT[Math.floor(s.typeRoll * DESAT.length)]).multiplyScalar(0.85 + s.tintRoll * 0.3));
    });
    parkedMesh.count = plan.spots.length;
    parkedMesh.castShadow = shadows;
    scene.add(parkedMesh);
  }

  /* ------------------------------ kenney bake ----------------------------- */
  /* V3: tint is a THREE.Color multiplier — per-instance hue/brightness jitter
     baked as vertex colors (the "varied palette hues" fidelity pass). */
  const bakeTint = new THREE.Color();
  function bakeOne(src, tint, matrix) {
    const g = src.clone();
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let v = 0; v < n; v += 1) tint.toArray(colors, v * 3);
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.applyMatrix4(matrix);
    return g;
  }

  /* curated multiplier tints for the parked-car bake (palette stays kenney's;
     the multiply shifts paint families: warm/cool/mint/rose/neutral/gray) */
  const PARKED_TINTS = [0xffffff, 0xffd9c0, 0xc9d8ff, 0xd8ffd0, 0xffc9c9, 0xbfbfbf];

  function swapIn(geos, material, removeList) {
    if (!geos.length) return null;
    const mesh = track(new THREE.Mesh(mergeGeometries(geos, false), material));
    mesh.castShadow = shadows;
    scene.add(mesh);
    for (const old of removeList) {
      scene.remove(old);
      if (old.geometry) old.geometry.dispose();
    }
    return mesh;
  }

  function upgrade(assets) {
    if (!assets) return;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    if (assets.bakeMaterial) {
      assets.bakeMaterial.roughness = 1.0;          // V3: per-texel roughness jitter
      assets.bakeMaterial.roughnessMap = roughTex;  // (avg ≈ .85, speckled)
      assets.bakeMaterial.needsUpdate = true;
      presetMats.push({ mat: assets.bakeMaterial, day: 0xffffff, night: 0x8a91a6 });
      if (assets.interior.length) { // detailed low-rises INSIDE the board
        const geos = [];
        for (const b of plan.blocks) {
          if (b.type !== "build") continue;
          for (const bd of b.buildings) {
            const t = assets.interior[Math.floor(bd.typeRoll * assets.interior.length)];
            const s = Math.min(bd.w / t.size.x, bd.d / t.size.z, HCAP / t.size.y);
            q.setFromAxisAngle(UP, bd.yaw);
            m4.compose(v.set(bd.x, SLAB_TOP, bd.z), q, sc.set(s, s, s));
            // warm hue jitter: plaster drifts cream→tan, brightness ±9%
            bakeTint.setHSL(0.06 + bd.typeRoll * 0.06, 0.10 + bd.tintRoll * 0.14, 0.66 + bd.tintRoll * 0.09);
            geos.push(bakeOne(t.geometry, bakeTint, m4));
          }
        }
        const mesh = swapIn(geos, assets.bakeMaterial, interiorMeshes);
        if (mesh) interiorMeshes.length = 0;
      }
      if (assets.towers.length || assets.far.length) { // skyline, scaled INTO the plan boxes
        const geos = [];
        q.identity();
        for (const t of plan.towers) {
          const pool = (t.band === "near" ? assets.towers : assets.far);
          const pick = pool.length ? pool : (assets.towers.length ? assets.towers : assets.far);
          if (!pick.length) continue;
          const md = pick[Math.floor(t.typeRoll * pick.length)];
          m4.compose(v.set(t.x, 0, t.z), q, sc.set(t.w / md.size.x, t.h / md.size.y, t.d / md.size.z));
          // same hue family as the procedural ring, per-tower variation
          bakeTint.setHSL(0.08 + t.hue * 0.06, 0.12, 0.58 + t.hue * 0.18);
          geos.push(bakeOne(md.geometry, bakeTint, m4));
        }
        const mesh = swapIn(geos, assets.bakeMaterial, [towersMesh]);
        if (mesh) towersMesh = mesh;
      }
    }
    if (assets.bakeCarMaterial && assets.parked.length) { // street dressing
      presetMats.push({ mat: assets.bakeCarMaterial, day: 0xffffff, night: 0x8a91a6 });
      const geos = [];
      for (const s of plan.spots) {
        const md = assets.parked[Math.floor(s.typeRoll * assets.parked.length)];
        const k = 3.9 / md.size.z;
        q.setFromAxisAngle(UP, s.yaw);
        m4.compose(v.set(s.x, s.y, s.z), q, sc.set(k, k, k));
        // varied kenney palette hues: curated tint family × brightness jitter
        bakeTint.set(PARKED_TINTS[Math.floor(s.tintRoll * PARKED_TINTS.length)])
          .multiplyScalar(0.82 + (s.tintRoll * 7.3 % 1) * 0.26);
        geos.push(bakeOne(md.geometry, bakeTint, m4));
      }
      const mesh = swapIn(geos, assets.bakeCarMaterial, [parkedMesh]);
      if (mesh) parkedMesh = mesh;
    }
    setPreset(preset); // re-tint the new bake materials for the active preset
  }

  /* ------------------------------- presets -------------------------------- */
  let preset = "day";
  function setPreset(name) {
    preset = name === "night" ? "night" : "day";
    const night = preset === "night";
    windows.visible = night;
    pools.visible = night;
    if (signsStatic) signsStatic.visible = night;
    if (steam) steam.visible = night && !REDUCED; // V3: steam is a night thing
    for (const f of flickers) f.visible = night;
    for (const e of presetMats) {
      e.mat.color.set(night ? e.night : e.day);
      if (e.emissiveNight !== undefined && e.mat.emissive) e.mat.emissive.set(night ? e.emissiveNight : 0x000000);
    }
    // day = dry warm concrete; night = the v1 wet-asphalt trick
    groundMat.metalness = night ? 0.75 : 0.02;
    groundMat.roughness = night ? 0.35 : 0.95;
  }

  const STEAM_CYCLE = 2.6;
  function update(dt, elapsed) {
    if (preset !== "night") return;
    for (const s of flickers) {
      const on = (Math.sin(elapsed * 9 + s.userData.seed) + Math.sin(elapsed * 23.7 + s.userData.seed * 2)) > -0.6;
      s.material.color.copy(s.userData.base).multiplyScalar(on ? 1 : 0.12);
    }
    if (steam && steam.visible) { // rising, fading puffs (9 instances)
      for (let i = 0; i < steamSeeds.length; i += 1) {
        const sd = steamSeeds[i];
        const c = (elapsed / STEAM_CYCLE + sd.phase) % 1;
        const a = Math.min(1, c / 0.12) * (1 - c) * 0.5;
        tmpQ.setFromAxisAngle(UP, sd.yaw);
        tmpM.compose(
          tmpV.set(sd.x, 0.3 + c * 2.1, sd.z),
          tmpQ,
          tmpS.setScalar(0.6 + c * 1.5),
        );
        steam.setMatrixAt(i, tmpM);
        steam.setColorAt(i, tmpC.setScalar(a));
      }
      steam.instanceMatrix.needsUpdate = true;
      steam.instanceColor.needsUpdate = true;
    }
    void dt;
  }

  return { setPreset, update, upgrade, blockBoxes, preset: () => preset };
}

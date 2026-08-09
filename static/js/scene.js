/* scene.js — the arena orchestrator (ARENA V2). The board is a golden-hour
   city district by default (config map_area is literally "New York"); the v1
   night look survives as a preset. This file only wires the stack together:
     lighting.js — day/night presets over one fixed light rig
     world.js    — roads-and-blocks city ON the board + skyline ring (seeded)
     cameras.js  — TOP / CHASE camera system
   plus renderer, overlay layer, half-res bloom and the ?debug=1 draw ledger.
   Game mapping (cellToWorld) is UNCHANGED — cells are road intersections. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createLighting } from "./lighting.js";
import { createWorld } from "./world.js";
import { createCameras } from "./cameras.js";

export const CELL = 10;
export const GRID = 7;
const HALF = (GRID - 1) / 2; // 3

export function cellToWorld(r, c, y = 0) {
  return new THREE.Vector3((c - HALF) * CELL, y, (r - HALF) * CELL);
}

/* deterministic city — every viewer sees the same district */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* DPR clamp 1.5 across the board (spec); shadows ON for med/high (day). */
export const QUALITY = {
  low: { dpr: 1.0, bloom: false, shadows: false },
  med: { dpr: 1.5, bloom: true, shadows: true },
  high: { dpr: 1.5, bloom: true, shadows: true },
};

export function qualityFromQuery() {
  const q = new URLSearchParams(location.search).get("q");
  return QUALITY[q] ? q : "med";
}

export function createArena(container, { quality = "med", preset = "day" } = {}) {
  const tier = QUALITY[quality] || QUALITY.med;
  const rng = mulberry32(770077);
  const debug = new URLSearchParams(location.search).get("debug") === "1";

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = tier.shadows;
  if (tier.shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(40, 16 / 10, 0.5, 600);
  camera.position.set(0, 95, 55);
  camera.lookAt(0, 0, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;

  const lighting = createLighting({ scene, tier });
  const world = createWorld({
    scene, tier, rng,
    maxAniso: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    CELL, GRID, cellToWorld,
  });

  /* ---- cell overlay: ALL board-state tinting in 1 draw call (additive;
     gain retuned per preset so hazard tints read on bright asphalt) ---- */
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
    tmp: new THREE.Color(),
    gain: 1,
    set(r, c, hex, k = 1) {
      this.tmp.set(hex).multiplyScalar(k * this.gain);
      overlay.setColorAt(r * GRID + c, this.tmp);
    },
    clear() {
      this.tmp.set(0x000000);
      for (let i = 0; i < GRID * GRID; i += 1) overlay.setColorAt(i, this.tmp);
    },
    commit() { overlay.instanceColor.needsUpdate = true; },
  };

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

  const cameras = createCameras({ camera, controls, blockBoxes: world.blockBoxes });

  /* ---- preset plumbing (default day; night is the v1 look) ---- */
  let presetName = "day";
  function setPreset(name) {
    const p = lighting.setPreset(name);
    presetName = lighting.preset();
    world.setPreset(presetName);
    overlayApi.gain = p.overlayGain;
    if (bloomPass) {
      bloomPass.threshold = p.bloom.threshold;
      bloomPass.strength = p.bloom.strength;
      bloomPass.radius = p.bloom.radius;
    }
  }
  setPreset(preset);

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

  /* ---- ?debug=1: draw-call ledger every ~2 s. "scene" counts the scene
     pass only (the number the ≤80 budget governs, same metric as v1's ~33);
     "frame" adds the bloom chain + output pass quads. ---- */
  if (debug) renderer.info.autoReset = false;
  let elapsed = 0;
  let dbgT = 0, dbgFrames = 0, dbgScene = 0;
  if (debug && composer) {
    const rp = composer.passes[0];
    const orig = rp.render.bind(rp);
    rp.render = (...a) => { orig(...a); dbgScene = renderer.info.render.calls; };
  }

  function render(dt) {
    elapsed += dt;
    world.update(dt, elapsed);
    if (debug) renderer.info.reset();
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (debug) {
      dbgT += dt; dbgFrames += 1;
      if (dbgT >= 2) {
        const r = renderer.info.render;
        const line =
          "[arena:debug] scene calls=" + (composer ? dbgScene : r.calls) +
          " frame=" + r.calls + " tris=" + r.triangles +
          " progs=" + (renderer.info.programs ? renderer.info.programs.length : 0) +
          " preset=" + presetName + " cam=" + cameras.mode() +
          " q=" + quality + " fps~" + Math.round(dbgFrames / dbgT);
        console.log(line);
        renderer.domElement.dataset.arenaDebug = line; // inspectable ledger
        dbgT = 0; dbgFrames = 0;
      }
    }
  }

  return {
    THREE, scene, camera, renderer, controls, composer,
    overlay: overlayApi,
    cellToWorld,
    tier: quality,
    cameras,
    setPreset,
    preset: () => presetName,
    upgradeWorld: world.upgrade,
    render, resize,
    info: () => renderer.info.render,
    dispose() { ro.disconnect(); renderer.dispose(); },
  };
}

/* scene.js — the arena orchestrator (ARENA V3). The board is a golden-hour
   city district by default (config map_area is literally "New York"); the v1
   night look survives as a preset. This file only wires the stack together:
     lighting.js — day/night presets over one fixed light rig (+ generated
                   gradient env cubemap so glass/paint pick up reflections)
     world.js    — roads-and-blocks city ON the board + skyline ring (seeded;
                   V3 adds street wear, billboards, night steam — a second
                   seeded rng so the V2 block plan is untouched)
     cameras.js  — TOP (cinematic tactical) / CHASE camera system
   plus renderer, overlay layer, half-res bloom, the V3 grade pass (subtle
   vignette + saturation/contrast lift; skipped entirely on q=low) and the
   ?debug=1 draw ledger.
   Game mapping (cellToWorld) is UNCHANGED — cells are road intersections. */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createLighting } from "./lighting.js";
import { createWorld } from "./world.js";
import { createCameras } from "./cameras.js";

export const CELL = 10;
import { GRID, HALF } from "./board.js";
export { GRID };   // live binding: importers follow setGrid()

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

/* DPR clamp 1.5 (V3: 2.0 allowed ONLY at q=high); shadows on med/high (day) */
export const QUALITY = {
  low: { dpr: 1.0, bloom: false, shadows: false },
  med: { dpr: 1.5, bloom: true, shadows: true },
  high: { dpr: 2.0, bloom: true, shadows: true },
};

export function qualityFromQuery() {
  const q = new URLSearchParams(location.search).get("q");
  return QUALITY[q] ? q : "med";
}

/* V3 grade pass — vignette + slight saturation/contrast lift, pre-Output
   (linear space, before tone mapping — filmic-correct). One fullscreen quad. */
const GradeShader = {
  name: "CosmosGradeShader",
  uniforms: {
    tDiffuse: { value: null },
    uVig: { value: 0.28 },   // vignette strength
    uSat: { value: 1.07 },   // saturation lift
    uCon: { value: 1.045 },  // contrast lift
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVig, uSat, uCon;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      c.rgb = (c.rgb - 0.5) * uCon + 0.5;
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - uVig * smoothstep(0.32, 0.72, d);
      gl_FragColor = c;
    }`,
};

export function createArena(container, { quality = "med", preset = "day" } = {}) {
  const tier = QUALITY[quality] || QUALITY.med;
  const rng = mulberry32(770077);        // the V2 block-plan stream (untouched)
  const rngDetail = mulberry32(770078);  // V3 dressing: wear/billboards/steam
  const debug = new URLSearchParams(location.search).get("debug") === "1";

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = tier.shadows;
  if (tier.shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  /* canonical TOP pose = polar 0.95 rad, distance 88, FOV 44 (cameras.js) */
  const camera = new THREE.PerspectiveCamera(44, 16 / 10, 0.5, 600);
  camera.position.set(0, 88 * Math.cos(0.95), 88 * Math.sin(0.95));
  camera.lookAt(0, 1.5, 0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;

  const lighting = createLighting({ scene, tier });
  const world = createWorld({
    scene, tier, rng, rngDetail,
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

  /* ---- composer: half-res bloom + grade + OutputPass (med/high);
          raw render on low — the grade pass is skipped entirely there ---- */
  let composer = null;
  let bloomPass = null;
  if (tier.bloom) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(container.clientWidth / 2, container.clientHeight / 2), 0.55, 0.35, 0.85);
    composer.addPass(bloomPass);
    composer.addPass(new ShaderPass(GradeShader));
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
     pass only (the number the ≤90 budget governs, same metric as v1's ~33);
     "frame" adds the bloom chain + grade + output pass quads. ---- */
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

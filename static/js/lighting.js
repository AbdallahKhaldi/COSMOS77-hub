/* lighting.js — the time-of-day rig (ARENA V3). Two presets over ONE fixed
   set of lights (never added/removed — color/intensity/position animate, so
   zero shader recompiles on toggle):
     day   — DEFAULT. Golden-hour Sky.js dome, warm sun (physical intensity
             3.2), hemisphere fill, light warm FogExp2. Shadows via
             shadow.intensity=1 (med/high tiers).
     night — the v1 look: moon dirlight, deep hemi, 2 hero point lights,
             heavier fog; shadow.intensity=0 keeps the map bound (no recompile).
   V3: scene.environment is a tiny GENERATED gradient cubemap (6 canvas faces,
   zero external requests) so glass windows / car paint pick up soft sky
   reflections; only environmentIntensity changes per preset (day 0.5, night
   0.18) — the texture is set once at boot, so toggling never recompiles.
   Bloom values per preset are exported for scene.js's composer. */

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

/* one 16px canvas face: vertical gradient through [stop, css] pairs */
function envFace(stops) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 16;
  const ctx = cv.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 16);
  for (const [v, c] of stops) g.addColorStop(v, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return cv;
}

function makeEnvCubemap() {
  const horizon = [[0, "#cfe0f0"], [0.55, "#f0d8b0"], [0.8, "#8a8074"], [1, "#5a564c"]];
  const top = [[0, "#bcd8f2"], [1, "#e8f0f8"]];
  const bottom = [[0, "#5a564c"], [1, "#4c483f"]];
  // order: +x, -x, +y, -y, +z, -z
  const faces = [horizon, horizon, top, bottom, horizon, horizon].map(envFace);
  const tex = new THREE.CubeTexture(faces);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export const PRESETS = {
  day: {
    sun: { color: 0xffe0b0, intensity: 3.2 },
    sunAngles: { elevation: 28, azimuth: 140 },       // degrees
    hemi: { sky: 0xffe3c4, ground: 0x8a7860, intensity: 0.6 },
    sky: { turbidity: 6, rayleigh: 1.2, mieCoefficient: 0.005, mieDirectionalG: 0.8 },
    fog: { color: 0xf3cfa5, density: 0.004 }, // spec ~0.0045; eased so the ring stays legible
    background: 0xf6d7ab,          // fallback behind the sky dome
    hero: 0,                       // neon hero points off in daylight
    bloom: { threshold: 1.0, strength: 0.25, radius: 0.3 },
    shadow: 1,                     // shadow.intensity
    overlayGain: 1.6,              // additive cell overlay boost on bright asphalt
    env: 0.5,                      // environmentIntensity (glass/paint glints)
  },
  night: {
    sun: { color: 0x8fb4ff, intensity: 0.55 },        // the v1 "moon"
    sunPos: [-70, 120, -40],
    hemi: { sky: 0x2b3a67, ground: 0x0b0d12, intensity: 0.9 },
    fog: { color: 0x0a0d1a, density: 0.008 },
    background: 0x06070f,
    hero: 1,                       // scale factor for the two hero points
    bloom: { threshold: 0.85, strength: 0.55, radius: 0.35 },
    shadow: 0,
    overlayGain: 1.0,
    env: 0.18,
  },
};

export function createLighting({ scene, tier }) {
  /* ---- sky dome (day only; hidden at night) ---- */
  const sky = new Sky();
  sky.scale.setScalar(450);        // inside camera far=600, outside the city
  scene.add(sky);
  const sunDir = new THREE.Vector3();

  /* ---- generated env cubemap: set ONCE, intensity animates per preset ---- */
  scene.environment = makeEnvCubemap();
  scene.environmentIntensity = 0.5;

  /* ---- the fixed rig ---- */
  const hemi = new THREE.HemisphereLight(0xffe3c4, 0x8a7860, 0.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe0b0, 3.2);
  scene.add(sun, sun.target);
  if (tier.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const f = 60; // tight ortho frustum around the board
    sun.shadow.camera.left = -f; sun.shadow.camera.right = f;
    sun.shadow.camera.top = f; sun.shadow.camera.bottom = -f;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.5;
    // V3 softness: r185 deprecates PCFSoft and runs PCFShadowMap, which
    // honors radius — verified live (console deprecation warning). Map stays 2048.
    sun.shadow.radius = 4;
  }

  const hero1 = new THREE.PointLight(0xffb46b, 0, 60, 2);
  hero1.position.set(-38, 9, -38);
  const hero2 = new THREE.PointLight(0x6bffea, 0, 55, 2);
  hero2.position.set(40, 8, 40);
  scene.add(hero1, hero2);
  const heroBase = [tier.bloom ? 60 : 40, tier.bloom ? 45 : 30];

  let current = null;

  function setPreset(name) {
    const p = PRESETS[name] || PRESETS.day;
    current = name === "night" ? "night" : "day";
    const day = current === "day";

    sky.visible = day;
    if (day) {
      const u = sky.material.uniforms;
      u.turbidity.value = p.sky.turbidity;
      u.rayleigh.value = p.sky.rayleigh;
      u.mieCoefficient.value = p.sky.mieCoefficient;
      u.mieDirectionalG.value = p.sky.mieDirectionalG;
      const phi = THREE.MathUtils.degToRad(90 - p.sunAngles.elevation);
      const theta = THREE.MathUtils.degToRad(p.sunAngles.azimuth);
      sunDir.setFromSphericalCoords(1, phi, theta);
      u.sunPosition.value.copy(sunDir);
      sun.position.copy(sunDir).multiplyScalar(140);
    } else {
      sun.position.set(p.sunPos[0], p.sunPos[1], p.sunPos[2]);
    }
    sun.color.set(p.sun.color);
    sun.intensity = p.sun.intensity;
    sun.target.position.set(0, 0, 0);
    if (tier.shadows) sun.shadow.intensity = p.shadow;

    hemi.color.set(p.hemi.sky);
    hemi.groundColor.set(p.hemi.ground);
    hemi.intensity = p.hemi.intensity;

    hero1.intensity = heroBase[0] * p.hero;
    hero2.intensity = heroBase[1] * p.hero;

    scene.environmentIntensity = p.env;

    if (!scene.fog) scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);
    else { scene.fog.color.set(p.fog.color); scene.fog.density = p.fog.density; }
    if (scene.background && scene.background.isColor) scene.background.set(p.background);
    else scene.background = new THREE.Color(p.background);

    return p; // scene.js reads .bloom / .overlayGain off the returned preset
  }

  return { setPreset, preset: () => current, sun, hemi, sky };
}

/* assets.js — ONE shared GLTFLoader for the Kenney CC0 kits (vendored at
   /static/vendor/kenney/). Everything loads in parallel behind a Promise
   that NEVER rejects: any individual file that fails resolves to null and
   the caller keeps its procedural fallback silently (the hot-swap contract).

   Colormap note: the vendored glbs reference an EXTERNAL Textures/colormap.png
   that was not shipped with the kit drop. Every model samples the palette as
   8 vertical gradient columns (verified from the files' UV data: wheels=col2,
   glass/trim=col3, per-model paint=cols 4/6/7, cone=col5, building walls=
   cols 0/1, building glass=col3, skyscraper accent=col5). We therefore serve
   GENERATED palette PNGs (canvas → data URI, zero external requests) through
   LoadingManager.setURLModifier — one curated palette per kit directory —
   which keeps the models loadable AND on the arena's art direction (black/
   white cruiser, vivid-orange muscle car, yellow taxi, orange cones, warm
   plaster low-rises, glassy skyline).

   Static placements (buildings, parked cars) get BAKED by world.js into one
   merged geometry per category, so the whole kenney city costs ~3 draw calls. */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const BASE = "/static/vendor/kenney/";

const MANIFEST = {
  police: "police.glb",
  thief: "thief.glb",
  cone: "props/cone.glb",
  interior: ["a", "b", "c", "d", "e", "f", "g"].map((s) => "buildings/building-" + s + ".glb"),
  towers: ["a", "b", "c", "d", "e"].map((s) => "buildings/building-skyscraper-" + s + ".glb"),
  far: ["a", "b", "c", "d", "e", "f"].map((s) => "buildings/low-detail-building-" + s + ".glb"),
  parked: ["sedan", "taxi", "van", "suv-luxury", "hatchback-sports"].map((s) => "parked/" + s + ".glb"),
};

/* ------------------------- generated palette PNGs ------------------------ */
/* 8 columns × vertical gradient; stops are [v, cssColor], v=0 at the top
   (glTF uv convention, flipY=false). Samples concentrate at v ≈ 0.28–0.78. */
const GRAYS = [[0, "#c8ccd2"], [0.5, "#8c9198"], [0.62, "#565b62"], [0.72, "#17181c"], [1, "#0b0c0f"]];
const DARKS = [[0, "#3a4048"], [0.5, "#262a31"], [0.62, "#1c2026"], [0.78, "#0d0f13"], [1, "#0a0b0e"]];
const NEUTRAL = [[0, "#b9b4aa"], [1, "#8f8b82"]];

const PALETTES = {
  cars: [ // police + thief (top-level dir)
    NEUTRAL, NEUTRAL, GRAYS, DARKS,
    [[0, "#f2b71e"], [1, "#c98f12"]],                                   // c4 (unused)
    [[0, "#ff7a1e"], [1, "#e35400"]],                                   // c5 (unused)
    [[0, "#ff7a10"], [0.55, "#f25c00"], [0.615, "#e35400"], [0.62, "#f2f4f6"], [1, "#dfe3e8"]], // c6: thief orange low-v, police white high-v
    [[0, "#2f4668"], [1, "#243550"]],                                   // c7 (unused)
  ],
  parked: [
    NEUTRAL, NEUTRAL, GRAYS, DARKS,
    [[0, "#e8b32a"], [0.5, "#d19a16"], [1, "#a87b10"]],                 // c4: taxi yellow / champagne suv
    [[0, "#ff7a1e"], [1, "#e35400"]],
    [[0, "#b03a2a"], [0.55, "#993024"], [0.62, "#e8eaec"], [1, "#d5d9dd"]], // c6: muted crimson sedans, light band
    [[0, "#39527a"], [0.6, "#2c4162"], [1, "#22334d"]],                 // c7: van navy
  ],
  props: [
    NEUTRAL, NEUTRAL, GRAYS, DARKS,
    [[0, "#e8b32a"], [1, "#a87b10"]],
    [[0, "#ff8626"], [0.45, "#f26a10"], [1, "#d85a08"]],                // c5: cone orange
    [[0, "#f26a10"], [0.5, "#f2f4f6"], [0.7, "#e8eaec"], [1, "#d5d9dd"]], // c6: reflective band
    NEUTRAL,
  ],
  buildings: [
    [[0, "#efe5d2"], [0.5, "#e6dabf"], [0.62, "#dccfb0"], [0.72, "#cfc09a"], [1, "#c2b28a"]], // c0: warm plaster walls
    [[0, "#cf7a52"], [0.5, "#c06a44"], [0.7, "#a85538"], [1, "#96482e"]],                     // c1: brick / awning trim
    GRAYS,
    [[0, "#93a7b8"], [0.56, "#7e93a6"], [0.63, "#667e98"], [0.72, "#4c637e"], [1, "#3c5068"]], // c3: window glass
    NEUTRAL,
    [[0, "#a8865a"], [0.35, "#96764c"], [0.5, "#7c6040"], [1, "#644c32"]],                    // c5: bronze curtain wall
    [[0, "#e8eaec"], [1, "#c9ccd2"]],
    NEUTRAL,
  ],
};

function paintPalette(cols) {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 128;
  const ctx = cv.getContext("2d");
  cols.forEach((stops, k) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    for (const [v, c] of stops) g.addColorStop(v, c);
    ctx.fillStyle = g;
    ctx.fillRect(k * 32, 0, 32, 128);
  });
  return cv.toDataURL("image/png");
}

let paletteUris = null;
function colormapFor(url) {
  if (!paletteUris) {
    paletteUris = {
      cars: paintPalette(PALETTES.cars),
      parked: paintPalette(PALETTES.parked),
      props: paintPalette(PALETTES.props),
      buildings: paintPalette(PALETTES.buildings),
    };
  }
  if (url.indexOf("/buildings/") !== -1) return paletteUris.buildings;
  if (url.indexOf("/parked/") !== -1) return paletteUris.parked;
  if (url.indexOf("/props/") !== -1) return paletteUris.props;
  return paletteUris.cars;
}

/* Collapse a gltf scene into ONE BufferGeometry (world-transform applied,
   attributes normalized to position/normal/uv so categories can merge). */
function flatten(scene) {
  scene.updateMatrixWorld(true);
  const geos = [];
  let material = null;
  scene.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
      }
      geos.push(g);
      if (!material && o.material) material = o.material;
    }
  });
  if (!geos.length) return null;
  const allIndexed = geos.every((g) => g.index !== null);
  const list = allIndexed ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (!geometry) return null;
  geometry.computeBoundingBox();
  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  return { geometry, size, box: geometry.boundingBox.clone(), material };
}

export function loadKenneyAssets() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) =>
    (url.indexOf("Textures/colormap.png") !== -1 ? colormapFor(url) : url));
  const loader = new GLTFLoader(manager);
  const one = (rel) => new Promise((resolve) => {
    loader.load(BASE + rel, (g) => resolve(g), undefined, () => resolve(null));
  });
  const many = (rels) => Promise.all(rels.map(one));

  return Promise.all([
    one(MANIFEST.police), one(MANIFEST.thief), one(MANIFEST.cone),
    many(MANIFEST.interior), many(MANIFEST.towers), many(MANIFEST.far), many(MANIFEST.parked),
  ]).then(([police, thief, cone, interior, towers, far, parked]) => {
    const flatCat = (arr) => arr.map((g) => (g ? flatten(g.scene) : null)).filter((x) => x !== null);
    const out = {
      vehicles: {
        police: police ? police.scene : null,
        thief: thief ? thief.scene : null,
      },
      cone: cone ? flatten(cone.scene) : null,
      interior: flatCat(interior),
      towers: flatCat(towers),
      far: flatCat(far),
      parked: flatCat(parked),
      bakeMaterial: null,     // city-kit palette, vertexColors ON (building bakes)
      bakeCarMaterial: null,  // car-kit palette, vertexColors ON (parked bake)
    };
    const cityDonor = out.interior[0] || out.towers[0] || out.far[0];
    if (cityDonor && cityDonor.material) {
      out.bakeMaterial = cityDonor.material.clone();
      out.bakeMaterial.vertexColors = true;
    }
    const carDonor = out.parked[0];
    if (carDonor && carDonor.material) {
      out.bakeCarMaterial = carDonor.material.clone();
      out.bakeCarMaterial.vertexColors = true;
    }
    return out;
  }).catch(() => null); // never throws into the boot path
}

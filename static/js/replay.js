/* replay.js — the REPLAY CINEMA (ARENA V3). Settled games only: bird's-eye is
   LEGAL here (positions are mutually revealed by the audit protocol) and only
   here. Loads GET /api/replays/{run_id} — or the demo fixture with ?demo=1 —
   and drives the same scene/world/vehicles stack as the live arena: both
   vehicles on TRUE paths (with headings, so CHASE works), barriers as they
   landed, per-step Verified OK / TAMPERED badge, window selector, 0.5/1/4/16x
   scrubber, BELIEF vs TRUTH overlay. V3: full-bleed world, floating glass
   chrome (scrubber bar + collapsible right panels), the shared ESC menu,
   the fresnel/scanline BELIEF hologram, and a chase FOV kick on play.
   Playback clock is a speed-multiplied accumulator — never wall-clock. */

import * as THREE from "three";
import { createArena, qualityFromQuery, cellToWorld } from "./scene.js";
import { createScentLayer, createBarrierPool, makeLabelSprite, holoMaterial, REDUCED } from "./entities.js";
import { createCruiser, createRunner } from "./vehicles.js";
import { loadKenneyAssets } from "./assets.js";
import { gridFromMap } from "./timeline.js";
import { initMenu, wireCollapse } from "./menu.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = params.get("demo") === "1";
const runId = (location.pathname.match(/\/replay\/([^/?#]+)/) || [])[1] || null;
const DOC_URL = demo || !runId ? "/static/fixtures/demo-replay.json" : "/api/replays/" + encodeURIComponent(runId);

const STEP_SEC = 0.7; // seconds per frame at 1x
const PRESET_KEY = "cosmos77.arena.preset";

/* ---------------------------------------------------------------- scaffold */
let preset = "day";
try { if (localStorage.getItem(PRESET_KEY) === "night") preset = "night"; } catch (_e) { /* private mode */ }

const arena = createArena($("stage"), { quality: qualityFromQuery(), preset });
const cruiser = createCruiser(arena.tier);
const runner = createRunner(arena.tier);
const scent = createScentLayer();
const barriers = createBarrierPool();
scent.setTint(0xff8a1e);
scent.setVisible(false); // V2: scent overlay defaults OFF in replay
arena.scene.add(cruiser.group, runner.group, scent.mesh, barriers.mesh);

/* kenney glb hot-swap (silent fallback to procedural on any failure) */
loadKenneyAssets().then((assets) => {
  if (!assets) return;
  arena.upgradeWorld(assets);
  if (assets.vehicles.police) cruiser.swapIn(assets.vehicles.police);
  if (assets.vehicles.thief) runner.swapIn(assets.vehicles.thief);
  if (assets.cone && assets.cone.material) barriers.attachCones(assets.cone.geometry, assets.cone.material);
});

/* the replay ghost marker — V3 fresnel/scanline hologram + ring + label */
const ghostHoloMat = holoMaterial(0x7ad7ff);
const ghostHolo = new THREE.Mesh(
  new THREE.CylinderGeometry(3.05, 3.05, 2.9, 28, 1, true),
  ghostHoloMat,
);
ghostHolo.position.y = 1.47;
const ghostRing = new THREE.Mesh(
  new THREE.RingGeometry(3.0, 3.9, 40),
  new THREE.MeshBasicMaterial({ color: 0x7ad7ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
);
ghostRing.rotation.x = -Math.PI / 2;
ghostRing.position.y = 0.42;
const ghostLabel = makeLabelSprite("BELIEF", "#7ad7ff");
ghostLabel.center.set(0.5, 0);
const ghostGroup = new THREE.Group();
ghostGroup.add(ghostHolo, ghostRing, ghostLabel);
ghostLabel.position.y = 4.6;
arena.scene.add(ghostGroup);

function applyPreset(p) {
  preset = p === "night" ? "night" : "day";
  arena.setPreset(preset);
  scent.setPreset(preset);
  cruiser.setPreset(preset);
  runner.setPreset(preset);
  const day = preset === "day";
  ghostHoloMat.uniforms.uBase.value = day ? 0.14 : 0.08;
  ghostHoloMat.uniforms.uRim.value = day ? 0.62 : 0.42;
  ghostRing.material.opacity = day ? 0.55 : 0.4;
  try { localStorage.setItem(PRESET_KEY, preset); } catch (_e) { /* private mode */ }
  document.querySelectorAll("#dnSeg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
  });
  if (frames.length) paintFrame(k); // repaint overlay tints under the new gain
}

let ghostLine = null, truthLine = null;
function rebuildLines(frames_, lo, hi) {
  for (const l of [ghostLine, truthLine]) {
    if (l) { arena.scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
  }
  const gPts = [], tPts = [];
  for (let i = lo; i <= hi; i += 1) {
    const g = traceGhost(frames_[i]);
    if (Array.isArray(g)) gPts.push(cellToWorld(g[0], g[1], 2.2));
    const t = frames_[i] && frames_[i].thief;
    if (Array.isArray(t)) tPts.push(cellToWorld(t[0], t[1], 1.4));
  }
  ghostLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(gPts.length ? gPts : [new THREE.Vector3(0, -60, 0)]),
    new THREE.LineDashedMaterial({ color: 0x7ad7ff, dashSize: 1.6, gapSize: 1.1, transparent: true, opacity: 0.85, toneMapped: false }),
  );
  ghostLine.computeLineDistances();
  ghostLine.visible = $("tglGhost").getAttribute("aria-pressed") === "true";
  truthLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(tPts.length ? tPts : [new THREE.Vector3(0, -60, 0)]),
    new THREE.LineBasicMaterial({ color: 0xff8a1e, transparent: true, opacity: 0.9, toneMapped: false }),
  );
  truthLine.visible = $("tglTruth").getAttribute("aria-pressed") === "true";
  arena.scene.add(ghostLine, truthLine);
}

/* ---------------------------------------------------------------- document */
let doc = null;
let frames = [];
let perStep = [];
let traceMap = new Map();       // "window,step" (and "*,step") -> {ghost, confidence}
let metaInfo = { gidA: "us", gidB: "them", totals: null, fin: {} };
let winLo = 0, winHi = 0;      // active frame range (window selector)
let k = 0;                      // current frame index
let playing = false;
let speed = 1;
let acc = 0;
const timer = new THREE.Timer(); // r185: Clock is deprecated

/* Belief trace pairs with frames BY STEP, never by array index: the builder
   (hub replay.py) emits belief entries keyed {window, step} from the police
   events tape, and step counts need not match frame indexes (a raw tape holds
   YOUR TURN + LOCKED lines per step). Later entries for the same (window,step)
   overwrite earlier ones, so the LOCKED post-turn view wins — same rule as the
   builder's scent index. Fixture traces without a window key fall back to a
   step-only key. */
function indexTrace(rows) {
  const m = new Map();
  for (const t of rows || []) {
    if (!t || t.step == null || !isFinite(Number(t.step))) continue;
    const entry = { ghost: Array.isArray(t.ghost) ? t.ghost : null, confidence: t.confidence };
    const step = Number(t.step);
    if (t.window != null && isFinite(Number(t.window))) m.set(Number(t.window) + "," + step, entry);
    else m.set("*," + step, entry);
  }
  return m;
}

function traceEntry(f) {
  if (!f) return null;
  return traceMap.get(Number(f.window) + "," + Number(f.step)) ||
    traceMap.get("*," + Number(f.step)) || null;
}

function traceGhost(f) {
  const t = traceEntry(f);
  return t && Array.isArray(t.ghost) ? t.ghost : null;
}

function windowsOf() {
  const seen = [];
  for (const f of frames) if (!seen.includes(f.window)) seen.push(f.window);
  return seen;
}

function setWindow(w) {
  const idx = frames.map((f, i) => [f.window, i]).filter(([win]) => win === w).map(([, i]) => i);
  winLo = idx.length ? idx[0] : 0;
  winHi = idx.length ? idx[idx.length - 1] : frames.length - 1;
  $("scrub").min = String(winLo);
  $("scrub").max = String(winHi);
  rebuildLines(frames, winLo, winHi);
  seek(winLo);
  arena.cameras.reframe(); // V2: auto-reframe TOP on window change
  document.querySelectorAll("#windowSeg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.w) === w));
  });
}

function hitRateUpTo(i) {
  let hits = 0, n = 0;
  for (let j = winLo; j <= i; j += 1) {
    const g = traceGhost(frames[j]); // step-paired, never index-paired
    const t = frames[j] && frames[j].thief;
    if (Array.isArray(g) && Array.isArray(t)) {
      n += 1;
      if (g[0] === t[0] && g[1] === t[1]) hits += 1;
    }
  }
  return n ? Math.round((hits / n) * 100) : 0;
}

/* shortest-arc heading write so cars FACE their travel (chase needs this) */
function setHeading(group, from, to) {
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return;
  const a = cellToWorld(from[0], from[1], 0), b = cellToWorld(to[0], to[1], 0);
  group.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
}

function paintFrame(i, lerpFrom = null, lerpK = 1) {
  const f = frames[i];
  if (!f) return;
  const cop = Array.isArray(f.cop) ? f.cop : [0, 0];
  const thief = Array.isArray(f.thief) ? f.thief : null;
  const target = cellToWorld(cop[0], cop[1], 0);
  if (lerpFrom && lerpFrom.cop) {
    cruiser.group.position.lerpVectors(cellToWorld(lerpFrom.cop[0], lerpFrom.cop[1], 0), target, lerpK);
    setHeading(cruiser.group, lerpFrom.cop, cop);
  } else cruiser.group.position.copy(target);
  if (thief) {
    const tt = cellToWorld(thief[0], thief[1], 0);
    if (lerpFrom && lerpFrom.thief) {
      runner.group.position.lerpVectors(cellToWorld(lerpFrom.thief[0], lerpFrom.thief[1], 0), tt, lerpK);
      setHeading(runner.group, lerpFrom.thief, thief);
    } else runner.group.position.copy(tt);
    runner.group.visible = true;
  } else runner.group.visible = false;

  barriers.sync(f.barriers || []);
  scent.setTargets(gridFromMap(f.scent));

  const g = traceGhost(f); // this frame's OWN step, wherever it sits in the array
  if (Array.isArray(g)) {
    const gp = cellToWorld(g[0], g[1], 0);
    ghostGroup.visible = $("tglGhost").getAttribute("aria-pressed") === "true";
    ghostGroup.position.set(gp.x, 0, gp.z);
  } else ghostGroup.visible = false;

  // overlay tint: barriers red; tampered step floods siren red
  arena.overlay.clear();
  for (const b of f.barriers || []) arena.overlay.set(b[0], b[1], 0xff3b30, 0.25);
  const ok = perStep[i] !== false && f.commit_ok !== false;
  if (!ok) for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) arena.overlay.set(r, c, 0xff3b3b, 0.05);
  arena.overlay.commit();

  // chrome
  const badge = $("verifyBadge");
  badge.textContent = ok ? "VERIFIED OK" : "TAMPERED";
  badge.className = "badge " + (ok ? "ok" : "bad");
  $("stepLine").textContent = `window ${f.window} · step ${f.step} · frame ${i - winLo + 1}/${winHi - winLo + 1}` + (f.hint ? ` · “${String(f.hint).slice(0, 40)}”` : "");
  $("hitrate").textContent = hitRateUpTo(i) + "%";
  $("scrub").value = String(i);
}

function seek(i) {
  k = Math.max(winLo, Math.min(winHi, i));
  paintFrame(k);
  if (k === winHi) showEndcard(); else hideEndcard();
}

/* ------------------------------------------------------------- end card */
let endShown = false;
function showEndcard() {
  $("endcard").style.display = "";
  if (endShown) return;
  endShown = true;
  const meta = doc.meta || {};
  const verdict = (doc.verify && doc.verify.verdict) || "Verified OK";
  const s = meta.score || {};
  // real hub docs carry gid-keyed final_result.total_score, no us/them meta
  const scoreTxt = (s.us != null || s.them != null)
    ? `${s.us ?? "?"} – ${s.them ?? "?"}`
    : (metaInfo.totals
      ? `${metaInfo.gidA} ${metaInfo.totals[metaInfo.gidA] ?? "?"} – ${metaInfo.gidB} ${metaInfo.totals[metaInfo.gidB] ?? "?"}`
      : "? – ?");
  const word = meta.verdict ||
    (metaInfo.fin.winner_group ? `${String(metaInfo.fin.winner_group).toUpperCase()} WINS` :
      metaInfo.fin.series_tie ? "SERIES TIED" :
        (verdict === "Verified OK" ? "SERIES SEALED" : "TAMPERED"));
  const el = $("slamWord");
  el.textContent = word;
  el.className = "word " + (String(word).includes("ESCAP") ? "escaped" : String(word).includes("BUST") ? "" : "series");
  $("slamDetail").textContent = `${scoreTxt} · ${verdict}`;
  $("slam").classList.add("show");
  setTimeout(() => $("slam").classList.remove("show"), 3200);
}
function hideEndcard() { endShown = false; }

/* --------------------------------------------------------------- controls */
function setSpeed(x) {
  speed = x;
  document.querySelectorAll("#speedSeg button").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.x) === x));
  });
}
$("btnPlay").addEventListener("click", () => {
  playing = !playing;
  if (playing && k >= winHi) seek(winLo);
  if (playing) arena.cameras.kick(); // V3: chase FOV kick as motion starts
  $("btnPlay").textContent = playing ? "❚❚ PAUSE" : "▶ PLAY";
});
$("scrub").addEventListener("input", (e) => { playing = false; $("btnPlay").textContent = "▶ PLAY"; seek(Number(e.target.value)); });
document.querySelectorAll("#speedSeg button").forEach((b) => {
  b.addEventListener("click", () => setSpeed(Number(b.dataset.x)));
});
$("tglGhost").addEventListener("click", (e) => {
  const on = e.target.getAttribute("aria-pressed") !== "true";
  e.target.setAttribute("aria-pressed", String(on));
  if (ghostLine) ghostLine.visible = on;
  ghostGroup.visible = on && ghostGroup.visible;
  if (!playing) paintFrame(k);
});
$("tglTruth").addEventListener("click", (e) => {
  const on = e.target.getAttribute("aria-pressed") !== "true";
  e.target.setAttribute("aria-pressed", String(on));
  if (truthLine) truthLine.visible = on;
});
$("tglScent").addEventListener("click", (e) => {
  const on = e.target.getAttribute("aria-pressed") !== "true";
  e.target.setAttribute("aria-pressed", String(on));
  scent.setVisible(on);
});
/* V2: "▶ ENDING" chip — seek to 3 frames before the window end, play at 1x */
$("btnEnding").addEventListener("click", () => {
  setSpeed(1);
  acc = 0;
  seek(Math.max(winLo, winHi - 3));
  playing = true;
  $("btnPlay").textContent = "❚❚ PAUSE";
});
/* V2: camera segment — TOP / CHASE COP / CHASE THIEF (legal: settled game) */
document.querySelectorAll("#camSeg button").forEach((b) => {
  b.addEventListener("click", () => {
    const m = b.dataset.cam;
    if (m === "top") arena.cameras.setMode("top");
    else {
      arena.cameras.setChaseTarget(m === "thief" ? runner.group : cruiser.group);
      arena.cameras.setMode("chase");
    }
    document.querySelectorAll("#camSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  });
});
/* V2: DAY / NIGHT segment */
document.querySelectorAll("#dnSeg button").forEach((b) => {
  b.addEventListener("click", () => applyPreset(b.dataset.preset));
});

arena.cameras.setChaseTarget(cruiser.group);
applyPreset(preset);
initMenu({ page: "replay" });
wireCollapse(document);

/* ------------------------------------------------------------------ loop */
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const rawDt = Math.min(timer.getDelta(), 0.1);
  const dt = rawDt * speed;           // speed-multiplied accumulator
  if (playing && frames.length) {
    acc += dt;
    while (acc >= STEP_SEC && k < winHi) { acc -= STEP_SEC; k += 1; }
    if (k >= winHi) {
      paintFrame(k);
      playing = false; $("btnPlay").textContent = "▶ PLAY"; showEndcard();
    } else {
      // authoritative state is frame k; vehicles glide INTO it from k-1
      const lerpK = REDUCED ? 1 : Math.min(1, acc / STEP_SEC);
      paintFrame(k, k > winLo ? frames[k - 1] : null, lerpK);
    }
  }
  cruiser.update(dt, timer.getElapsed());
  runner.update(dt, timer.getElapsed());
  scent.update(dt);
  barriers.update(Math.max(dt, rawDt));
  if (ghostGroup.visible) {
    ghostHoloMat.uniforms.uTime.value = REDUCED ? 0 : timer.getElapsed();
    if (!REDUCED) {
      const p = 0.92 + 0.1 * Math.sin(timer.getElapsed() * 5);
      ghostGroup.scale.set(p, 1, p);
    }
  }
  arena.cameras.update(rawDt, null);
  arena.render(rawDt);
}

/* ------------------------------------------------------------------ boot */
fetch(DOC_URL, { headers: { Accept: "application/json" }, cache: "no-store" })
  .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then((d) => {
    doc = d;
    frames = Array.isArray(d.frames) ? d.frames : [];
    traceMap = indexTrace(Array.isArray(d.belief_trace) ? d.belief_trace : []);
    perStep = (d.verify && Array.isArray(d.verify.per_step)) ? d.verify.per_step : [];
    const meta = d.meta || {};
    // real hub docs: meta = {run_id, game_id, game_uid, windows, final_result};
    // gids come from the gid-keyed totals (fixture meta gid_a/gid_b wins)
    metaInfo.fin = meta.final_result && typeof meta.final_result === "object" ? meta.final_result : {};
    metaInfo.totals = metaInfo.fin.total_score && typeof metaInfo.fin.total_score === "object"
      ? metaInfo.fin.total_score : null;
    const gids = metaInfo.totals ? Object.keys(metaInfo.totals) : [];
    metaInfo.gidA = meta.gid_a || gids[0] || "us";
    metaInfo.gidB = meta.gid_b || gids[1] || "them";
    $("metaPill").textContent =
      (demo || !runId ? "demo fixture · " : "") +
      `${metaInfo.gidA} vs ${metaInfo.gidB} · ${frames.length} frames`;
    $("verdictLine").textContent = "series verdict: " + ((d.verify && d.verify.verdict) || "?");
    const tbody = $("scoreTable").querySelector("tbody");
    tbody.innerHTML = "";
    const rows = (meta.per_window || []).map((w) => (
      [String(w.window), String(w.result || "—"), String(w.us ?? "—"), String(w.them ?? "—")]
    ));
    if (!rows.length && metaInfo.totals) { // hub docs: one totals row (gid-keyed)
      rows.push(["Σ", metaInfo.fin.winner_group ? `winner ${metaInfo.fin.winner_group}` : "series",
        String(metaInfo.totals[metaInfo.gidA] ?? "—"), String(metaInfo.totals[metaInfo.gidB] ?? "—")]);
    }
    for (const cols of rows) {
      const tr = document.createElement("tr");
      cols.forEach((txt, ci) => {
        const td = document.createElement("td");
        td.textContent = txt;
        if (ci === 2) td.className = "r-us";
        if (ci === 3) td.className = "r-them";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    const seg = $("windowSeg");
    for (const w of windowsOf()) {
      const b = document.createElement("button");
      b.dataset.w = String(w);
      b.textContent = "W" + w;
      b.addEventListener("click", () => setWindow(w));
      seg.appendChild(b);
    }
    const first = windowsOf()[0];
    if (first !== undefined) setWindow(first);
    frame();
  })
  .catch((e) => {
    $("metaPill").textContent = "replay unavailable — " + e.message + (runId ? "" : " (no run id; try ?demo=1)");
    $("metaPill").className = "chip-sub mono warn";
    frame();
  });

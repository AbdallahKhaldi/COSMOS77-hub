/* hud.js — the DOM layer (never WebGL), ARENA V3: every element floats over
   the full-viewport world as a glass cluster. This module owns the in-game
   HUD: status chip (LIVE / DEMO REEL + run label), YOUR TURN / LOCKED banner,
   the mandated 2D belief heatmap (doubles as the top-down minimap: self,
   barriers, posterior) inside the collapsible bottom-left tactical panel,
   perceived-scent toggle, wanted stars, compact score strip + window pips,
   and the bottom-center one-line strip that interleaves radio intercepts
   with commit-hash seals. The ESC menu lives in menu.js. Local truth only —
   the heatmap renders OUR posterior, never an opponent position. */

import { GRID, gridFromMap, windowEndInfo, seriesVerdict } from "./timeline.js";

const $ = (id) => document.getElementById(id);

const STRIP_EVERY_MS = 4000; // interleave cadence for radio/seal lines
const STRIP_KEEP = 12;

function fmtHash(h) { return h ? h.slice(0, 12) : ""; }

export function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

export function wireCopyButtons(scope) {
  (scope || document).querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const text = btn.getAttribute("data-copy") ||
        (btn.previousElementSibling && btn.previousElementSibling.textContent) || "";
      navigator.clipboard && navigator.clipboard.writeText(text).then(
        () => toast("COPIED"),
        () => toast("COPY BLOCKED"),
      );
    });
  });
}

export function createHud({ perspective, onPerspective, onMode }) {
  const els = {
    dot: $("dot"), statustext: $("statustext"),
    truthLabel: $("truthLabel"), truthRole: $("truthRole"),
    banner: $("banner"), pill: $("linkPill"), wanted: $("wanted"),
    slam: $("slam"), slamWord: $("slamWord"), slamDetail: $("slamDetail"),
    heatmap: $("heatmap"), hmLegend: $("hmLegend"),
    stripTag: $("stripTag"), stripLine: $("stripLine"),
    scoreUs: $("scoreUs"), scoreThem: $("scoreThem"),
    nameUs: $("nameUs"), nameThem: $("nameThem"), pips: $("pips"),
    windowLine: $("windowLine"),
    hero: $("hero"), tacpanel: $("tacpanel"),
  };

  /* build the 49-cell heatmap grid once */
  const cells = [];
  for (let i = 0; i < GRID * GRID; i += 1) {
    const d = document.createElement("div");
    d.className = "cell";
    els.heatmap.appendChild(d);
    cells.push(d);
  }

  let panelLayer = "belief";        // belief | scent (heatmap panel view)
  let scent3d = true;
  let starsHot = false;
  let mode = "attract";
  let source = "live";              // live | demo (the START button flips this)
  let linkState = "open";
  let runId = null;

  /* -------- the one-line strip: radio + commit seals, interleaved -------- */
  const stripQ = [];                // [{tag, cls, text}]
  let stripIdx = 0;
  let lastHintText = null;
  let lastCommitHash = null;

  function stripShow(entry) {
    if (!entry) return;
    els.stripTag.textContent = entry.tag;
    els.stripTag.className = "strip-tag" + (entry.cls ? " " + entry.cls : "");
    els.stripLine.classList.remove("roll");
    void els.stripLine.offsetWidth; // restart the slide-in
    els.stripLine.textContent = entry.text;
    els.stripLine.classList.add("roll");
  }

  function stripPush(tag, cls, text) {
    stripQ.push({ tag, cls, text });
    if (stripQ.length > STRIP_KEEP) stripQ.shift();
    stripIdx = stripQ.length - 1;
    stripShow(stripQ[stripIdx]);
  }

  setInterval(() => { // alternate through recent lines, unobtrusively
    if (stripQ.length < 2) return;
    stripIdx = (stripIdx + 1) % stripQ.length;
    stripShow(stripQ[stripIdx]);
  }, STRIP_EVERY_MS);

  function sysLine(text) {
    stripPush("SYS", "", text);
  }

  /* ------------------------------ chrome bits ---------------------------- */
  function setPerspectiveChrome(p) {
    const police = p === "police";
    els.truthRole.textContent = police ? "POLICE PERSPECTIVE" : "THIEF PERSPECTIVE";
    els.truthLabel.classList.toggle("thief", !police);
    els.heatmap.classList.toggle("thief-view", !police);
    els.nameUs.textContent = police ? "COSMOS77 · POLICE" : "COSMOS77 · THIEF";
    els.nameThem.textContent = "OPPONENT (BELIEF ONLY)";
    document.querySelectorAll("#perspectiveSeg button").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.p === p));
    });
  }
  setPerspectiveChrome(perspective);

  function renderChip() {
    if (mode === "live") {
      els.statustext.textContent = source === "demo" ? "DEMO REEL" : "● LIVE — LOCAL TRUTH";
      els.dot.className = "dot live";
    } else {
      els.statustext.textContent = source === "demo" ? "DEMO REEL — STANDBY" : "STANDBY — AWAITING RUN";
      els.dot.className = "dot";
    }
    if (linkState === "reconnecting") {
      els.pill.textContent = "reconnecting…";
      els.pill.className = "chip-sub mono warn";
      els.dot.className = "dot down";
    } else {
      els.pill.className = "chip-sub mono" + (source === "demo" ? " demo" : "");
      if (mode === "live" && runId) {
        els.pill.textContent = (source === "demo" ? "fixture · run " : "run ") + runId;
      } else if (source === "demo") {
        els.pill.textContent = "demo fixture — same path as the live feed";
      } else {
        els.pill.textContent = "attract mode — no run live";
      }
    }
  }

  /* ------------------------------- renders -------------------------------- */
  function renderHeatmap(state) {
    const v = state.view;
    const belief = v ? gridFromMap(v.posterior) : new Float64Array(GRID * GRID);
    const scent = v ? gridFromMap(v.perceived_scent) : new Float64Array(GRID * GRID);
    const barrierSet = new Set(
      v && Array.isArray(v.barriers) ? v.barriers.map((b) => b[0] * GRID + b[1]) : [],
    );
    const selfIdx = v && Array.isArray(v.self_pos) ? v.self_pos[0] * GRID + v.self_pos[1] : -1;
    const exact = v && v.confidence === "exact";
    let peakI = -1, peak = 0;
    for (let i = 0; i < GRID * GRID; i += 1) if (belief[i] > peak) { peak = belief[i]; peakI = i; }

    for (let i = 0; i < GRID * GRID; i += 1) {
      const d = cells[i];
      let bg = "";
      if (panelLayer === "belief") {
        const p = Math.min(1, belief[i] * 1.6);
        if (p > 0.01) bg = `rgba(122,215,255,${(0.08 + p * 0.6).toFixed(3)})`;
      } else {
        const s = Math.min(1, scent[i]);
        if (s > 0.01) bg = `rgba(255,138,30,${(0.08 + s * 0.6).toFixed(3)})`;
      }
      d.style.background = bg;
      d.className = "cell" +
        (i === selfIdx ? " self" : "") +
        (barrierSet.has(i) ? " barrier" : "") +
        (panelLayer === "belief" && exact && i === peakI ? " exact" : "");
    }
    els.hmLegend.innerHTML = panelLayer === "belief"
      ? `<span>POSTERIOR P(OPPONENT)</span><span>${v ? "confidence: " + escapeHtml(String(v.confidence || "none")) : "no data"}</span>`
      : `<span>PERCEIVED SCENT</span><span>authoritative field</span>`;
  }

  function renderStripFeeds(state) {
    const v = state.view;
    const hints = v && Array.isArray(v.hints) ? v.hints : [];
    if (hints.length) {
      const latest = String(hints[hints.length - 1]);
      if (latest !== lastHintText) {
        lastHintText = latest;
        const who = state.perspective === "police" ? "🚗 ROGUE" : "🚓 DETECTIVE";
        stripPush("RADIO", "", who + " · " + latest);
      }
    }
    const commits = state.commits;
    if (commits.length) {
      const c = commits[commits.length - 1];
      if (c.hash !== lastCommitHash) {
        lastCommitHash = c.hash;
        stripPush("SEAL", "seal", fmtHash(c.hash) + "… · step " + c.step + " · SHA-256 SEALED");
      }
    }
  }

  function renderScores(state) {
    els.scoreUs.textContent = String(state.scores.us);
    els.scoreThem.textContent = String(state.scores.them);
    els.pips.innerHTML = "";
    for (let w = 1; w <= state.windowsTotal; w += 1) {
      const pip = document.createElement("span");
      const done = state.pips.find((p) => p.window === w);
      pip.className = "pip" +
        (done ? (done.winner === "us" ? " us" : done.winner === "them" ? " them" : " tie") : "") +
        (!done && w === state.currentWindow && state.view ? " live" : "");
      pip.title = done ? `window ${w}: ${done.us}–${done.them}` : `window ${w}`;
      els.pips.appendChild(pip);
    }
    const v = state.view;
    els.windowLine.textContent = v
      ? `W${state.currentWindow}/${state.windowsTotal} · STEP ${v.step ?? 0}/35 · BARRIERS ${v.barriers_left ?? "—"}`
      : `awaiting engagement`;
  }

  function renderBanner(state) {
    const v = state.view;
    if (!v) { els.banner.textContent = "STANDBY"; els.banner.classList.add("locked"); return; }
    const yours = v.banner === "YOUR TURN";
    els.banner.textContent = v.banner || "…";
    els.banner.classList.toggle("locked", !yours);
  }

  function renderStars(state) {
    const exact = !!(state.view && state.view.confidence === "exact");
    if (exact === starsHot) return;
    starsHot = exact;
    els.wanted.classList.toggle("hot", exact);
    els.wanted.setAttribute("aria-label", exact ? "belief locked: wanted" : "belief diffuse");
  }

  function slam(word, cls, detail) {
    els.slamWord.textContent = word;
    els.slamWord.className = "word " + (cls || "");
    els.slamDetail.textContent = detail || "";
    els.slam.classList.add("show");
    setTimeout(() => els.slam.classList.remove("show"), 3400);
  }

  function renderEventFlourish(state, env) {
    if (!env) return;
    if (env.type === "window_end") {
      const p = env.payload || {};
      const info = windowEndInfo(p, state.pips.length); // hub OR fixture dialect
      const res = String(p.result || "").toLowerCase();
      if (res.includes("capture")) slam("BUSTED", "", `window ${info.window} sealed`);
      else if (res.includes("surviv")) slam("ESCAPED", "escaped", `window ${info.window} sealed`);
      else slam("WINDOW SEALED", "series", `window ${info.window}`);
      sysLine(`// window ${info.window} settled — ${info.us}–${info.them}`);
    } else if (env.type === "series_end") {
      const p = env.payload || {};
      slam("SERIES COMPLETE", "series", `${state.scores.us} – ${state.scores.them} · ${seriesVerdict(p)}`);
      sysLine("// series settled — replay unlocked");
    } else if (env.type === "status" && env.payload && env.payload.line) {
      sysLine("// " + env.payload.line);
    } else if (env.type === "status" && env.payload && env.payload.state) {
      // hub-dialect operational status: {state:"running"|"standing", run_id?…}
      sysLine("// " + (env.payload.state === "running"
        ? `run ${env.payload.run_id || ""} live — local truth streaming`
        : "agents standing by"));
    }
  }

  function setMode(m) {
    mode = m;
    if (els.hero) els.hero.classList.toggle("hidden", m !== "attract");
    const resume = document.getElementById("menuResume");
    if (resume) resume.hidden = m === "attract"; // nothing to resume in attract
    renderChip();
    if (onMode) onMode(m);
  }

  return {
    showSlam: slam,
    render(state, meta) {
      runId = state.runId;
      renderBanner(state);
      renderHeatmap(state);
      renderStripFeeds(state);
      renderScores(state);
      renderStars(state);
      renderChip();
      // Flourishes (slam banner + strip pushes) fire only for FRESH events.
      // Catch-up deliveries (demo-tape resume after a perspective switch) are
      // marked catchup:true by the fake socket — replaying a WINDOW SEALED /
      // SERIES COMPLETE slam for events the viewer already lived through would
      // be a re-announcement of old news. Deep live backlogs (tab restore)
      // are also compressed silently; <=3 matches the director's normal tier.
      if (meta && meta.env && !meta.catchup && !(meta.backlog > 3)) {
        renderEventFlourish(state, meta.env);
      }
    },
    setMode,
    /* live socket vs demo fixture — flips the chip labels */
    setSource(s) {
      source = s === "demo" ? "demo" : "live";
      lastHintText = null;
      renderChip();
    },
    setLink(s) {
      if (s === "reconnecting" || s === "open") { linkState = s; renderChip(); }
    },
    setPerspectiveChrome,
    sysLine,
    toast,
    wireChrome() {
      // heatmap panel layer seg
      document.querySelectorAll("#hmSeg button").forEach((b) => {
        b.addEventListener("click", () => {
          panelLayer = b.dataset.layer;
          document.querySelectorAll("#hmSeg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        });
      });
      // 3D perceived-scent toggle (state read by the page glue via event)
      const tgl = $("tglScent");
      tgl.addEventListener("click", () => {
        scent3d = !scent3d;
        tgl.setAttribute("aria-pressed", String(scent3d));
        tgl.dispatchEvent(new CustomEvent("scent-toggle", { bubbles: true, detail: scent3d }));
      });
      // perspective switcher — the FEED seg (chase from the cop or the thief)
      document.querySelectorAll("#perspectiveSeg button").forEach((b) => {
        b.addEventListener("click", () => {
          if (b.getAttribute("aria-pressed") === "true") return;
          onPerspective(b.dataset.p);
        });
      });
      // collapsible tactical panel — one tap folds it to a small chip
      const tacToggle = $("tacToggle");
      if (tacToggle && els.tacpanel) {
        const setCollapsed = (c) => {
          els.tacpanel.classList.toggle("collapsed", c);
          tacToggle.setAttribute("aria-expanded", String(!c));
          tacToggle.title = (c ? "expand" : "collapse") + " the tactical panel";
        };
        tacToggle.addEventListener("click", () =>
          setCollapsed(!els.tacpanel.classList.contains("collapsed")));
        if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) {
          setCollapsed(true); // phones boot with the map chip, world stays clear
        }
      }
      wireCopyButtons(document);
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

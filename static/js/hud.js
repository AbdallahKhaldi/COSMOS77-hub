/* hud.js — the DOM layer (never WebGL): YOUR TURN / LOCKED banner, the
   mandated 2D belief heatmap (doubles as the top-down minimap: self,
   barriers, posterior), perceived-scent toggle, radio/hints ticker,
   commit-hash ticker, score strip + window pips, wanted-stars flourish,
   challenge drawer, endpoints with copy buttons. Local truth only — the
   heatmap renders OUR posterior, never an opponent position. */

import { GRID, gridFromMap } from "./timeline.js";
import { getJSON, postJSON } from "./net.js";

const $ = (id) => document.getElementById(id);

function fmtHash(h) { return h ? h.slice(0, 12) : ""; }

function toast(msg) {
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

export function createHud({ perspective, demo, onPerspective }) {
  const els = {
    dot: $("dot"), statustext: $("statustext"),
    truthLabel: $("truthLabel"), truthRole: $("truthRole"),
    banner: $("banner"), pill: $("linkPill"), wanted: $("wanted"),
    slam: $("slam"), slamWord: $("slamWord"), slamDetail: $("slamDetail"),
    heatmap: $("heatmap"), hmLegend: $("hmLegend"),
    ticker: $("ticker"), commits: $("commits"),
    scoreUs: $("scoreUs"), scoreThem: $("scoreThem"),
    nameUs: $("nameUs"), nameThem: $("nameThem"), pips: $("pips"),
    windowLine: $("windowLine"),
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
  let lastHintCount = -1;
  let lastCommitCount = -1;
  let starsHot = false;

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

  function renderTicker(state) {
    const v = state.view;
    const hints = v && Array.isArray(v.hints) ? v.hints : [];
    if (hints.length === lastHintCount) return;
    lastHintCount = hints.length;
    els.ticker.innerHTML = "";
    const who = state.perspective === "police" ? "🚗 ROGUE" : "🚓 DETECTIVE";
    hints.slice(-8).reverse().forEach((h) => {
      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML = `<span class="who">${who}</span> · ${escapeHtml(String(h))}`;
      els.ticker.appendChild(line);
    });
    if (!hints.length) sysLine("// comms channel open — awaiting intercepts");
  }

  function sysLine(text) {
    const line = document.createElement("div");
    line.className = "line sys";
    line.textContent = text;
    els.ticker.prepend(line);
    while (els.ticker.children.length > 10) els.ticker.lastChild.remove();
  }

  function renderCommits(state) {
    if (state.commits.length === lastCommitCount) return;
    lastCommitCount = state.commits.length;
    els.commits.innerHTML = "";
    if (!state.commits.length) {
      els.commits.innerHTML = '<div class="c"><span class="h">— no sealed moves yet —</span></div>';
      return;
    }
    state.commits.slice(-6).reverse().forEach((c) => {
      const row = document.createElement("div");
      row.className = "c";
      row.innerHTML = `<span class="h">${escapeHtml(fmtHash(c.hash))}…</span><span class="s">step ${escapeHtml(String(c.step))} · SHA-256 SEALED</span>`;
      els.commits.appendChild(row);
    });
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
      ? `window ${state.currentWindow} / ${state.windowsTotal} · step ${v.step ?? 0} / 35 · barriers left ${v.barriers_left ?? "—"}`
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
      const res = String(p.result || "").toLowerCase();
      if (res.includes("capture")) slam("BUSTED", "", `window ${p.window ?? state.pips.length} sealed`);
      else if (res.includes("surviv")) slam("ESCAPED", "escaped", `window ${p.window ?? state.pips.length} sealed`);
      else slam("WINDOW SEALED", "series", `window ${p.window ?? state.pips.length}`);
      sysLine(`// window ${p.window ?? "?"} settled — ${p.us ?? "?"}–${p.them ?? "?"}`);
    } else if (env.type === "series_end") {
      const p = env.payload || {};
      slam("SERIES COMPLETE", "series", `${state.scores.us} – ${state.scores.them} · ${p.verdict || "settled"}`);
      sysLine("// series settled — replay unlocked");
    } else if (env.type === "status" && env.payload && env.payload.line) {
      sysLine("// " + env.payload.line);
    }
  }

  return {
    render(state, meta) {
      renderBanner(state);
      renderHeatmap(state);
      renderTicker(state);
      renderCommits(state);
      renderScores(state);
      renderStars(state);
      if (meta && meta.env) renderEventFlourish(state, meta.env);
    },
    setMode(mode) {
      if (mode === "attract") {
        els.statustext.textContent = demo ? "DEMO REEL — FIXTURE FEED" : "SYSTEM READY — AWAITING ENGAGEMENT";
        els.dot.className = "dot";
        els.pill.textContent = demo ? "demo fixture" : "attract mode — no run live";
        els.pill.className = "pill" + (demo ? " demo" : "");
      } else {
        els.statustext.textContent = "● LIVE — LOCAL TRUTH FEED";
        els.dot.className = "dot live";
        els.pill.textContent = demo ? "demo fixture (live path)" : "live";
        els.pill.className = "pill" + (demo ? " demo" : "");
      }
    },
    setLink(linkState) {
      if (linkState === "reconnecting") {
        els.pill.textContent = "reconnecting…";
        els.pill.className = "pill warn";
        els.dot.className = "dot down";
      } else if (linkState === "open") {
        els.pill.className = "pill" + (demo ? " demo" : "");
        els.pill.textContent = demo ? "demo fixture" : "link up";
      }
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
          lastHintCount = -1; // force repaint
        });
      });
      // 3D perceived-scent toggle (state read by the page glue via event)
      const tgl = $("tglScent");
      tgl.addEventListener("click", () => {
        scent3d = !scent3d;
        tgl.setAttribute("aria-pressed", String(scent3d));
        tgl.dispatchEvent(new CustomEvent("scent-toggle", { bubbles: true, detail: scent3d }));
      });
      // perspective switcher
      document.querySelectorAll("#perspectiveSeg button").forEach((b) => {
        b.addEventListener("click", () => {
          if (b.getAttribute("aria-pressed") === "true") return;
          onPerspective(b.dataset.p);
        });
      });
      wireCopyButtons(document);
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/* ------------------------- challenge drawer + endpoints ------------------- */
export async function initChrome() {
  // our two endpoint URLs (from /api/status) with copy buttons
  try {
    const st = await getJSON("/api/status");
    const eps = (st && (st.endpoints || st.urls)) || {};
    const cop = eps.cop || eps.cop_url || "";
    const thief = eps.thief || eps.thief_url || "";
    if (cop) { $("epCop").textContent = cop; $("epCopBtn").setAttribute("data-copy", cop); }
    if (thief) { $("epThief").textContent = thief; $("epThiefBtn").setAttribute("data-copy", thief); }
    const line = st && (st.line || (st.agents ? `cop ${st.agents.cop || "?"} · thief ${st.agents.thief || "?"}` : ""));
    if (line) $("statustext").textContent = String(line).toUpperCase();
  } catch (_e) {
    $("epCop").textContent = "(backend offline — endpoints unavailable)";
    $("epThief").textContent = "(backend offline — endpoints unavailable)";
  }

  // ENGAGE — POST /api/challenge
  const go = $("chGo");
  if (!go) return;
  go.addEventListener("click", async () => {
    const single = $("chSingle").value.trim();
    const body = {
      kind: document.querySelector("#chKind button[aria-pressed='true']").dataset.kind,
      opponent_gid: $("chGid").value.trim() || "challenger",
      their_cop_url: single ? null : $("chCop").value.trim() || null,
      their_thief_url: single ? null : $("chThief").value.trim() || null,
      their_single_url: single || null,
    };
    const out = $("chResult");
    go.disabled = true;
    out.innerHTML = '<span class="mono c-road">dialing…</span>';
    try {
      const res = await postJSON("/api/challenge", body);
      const watch = res.watch_url || "/";
      out.innerHTML =
        `<div class="urlrow"><span class="tag cop">WATCH</span><code>${escapeHtml(watch)}</code>` +
        `<button class="btn btn--copy" data-copy="${escapeHtml(watch)}">COPY</button></div>` +
        `<p class="sub mono">run ${escapeHtml(res.run_id || "?")} accepted — the bodycam goes live when the handshake lands.</p>`;
      wireCopyButtons(out);
    } catch (e) {
      const msg = (e.data && (e.data.detail || e.data.error)) || e.message;
      out.innerHTML = `<p class="sub c-siren mono">refused: ${escapeHtml(String(msg))}</p>`;
    } finally {
      go.disabled = false;
    }
  });
  document.querySelectorAll("#chKind button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#chKind button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
  });
}

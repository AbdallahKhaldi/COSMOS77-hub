/* timeline.js — authoritative event log + the ONE shared reducer (applyEvent).
   Used by live mode, reconnect catch-up, snapshot rebuild, demo fixtures and
   the replay scrubber, so every path renders pixel-identically.
   Pure logic: no THREE, no DOM. Envelope contract (hub-assigned):
   {seq:int, ts:float, run_id:str, perspective:"police"|"thief",
    type:"view"|"window_end"|"series_end"|"status"|"snapshot", payload:{...}}
   NOTE: seq is monotonic per RUN across BOTH perspectives; a one-perspective
   socket legitimately sees gaps — so ordering is a monotonic filter only,
   never gap-waiting. */

export const GRID = 7;
export const WINDOWS_DEFAULT = 6;

export function initialState(perspective = "police") {
  return {
    runId: null,
    perspective,
    view: null,            // latest view payload, verbatim local truth
    scores: { us: 0, them: 0 },
    windowsTotal: WINDOWS_DEFAULT,
    currentWindow: 1,
    pips: [],              // [{window, winner:"us"|"them"|"tie", us, them}]
    series: null,          // series_end payload once settled
    status: null,          // latest operational status payload
    commits: [],           // [{step, hash}] — newest last, capped
    lastSeq: 0,
  };
}

function num(x, fb = 0) { return typeof x === "number" && isFinite(x) ? x : fb; }

function pushCommit(commits, step, hash) {
  if (typeof hash !== "string" || hash.length < 8) return commits;
  if (commits.length && commits[commits.length - 1].hash === hash) return commits;
  const next = commits.concat([{ step: num(step, 0), hash }]);
  return next.length > 30 ? next.slice(next.length - 30) : next;
}

function readScores(p, prev) {
  if (!p || typeof p !== "object") return prev;
  if (p.scores && typeof p.scores === "object") {
    return { us: num(p.scores.us, prev.us), them: num(p.scores.them, prev.them) };
  }
  return { us: num(p.us, prev.us), them: num(p.them, prev.them) };
}

function windowWinner(us, them) {
  if (us > them) return "us";
  if (them > us) return "them";
  return "tie";
}

function looksLikeView(p) {
  return p && typeof p === "object" && Array.isArray(p.self_pos);
}

/* The reducer. Returns a NEW state; never mutates the old one. */
export function applyEvent(state, env) {
  if (!env || typeof env !== "object") return state;
  const p = env.payload || {};
  const s = { ...state, lastSeq: num(env.seq, state.lastSeq) };
  if (env.run_id) s.runId = env.run_id;
  if (env.perspective) s.perspective = env.perspective;

  switch (env.type) {
    case "snapshot": {
      const base = initialState(s.perspective);
      base.runId = s.runId;
      base.lastSeq = s.lastSeq;
      if (looksLikeView(p)) { base.view = p; }
      else {
        if (looksLikeView(p.view)) base.view = p.view;
        base.scores = readScores(p, base.scores);
        base.windowsTotal = num(p.windows_total, base.windowsTotal);
        base.currentWindow = num(p.window, base.currentWindow);
        if (Array.isArray(p.pips)) base.pips = p.pips;
        if (p.status) base.status = p.status;
      }
      if (base.view) {
        base.currentWindow = num(base.view.sub_game, base.currentWindow);
        base.commits = pushCommit(base.commits, base.view.step, base.view.commit);
      }
      return base;
    }
    case "view": {
      s.view = p;
      s.currentWindow = num(p.sub_game, s.currentWindow);
      s.commits = pushCommit(s.commits, p.step, p.commit);
      return s;
    }
    case "window_end": {
      const w = num(p.window, num(p.sub_game, s.currentWindow));
      const sc = readScores(p, { us: NaN, them: NaN });
      const us = isFinite(sc.us) ? sc.us : 0;
      const them = isFinite(sc.them) ? sc.them : 0;
      const pip = { window: w, winner: p.winner || windowWinner(us, them), us, them };
      s.pips = s.pips.filter((q) => q.window !== w).concat([pip])
        .sort((a, b) => a.window - b.window);
      s.scores = {
        us: s.pips.reduce((t, q) => t + num(q.us, 0), 0),
        them: s.pips.reduce((t, q) => t + num(q.them, 0), 0),
      };
      s.currentWindow = Math.min(w + 1, s.windowsTotal);
      return s;
    }
    case "series_end": {
      s.series = p;
      s.scores = readScores(p, s.scores);
      return s;
    }
    case "status": {
      s.status = p;
      return s;
    }
    default:
      return s;
  }
}

/* Ordered, deduped event log. */
export class Timeline {
  constructor(perspective = "police") {
    this.perspective = perspective;
    this.events = [];
    this.lastSeq = 0;
    this.runId = null;
  }

  /* Returns true if the envelope was accepted (appended). */
  push(env) {
    if (!env || typeof env.seq !== "number") return false;
    if (env.run_id && this.runId && env.run_id !== this.runId) {
      // a new run started — the old log is a different game
      this.events = [];
      this.lastSeq = 0;
    }
    if (env.run_id) this.runId = env.run_id;
    if (env.seq <= this.lastSeq) return false;      // dedupe / replayed frame
    this.lastSeq = env.seq;                          // gaps are normal (per-perspective stream)
    this.events.push(env);
    return true;
  }

  /* Perspective switch / new run: same object, clean log (the director holds
     a reference to this instance — never swap it, reset it). */
  reset(perspective) {
    if (perspective) this.perspective = perspective;
    this.events = [];
    this.lastSeq = 0;
    this.runId = null;
  }

  /* Full-history rebuild — O(events); state is tiny so this is sub-ms. */
  stateAt(k) {
    let s = initialState(this.perspective);
    const end = Math.min(k, this.events.length - 1);
    for (let i = 0; i <= end; i += 1) s = applyEvent(s, this.events[i]);
    return s;
  }
}

/* Helpers shared by heatmap + scene layers. */
export function keyRC(r, c) { return r + "," + c; }

export function parseRC(key) {
  const i = key.indexOf(",");
  return [parseInt(key.slice(0, i), 10), parseInt(key.slice(i + 1), 10)];
}

/* posterior/scent maps arrive keyed "r,c" -> float; normalize to a Float64Array(49). */
export function gridFromMap(map) {
  const g = new Float64Array(GRID * GRID);
  if (map && typeof map === "object") {
    for (const k of Object.keys(map)) {
      const [r, c] = parseRC(k);
      if (r >= 0 && r < GRID && c >= 0 && c < GRID) g[r * GRID + c] = Number(map[k]) || 0;
    }
  }
  return g;
}

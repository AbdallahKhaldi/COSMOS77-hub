/* timeline.js — authoritative event log + the ONE shared reducer (applyEvent).
   Used by live mode, reconnect catch-up, snapshot rebuild, demo fixtures and
   the replay scrubber, so every path renders pixel-identically.
   Pure logic: no THREE, no DOM. Envelope contract (hub-assigned):
   {seq:int, ts:float, run_id:str, perspective:"police"|"thief",
    type:"view"|"window_end"|"series_end"|"status"|"snapshot", payload:{...}}
   Payload dialect = THE HUB'S (src/cosmos_hub/envelopes.py, the real wire):
     window_end {sub_game, result, my_role, steps, reason, settled,
                 score:{gid:pts}, winner_group, roles:{gid:role}}
     series_end {game_id, num_sub_games, final_result, mutual_agreement}
     snapshot   {run_id, perspective, view?, windows?:[...], final?, status?}
     status     {state, run_id?, kind?, opponent?, windows?}
   The reducer maps gid-keyed scores to per-feed us/them via my_role+roles and
   stays tolerant of the older fixture keys (us/them/winner/verdict/scores).
   NOTE: seq is monotonic per RUN across BOTH perspectives; a one-perspective
   socket legitimately sees gaps — so ordering is a monotonic filter only,
   never gap-waiting. */

export { GRID } from "./board.js";  // live binding, never a frozen copy
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
    usGid: null,           // this feed's group id, learned from window_end roles
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

/* Normalize a window_end payload from EITHER dialect into per-feed terms.
   HUB dialect (envelopes.window_end_payload, the real wire):
     {sub_game, result, my_role, steps, reason, settled,
      score:{gid:pts}, winner_group:gid|null, roles:{gid:role}}
   fixture-legacy dialect: {window, result, us, them, winner, settled}.
   "us" is the side THIS feed's agent played in that window (my_role). */
export function windowEndInfo(p, fallbackWindow = 1) {
  const q = p && typeof p === "object" ? p : {};
  const w = num(q.window, num(q.sub_game, fallbackWindow));
  let usGid = null, themGid = null;
  if (q.roles && typeof q.roles === "object" && q.my_role) {
    for (const g of Object.keys(q.roles)) {
      if (q.roles[g] === q.my_role && usGid === null) usGid = g;
      else themGid = g;
    }
  }
  let us = NaN, them = NaN;
  if (usGid !== null && q.score && typeof q.score === "object") {
    us = num(q.score[usGid], NaN);
    them = num(themGid !== null ? q.score[themGid] : NaN, NaN);
  }
  if (!isFinite(us) && !isFinite(them)) {
    const sc = readScores(q, { us: NaN, them: NaN });
    us = sc.us; them = sc.them;
  }
  us = isFinite(us) ? us : 0;
  them = isFinite(them) ? them : 0;
  let winner = typeof q.winner === "string" ? q.winner : null; // fixture-legacy
  if (!winner && "winner_group" in q) {
    if (q.winner_group == null) winner = "tie";
    else if (q.winner_group === usGid) winner = "us";
    else if (q.winner_group === themGid) winner = "them";
  }
  if (!winner) winner = windowWinner(us, them);
  return { window: w, us, them, winner, usGid, themGid,
    result: q.result, settled: q.settled !== false };
}

/* Merge one settled window into state (used by window_end AND hub snapshots). */
function foldWindow(s, p, fallbackWindow) {
  const info = windowEndInfo(p, fallbackWindow);
  if (info.usGid) s.usGid = info.usGid;
  const pip = { window: info.window, winner: info.winner, us: info.us, them: info.them };
  s.pips = s.pips.filter((q) => q.window !== info.window).concat([pip])
    .sort((a, b) => a.window - b.window);
  s.scores = {
    us: s.pips.reduce((t, q) => t + num(q.us, 0), 0),
    them: s.pips.reduce((t, q) => t + num(q.them, 0), 0),
  };
  s.currentWindow = Math.min(info.window + 1, s.windowsTotal);
  return info;
}

/* Series totals per feed. HUB dialect: series_end_payload carries
   final_result.total_score keyed by gid — map via the usGid learned from
   window_end roles. Fixture-legacy carries us/them. Else keep the pip sums. */
function foldSeries(s, p) {
  s.series = p && typeof p === "object" ? p : {};
  const totals = s.series.final_result && s.series.final_result.total_score;
  if (totals && typeof totals === "object" && s.usGid && s.usGid in totals) {
    const other = Object.keys(totals).find((g) => g !== s.usGid);
    s.scores = {
      us: num(totals[s.usGid], s.scores.us),
      them: num(other != null ? totals[other] : NaN, s.scores.them),
    };
  } else {
    s.scores = readScores(s.series, s.scores);
  }
}

/* Human verdict line for a series_end payload of either dialect (HUD slam). */
export function seriesVerdict(p) {
  if (!p || typeof p !== "object") return "settled";
  if (p.verdict) return String(p.verdict); // fixture-legacy rich text
  const fin = p.final_result || {};
  const sealed = p.mutual_agreement && p.mutual_agreement.confirmed
    ? " · mutually sealed" : "";
  if (fin.winner_group) return String(fin.winner_group).toUpperCase() + " TAKES THE SERIES" + sealed;
  if (fin.series_tie) return "SERIES TIED" + sealed;
  return "settled" + sealed;
}

/* Where this game's trash-talk actually came from, in the viewer's own words.

   The move is ALWAYS python (rule 25 / table 21); the LLM only ever writes hint
   text.  But "is the model really being called, or is it falling back to the
   zero-token templates?" was previously answerable only by opening the Gemini
   console, so the sealed token total is stated here instead: tokens burned means
   the model spoke, zero means the templates did. */
export function hintProvenance(p) {
  const fin = (p && p.final_result) || {};
  const tokens = (fin.tokens_total_series || {})["cosmos77"];
  if (typeof tokens !== "number") return "hint provenance unreported";
  return tokens > 0
    ? `hints: live LLM · ${tokens.toLocaleString()} tokens this series`
    : "hints: zero-token templates (no LLM call this series)";
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
      /* HUB dialect (envelopes.snapshot_envelope): {run_id, perspective,
         view?, windows?:[window_end payloads], final?:series_end payload,
         status?}. Fixture-legacy: bare view, or {view, scores, window,
         windows_total, pips?}. Both accepted; hub keys win. */
      const base = initialState(s.perspective);
      base.runId = s.runId;
      base.lastSeq = s.lastSeq;
      if (looksLikeView(p)) { base.view = p; }
      else {
        if (looksLikeView(p.view)) base.view = p.view;
        if (p.status) {
          base.status = p.status;
          base.windowsTotal = num(p.status.windows, base.windowsTotal);
        }
        base.windowsTotal = num(p.windows_total, base.windowsTotal);
        if (Array.isArray(p.windows)) {          // settled windows, hub dialect
          for (const q of p.windows) foldWindow(base, q, base.pips.length + 1);
        } else {
          base.scores = readScores(p, base.scores);
          if (Array.isArray(p.pips)) base.pips = p.pips;
        }
        if (p.final) foldSeries(base, p.final);
        base.currentWindow = num(p.window, base.currentWindow);
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
      foldWindow(s, p, s.currentWindow);
      return s;
    }
    case "series_end": {
      foldSeries(s, p);
      return s;
    }
    case "status": {
      /* HUB dialect: {state:"running"|"standing", run_id?, kind?, opponent?,
         windows?} — a run_started status carries the real series length. */
      s.status = p;
      s.windowsTotal = num(p.windows, s.windowsTotal);
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
    // Only a DIFFERENT GAME resets the log. "standing" is the hub's idle posture —
    // its statuses arrive right after a fast run ends and must never wipe a tape
    // the viewer is still watching.
    if (env.run_id && env.run_id !== "standing" && this.runId && env.run_id !== this.runId) {
      this.events = [];
      this.lastSeq = 0;
    }
    if (env.run_id && env.run_id !== "standing") this.runId = env.run_id;
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

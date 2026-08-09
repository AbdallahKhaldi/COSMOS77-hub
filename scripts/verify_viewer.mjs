/* verify_viewer.mjs — executable regression pins for the arena front-end
   (Track C). No framework, no dependencies: `node scripts/verify_viewer.mjs`
   from the hub repo root; exit 0 = every pin holds.

   It imports the REAL shipped static/js/timeline.js bytes (data: URL import —
   the repo is not an npm package) and extracts the REAL pairing/parse code
   from replay.js and menu.js, then replays:
   - the regenerated HUB-DIALECT demo fixture end to end, both perspectives
     (scores/pips/verdict must be the real run's 5–10 survival);
   - catch-up flourish suppression on perspective switch, incl. the
     tail-of-burst regression a bare backlog threshold misses;
   - real 6-window hub payload shapes (gid-keyed score/winner_group/roles);
   - mid-series reconnect snapshots (windows[] + status.windows);
   - legacy fixture-dialect compatibility;
   - belief-trace pairing by (window, step) across fixture / duplicated-step /
     deduped replay docs;
   - the /api/runs {"runs":[...]} envelope parse in the menu.

   SECURITY NOTE on new Function(): the only strings ever interpolated into a
   function body here are slices of THIS repo's own shipped files
   (static/js/replay.js, static/js/menu.js) read from the local disk — the
   exact code under test, which node would execute anyway if it were
   importable. No network, argument, or environment data reaches those
   bodies. Do not repurpose this pattern for anything an outside party can
   influence. */
import { readFileSync } from "node:fs";

const HUB = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const tlSrc = readFileSync(HUB + "/static/js/timeline.js", "utf8");
const { applyEvent, initialState, windowEndInfo, seriesVerdict } =
  await import("data:text/javascript;base64," + Buffer.from(tlSrc).toString("base64"));

let fails = 0;
function ok(name, cond, detail = "") {
  if (!cond) { fails += 1; console.log("FAIL", name, detail); }
  else console.log("ok  ", name, detail);
}

/* ---------- shared replicas of the tiny consumer loops ---------- */
function makeTL(p) { return { perspective: p, events: [], lastSeq: 0, runId: null }; }
function push(tl, env) { // Timeline.push semantics (timeline.js)
  if (!env || typeof env.seq !== "number") return false;
  if (env.run_id && tl.runId && env.run_id !== tl.runId) { tl.events = []; tl.lastSeq = 0; }
  if (env.run_id) tl.runId = env.run_id;
  if (env.seq <= tl.lastSeq) return false;
  tl.lastSeq = env.seq;
  tl.events.push(env);
  return true;
}
/* director drain + the hud flourish gate (director.js applyNext / hud.render) */
function drain(tl, state) {
  let cursor = 0, mode = "attract";
  const flourishes = [], syslines = [];
  while (cursor < tl.events.length) {
    const env = tl.events[cursor];
    cursor += 1;
    state = applyEvent(state, env);
    const backlog = tl.events.length - cursor;
    const gameful = env.type === "view" || env.type === "window_end" ||
      env.type === "series_end" || (env.type === "snapshot" && !!(env.payload && env.payload.view));
    if (gameful && mode !== "live") mode = "live";
    const fire = !(env.catchup === true) && !(backlog > 3); // hud.js gate
    if (fire && (env.type === "window_end" || env.type === "series_end")) {
      flourishes.push(env.type + ":" + env.perspective);
      if (env.type === "window_end") {
        const info = windowEndInfo(env.payload || {}, state.pips.length);
        syslines.push(`// window ${info.window} settled — ${info.us}–${info.them}`);
      } else {
        syslines.push(`SERIES COMPLETE ${state.scores.us} – ${state.scores.them} · ${seriesVerdict(env.payload)}`);
      }
    }
    if (fire && env.type === "status" && env.payload && env.payload.state) {
      syslines.push("// status " + env.payload.state);
    }
  }
  return { state, mode, flourishes, syslines };
}

/* ================= 1. demo fixture, hub dialect, end to end ================= */
const tape = JSON.parse(readFileSync(HUB + "/static/fixtures/demo-live.json", "utf8"));
{
  let state = initialState("police");
  let mode = "attract"; const fl = [], sys = [];
  for (const env of tape.filter((e) => e.perspective === "police")) {
    const r = drain({ events: [env] }, state); // live cadence: one event per tick
    state = r.state;
    if (r.mode === "live") mode = "live";
    fl.push(...r.flourishes); sys.push(...r.syslines);
  }
  ok("demo/police windowsTotal=1", state.windowsTotal === 1, String(state.windowsTotal));
  ok("demo/police scores 5-10", state.scores.us === 5 && state.scores.them === 10, JSON.stringify(state.scores));
  ok("demo/police pip winner them", state.pips.length === 1 && state.pips[0].winner === "them"
    && state.pips[0].us === 5 && state.pips[0].them === 10, JSON.stringify(state.pips));
  ok("demo/police usGid learned", state.usGid === "cosmos77", state.usGid);
  ok("demo/police series + live mode", !!state.series && mode === "live");
  ok("demo/police flourishes fresh", fl.join("|") === "window_end:police|series_end:police", fl.join("|"));
  ok("demo/police sysline real scores", sys.includes("// window 1 settled — 5–10"), JSON.stringify(sys));
  ok("demo/police series verdict", sys.some((s) => s.includes("SERIES COMPLETE 5 – 10 · COSMOS77-MIRROR TAKES THE SERIES · mutually sealed")), JSON.stringify(sys.filter((s) => s.includes("SERIES"))));
}
{
  let state = initialState("thief");
  for (const env of tape.filter((e) => e.perspective === "thief")) state = applyEvent(state, env);
  ok("demo/thief scores 10-5", state.scores.us === 10 && state.scores.them === 5, JSON.stringify(state.scores));
  ok("demo/thief pip winner us", state.pips[0].winner === "us");
  ok("demo/thief usGid mirror", state.usGid === "cosmos77-mirror", state.usGid);
}

/* ============ 2. perspective-switch catch-up: marked, silent ============ */
{
  const mine = tape.filter((e) => e.perspective === "thief")
    .map((e) => ({ ...e, catchup: true })); // net.js resume marks copies
  const tl = makeTL("thief");
  for (const env of mine) push(tl, env);
  const r = drain(tl, initialState("thief"));
  ok("catchup/silent (no slam, no strip)", r.flourishes.length === 0 && r.syslines.length === 0,
    JSON.stringify([r.flourishes, r.syslines]));
  ok("catchup/state complete", r.state.scores.us === 10 && r.state.pips.length === 1 && !!r.state.series);
  ok("catchup/mode live", r.mode === "live");
}
{ // regression: WITHOUT the mark, tail-of-burst events land at backlog<=3 and WOULD slam
  const tl = makeTL("police");
  for (const env of tape.filter((e) => e.perspective === "police")) push(tl, env);
  const r = drain(tl, initialState("police"));
  ok("regression/unmarked tail burst would slam (mark is load-bearing)",
    r.flourishes.length > 0, JSON.stringify(r.flourishes));
}

/* ================= 3. real 6-window hub payload shapes ================= */
{
  const mk = (seq, type, payload) => ({ seq, ts: 0, run_id: "f2-x", perspective: "police", type, payload });
  let state = initialState("police");
  state = applyEvent(state, mk(1, "status", { state: "running", run_id: "f2-x", kind: "f2", opponent: "SMNGRP05", windows: 6 }));
  ok("real/windowsTotal from status", state.windowsTotal === 6, String(state.windowsTotal));
  const we = (n, us, them, winner) => mk(10 + n, "window_end", {
    sub_game: n, result: us > them ? "capture" : "survival", my_role: "police", steps: 35,
    reason: "x", settled: true, score: { cosmos77: us, SMNGRP05: them },
    winner_group: winner, roles: { cosmos77: "police", SMNGRP05: "thief" },
  });
  state = applyEvent(state, we(1, 20, 5, "cosmos77"));
  state = applyEvent(state, we(3, 5, 10, "SMNGRP05"));
  state = applyEvent(state, we(5, 2, 2, null));
  ok("real/pip winners us,them,tie", state.pips.map((p) => p.winner).join(",") === "us,them,tie", JSON.stringify(state.pips));
  ok("real/scores summed 27-17", state.scores.us === 27 && state.scores.them === 17, JSON.stringify(state.scores));
  state = applyEvent(state, mk(20, "series_end", {
    game_id: "cosmos77-vs-SMNGRP05", num_sub_games: 6,
    final_result: { total_score: { cosmos77: 55, SMNGRP05: 35 }, winner_group: "cosmos77", series_tie: false },
    mutual_agreement: { confirmed: true, sha256: "aa" },
  }));
  ok("real/series totals mapped 55-35", state.scores.us === 55 && state.scores.them === 35, JSON.stringify(state.scores));
  ok("real/verdict text", seriesVerdict(state.series) === "COSMOS77 TAKES THE SERIES · mutually sealed", seriesVerdict(state.series));
}

/* ============ 4. mid-series reconnect snapshot (hub dialect) ============ */
{
  const snap = { seq: 500, ts: 0, run_id: "f2-x", perspective: "police", type: "snapshot", payload: {
    run_id: "f2-x", perspective: "police",
    view: { role: "police", sub_game: 4, step: 12, banner: "LOCKED", self_pos: [2, 3], barriers: [], barriers_left: 10, posterior: {}, perceived_scent: {}, confidence: "fuzzy", hints: [] },
    windows: [
      { sub_game: 1, result: "capture", my_role: "police", steps: 20, reason: "x", settled: true, score: { cosmos77: 20, SMNGRP05: 5 }, winner_group: "cosmos77", roles: { cosmos77: "police", SMNGRP05: "thief" } },
      { sub_game: 3, result: "survival", my_role: "police", steps: 35, reason: "x", settled: true, score: { cosmos77: 5, SMNGRP05: 10 }, winner_group: "SMNGRP05", roles: { cosmos77: "police", SMNGRP05: "thief" } },
    ],
    status: { state: "running", run_id: "f2-x", kind: "f2", opponent: "SMNGRP05", windows: 6 },
  } };
  const state = applyEvent(initialState("police"), snap);
  ok("snapshot/pips rebuilt", state.pips.length === 2, JSON.stringify(state.pips));
  ok("snapshot/scores 25-15", state.scores.us === 25 && state.scores.them === 15, JSON.stringify(state.scores));
  ok("snapshot/windowsTotal via status", state.windowsTotal === 6);
  ok("snapshot/currentWindow from view", state.currentWindow === 4, String(state.currentWindow));
  ok("snapshot/view kept", !!state.view && state.view.self_pos[0] === 2);
}

/* ================= 5. legacy fixture dialect still accepted ================= */
{
  let state = initialState("police");
  state = applyEvent(state, { seq: 1, run_id: "d", perspective: "police", type: "snapshot",
    payload: { window: 1, windows_total: 2, scores: { us: 0, them: 0 }, view: null } });
  ok("legacy/snapshot windows_total", state.windowsTotal === 2);
  state = applyEvent(state, { seq: 2, run_id: "d", perspective: "police", type: "window_end",
    payload: { window: 1, result: "survival", us: 5, them: 10, winner: "them", settled: true } });
  ok("legacy/window_end pip", state.pips[0].winner === "them" && state.scores.us === 5, JSON.stringify(state.pips));
  state = applyEvent(state, { seq: 3, run_id: "d", perspective: "police", type: "series_end",
    payload: { verdict: "ESCAPED", us: 15, them: 20, settled: true } });
  ok("legacy/series scores + verdict", state.scores.us === 15 && seriesVerdict(state.series) === "ESCAPED");
}

/* ============ 6. replay.js belief-trace pairing by (window, step) ============ */
const replaySrc = readFileSync(HUB + "/static/js/replay.js", "utf8");
{
  const a = replaySrc.indexOf("function indexTrace");
  const b = replaySrc.indexOf("/* shortest-arc heading");
  const block = replaySrc.slice(a, b);
  if (!block.includes("function traceGhost")) throw new Error("replay.js extraction failed");
  // run the REAL bytes with a rebindable traceMap
  const wrap = new Function("traceMapRef", `let traceMap = traceMapRef; ${block}; return { indexTrace, traceGhost, setMap: (m) => { traceMap = m; } };`);
  const R = wrap(new Map());
  const hitRate = (frames, ghostFor) => {
    let hits = 0, n = 0;
    for (const f of frames) {
      const g = ghostFor(f);
      if (Array.isArray(g) && Array.isArray(f.thief)) { n += 1; if (g[0] === f.thief[0] && g[1] === f.thief[1]) hits += 1; }
    }
    return n ? Math.round((hits / n) * 100) : 0;
  };

  // 6a. demo fixture (trace rows carry step but no window): pairing preserved
  const demo = JSON.parse(readFileSync(HUB + "/static/fixtures/demo-replay.json", "utf8"));
  R.setMap(R.indexTrace(demo.belief_trace));
  let same = 0;
  for (let i = 0; i < demo.frames.length; i += 1) {
    const g = R.traceGhost(demo.frames[i]);
    const old = demo.belief_trace[i] && Array.isArray(demo.belief_trace[i].ghost) ? demo.belief_trace[i].ghost : null;
    if (JSON.stringify(g) === JSON.stringify(old)) same += 1;
  }
  ok("trace/fixture pairing preserved", same === demo.frames.length, same + "/" + demo.frames.length);

  // 6b. CURRENT real doc shape: two entries per step (YOUR TURN + LOCKED) — LOCKED wins
  const frames = []; const dup = [];
  for (let s = 1; s <= 35; s += 1) {
    frames.push({ window: 1, step: s, thief: [s % 7, (s * 2) % 7] });
    dup.push({ window: 1, step: s, ghost: [9, 9], confidence: "fuzzy" });
    dup.push({ window: 1, step: s, ghost: [s % 7, (s * 2) % 7], confidence: "exact" });
  }
  R.setMap(R.indexTrace(dup));
  let aligned = 0;
  for (const f of frames) { const g = R.traceGhost(f); if (g && g[0] === f.thief[0] && g[1] === f.thief[1]) aligned += 1; }
  ok("trace/dup-step doc: LOCKED wins 35/35", aligned === 35, aligned + "/35");
  ok("trace/dup-step hit-rate 100%", hitRate(frames, R.traceGhost) === 100);
  const oldGhost = dup[34].ghost; // old positional pairing gave frame 35 step-18 data
  ok("trace/regression: index pairing was wrong", !(oldGhost[0] === frames[34].thief[0] && oldGhost[1] === frames[34].thief[1]),
    JSON.stringify({ oldGhost, truth: frames[34].thief, entryStep: dup[34].step }));

  // 6c. deduped (one entry per step) doc pairs cleanly; 6d. no cross-window collision
  const dedup = frames.map((f) => ({ window: 1, step: f.step, ghost: f.step % 3 ? [9, 9] : f.thief, confidence: "fuzzy" }));
  R.setMap(R.indexTrace(dedup));
  let m3 = 0;
  for (const f of frames) { const g = R.traceGhost(f); const want = dedup.find((t) => t.step === f.step).ghost; if (JSON.stringify(g) === JSON.stringify(want)) m3 += 1; }
  ok("trace/deduped doc pairs 35/35", m3 === 35, m3 + "/35");
  const fr4 = [{ window: 1, step: 5, thief: [1, 1] }, { window: 2, step: 5, thief: [2, 2] }];
  R.setMap(R.indexTrace([{ window: 1, step: 5, ghost: [1, 1] }, { window: 2, step: 5, ghost: [2, 2] }]));
  ok("trace/multi-window no collision", JSON.stringify(R.traceGhost(fr4[0])) === "[1,1]" && JSON.stringify(R.traceGhost(fr4[1])) === "[2,2]");
}

/* ================= 7. menu.js /api/runs envelope parse ================= */
const menuSrc = readFileSync(HUB + "/static/js/menu.js", "utf8");
{
  const a = menuSrc.indexOf("async function loadRuns()");
  const b = menuSrc.indexOf("wireCopyButtons(menu);");
  const body = menuSrc.slice(a, b);
  if (!body.includes("runs.runs")) throw new Error("menu.js envelope unwrap missing");
  const run = (payload) => {
    const rows = [];
    const fn = new Function("rows", "payload", `
      const $ = () => ({ innerHTML: "", appendChild: (x) => rows.push(x) });
      const runRow = (r) => r;
      const getJSON = async () => payload;
      ${body}
      return loadRuns();`);
    return fn(rows, payload).then(() => rows);
  };
  const api = { runs: [
    { run_id: "f1-a", settled: true, windows_logged: 1, replay: true, mtime: 1754740000 },
    { run_id: "f2-b", settled: false, windows_logged: 3, replay: false, mtime: 1754741000 },
    { run_id: "sp-c", settled: true, windows_logged: 1, replay: false, mtime: 1754700000 },
  ] };
  const got = await run(api);
  ok("menu/demo row label + link", got[0].rid === "demo-tape" && got[0].meta === "real settled selfplay · 1 window"
    && got[0].watch === "/replay/demo-tape?demo=1", JSON.stringify(got[0]));
  ok("menu/settled real runs listed", got.some((r) => r.rid === "f1-a"), JSON.stringify(got.map((r) => r.rid)));
  ok("menu/unsettled filtered", !got.some((r) => r.rid === "f2-b"));
  const f1 = got.find((r) => r.rid === "f1-a");
  ok("menu/meta from real fields", /1 window · \d/.test(f1.meta), f1.meta);
  ok("menu/watch link", f1.watch === "/replay/f1-a");
  const sp = got.find((r) => r.rid === "sp-c");
  ok("menu/no-replay row", sp.meta.includes("no replay") && sp.watch === null, JSON.stringify(sp));
  const got2 = await run([{ run_id: "x", settled: true, opponent_gid: "SMNGRP05", kind: "f2", score: { us: 55, them: 35 }, verdict: "cosmos77 wins", replay: true }]);
  const x = got2.find((r) => r.rid === "x");
  ok("menu/bare array + future rich fields", x && x.meta === "SMNGRP05 · f2 · 55–35 · cosmos77 wins", x && x.meta);
  const got3 = await run({ runs: [] });
  ok("menu/empty envelope hint row", got3.some((r) => r.rid === "no settled runs yet"), JSON.stringify(got3.map((r) => r.rid)));
}

console.log(fails ? `\n${fails} PIN(S) FAILED` : "\nALL VIEWER PINS HOLD");
process.exit(fails ? 1 : 0);

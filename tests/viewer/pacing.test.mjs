/* Deterministic proof of the drain policy — especially the feed-switch
   fast-forward that must land the other agent at the SAME game moment,
   never back on its spawn cell. Run: node tests/viewer/pacing.test.mjs */
import assert from "node:assert/strict";
import { drainDecision, atOrBefore, INSTANT_CAP } from "../../static/js/pacing.js";

const view = (step, sub = 1) => ({ type: "view", payload: { step, sub_game: sub } });
const status = () => ({ type: "status", payload: { state: "running" } });
const windowEnd = (sub) => ({ type: "window_end", payload: { sub_game: sub } });

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log("  ok  " + name); };

test("fast-forward re-applies everything at or before the held moment", () => {
  const ff = { sub_game: 1, step: 5 };
  for (const step of [1, 2, 3, 4, 5]) {
    const d = drainDecision({ pending: view(step), fastForward: ff, paceMs: 650,
      nowMs: 0, lastViewAt: 0, backlog: 70, tweens: 0 });
    assert.deepEqual(d, { do: "apply", instant: true, beat: false }, "step " + step);
  }
});

test("fast-forward STOPS at the first envelope past the held moment", () => {
  const d = drainDecision({ pending: view(6), fastForward: { sub_game: 1, step: 5 },
    paceMs: 650, nowMs: 0, lastViewAt: 0, backlog: 70, tweens: 0 });
  assert.deepEqual(d, { do: "clearFastForward" });
});

test("the paced beat can NEVER throttle a fast-forward (the switch bug)", () => {
  // beat not yet due (nowMs === lastViewAt) — pacing alone would say "wait"
  const paced = drainDecision({ pending: view(2), fastForward: null, paceMs: 650,
    nowMs: 1000, lastViewAt: 1000, backlog: 70, tweens: 0 });
  assert.equal(paced.do, "wait");
  const forwarding = drainDecision({ pending: view(2), fastForward: { sub_game: 1, step: 5 },
    paceMs: 650, nowMs: 1000, lastViewAt: 1000, backlog: 70, tweens: 0 });
  assert.equal(forwarding.do, "apply", "fast-forward must win over the beat");
  assert.equal(forwarding.instant, true, "and must not animate the rewind");
});

test("statuses and snapshots never end a fast-forward", () => {
  assert.equal(atOrBefore(status(), { sub_game: 1, step: 0 }), true);
  const d = drainDecision({ pending: status(), fastForward: { sub_game: 1, step: 0 },
    paceMs: 650, nowMs: 0, lastViewAt: 0, backlog: 5, tweens: 0 });
  assert.equal(d.do, "apply");
});

test("a later window is past the moment even at a lower step", () => {
  assert.equal(atOrBefore(view(1, 2), { sub_game: 1, step: 30 }), false);
  assert.equal(atOrBefore(windowEnd(1), { sub_game: 1, step: 30 }), true);
});

test("without a fast-forward the beat holds live playback watchable", () => {
  const early = drainDecision({ pending: view(3), fastForward: null, paceMs: 650,
    nowMs: 1200, lastViewAt: 1000, backlog: 3, tweens: 0 });
  assert.equal(early.do, "wait", "200ms after the last beat: hold");
  const due = drainDecision({ pending: view(3), fastForward: null, paceMs: 650,
    nowMs: 1700, lastViewAt: 1000, backlog: 3, tweens: 0 });
  assert.deepEqual(due, { do: "apply", instant: false, beat: true });
});

test("burst catch-up still applies instantly when not pacing", () => {
  const d = drainDecision({ pending: windowEnd(1), fastForward: null, paceMs: 0,
    nowMs: 0, lastViewAt: 0, backlog: 40, tweens: 3 });
  assert.deepEqual(d, { do: "apply", instant: true, beat: false });
});

test("END-TO-END: a switch at step 7 lands the other feed at step 7, not spawn", () => {
  // the incoming stream for the other perspective, exactly as the hub replays it
  const stream = [status(), status()];
  for (let s = 1; s <= 20; s += 1) { stream.push(view(s)); stream.push(view(s)); }
  let cursor = 0, ff = { sub_game: 1, step: 7 }, applied = [];
  let frames = 0;
  // simulate frames; the beat is never due (worst case for the bug)
  while (cursor < stream.length && frames < 10) {
    frames += 1;
    for (let guard = 0; guard < INSTANT_CAP && cursor < stream.length; guard += 1) {
      const d = drainDecision({ pending: stream[cursor], fastForward: ff, paceMs: 650,
        nowMs: 5000, lastViewAt: 5000, backlog: stream.length - cursor, tweens: 0 });
      if (d.do === "clearFastForward") { ff = null; break; }
      if (d.do === "wait") break;
      applied.push(stream[cursor]); cursor += 1;
    }
    if (!ff) break;
  }
  const lastStep = applied.filter((e) => e.type === "view").pop().payload.step;
  assert.equal(lastStep, 7, "the viewer resumes at the held step");
  assert.equal(ff, null, "fast-forward released");
  assert.equal(frames, 1, "and it catches up within a single frame");
});

test("switching after a finished run fast-forwards to the END, never replays it", () => {
  // the sentinel the page passes when there is no moment to hold (attract mode)
  const toEnd = { sub_game: Infinity, step: Infinity };
  const stream = [];
  for (let s = 1; s <= 35; s += 1) stream.push(view(s));
  stream.push(windowEnd(1));
  let cursor = 0, applied = 0;
  for (let guard = 0; guard < 200 && cursor < stream.length; guard += 1) {
    const d = drainDecision({ pending: stream[cursor], fastForward: toEnd, paceMs: 650,
      nowMs: 0, lastViewAt: 0, backlog: stream.length - cursor, tweens: 0 });
    assert.equal(d.do, "apply", "every envelope applies instantly");
    assert.equal(d.instant, true, "and none of it animates");
    cursor += 1; applied += 1;
  }
  assert.equal(applied, stream.length, "the whole finished game lands at once");
});

console.log(`\nALL ${passed} PACING PINS HOLD`);

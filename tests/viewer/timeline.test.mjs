/* timeline.test.mjs — the reducer module IMPORTS AND RUNS.

   The audit found the live viewer dead in production because `export { GRID } from`
   creates no module-local binding: every gridFromMap() call threw ReferenceError,
   and no test imported timeline.js so nothing caught it. These pins hold the module
   to the standard "it executes", plus the live-binding contract with board.js. */

import { strict as assert } from "node:assert";
import { gridFromMap, GRID, applyEvent, initialState, hintProvenance } from "../../static/js/timeline.js";
import { setGrid } from "../../static/js/board.js";

// 1. gridFromMap executes and maps r,c keys (the exact call that threw in production)
{
  const g = gridFromMap({ "0,0": 0.5, "6,6": 0.25 });
  assert.equal(g.length, GRID * GRID);
  assert.equal(g[0], 0.5);
  assert.equal(g[6 * GRID + 6], 0.25);
}

// 2. the board.js live binding actually propagates into this module
{
  assert.equal(GRID, 7);
  setGrid(10);
  const g10 = gridFromMap({ "9,9": 1 });
  assert.equal(g10.length, 100, "gridFromMap must follow setGrid");
  assert.equal(g10[99], 1);
  setGrid(7); // restore for the other pins
}

// 3. the reducer executes end to end on a live-shaped envelope
{
  let s = initialState("police");
  s = applyEvent(s, {
    seq: 1, run_id: "r1", perspective: "police", type: "view",
    payload: { role: "police", sub_game: 1, step: 3, self_pos: [1, 2],
               barriers: [[0, 0]], posterior: { "3,3": 0.9 }, confidence: "exact" },
  });
  assert.equal(s.view.step, 3);
  assert.deepEqual(s.view.self_pos, [1, 2]);
}

// 4. hintProvenance states token truth without throwing on absent fields
{
  assert.match(hintProvenance({ final_result: { tokens_total_series: { cosmos77: 902 } } }), /902/);
  assert.match(hintProvenance({}), /unreported/);
}

console.log("ALL 4 TIMELINE PINS HOLD");

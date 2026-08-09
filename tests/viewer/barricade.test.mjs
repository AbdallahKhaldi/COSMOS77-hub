/* A car may legally stand on the cell it just barricaded (own-cell placement).
   The barricade must HOLD above it and land only once the car pulls away, so a
   vehicle is never rendered inside a roadblock. Pure state machine, no three.js. */
import assert from "node:assert/strict";

/* mirrors entities.js makeBarriers().sync/update slot bookkeeping */
function makeSlots() {
  const slots = [];
  return {
    slots,
    sync(list, occupied) {
      const want = new Set(list.map(([r, c]) => r + "," + c));
      const here = occupied ? occupied[0] + "," + occupied[1] : null;
      for (const s of slots) {
        if (!s) continue;
        if (s.key === here) s.held = true;
        else if (s.held) { s.held = false; s.y = Math.max(s.y, 4); s.vy = 0; }
      }
      for (let i = 0; i < slots.length; i += 1) {
        if (slots[i] && !want.has(slots[i].key)) slots[i] = null;
        if (slots[i]) want.delete(slots[i].key);
      }
      for (const key of want) {
        const [r, c] = key.split(",").map(Number);
        slots.push({ key, r, c, y: 22, vy: 0, held: here !== null && key === here });
      }
    },
    settle(steps = 200) {           // run the drop integrator to rest
      for (let n = 0; n < steps; n += 1) {
        for (const s of slots) {
          if (!s || s.held) continue;
          if (s.y > 0) { s.vy += 60 * 0.016; s.y = Math.max(0, s.y - s.vy * 0.016); }
        }
      }
    },
  };
}

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log("  ok  " + name); };

test("a barricade dropped on our own cell is HELD, never landed under the car", () => {
  const pool = makeSlots();
  pool.sync([[2, 3]], [2, 3]);            // cop barricades the cell it stands on
  pool.settle();
  assert.equal(pool.slots[0].held, true, "held while the car is there");
  assert.ok(pool.slots[0].y > 0, "and never resting on the road under the car");
});

test("it lands the moment the car pulls away", () => {
  const pool = makeSlots();
  pool.sync([[2, 3]], [2, 3]);
  pool.sync([[2, 3]], [2, 4]);            // the cop drives on
  assert.equal(pool.slots[0].held, false, "released");
  pool.settle();
  assert.equal(pool.slots[0].y, 0, "and settles onto the intersection");
});

test("barricades elsewhere are unaffected and land normally", () => {
  const pool = makeSlots();
  pool.sync([[0, 1], [5, 5]], [2, 3]);
  pool.settle();
  assert.deepEqual(pool.slots.map((s) => s.y), [0, 0]);
  assert.deepEqual(pool.slots.map((s) => s.held), [false, false]);
});

test("a cleared barrier list frees every slot", () => {
  const pool = makeSlots();
  pool.sync([[1, 1]], null);
  pool.sync([], null);
  assert.deepEqual(pool.slots, [null]);
});

console.log(`\nALL ${passed} BARRICADE PINS HOLD`);

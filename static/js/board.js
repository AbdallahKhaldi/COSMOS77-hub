/* board.js — the ONE source of truth for how big the board is.

   The arena shipped with `GRID = 7` written into scene.js and timeline.js, while
   the rules panel happily offers 7 through 11. Pick 10x10 and the engine played a
   10x10 game while the viewer drew a 7x7 city and a 7x7 belief map, silently
   dropping every cell from index 7 up: a viewer that misreports the board it is
   watching, which under rules 8-9 is the one thing this surface may never do.

   These are `let` exports on purpose. ES modules give importers LIVE bindings, so
   `setGrid` reaches every module that read `GRID` — provided they read it when
   called rather than freezing it at module load. Anything derived from GRID must
   therefore live in here (see HALF), never in an importer's top-level const. */

export let GRID = 7;
export let HALF = 3;           // (GRID - 1) / 2 — the board's centre offset

export const MIN_GRID = 7;     // Appendix F floor; the sandbox may raise, never lower
export const MAX_GRID = 11;

/** Set the board size for everything downstream. Returns true when it changed. */
export function setGrid(size) {
  const n = Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(Number(size) || GRID)));
  if (n === GRID) return false;
  GRID = n;
  HALF = (n - 1) / 2;
  return true;
}

/* pacing.js — the drain policy, pure and testable (no three.js, no DOM).

   The viewer applies envelopes under three regimes and the ORDER matters:
     1. fast-forward  — after a feed switch, re-apply the other agent's stream
                        silently up to the moment the viewer was watching;
     2. paced beat    — a real selfplay settles in ~2s, so live playback is held
                        to one view per `paceMs` to be watchable;
     3. burst tiers   — reconnect catch-up applies instantly above a backlog.
   Fast-forward must be evaluated BEFORE the beat, or the beat throttles the
   catch-up and the switched feed crawls up from its spawn cell — the bug this
   module exists to make impossible. Covered by tests/viewer/pacing.test.mjs. */

export const INSTANT_CAP = 20;   // events applied per frame while catching up
export const BURST_BACKLOG = 12; // above this, skip tweens entirely

/** Is *envelope* at or before the held (sub_game, step) moment? */
export function atOrBefore(envelope, moment) {
  const payload = envelope.payload || {};
  const sub = typeof payload.sub_game === "number" ? payload.sub_game : 1;
  const step = typeof payload.step === "number" ? payload.step : 0;
  const gameful = envelope.type === "view" || envelope.type === "window_end";
  if (!gameful) return true; // status/snapshot carry no position: always re-apply
  return sub < moment.sub_game || (sub === moment.sub_game && step <= moment.step);
}

/** What should the drain loop do with the next pending envelope?
 *  Returns one of: {do:"apply", instant, beat} | {do:"clearFastForward"} | {do:"wait"}. */
export function drainDecision(state) {
  const { pending, fastForward, paceMs, nowMs, lastViewAt, backlog, tweens } = state;
  if (!pending) return { do: "wait" };
  if (fastForward) {
    return atOrBefore(pending, fastForward)
      ? { do: "apply", instant: true, beat: false }
      : { do: "clearFastForward" };
  }
  if (paceMs > 0 && pending.type === "view") {
    return nowMs - lastViewAt < paceMs
      ? { do: "wait" }
      : { do: "apply", instant: false, beat: true };
  }
  if (backlog > BURST_BACKLOG) return { do: "apply", instant: true, beat: false };
  if (tweens === 0) return { do: "apply", instant: false, beat: false };
  return { do: "wait" };
}

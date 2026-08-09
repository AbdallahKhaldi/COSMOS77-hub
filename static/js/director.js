/* director.js — ONE requestAnimationFrame drives everything.
   Each tick: (a) drain net inbox -> timeline; (b) advance tweens with
   dt = clock.getDelta() * speed (speed-multiplied accumulator — NEVER
   wall-clock in tween math, so 0.5x..16x replay stays exact); (c) if idle
   and cursor < events.length start the next event's tween(s); (d) idle
   animations (strobe/shimmer/scent chase); (e) controls.update + render.
   Burst tiers (reconnect catch-up / tab restore): backlog<=3 normal 450ms;
   <=12 dur=max(120,450/backlog); >12 instant-apply capped ~20 events/frame.
   On tween completion positions SNAP to exact cell centers (no float drift
   over a 35-move window). */

import * as THREE from "three";
import { cellToWorld } from "./scene.js";
import { REDUCED } from "./entities.js";
import { applyEvent, initialState, gridFromMap } from "./timeline.js";

const MOVE_MS = 450;
const INSTANT_CAP = 20;

function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; }

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export function createDirector({ arena, timeline, hud, rig }) {
  /* rig = {vehicle, ghost, scent, barriers, trail} from entities.js.
     hud.render(state, meta) is DOM-only; called on every applied event. */
  const timer = new THREE.Timer(); // r185: Clock is deprecated
  let cursor = 0;                   // next timeline event to apply
  let state = initialState(timeline.perspective);
  let speed = 1;
  let mode = "attract";             // attract | live
  let tweens = [];
  let running = false;

  function backlog() { return timeline.events.length - cursor; }

  function moveDuration() {
    const b = backlog();
    if (REDUCED) return 0.001;
    if (b <= 3) return MOVE_MS / 1000;
    if (b <= 12) return Math.max(120, MOVE_MS / b) / 1000;
    return 0; // instant tier
  }

  function addTween(from, to, dur, apply, done) {
    if (dur <= 0) { apply(to, from, 1); if (done) done(); return; }
    tweens.push({ t: 0, dur, from, to, apply, done });
  }

  function stepTweens(dt) {
    if (!tweens.length) return;
    const keep = [];
    for (const tw of tweens) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.apply(tw.to, tw.from, easeInOutQuad(k));
      if (k >= 1) { if (tw.done) tw.done(); } else keep.push(tw);
    }
    tweens = keep;
  }

  /* ------------- applying one envelope to the 3D rig + HUD ------------- */
  function applyToRig(prev, next, env, dur) {
    const p = env.payload || {};
    if (env.type === "view") {
      const prevPos = prev.view && prev.view.self_pos;
      const pos = p.self_pos;
      if (Array.isArray(pos)) {
        const to = cellToWorld(pos[0], pos[1], 0);
        if (prevPos && (prevPos[0] !== pos[0] || prevPos[1] !== pos[1])) {
          const from = cellToWorld(prevPos[0], prevPos[1], 0);
          rig.trail.push(from.x, from.z);
          const heading = Math.atan2(to.x - from.x, to.z - from.z);
          const g = rig.vehicle.group;
          addTween(from, to, dur, (b, a, k) => {
            tmpA.copy(a); tmpB.copy(b);
            g.position.lerpVectors(tmpA, tmpB, k);
            let d = heading - g.rotation.y; // shortest-arc turn, no 360 spins
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            g.rotation.y += d * Math.min(1, k * 2);
          }, () => { g.position.copy(to); g.rotation.y = heading; }); // SNAP
        } else {
          rig.vehicle.group.position.copy(to); // first placement / STAY
        }
      }
      rig.barriers.sync(p.barriers);
      rig.ghost.setPosterior(gridFromMap(p.posterior), p.confidence || "none");
      rig.scent.setTargets(gridFromMap(p.perceived_scent));
      paintOverlay(next);
    } else if (env.type === "window_end") {
      rig.barriers.reset();
      rig.ghost.setPosterior(new Float64Array(49), "none");
      rig.scent.setTargets(new Float64Array(49));
      paintOverlay(next);
    } else if (env.type === "snapshot") {
      const v = next.view;
      if (v && Array.isArray(v.self_pos)) {
        rig.vehicle.group.position.copy(cellToWorld(v.self_pos[0], v.self_pos[1], 0));
        rig.barriers.sync(v.barriers);
        rig.ghost.setPosterior(gridFromMap(v.posterior), v.confidence || "none");
        rig.scent.setTargets(gridFromMap(v.perceived_scent));
      }
      paintOverlay(next);
    }
  }

  /* barrier cells pulse siren-red on the additive cell-overlay layer */
  function paintOverlay(st) {
    arena.overlay.clear();
    const v = st.view;
    if (v && Array.isArray(v.barriers)) {
      for (const b of v.barriers) {
        if (Array.isArray(b)) arena.overlay.set(b[0], b[1], 0xff3b30, 0.28);
      }
    }
    arena.overlay.commit();
  }

  function applyNext() {
    const env = timeline.events[cursor];
    cursor += 1;
    const prev = state;
    state = applyEvent(state, env);
    if (env.type !== "status" && mode !== "live") setMode("live");
    applyToRig(prev, state, env, moveDuration());
    hud.render(state, { backlog: backlog(), mode, env });
    if (env.type === "window_end") {
      arena.cameras.reframe(); // ARENA V2: auto-reframe TOP on window change
    }
    if (env.type === "series_end") {
      setTimeout(() => { if (backlog() === 0) setMode("attract"); }, 14000);
    }
  }

  function setMode(m) {
    mode = m;
    hud.setMode(m);
  }

  /* --------------------------------- cameras ---------------------------
     ARENA V2: cameras.js owns TOP (clamped tactical orbit; drift only in
     attract) and CHASE (third-person follow of OUR car — the feed
     perspective's own vehicle, never the opponent's). */
  function updateCamera(dt) {
    arena.cameras.update(dt, mode === "attract" ? null : rig.vehicle.group.position);
  }

  /* ------------------------------ main loop ---------------------------- */
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    timer.update();
    const rawDt = Math.min(timer.getDelta(), 0.1);
    const dt = rawDt * speed;         // the speed-multiplied accumulator

    // a new run_id resets the timeline under us — resync the cursor
    if (cursor > timeline.events.length) { cursor = 0; state = initialState(timeline.perspective); }

    // (a) start pending events: instant tier drains up to INSTANT_CAP/frame,
    // tween tiers start the next event only when the previous tween is done.
    let guard = 0;
    while (backlog() > 0 && guard < INSTANT_CAP) {
      if (backlog() > 12) { applyNext(); guard += 1; continue; }
      if (tweens.length === 0) { applyNext(); guard += 1; continue; }
      break;
    }

    // (b..d)
    stepTweens(dt);
    rig.vehicle.update(dt, timer.getElapsed() * speed);
    rig.ghost.update(dt, timer.getElapsed());
    rig.scent.update(dt);
    rig.barriers.update(Math.max(dt, rawDt)); // drops finish even at 0.5x
    rig.trail.update(dt);
    updateCamera(rawDt);

    // (e)
    arena.render(rawDt);
  }

  return {
    start() {
      if (!running) { running = true; timer.update(); requestAnimationFrame(frame); }
    },
    stop() { running = false; },
    /* net.js callback — inbox drain is just timeline.push (cheap, sync);
       everything (status included) is applied IN ORDER by the frame loop. */
    onEnvelope(env) {
      timeline.push(env);
    },
    setSpeed(x) { speed = x; },
    setAttract() { setMode("attract"); },
    get state() { return state; },
    get mode() { return mode; },
    /* full reset on perspective switch — new socket, new truth */
    reset(perspective) {
      timeline.reset(perspective);
      cursor = 0;
      tweens = [];
      state = initialState(perspective);
      rig.barriers.reset();
      rig.ghost.setPosterior(new Float64Array(49), "none");
      rig.scent.setTargets(new Float64Array(49));
      rig.trail.setTint(perspective === "thief" ? 0xff8a1e : 0x2b7fff);
      arena.overlay.clear();
      arena.overlay.commit();
      arena.cameras.reframe();
      setMode("attract");
      hud.render(state, { backlog: 0, mode: "attract", env: null });
    },
  };
}

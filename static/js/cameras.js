/* cameras.js — TOP / CHASE camera system (ARENA V3).

   TOP   — CINEMATIC TACTICAL: an oblique 3/4 angle, never flat-overhead.
           Canonical pose = polar 0.95 rad, distance 88, FOV 44, target
           (0,1.5,0). A very slow ambient orbit breathes around the azimuth:
           a ±0.35 rad sine whose PEAK angular rate equals a 90 s full turn
           (period = 0.35·90 = 31.5 s), running in attract AND while
           following — clamped, never a runaway spiral, off under reduced
           motion. Every window change reframes to the canonical pose (600 ms
           eased) then dollies IN ~4% (88 → 84.5 over 2.8 s, easeOutCubic) —
           the "push" that makes each window feel like a new shot.
           OrbitControls stay live in TOP, clamped polar 0.55..1.15 and
           distance 62..118 (flat-overhead is impossible).
   CHASE — third person, user-approved in V2 and kept: desired = car −
           forward·9.5 + up·4.6, critically damped (k≈4/s), look-ahead
           lookAt(car + forward·3.5 + up·1.2), FOV 55, lateral sway with
           turns, idle orbital creep after 3 s. V3 adds the FOV kick: when
           the followed car starts a move, fov 55→58 over 120 ms and back
           over 180 ms (300 ms total) — speed sensation; off under reduced
           motion. setChaseTarget() while IN chase runs the same 600 ms eased
           transition, landing directly behind the newly selected car.
   Mode switches tween position+quaternion+fov over 600 ms — never a cut
   (instant under prefers-reduced-motion). */

import * as THREE from "three";

const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TOP_FOV = 44, CHASE_FOV = 55;
const TOP_POLAR = 0.95, TOP_DIST = 88;
const CHASE_BACK = 9.5, CHASE_UP = 4.6, LOOK_AHEAD = 3.5, LOOK_UP = 1.2;
const DAMP_K = 4, LOOK_K = 6, TRANS_S = 0.6;
const ORBIT_AMP = 0.35, ORBIT_PERIOD = 31.5; // peak rate = 2π/90 (90 s turn)
const IDLE_AFTER = 3, CREEP_PERIOD = 8;
const DOLLY_K = 0.04, DOLLY_S = 2.8;         // 4% push-in per window
const KICK_FOV = 58, KICK_UP = 0.12, KICK_DOWN = 0.18;

function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2; }
function easeOutCubic(t) { return 1 - ((1 - t) ** 3); }

export function createCameras({ camera, controls, blockBoxes = [] }) {
  controls.minPolarAngle = 0.55;   // never flat-overhead
  controls.maxPolarAngle = 1.15;   // never grazing either
  controls.minDistance = 62;
  controls.maxDistance = 118;

  const TOP_POS = new THREE.Vector3(
    0,
    TOP_DIST * Math.cos(TOP_POLAR),                    // 51.19
    TOP_DIST * Math.sin(TOP_POLAR),                    // 71.58
  );
  const TOP_TGT = new THREE.Vector3(0, 1.5, 0);

  let mode = "top";
  let chaseTarget = null; // Object3D (the followed car's group)
  let transition = null;  // {t, fromPos, fromQuat, fromFov}
  let userHold = false;
  controls.addEventListener("start", () => { userHold = true; dollyT = -1; });
  controls.addEventListener("end", () => { userHold = false; });

  const savedTopPos = TOP_POS.clone();
  const savedTopTgt = TOP_TGT.clone();
  const camFollow = new THREE.Vector3(0, 0, 0);
  let orbitT = 0, orbitPrev = 0;

  // window push-in state (armed by reframe, runs after the transition)
  let dollyT = -1, dollyDist = 0, pendingDolly = false;

  // chase FOV kick state
  let kickT = -1;

  // chase sim state
  const smoothPos = new THREE.Vector3();
  const lookSmooth = new THREE.Vector3();
  const lastTgt = new THREE.Vector3();
  const chaseQuat = new THREE.Quaternion();
  let prevYaw = 0, sway = 0, idleT = 0, creep = 0, chaseWarm = false;

  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), desired = new THREE.Vector3();
  const lookDes = new THREE.Vector3(), m4 = new THREE.Matrix4(), q1 = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  function chaseSim(dt) {
    const g = chaseTarget;
    if (!g) return;
    const carPos = g.position;
    const yaw = g.rotation.y;
    if (!chaseWarm) {
      chaseWarm = true;
      smoothPos.copy(camera.position);
      lastTgt.copy(carPos);
      prevYaw = yaw;
      lookSmooth.set(carPos.x, carPos.y + LOOK_UP, carPos.z);
      idleT = 0; creep = 0; sway = 0;
    }
    if (dt > 0) {
      const speed = lastTgt.distanceTo(carPos) / dt;
      if (speed < 0.5) idleT += dt; else idleT = 0;
      let dYaw = yaw - prevYaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      const yawRate = THREE.MathUtils.clamp(dYaw / dt, -4, 4);
      const swayT = REDUCED ? 0 : THREE.MathUtils.clamp(-yawRate * 1.1, -1.4, 1.4);
      sway += (swayT - sway) * Math.min(1, dt * 3);
      if (!REDUCED && idleT > IDLE_AFTER) {
        creep += Math.min(1, (idleT - IDLE_AFTER) / 1.5) * (Math.PI * 2 / CREEP_PERIOD) * dt;
      } else {
        creep -= creep * Math.min(1, dt * 2); // ease back behind the car
      }
      prevYaw = yaw;
      lastTgt.copy(carPos);
    }
    fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const a = yaw + Math.PI + creep;
    desired.set(
      carPos.x + Math.sin(a) * CHASE_BACK,
      carPos.y + CHASE_UP,
      carPos.z + Math.cos(a) * CHASE_BACK,
    ).addScaledVector(right, sway);
    const k = dt > 0 ? 1 - Math.exp(-DAMP_K * dt) : 1;
    smoothPos.lerp(desired, k);
    for (const box of blockBoxes) { // simple pullback: never inside a block
      if (box.containsPoint(smoothPos)) { smoothPos.y = box.max.y + 1.0; break; }
    }
    lookDes.set(carPos.x + fwd.x * LOOK_AHEAD, carPos.y + LOOK_UP, carPos.z + fwd.z * LOOK_AHEAD);
    lookSmooth.lerp(lookDes, dt > 0 ? 1 - Math.exp(-LOOK_K * dt) : 1);
    m4.lookAt(smoothPos, lookSmooth, UP);
    chaseQuat.setFromRotationMatrix(m4);
  }

  function topDestQuat(out) {
    m4.lookAt(savedTopPos, savedTopTgt, UP);
    out.setFromRotationMatrix(m4);
    return out;
  }

  function finishTransition() {
    transition = null;
    if (mode === "top") {
      camera.position.copy(savedTopPos);
      camera.fov = TOP_FOV;
      camera.updateProjectionMatrix();
      controls.target.copy(savedTopTgt);
      camFollow.copy(savedTopTgt).setY(0);
      controls.enabled = true;
      controls.update();
      if (pendingDolly && !REDUCED) { // arm the 4% window push-in
        pendingDolly = false;
        dollyT = 0;
        dollyDist = camera.position.distanceTo(controls.target);
      }
    } else {
      camera.fov = CHASE_FOV;
      camera.updateProjectionMatrix();
    }
  }

  function beginTransition() {
    dollyT = -1;
    kickT = -1;
    if (REDUCED) { // reduced motion: no 600ms glide, just settle
      if (mode === "chase") { chaseWarm = false; chaseSim(0); camera.position.copy(smoothPos); camera.quaternion.copy(chaseQuat); }
      transition = null;
      finishTransition();
      return;
    }
    transition = {
      t: 0,
      fromPos: camera.position.clone(),
      fromQuat: camera.quaternion.clone(),
      fromFov: camera.fov,
    };
    controls.enabled = false;
  }

  function setMode(m) {
    const next = m === "chase" ? "chase" : "top";
    if (next === mode && !transition) return;
    if (mode === "top") { // leaving top: remember where the user parked it
      savedTopPos.copy(camera.position);
      savedTopTgt.copy(controls.target);
    }
    mode = next;
    if (mode === "chase") chaseWarm = false;
    pendingDolly = false;
    beginTransition();
  }

  function reframe() { // eased reframe + gentle dolly-in on every new window
    savedTopPos.copy(TOP_POS);
    savedTopTgt.copy(TOP_TGT);
    if (mode !== "top") return;
    pendingDolly = true;
    beginTransition();
  }

  function applyDolly(dt) {
    if (dollyT < 0) return;
    dollyT += dt;
    const e = easeOutCubic(Math.min(1, dollyT / DOLLY_S));
    const dist = dollyDist * (1 - DOLLY_K * e);
    camera.position.sub(controls.target).setLength(dist).add(controls.target);
    if (dollyT >= DOLLY_S) dollyT = -1;
  }

  function applyKick(dt) {
    if (kickT < 0) return;
    kickT += dt;
    let f;
    if (kickT <= KICK_UP) f = CHASE_FOV + (KICK_FOV - CHASE_FOV) * (kickT / KICK_UP);
    else if (kickT <= KICK_UP + KICK_DOWN) f = KICK_FOV - (KICK_FOV - CHASE_FOV) * ((kickT - KICK_UP) / KICK_DOWN);
    else { f = CHASE_FOV; kickT = -1; }
    camera.fov = f;
    camera.updateProjectionMatrix();
  }

  function update(dt, followPos) {
    if (transition) {
      transition.t += dt;
      const e = easeInOutCubic(Math.min(1, transition.t / TRANS_S));
      let destPos, destQuat, destFov;
      if (mode === "chase") {
        chaseSim(dt);
        destPos = smoothPos; destQuat = chaseQuat; destFov = CHASE_FOV;
      } else {
        destPos = savedTopPos; destQuat = topDestQuat(q1); destFov = TOP_FOV;
      }
      camera.position.lerpVectors(transition.fromPos, destPos, e);
      camera.quaternion.slerpQuaternions(transition.fromQuat, destQuat, e);
      camera.fov = transition.fromFov + (destFov - transition.fromFov) * e;
      camera.updateProjectionMatrix();
      if (transition.t >= TRANS_S) finishTransition();
      return;
    }
    if (mode === "top") {
      controls.enabled = true;
      if (followPos) { // live: shadow the followed car from the oblique angle
        camFollow.lerp(followPos, Math.min(1, dt * 3));
        controls.target.copy(camFollow).setY(1.5);
      } else {
        controls.target.lerp(savedTopTgt, Math.min(1, dt));
      }
      if (!REDUCED && !userHold) { // the slow ambient orbit — always breathing
        orbitT += dt;
        const off = ORBIT_AMP * Math.sin((orbitT * Math.PI * 2) / ORBIT_PERIOD);
        const dAz = off - orbitPrev;
        orbitPrev = off;
        camera.position.sub(controls.target)
          .applyAxisAngle(UP, dAz)
          .add(controls.target);
      }
      applyDolly(dt);
      controls.update();
    } else {
      controls.enabled = false;
      chaseSim(dt);
      camera.position.copy(smoothPos);
      camera.quaternion.copy(chaseQuat);
      applyKick(dt);
    }
  }

  return {
    setMode,
    mode: () => mode,
    /* switching feed while IN chase glides 600 ms to behind the new car */
    setChaseTarget(group) {
      if (group === chaseTarget) return;
      chaseTarget = group;
      chaseWarm = false;
      if (mode === "chase") beginTransition();
    },
    /* the followed car starts a move — tiny FOV kick for speed sensation */
    kick() {
      if (REDUCED || mode !== "chase" || transition) return;
      if (kickT < 0) kickT = 0;
    },
    reframe,
    update,
  };
}

/* cameras.js — TOP / CHASE camera system (ARENA V2).

   TOP   — the tactical orbit. OrbitControls active ONLY here, clamped: polar
           0.35..0.95, distance 70..120; the attract drift is a bounded ±0.28
           rad azimuth sway (period 46 s), never a runaway spiral. reframe()
           tweens back to the canonical view on every window change.
   CHASE — true third person: desired = car − forward·9.5 + up·4.6, critically
           damped (k≈4/s), look-ahead lookAt(car + forward·3.5 + up·1.2),
           FOV 55, subtle lateral sway with turns (off under reduced motion).
           When the car idles >3 s, a slow 8 s-period orbital creep keeps the
           frame alive. If the damped position would sit inside an interior
           block's AABB it pulls up above the block (simple pullback; blocks
           are height-capped at 4.3 so the 4.6 chase height clears them).
   Mode switches tween position+quaternion+fov over 600 ms — never a cut
   (instant under prefers-reduced-motion). */

import * as THREE from "three";

const REDUCED = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const TOP_FOV = 40, CHASE_FOV = 55;
const CHASE_BACK = 9.5, CHASE_UP = 4.6, LOOK_AHEAD = 3.5, LOOK_UP = 1.2;
const DAMP_K = 4, LOOK_K = 6, TRANS_S = 0.6;
const DRIFT_AMP = 0.28, DRIFT_PERIOD = 46;
const IDLE_AFTER = 3, CREEP_PERIOD = 8;

function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2; }

export function createCameras({ camera, controls, blockBoxes = [] }) {
  controls.minPolarAngle = 0.35;
  controls.maxPolarAngle = 0.95;
  controls.minDistance = 70;
  controls.maxDistance = 120;

  const TOP_POS = new THREE.Vector3(0, 95, 55);
  const TOP_TGT = new THREE.Vector3(0, 1.5, 0);

  let mode = "top";
  let chaseTarget = null; // Object3D (the followed car's group)
  let transition = null;  // {t, fromPos, fromQuat, fromFov}
  let userHold = false;
  controls.addEventListener("start", () => { userHold = true; });
  controls.addEventListener("end", () => { userHold = false; });

  const savedTopPos = TOP_POS.clone();
  const savedTopTgt = TOP_TGT.clone();
  const camFollow = new THREE.Vector3(0, 0, 0);
  let driftT = 0, driftPrev = 0;

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
    } else {
      camera.fov = CHASE_FOV;
      camera.updateProjectionMatrix();
    }
  }

  function beginTransition() {
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
    beginTransition();
  }

  function reframe() { // auto-reframe on window change (TOP only)
    savedTopPos.copy(TOP_POS);
    savedTopTgt.copy(TOP_TGT);
    if (mode !== "top") return;
    beginTransition();
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
      if (followPos) { // live: shadow the followed car from altitude
        camFollow.lerp(followPos, Math.min(1, dt * 3));
        controls.target.copy(camFollow).setY(1.5);
      } else {
        controls.target.lerp(savedTopTgt, Math.min(1, dt));
        if (!REDUCED && !userHold) { // clamped attract drift
          driftT += dt;
          const off = DRIFT_AMP * Math.sin((driftT * Math.PI * 2) / DRIFT_PERIOD);
          const dAz = off - driftPrev;
          driftPrev = off;
          camera.position.sub(controls.target)
            .applyAxisAngle(UP, dAz)
            .add(controls.target);
        }
      }
      controls.update();
    } else {
      controls.enabled = false;
      chaseSim(dt);
      camera.position.copy(smoothPos);
      camera.quaternion.copy(chaseQuat);
    }
  }

  return {
    setMode,
    mode: () => mode,
    setChaseTarget(group) {
      chaseTarget = group;
      chaseWarm = false;
    },
    reframe,
    update,
  };
}

// VR wand geometry, kept free of scene state so tests can run it. Floor frame: metres, floor at z=0, +z up (frame.ts).
import * as THREE from 'three';

export const DELETE_HOLD_S = 1.5;      // hold still on an object this long to delete it
export const DELETE_SHOW_S = 0.4;      // ...the outline only starts turning red after this, so normal grabs don't flash
export const DRAG_DEADZONE_M = 0.05;   // past this much drag a hold is a move, never a delete

export const CONFIRM_S = 0.35;         // A must be held this long to remove the pointed-at object (a tap used to; too easy to hit)
export const PUSH_SPEED_MPS = 1.2;     // wand stick up/down while holding an object: pushes it away / pulls it in
export const PUSH_MAX_M = 3;
export const STICK_DEADZONE = 0.2;

/** Where a ray meets the horizontal plane at height z, or null if it points level or away from it, or the hit is further than maxM. */
export function rayPlaneHit(origin: THREE.Vector3, dir: THREE.Vector3, z: number, maxM = 15): THREE.Vector3 | null {
  const dz = z - origin.z;
  if (Math.abs(dir.z) < 1e-3 || dz / dir.z <= 0) return null;
  const t = dz / dir.z;
  return t <= maxM ? origin.clone().addScaledVector(dir, t) : null;
}

/** Where a ray meets the floor (z=0), or null if it points level or up, or the hit is further than maxM. */
export function floorHit(origin: THREE.Vector3, dir: THREE.Vector3, maxM = 15): THREE.Vector3 | null {
  if (dir.z > -1e-3) return null;
  const t = -origin.z / dir.z;
  return t > 0 && t <= maxM ? origin.clone().addScaledVector(dir, t) : null;
}

/** Push/pull offset along the ray (metres) after dt seconds of the wand stick's Y axis (up = -1 on WebXR gamepads = push away). */
export function pushPull(push: number, stickY: number, dt: number): number {
  if (Math.abs(stickY) < STICK_DEADZONE) return push;
  return Math.max(-PUSH_MAX_M, Math.min(PUSH_MAX_M, push - stickY * PUSH_SPEED_MPS * dt));
}

/** The held object's turn from the wand stick: a quarter turn per flick (right = clockwise from above), the steps a layout
 *  keeps (main.ts commitPose rounds to them), so what you see held is what lands. A flick counts once the stick leans past
 *  0.7 more sideways than up/down (so a push or pull doesn't also turn it); it re-arms near the centre. Returns [spin, ready]. */
export function spinStep(spin: number, ready: boolean, stickX: number, stickY: number): [number, boolean] {
  if (ready && Math.abs(stickX) > 0.7 && Math.abs(stickX) > Math.abs(stickY)) return [spin - Math.sign(stickX) * Math.PI / 2, false];
  return [spin, ready || Math.abs(stickX) < 0.3];
}

/** Press-and-hold progress 0..1 for the A-button remove (1 = remove now). */
export const confirmProgress = (heldS: number) => Math.min(1, Math.max(0, heldS / CONFIRM_S));

/** Wrist twist since q0: signed roll about the current ray (controller -z), radians. Positive = clockwise as you look along the ray. */
export function twistAngle(q0: THREE.Quaternion, q: THREE.Quaternion): number {
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const flat = (v: THREE.Vector3) => v.addScaledVector(d, -v.dot(d));
  const u0 = flat(new THREE.Vector3(0, 1, 0).applyQuaternion(q0)), u = flat(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
  return Math.atan2(new THREE.Vector3().crossVectors(u0, u).dot(d), u0.dot(u));
}

/** Nearest quarter turn: a twist counts once it passes 45 deg (hand tracking is noisy; furniture snaps to 90 deg anyway). */
export const snapQuarter = (a: number) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2);

/** Hold-to-delete progress: -1 once the hold has become a drag, else 0..1 (1 = delete now). */
export function holdProgress(heldS: number, maxDragM: number): number {
  if (maxDragM > DRAG_DEADZONE_M) return -1;
  return Math.min(1, heldS / DELETE_HOLD_S);
}

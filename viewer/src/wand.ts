// VR wand geometry, kept free of scene state so tests can run it. Floor frame: metres, floor at z=0, +z up (frame.ts).
import * as THREE from 'three';

export const DELETE_HOLD_S = 1.5;      // hold still on an object this long to delete it
export const DELETE_SHOW_S = 0.4;      // ...the outline only starts turning red after this, so normal grabs don't flash
export const DRAG_DEADZONE_M = 0.05;   // past this much drag a hold is a move, never a delete

/** Where a ray meets the floor (z=0), or null if it points level or up, or the hit is further than maxM. */
export function floorHit(origin: THREE.Vector3, dir: THREE.Vector3, maxM = 15): THREE.Vector3 | null {
  if (dir.z > -1e-3) return null;
  const t = -origin.z / dir.z;
  return t > 0 && t <= maxM ? origin.clone().addScaledVector(dir, t) : null;
}

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

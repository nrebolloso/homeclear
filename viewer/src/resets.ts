// Reset rules for the room editor, kept free of scene state so tests can run them. Floor frame: metres, radians.
import type { Pose } from './grid.ts';

export const RESET_ALL_HOLD_S = 1;   // VR: hold both grips this long to reset everything (destructive, so deliberate)

const turnOf = (p: Pose, o: Pose) => Math.atan2(Math.sin(p.yaw - o.yaw), Math.cos(p.yaw - o.yaw));   // wrapped to (-pi, pi]

/** Differs from where the scan had it: moved more than 1 cm, turned more than 0.01 rad, or taken out. */
export const isMoved = (p: Pose, o: Pose) => !!p.removed || Math.hypot(p.x - o.x, p.y - o.y) > 0.01 || Math.abs(turnOf(p, o)) > 0.01;

/** "moved 1.0 m · turned 90°" for the label under an object's name; empty when it is where it started. */
export function movedText(p: Pose, o: Pose): string {
  const d = Math.hypot(p.x - o.x, p.y - o.y), t = Math.abs(turnOf(p, o));
  return [d > 0.01 ? `moved ${d.toFixed(1)} m` : '', t > 0.01 ? `turned ${Math.round((t * 180) / Math.PI)}°` : ''].filter(Boolean).join(' · ');
}

/** The original spot as a fresh pose: not removed, and safe to mutate. */
export const resetPose = (o: Pose): Pose => ({ x: o.x, y: o.y, yaw: o.yaw });

/** Reset-everything ring fill, 0..1, from how long both grips have been held. */
export const resetHoldProgress = (heldS: number) => Math.min(1, heldS / RESET_ALL_HOLD_S);

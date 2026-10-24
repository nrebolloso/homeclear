// Driving a wheelchair on the desktop: arc steering about the drive-wheel axle, speed that builds and coasts, and a swept
// footprint, so the 1.0 m frame cannot swing through a wall corner the ADA turning check says doesn't fit. Pure (no DOM, no
// three) so tests/drive.test.ts can run it; main.ts feeds it keys and a "is this cell clear" callback. The body pose is the
// user's hips (as for the walker), the chair turns about the axle midpoint, a little behind them. Speeds are typical for a
// manual chair indoors and ASSUMED, like the chair's size.
import type { WalkerCfg } from './walker.ts';

export interface Pose { x: number; y: number; yaw: number }
export interface Vel { v: number; w: number }   // m/s along the heading, rad/s (left +)
export interface DriveInput { throttle: number; steer: number; spin: number }   // each -1..1: forward, left, counter-clockwise

export const CHAIR_DRIVE = {
  v_max: 1.0, v_rev: 0.5,   // m/s forward and back
  accel: 0.8, coast: 0.5, brake: 1.6,   // m/s²: pushing, letting go, pushing the other way
  steer_w: 0.9, steer_ref_v: 0.5,   // rad/s at 0.5 m/s and above: a 0.55 m arc at that speed, 1.1 m at full speed
  spin_w: 1.4, w_accel: 5,   // rad/s turning on the spot, and how fast the turn rate follows the keys
};

/** The chair as the collision sees it: the pivot (axle midpoint) and the frame's outline in the body frame, sampled
 *  at `step_m`, plus the farthest point from the pivot (what sweeps the biggest circle). */
export interface Chair { pivot: number; outline: [number, number][]; rmax: number; step_m: number }

export function chairGeometry(cfg: WalkerCfg, step_m: number): Chair {
  const pivot = cfg.legs[0][0], x0 = cfg.user_gap_m, x1 = x0 + cfg.depth_m, hw = cfg.width_m / 2, pts: [number, number][] = [];
  const nx = Math.ceil(cfg.depth_m / step_m), ny = Math.ceil(cfg.width_m / step_m);
  for (let i = 0; i <= nx; i++) { const x = x0 + (cfg.depth_m * i) / nx; pts.push([x, hw], [x, -hw]); }
  for (let j = 1; j < ny; j++) { const y = -hw + (cfg.width_m * j) / ny; pts.push([x0, y], [x1, y]); }
  const outline = [...pts, ...cfg.legs];
  return { pivot, outline, rmax: Math.max(...outline.map(([x, y]) => Math.hypot(x - pivot, y))), step_m };
}

const toWorld = (p: Pose, [px, py]: readonly number[]): [number, number] => {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [p.x + c * px - s * py, p.y + s * px + c * py];
};
/** A pose check from a point check: the hips and every outline point must be on clear floor. */
export const clearOf = (chair: Chair, pointClear: (x: number, y: number) => boolean) => (p: Pose) =>
  pointClear(p.x, p.y) && chair.outline.every(q => pointClear(...toWorld(p, q)));

/** Roll `dist` along the heading and turn `dyaw`, both about the axle midpoint (heading at the mid-turn, so an arc stays an arc). */
function moveAbout(p: Pose, chair: Chair, dist: number, dyaw: number): Pose {
  const [px, py] = toWorld(p, [chair.pivot, 0]), mid = p.yaw + dyaw / 2, yaw = p.yaw + dyaw;
  const nx = px + Math.cos(mid) * dist, ny = py + Math.sin(mid) * dist;
  return { x: nx - Math.cos(yaw) * chair.pivot, y: ny - Math.sin(yaw) * chair.pivot, yaw };
}
/** Sub-steps so no outline point moves more than half a step (a cell) between two checks. */
const stepsFor = (chair: Chair, dist: number, dyaw: number) => Math.max(1, Math.ceil(Math.max(Math.abs(dist), Math.abs(dyaw) * chair.rmax) / (chair.step_m)));
const approach = (x: number, target: number, rate: number) => x + Math.max(-rate, Math.min(rate, target - x));

/** One frame of driving. Updates `body` and `vel` in place; returns whether the chair was stopped by something. */
export function driveStep(body: Pose, vel: Vel, input: DriveInput, dt: number, chair: Chair, ok: (p: Pose) => boolean, d = CHAIR_DRIVE) {
  const target = input.throttle * (input.throttle > 0 ? d.v_max : d.v_rev);
  const against = vel.v !== 0 && Math.sign(target) === -Math.sign(vel.v);
  vel.v = approach(vel.v, target, (target === 0 ? d.coast : against ? d.brake : d.accel) * dt);
  // turning needs rolling: the steer rate grows with speed, and backing up swings the other way, as with a car
  const steerW = input.steer * d.steer_w * Math.max(-1, Math.min(1, vel.v / d.steer_ref_v));
  vel.w = approach(vel.w, input.spin * d.spin_w + steerW, d.w_accel * dt);
  const n = stepsFor(chair, vel.v * dt, vel.w * dt);
  let blocked = false;
  for (let i = 0; i < n; i++) {
    const dist = (vel.v * dt) / n, dyaw = (vel.w * dt) / n, both = moveAbout(body, chair, dist, dyaw);
    if (ok(both)) { Object.assign(body, both); continue; }
    blocked = true;
    const roll = moveAbout(body, chair, dist, 0), turn = moveAbout(body, chair, 0, dyaw);
    if (dist && ok(roll)) { Object.assign(body, roll); vel.w = 0; }   // the turn is blocked: roll on straight
    else if (dyaw && ok(turn)) { Object.assign(body, turn); vel.v = 0; }   // the roll is blocked: swing on the spot
    else { vel.v = vel.w = 0; break; }
  }
  return blocked;
}

/** Turn the chair on the spot by `dyaw` (scroll-sideways, recentre), stopping where the frame first meets a wall.
 *  Returns the angle actually turned. */
export function spinBy(body: Pose, dyaw: number, chair: Chair, ok: (p: Pose) => boolean) {
  const n = stepsFor(chair, 0, dyaw), each = dyaw / n;
  let done = 0;
  for (let i = 0; i < n; i++) {
    const next = moveAbout(body, chair, 0, each);
    if (!ok(next)) break;
    Object.assign(body, next); done += each;
  }
  return done;
}

/** Can the chair turn a full circle on the spot from here? (the swept version of the ADA 1.525 m turning space) */
export function canSpinAround(body: Pose, chair: Chair, ok: (p: Pose) => boolean) {
  const n = stepsFor(chair, 0, 2 * Math.PI), at = { ...body };
  for (let i = 0; i < n; i++) { Object.assign(at, moveAbout(at, chair, 0, (2 * Math.PI) / n)); if (!ok(at)) return false; }
  return true;
}

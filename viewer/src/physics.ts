// Physics pass (Rapier): the walker itself pushed along a planned route over the measured bump layer. A front wheel
// rides up a step if pushed hard enough; a rear glide can catch on an edge. Where holding the walking speed needs more
// push than the person can give, that is a snag. Separate from the Monte Carlo (that one is the feet, this the walker).
// Bump heights are the splat's; the walker's masses, wheel sizes, friction and push limit are ASSUMPTIONS (PHYSICS).
import RAPIER from '@dimforge/rapier3d-compat';
import { toCell, type GridMeta, type XY } from './grid.ts';
import type { WalkerCfg } from './walker.ts';

export interface PhysicsCfg {
  speed_mps: number;
  /** horizontal push the person can keep up (N) */
  push_max_n: number;
  /** weight leaned on the grips (N) */
  hand_load_n: number;
  /** pitch/roll torque the hands can hold to keep the frame level (N m): without it a push at handle height loads the
   *  front wheels faster than it pushes them, and nothing over ~8 mm can be crossed at any force */
  grip_torque_nm: number;
  frame_mass_kg: number;
  /** front legs are wheels (a 5 in two-wheel walker), rear legs glides (radius of the curved front: ski or tennis ball) */
  wheel_radius_m: number;
  glide_radius_m: number;
  glide_friction: number;
  /** at the push limit this long = a snag (s) */
  stall_s: number;
  /** heightfield spacing (m): finer than the 2 cm grid so a step stays a step, not a ramp */
  sample_m: number;
}
export const PHYSICS: PhysicsCfg = {
  speed_mps: 0.35, push_max_n: 40, hand_load_n: 30, grip_torque_nm: 20, frame_mass_kg: 3, wheel_radius_m: 0.0635,
  glide_radius_m: 0.033, glide_friction: 0.25, stall_s: 0.25, sample_m: 0.005,
};

export interface Snag {
  /** where the leg caught (floor frame) */
  position: XY; s_m: number; leg: 'front wheel' | 'rear glide'; height_m: number; comp: number;
  /** push needed to get going again, at the limit by definition; `tipped` if the frame rolled or pitched past 10 deg */
  push_n: number; tipped: boolean;
}
export interface PhysicsResult {
  snags: Snag[];
  /** hardest push on each bump component the walker crossed (N), snag or not */
  peak_push_n: Record<number, number>;
  /** the walker reached the goal */
  done: boolean; sim_s: number; ms: number;
}

let ready: Promise<void> | null = null;
/** Load the Rapier wasm once (inlined in the -compat build, so it works in the worker and under node --test). */
export const initPhysics = () => (ready ??= RAPIER.init());

/** The floor under a box [x0, y0, x1, y1] as ONE Rapier heightfield (the bump layer's heights, flat floor 0 elsewhere),
 *  turned so its local y is up. One field, no seams: where a ball rolls from one collider onto another's border it
 *  meets a sideways edge normal and stops dead, whatever the bump height (FIX_INTERNAL_EDGES only covers one field). */
export function floorField(world: RAPIER.World, g: GridMeta, bump: Float32Array, comps: Int32Array, box: [number, number, number, number], h: number) {
  const [x0, y0, x1, y1] = box, sx = x1 - x0, sy = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ncols = Math.ceil(sx / h), nrows = Math.ceil(sy / h);
  const H = new Float32Array((nrows + 1) * (ncols + 1));
  for (let j = 0; j <= ncols; j++)
    for (let i = 0; i <= nrows; i++) {
      const lx = -sx / 2 + (j * sx) / ncols, lz = -sy / 2 + (i * sy) / nrows;   // rows run along local z, columns along x
      const [ci, cj] = toCell(g, [cx + lx, cy - lz]), k = ci * g.shape[1] + cj;
      H[i + j * (nrows + 1)] = comps[k] ? bump[k] : 0;                         // column-major
    }
  const up = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };   // +90 deg about x: local y -> world z, local z -> world -y
  return world.createCollider(RAPIER.ColliderDesc.heightfield(nrows, ncols, H, { x: sx, y: 1, z: sy }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setTranslation(cx, cy, 0).setRotation(up).setFriction(1));
}

/** Push the walker (frame centre on the planned path) from the start of `route` to its end. */
export function pushAlong(g: GridMeta, bump: Float32Array, comps: Int32Array, route: XY[], w: WalkerCfg, over: Partial<PhysicsCfg> = {}): PhysicsResult {
  const t0 = performance.now(), P = { ...PHYSICS, ...over };
  const s = [0];
  for (let k = 1; k < route.length; k++) s.push(s[k - 1] + Math.hypot(route[k][0] - route[k - 1][0], route[k][1] - route[k - 1][1]));
  const Ltot = s[s.length - 1];
  let seg = 0;
  const at = (u: number): [number, number, number] => {   // x, y, heading at arc length u (u only grows)
    u = Math.min(Math.max(u, 0), Ltot);
    while (seg < route.length - 2 && s[seg + 1] < u) seg++;
    const a = route[seg], b = route[seg + 1] ?? a, f = (u - s[seg]) / Math.max(s[seg + 1] - s[seg], 1e-9);
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), Math.atan2(b[1] - a[1], b[0] - a[0])];
  };
  // the floor around the whole route, one field (sampled every 10 cm: route vertices can be far apart)
  const reach = 0.8, box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let v = 0; v <= Ltot + 0.1; v += 0.1) {
    const [x, y] = at(Math.min(v, Ltot));
    box[0] = Math.min(box[0], x - reach); box[1] = Math.min(box[1], y - reach); box[2] = Math.max(box[2], x + reach); box[3] = Math.max(box[3], y + reach);
  }
  seg = 0;

  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = 1 / 240;
  // a catch-all below the field (only reached off its edge)
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 50, 0.05).setTranslation(0, 0, -0.051).setFriction(1));
  floorField(world, g, bump, comps, box, P.sample_m);

  const [x0, y0, yaw0] = at(0), off = w.user_gap_m + w.depth_m / 2;   // walker.json legs are from the body centre
  const q = (yaw: number) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x0, y0, 0).setRotation(q(yaw0))
    .setLinearDamping(0.5).setAngularDamping(2).setCanSleep(false));
  // the frame's mass sits at mid-height (a sensor: mass, no contacts)
  world.createCollider(RAPIER.ColliderDesc.cuboid(w.depth_m / 2, w.width_m / 2, w.handle_height_m / 2).setTranslation(0, 0, w.handle_height_m / 2)
    .setSensor(true).setMass(P.frame_mass_kg), body);
  const frontX = Math.max(...w.legs.map(l => l[0]));
  const legs = w.legs.map(([lx, ly]) => {
    const wheel = lx === frontX, r = wheel ? P.wheel_radius_m : P.glide_radius_m;
    world.createCollider(RAPIER.ColliderDesc.ball(r).setTranslation(lx - off, ly, r).setMass(0.1)
      .setFriction(wheel ? 0 : P.glide_friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0), body);
    return { lx: lx - off, ly, r, kind: (wheel ? 'front wheel' : 'rear glide') as Snag['leg'] };
  });
  const grip = { x: -w.depth_m / 2 + 0.05, z: w.handle_height_m };   // hands on the grips, user side

  const out: PhysicsResult = { snags: [], peak_push_n: {}, done: false, sim_s: 0, ms: 0 };
  const dt = world.timestep, tMax = Ltot / P.speed_mps * 3 + 5;
  let u = 0, slow = 0, quiet = 0, integ = 0;
  const local = (yaw: number, lx: number, ly: number, p: { x: number; y: number }): XY =>
    [p.x + Math.cos(yaw) * lx - Math.sin(yaw) * ly, p.y + Math.sin(yaw) * lx + Math.cos(yaw) * ly];
  const cellAt = (xy: XY) => { const [ci, cj] = toCell(g, xy); return ci * g.shape[1] + cj; };
  // arc length of the walker's closest point on the route, searched a little ahead of the last one (never backwards)
  const project = (x: number, y: number) => {
    let best = u, bd = Infinity;
    for (let k = Math.max(0, seg - 1); k < route.length - 1 && s[k] < u + 0.5; k++) {
      const [ax, ay] = route[k], dx = route[k + 1][0] - ax, dy = route[k + 1][1] - ay, l2 = dx * dx + dy * dy || 1e-12;
      const f = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)), d = Math.hypot(ax + f * dx - x, ay + f * dy - y);
      if (d < bd) { bd = d; best = s[k] + f * Math.sqrt(l2); }
    }
    return Math.max(u, best);
  };
  for (let t = 0; t < tMax; t += dt) {
    const p = body.translation(), v = body.linvel(), rot = body.rotation();
    const yaw = Math.atan2(2 * (rot.w * rot.z + rot.x * rot.y), 1 - 2 * (rot.y * rot.y + rot.z * rot.z));
    u = project(p.x, p.y);
    if (u >= Ltot - 0.02) { out.done = true; out.sim_s = t; break; }
    const [cx, cy] = at(u), [, , th] = at(Math.min(u + 0.15, Ltot));   // steer toward the route a little ahead
    const ax = Math.cos(at(u)[2]), ay = Math.sin(at(u)[2]);
    // the person: a steady push that builds up while the walker is slower than their walking speed (PI on speed),
    // capped at what they can give; sideways, they just keep it on the path (not counted against the push limit)
    const vAlong = v.x * ax + v.y * ay, err = P.speed_mps - vAlong;
    integ = Math.min(P.push_max_n, Math.max(0, integ + 120 * err * dt));
    const push = Math.min(P.push_max_n, Math.max(0, 40 * err + integ));
    const ex = p.x - cx, ey = p.y - cy, side = -ay * ex + ax * ey, vSide = -ay * v.x + ax * v.y;
    const fSide = -300 * side - 40 * vSide;
    const fx = push * ax - fSide * ay, fy = push * ay + fSide * ax;
    body.resetForces(false); body.resetTorques(false);
    const [gx, gy] = local(yaw, grip.x, 0, p);
    body.addForceAtPoint({ x: fx, y: fy, z: -P.hand_load_n }, { x: gx, y: gy, z: p.z + grip.z }, false);
    let dyaw = th - yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    // the hands stop the frame tipping forward (rear lifting) or rolling, within what a grip can resist; the nose is
    // free to lift as a wheel climbs
    const { x: qx, y: qy, z: qz, w: qw } = rot, w_ = body.angvel();
    const f = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qw * qz), 2 * (qx * qz - qw * qy)];   // frame forward
    const l = [2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx)];   // frame left
    const down = Math.max(0, -f[2]), wl = w_.x * l[0] + w_.y * l[1] + w_.z * l[2], wf = w_.x * f[0] + w_.y * f[1] + w_.z * f[2];
    const kl = -400 * down - (down > 0 ? 14 * wl : 0), kf = -400 * l[2] - 14 * wf;   // about the left axis, the forward axis
    let tx = kl * l[0] + kf * f[0], ty = kl * l[1] + kf * f[1];
    const tm = Math.hypot(tx, ty);
    if (tm > P.grip_torque_nm) { tx *= P.grip_torque_nm / tm; ty *= P.grip_torque_nm / tm; }
    body.addTorque({ x: tx, y: ty, z: Math.max(-15, Math.min(15, 8 * dyaw - 2.3 * w_.z)) }, false);
    world.step();

    // which leg is at an edge: the biggest rise just ahead of a leg over the floor under it
    let worst = { k: -1, h: 0, c: 0, xy: [0, 0] as XY };
    legs.forEach((l, k) => {
      const under = bump[cellAt(local(yaw, l.lx, l.ly, p))];
      for (let ahead = 0.01; ahead <= l.r + 0.05; ahead += 0.01) {   // the edge it is up against, or just met
        const xy = local(yaw, l.lx + ahead, l.ly, p), c = cellAt(xy);
        if (comps[c] && bump[c] - under > worst.h) worst = { k, h: bump[c] - under, c: comps[c], xy };
      }
    });
    if (worst.k >= 0) out.peak_push_n[worst.c] = Math.max(out.peak_push_n[worst.c] ?? 0, push);
    const tilt = Math.asin(Math.min(1, Math.hypot(2 * (rot.w * rot.x + rot.y * rot.z), 2 * (rot.w * rot.y - rot.z * rot.x))));
    // a snag: full push and the walker all but stopped, for stall_s; or the frame tips
    slow = push >= P.push_max_n - 1e-6 && vAlong < 0.3 * P.speed_mps ? slow + dt : 0;
    quiet = Math.max(0, quiet - Math.max(vAlong, 0) * dt);
    const tipped = tilt > (10 * Math.PI) / 180;
    if ((slow >= P.stall_s || tipped) && quiet === 0) {
      const k = worst.k >= 0 ? worst.k : 0, l = legs[k];
      out.snags.push({ position: worst.k >= 0 ? worst.xy : [p.x, p.y], s_m: u, leg: l.kind, height_m: worst.h, comp: worst.c, push_n: push, tipped });
      // the person lifts the walker over: set it down a few cm on, upright, and walks on
      const step = 2 * l.r + 0.03;
      body.setTranslation({ x: p.x + ax * step, y: p.y + ay * step, z: 0.06 }, false);
      body.setRotation(q(th), false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false); body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      slow = 0; integ = 0; quiet = 0.1;
    }
    out.sim_s = t;
  }
  world.free();
  out.ms = performance.now() - t0;
  return out;
}

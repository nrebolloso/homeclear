// Live object physics (Rapier, in its own worker: physworker.ts). Each movable object is a rigid body whose collider is
// its own splat, voxelised into columns (a chair keeps its seat, back and legs; a table its top and legs); the mat is a
// thin slab that slides on the floor, with a hinged flap where the splat shows a curled corner. The walker is pushed by
// the person (capped force) and everything it touches is logged as an event.
// Shapes, positions and the corner lift are the splat's. Masses, frictions and flap stiffness are NOT measured: each run
// samples them from physics_ranges.json, and every number shown says so.
import RAPIER from '@dimforge/rapier3d-compat';
import { cellXY, polyCells, type GridMeta, type Pose, type XY } from './grid.ts';
import type { WalkerCfg } from './walker.ts';

export type Range = [number, number];
export interface PhysRanges {
  objects: Record<string, { mass_kg: Range; floor_friction: Range }>;
  mat: { mass_per_m2_kg: Range; floor_friction: Range; flap_stiffness_nm_per_rad: Range; flap_damping: Range; curl_min_m: number };
  walker: { push_max_n: Range; glide_friction: Range; frame_mass_kg: Range; hand_load_n: Range };
}
export interface PhysObject { name: string; kind: string; pivot: number[]; footprint: XY[]; height_m: number; layer: string;
  /** pivot-local Gaussian centres (x, y, z, ...) with opacity >= 0.3 */
  points: Float32Array }
export interface PhysEvent { t: number; kind: 'bumped' | 'moved' | 'tipped' | 'slid' | 'corner_caught' | 'corner_folded';
  object: string; k: number; value?: number; at: XY }
export interface Sampled { [object: string]: Record<string, number> }

/** Deterministic per-run sampling (seeded), so a run can be repeated and its values reported. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r: Range, u: () => number) => r[0] + (r[1] - r[0]) * u();

const VOX = 0.05;
/** Points -> vertical cuboids: occupied VOX voxels (>= 2 points), contiguous runs per column merged. Clipped to z >= 2 mm
 *  (runners lying flat dip below the floor band) so nothing starts inside the floor. */
export function columns(p: Float32Array, stride = 3): { c: [number, number, number]; h: [number, number, number] }[] {
  const cnt = new Map<string, number>();
  for (let i = 0; i < p.length; i += stride) {
    const k = `${Math.floor(p[i] / VOX)},${Math.floor(p[i + 1] / VOX)},${Math.floor(p[i + 2] / VOX)}`;
    cnt.set(k, (cnt.get(k) ?? 0) + 1);
  }
  const cols = new Map<string, number[]>();
  for (const [k, n] of cnt) if (n >= 2) { const [x, y, z] = k.split(',').map(Number); const key = `${x},${y}`; (cols.get(key) ?? cols.set(key, []).get(key)!).push(z); }
  const out: { c: [number, number, number]; h: [number, number, number] }[] = [];
  for (const [key, zs] of cols) {
    const [x, y] = key.split(',').map(Number);
    zs.sort((a, b) => a - b);
    for (let s = 0; s < zs.length;) {
      let e = s;
      while (e + 1 < zs.length && zs[e + 1] === zs[e] + 1) e++;
      const z0 = Math.max(zs[s] * VOX, 0.002), z1 = (zs[e] + 1) * VOX;
      if (z1 > z0 + 0.004) out.push({ c: [(x + 0.5) * VOX, (y + 0.5) * VOX, (z0 + z1) / 2], h: [VOX / 2, VOX / 2, (z1 - z0) / 2] });
      s = e + 1;
    }
  }
  return out;
}

/** The most curled corner of a mat, from the bump layer: highest cell within 15 cm of a corner (inside the mat) above
 *  the mat's median height. null if no corner stands curl_min_m above the rest. */
export function curledCorner(points: Float32Array, poly: XY[], curlMin: number) {
  // the mat's own splat points (pivot-local, like poly): the bump layer has movable rugs cut out, so it can't show a curl
  const pts: { x: number; y: number; h: number }[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) pts.push({ x: points[i], y: points[i + 1], h: points[i + 2] });
  if (!pts.length) return null;
  const q = (hs: number[], f: number) => hs.sort((a, b) => a - b)[Math.floor(f * (hs.length - 1))];
  const med = q(pts.map(c => c.h), 0.5);
  let best: { corner: number; lift_m: number; size_m: number } | null = null;
  poly.forEach(([cx, cy], k) => {
    const near = pts.filter(c => Math.hypot(c.x - cx, c.y - cy) < 0.06);   // the tip: a curl rises toward the corner
    if (near.length < 5) return;
    const top = q(near.map(c => c.h), 0.9) - med;   // 90th percentile, not max: single floaters are splat noise
    // flap size: how far from the corner the raised points reach (at least 6 cm, at most 20)
    const reach = Math.max(0, ...pts.filter(c => c.h - med > top / 3 && Math.hypot(c.x - cx, c.y - cy) < 0.25).map(c => Math.hypot(c.x - cx, c.y - cy)));
    // never past half of either adjacent edge, or the cut-down slab turns inside out on a small mat
    const n = poly.length, edge = Math.min(Math.hypot(poly[(k + 1) % n][0] - cx, poly[(k + 1) % n][1] - cy), Math.hypot(poly[(k + n - 1) % n][0] - cx, poly[(k + n - 1) % n][1] - cy));
    if (top >= curlMin && (!best || top > best.lift_m)) best = { corner: k, lift_m: top, size_m: Math.min(0.2, edge / 2, Math.max(0.06, reach * Math.SQRT2)) };
  });
  return best as { corner: number; lift_m: number; size_m: number } | null;
}

// collision groups (membership << 16 | filter)
const FLOOR = 1, WALL = 2, OBJ = 4, MATBOT = 8, MATTOP = 16, WALKER = 32, FLAP = 64;
const grp = (m: number, f: number) => (m << 16) | f;
const yawQ = (yaw: number) => ({ x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });
const yawOf = (q: { x: number; y: number; z: number; w: number }) => Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
const tiltOf = (q: { x: number; y: number; z: number; w: number }) => Math.acos(Math.min(1, Math.abs(1 - 2 * (q.x * q.x + q.y * q.y))));   // body z vs world z
const rot = (q: { x: number; y: number; z: number; w: number }, v: [number, number, number]): [number, number, number] => {
  const [x, y, z] = v, { x: qx, y: qy, z: qz, w: qw } = q;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
};

export interface WorldInit {
  g: GridMeta; obst: Uint8Array; bump: Float32Array; objects: PhysObject[]; poses: Pose[]; walker: WalkerCfg;
  ranges: PhysRanges; seed: number;
  /** object pairs filmed overlapping (a chair tucked under the table): they never collide with each other */
  overlap: [number, number][];
}

export function createWorld(I: WorldInit) {
  const u = rng(I.seed), sampled: Sampled = {};
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  world.timestep = 1 / 120;
  const events = new RAPIER.EventQueue(true);
  const owner = new Map<number, number>();   // collider handle -> object index (-1 walker, -2 flap)
  const ignore = new Set(I.overlap.map(([a, b]) => `${Math.min(a, b)},${Math.max(a, b)}`));

  world.createCollider(RAPIER.ColliderDesc.cuboid(100, 100, 0.5).setTranslation(0, 0, -0.5).setFriction(1).setCollisionGroups(grp(FLOOR, OBJ | MATBOT | WALKER | FLAP)));
  // walls/cabinets: measured obstacle cells (movable objects' own spots excluded), merged into rectangles, 2 m tall
  const { g } = I, [nx, ny] = g.shape;
  const runs = new Map<string, number>();   // "j0,j1" -> i0 of the open rectangle
  const wall = (i0: number, i1: number, j0: number, j1: number) => world.createCollider(RAPIER.ColliderDesc.cuboid((i1 - i0) * g.cell_m / 2, (j1 - j0) * g.cell_m / 2, 1)
    .setTranslation(g.origin_xy[0] + (i0 + i1) * g.cell_m / 2, g.origin_xy[1] + (j0 + j1) * g.cell_m / 2, 1).setFriction(0.5).setCollisionGroups(grp(WALL, OBJ | MATBOT | WALKER)));
  for (let i = 0; i <= nx; i++) {
    const row = new Set<string>();
    if (i < nx) for (let j = 0; j < ny;) {
      if (!I.obst[i * ny + j]) { j++; continue; }
      let e = j; while (e < ny && I.obst[i * ny + e]) e++;
      row.add(`${j},${e}`); j = e;
    }
    for (const [k, i0] of runs) if (!row.has(k)) { const [j0, j1] = k.split(',').map(Number); wall(i0, i, j0, j1); runs.delete(k); }
    for (const k of row) if (!runs.has(k)) runs.set(k, i);
  }

  // objects
  interface Body { k: number; o: PhysObject; rb: RAPIER.RigidBody; rest: Pose; disturbed: number; announced: boolean; tipped: boolean; mat: boolean; fixed: boolean; still: number }
  const bodies: Body[] = [];
  let flap: { rb: RAPIER.RigidBody; mat: Body; out: [number, number, number]; folded: boolean; corner: XY; lift_m: number; size_m: number; tri: XY[] } | null = null;
  I.objects.forEach((o, k) => {
    const p = I.poses[k], mat = o.kind === 'rug';
    let z5 = 0;
    if (!mat) { const zs: number[] = []; for (let i = 2; i < o.points.length; i += 3) zs.push(o.points[i]); zs.sort((a, b) => a - b); z5 = zs[Math.floor(zs.length * 0.05)] ?? 0; }
    const fixed = !mat && (o.kind === 'door' || z5 > 0.15);   // a hinged leaf can't slide (swing not modelled), or stands on a cabinet out of reach: kept still
    const rb = world.createRigidBody((fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic().setSleeping(true).setLinearDamping(0.2).setAngularDamping(0.5))
      .setTranslation(p.x, p.y, 0).setRotation(yawQ(p.yaw)).setEnabled(!p.removed));
    const s: Record<string, number> = {};
    const add = (d: RAPIER.ColliderDesc) => { const c = world.createCollider(d.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), rb); owner.set(c.handle, k); return c; };
    if (mat) {
      const R = I.ranges.mat, [a, b, c] = o.footprint;
      const w = Math.hypot(b[0] - a[0], b[1] - a[1]), d = Math.hypot(c[0] - b[0], c[1] - b[1]), t = Math.max(o.height_m, 0.004);
      s.mass_kg = pick(R.mass_per_m2_kg, u) * w * d; s.floor_friction = pick(R.floor_friction, u);
      // the curled corner (if the splat shows one) is cut off the slab and hung on a hinge
      const world0 = o.footprint.map(([x, y]) => [x + o.pivot[0], y + o.pivot[1]] as XY);
      const curl = curledCorner(o.points, o.footprint, R.curl_min_m);
      let poly = o.footprint.map(q => [q[0], q[1]] as XY);   // pivot-local; the body sits at the pose
      let tri: XY[] | null = null;
      if (curl) {
        const n = poly.length, C = poly[curl.corner], P = poly[(curl.corner + n - 1) % n], N = poly[(curl.corner + 1) % n];
        const along = (q: XY) => { const l = Math.hypot(q[0] - C[0], q[1] - C[1]); return [C[0] + (q[0] - C[0]) / l * curl.size_m, C[1] + (q[1] - C[1]) / l * curl.size_m] as XY; };
        const A = along(P), B = along(N);
        tri = [A, C, B];
        poly = poly.flatMap((q, i) => (i === curl.corner ? [A, B] : [q]));
        s.flap_stiffness_nm_per_rad = pick(R.flap_stiffness_nm_per_rad, u); s.flap_damping = pick(R.flap_damping, u);
      }
      const prism = (pts: XY[], z0: number, z1: number) => new Float32Array(pts.flatMap(([x, y]) => [x, y, z0, x, y, z1]));
      const area = Math.abs(poly.reduce((acc, q, i) => { const r = poly[(i + 1) % poly.length]; return acc + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;
      add(RAPIER.ColliderDesc.convexHull(prism(poly, 0, t / 2))!.setMass(s.mass_kg).setFriction(s.floor_friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setCollisionGroups(grp(MATBOT, FLOOR | WALL)));
      add(RAPIER.ColliderDesc.convexHull(prism(poly, t / 2, t))!.setMass(0.001).setFriction(1).setCollisionGroups(grp(MATTOP, OBJ | WALKER)));
      const body: Body = { k, o, rb, rest: { ...p }, disturbed: 0, announced: false, tipped: false, mat: true, fixed: false, still: 0 };
      bodies.push(body);
      if (tri && curl) {
        const [A, C, B] = tri, mid: [number, number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, t];
        const ol = Math.hypot(C[0] - mid[0], C[1] - mid[1]), out: [number, number, number] = [(C[0] - mid[0]) / ol, (C[1] - mid[1]) / ol, 0];
        const axis = { x: out[1], y: -out[0], z: 0 };   // axis x out = +z: a positive angle lifts the corner
        const q0 = yawQ(p.yaw), mw = rot(q0, mid);
        const frb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setSleeping(true).setTranslation(p.x + mw[0], p.y + mw[1], mw[2]).setRotation(q0).setAngularDamping(0.5));
        const fc = world.createCollider(RAPIER.ColliderDesc.convexHull(prism(tri.map(([x, y]) => [x - mid[0], y - mid[1]] as XY), -t, 0))!
          .setMass(Math.max(0.005, (s.mass_kg / area) * curl.size_m ** 2 / 2)).setFriction(1).setCollisionGroups(grp(FLAP, WALKER | FLOOR))
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), frb);
        owner.set(fc.handle, -2);
        const j = world.createImpulseJoint(RAPIER.JointData.revolute({ x: mid[0], y: mid[1], z: mid[2] }, { x: 0, y: 0, z: 0 }, axis), rb, frb, true) as RAPIER.RevoluteImpulseJoint;
        const rest = Math.asin(Math.min(1, curl.lift_m / ol));
        j.configureMotorModel(RAPIER.MotorModel.ForceBased);   // stiffness in N m per rad, not an acceleration
        j.configureMotorPosition(rest, s.flap_stiffness_nm_per_rad, s.flap_damping);
        // start at the curl (rotate about the hinge, through its midpoint)
        const h = Math.sin(rest / 2), qa = { x: axis.x * h, y: axis.y * h, z: 0, w: Math.cos(rest / 2) };
        frb.setRotation({ w: q0.w * qa.w - q0.z * qa.z, x: q0.w * qa.x - q0.z * qa.y, y: q0.w * qa.y + q0.z * qa.x, z: q0.z * qa.w + q0.w * qa.z }, false);
        flap = { rb: frb, mat: body, out, folded: false, corner: world0[curl.corner], lift_m: curl.lift_m, size_m: curl.size_m, tri: tri.map(q => [q[0] - mid[0], q[1] - mid[1]] as XY) };
        sampled['curled corner'] = { lift_m_measured: curl.lift_m, size_m_measured: curl.size_m };
      }
    } else {
      const R = I.ranges.objects[o.kind] ?? I.ranges.objects.other, cols = columns(o.points);
      if (!cols.length) {   // no splat points (synthetic scene): a box over the footprint, floor to height
        const xs = o.footprint.map(q => q[0]), ys = o.footprint.map(q => q[1]), h = Math.max(o.height_m, 0.01);
        cols.push({ c: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, h / 2], h: [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...ys) - Math.min(...ys)) / 2, h / 2] });
      }
      s.mass_kg = pick(R.mass_kg, u); s.floor_friction = pick(R.floor_friction, u);
      const vol = cols.reduce((a, c) => a + c.h[0] * c.h[1] * c.h[2], 0) || 1;
      for (const c of cols) add(RAPIER.ColliderDesc.cuboid(...c.h).setTranslation(...c.c).setMass((s.mass_kg * c.h[0] * c.h[1] * c.h[2]) / vol)
        .setFriction(s.floor_friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setCollisionGroups(grp(OBJ, FLOOR | WALL | OBJ | WALKER | MATTOP)));
      // it was filmed standing, but a half-seen splat (legs hidden under a table) has no support and topples: a 1 cm foot
      // inside each footprint corner stands in for the legs; they only touch the floor and the mat, never the walker
      const [cx, cy] = o.footprint.reduce((a, q) => [a[0] + q[0] / o.footprint.length, a[1] + q[1] / o.footprint.length], [0, 0]);
      for (const [x, y] of o.footprint) {
        const d = Math.hypot(x - cx, y - cy) || 1, f = Math.max(0, 1 - 0.04 / d);
        add(RAPIER.ColliderDesc.cuboid(0.02, 0.02, 0.005).setTranslation(cx + (x - cx) * f, cy + (y - cy) * f, 0.005).setMass(0)
          .setFriction(s.floor_friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setCollisionGroups(grp(OBJ, FLOOR | MATTOP)));
      }
      bodies.push({ k, o, rb, rest: { ...p }, disturbed: 0, announced: false, tipped: false, mat: false, fixed, still: 0 });
    }
    if (!fixed) sampled[o.name] = s;
  });

  // the walker: dynamic, upright (roll/pitch locked: tipping the walker is the route pass in physics.ts), pushed by the person
  const W = I.ranges.walker, wv = { push_max_n: pick(W.push_max_n, u), glide_friction: pick(W.glide_friction, u), frame_mass_kg: pick(W.frame_mass_kg, u), hand_load_n: pick(W.hand_load_n, u) };
  sampled.walker = wv;
  const walker = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0.01).setCanSleep(false).setLinearDamping(1).enabledRotations(false, false, true));
  const wk = I.walker, frontX = Math.max(...wk.legs.map(l => l[0])), WR = 0.0635, GR = 0.033, hh = wk.handle_height_m;
  const wcol = (d: RAPIER.ColliderDesc) => owner.set(world.createCollider(d.setCollisionGroups(grp(WALKER, FLOOR | WALL | OBJ | MATTOP | FLAP)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), walker).handle, -1);
  for (const [lx, ly] of wk.legs) {
    const wheel = lx === frontX, r = wheel ? WR : GR;
    wcol(RAPIER.ColliderDesc.ball(r).setTranslation(lx, ly, r).setMass(0.1).setFriction(wheel ? 0 : wv.glide_friction).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min));
    // the leg tube, from above the wheel/glide to the handle
    const z0 = 2 * r + 0.01;
    wcol(RAPIER.ColliderDesc.capsule((hh - z0) / 2, wk.leg_radius_m).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }).setTranslation(lx, ly, (hh + z0) / 2).setMass(wv.frame_mass_kg / 8).setFriction(0.3));
  }
  // capsules lie along their local y: the leg tubes turn to z, the side rails to x, the cross brace stays along y
  for (const side of [1, -1]) {   // side rails at handle height, front leg to back leg
    const [f] = wk.legs.filter(l => l[0] === frontX && Math.sign(l[1]) === side), [b] = wk.legs.filter(l => l[0] !== frontX && Math.sign(l[1]) === side);
    if (!f || !b) continue;
    wcol(RAPIER.ColliderDesc.capsule((f[0] - b[0]) / 2, wk.leg_radius_m).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
      .setTranslation((f[0] + b[0]) / 2, side * Math.abs(f[1]), hh).setMass(wv.frame_mass_kg / 4).setFriction(0.3));
    wcol(RAPIER.ColliderDesc.capsule((f[0] - b[0]) / 2, wk.leg_radius_m).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })   // lower side brace
      .setTranslation((f[0] + b[0]) / 2, side * Math.abs(f[1]), 0.3).setMass(0.01).setFriction(0.3));
  }
  const hy = Math.max(...wk.legs.map(l => Math.abs(l[1])));   // front cross brace (as walker.ts draws it; open at the back for the user)
  wcol(RAPIER.ColliderDesc.capsule(hy, wk.leg_radius_m).setTranslation(frontX, 0, 0.45).setMass(0.01).setFriction(0.3));

  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(c1, c2) {
      const a = owner.get(c1), b = owner.get(c2);
      if (a === undefined || b === undefined || a < 0 || b < 0 || a === b) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      return ignore.has(`${Math.min(a, b)},${Math.max(a, b)}`) ? null : RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair: () => true,
  };

  let t = 0, acc = 0, lastBump = new Map<number, number>();
  const flapAngle = () => {
    if (!flap) return 0;
    const o = rot(flap.rb.rotation(), flap.out), m = rot(flap.mat.rb.rotation(), flap.out), up = rot(flap.mat.rb.rotation(), [0, 0, 1]);
    return Math.atan2(o[0] * up[0] + o[1] * up[1] + o[2] * up[2], o[0] * m[0] + o[1] * m[1] + o[2] * m[2]);
  };
  return {
    sampled, walkerValues: wv, flapInfo: () => flap && { corner: flap.corner, lift_m: flap.lift_m, size_m: flap.size_m, tri: flap.tri, angle: flapAngle(), folded: flap.folded },
    /** Put the walker on the person's spot (no physics in between). */
    placeWalker(b: { x: number; y: number; yaw: number }) {
      walker.setTranslation({ x: b.x, y: b.y, z: 0.01 }, true); walker.setRotation(yawQ(b.yaw), true);
      walker.setLinvel({ x: 0, y: 0, z: 0 }, true); walker.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    /** Layout changed in the viewer (drag, remove, put back): teleport the bodies that differ, upright and still. */
    setPoses(poses: Pose[]) {
      for (const B of bodies) {
        const p = poses[B.k], q = B.rb.translation(), off = !!p.removed !== !B.rb.isEnabled();
        if (off) B.rb.setEnabled(!p.removed);
        if (!off && Math.hypot(q.x - p.x, q.y - p.y) < 0.01 && Math.abs(Math.atan2(Math.sin(yawOf(B.rb.rotation()) - p.yaw), Math.cos(yawOf(B.rb.rotation()) - p.yaw))) < 0.02) continue;
        B.rb.setTranslation({ x: p.x, y: p.y, z: 0 }, false); B.rb.setRotation(yawQ(p.yaw), false);
        B.rb.setLinvel({ x: 0, y: 0, z: 0 }, false); B.rb.setAngvel({ x: 0, y: 0, z: 0 }, false);
        B.rest = { ...p }; B.tipped = false; B.disturbed = 0; B.announced = false;
        if (B.mat && flap) { flap.rb.setEnabled(false); flap = null; }   // a moved mat lies flat where it is put (no corner flap)
      }
    },
    /** Advance dt seconds with the person pushing the walker toward `target` (body centre + heading). */
    step(dt: number, target: { x: number; y: number; yaw: number }) {
      const out: PhysEvent[] = [], settled: { k: number; pose: Pose; moved_m: number; tipped: boolean }[] = [];
      acc = Math.min(acc + dt, 0.1);   // a slow frame catches up, up to 0.1 s (below that the walk runs in slow motion)
      const wp = walker.translation();
      if (Math.hypot(target.x - wp.x, target.y - wp.y) > 0.4) this.placeWalker(target);   // fell far behind (a teleport, a new route)
      while (acc >= world.timestep) {
        acc -= world.timestep; t += world.timestep;
        const p = walker.translation(), v = walker.linvel(), q = walker.rotation();
        // the person: velocity toward the target, force capped at what they can push (both ways: they also hold back)
        let fx = 60 * ((target.x - p.x) * 6 - v.x), fy = 60 * ((target.y - p.y) * 6 - v.y);
        const f = Math.hypot(fx, fy);
        if (f > wv.push_max_n) { fx *= wv.push_max_n / f; fy *= wv.push_max_n / f; }
        walker.resetForces(false);
        walker.addForce({ x: fx, y: fy, z: -wv.hand_load_n }, false);
        let dy = target.yaw - yawOf(q); dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        walker.setAngvel({ x: 0, y: 0, z: Math.max(-3, Math.min(3, 8 * dy)) }, true);
        world.step(events, hooks);
        events.drainCollisionEvents((h1, h2, started) => {
          if (!started) return;
          const a = owner.get(h1), b = owner.get(h2);
          if (a === undefined || b === undefined || (a !== -1) === (b !== -1)) return;   // only walker vs something
          const k = a === -1 ? b : a, at = walker.translation();
          if (k === -2 && flap && flapAngle() > 0.05) out.push({ t, kind: 'corner_caught', object: flap.mat.o.name, k: flap.mat.k, value: flapAngle(), at: [at.x, at.y] });
          if (k < 0) return;
          const B = bodies.find(x => x.k === k)!;
          B.disturbed = t;
          if (B.mat) return;   // walking over the mat is not a bump; sliding it is
          if (t - (lastBump.get(k) ?? -9) > 1) out.push({ t, kind: 'bumped', object: B.o.name, k, at: [at.x, at.y] });
          lastBump.set(k, t);
        });
      }
      for (const B of bodies) {
        if (B.fixed || !B.rb.isEnabled() || (B.rb.isSleeping() && !B.disturbed)) continue;
        const q = B.rb.rotation(), tr = B.rb.translation(), tilt = tiltOf(q);
        if (!B.tipped && tilt > (30 * Math.PI) / 180) { B.tipped = true; out.push({ t, kind: 'tipped', object: B.o.name, k: B.k, value: (tilt * 180) / Math.PI, at: [tr.x, tr.y] }); }
        const d = Math.hypot(tr.x - B.rest.x, tr.y - B.rest.y);
        if (!B.announced && d > 0.02) { B.announced = true; out.push({ t, kind: B.mat ? 'slid' : 'moved', object: B.o.name, k: B.k, value: d, at: [tr.x, tr.y] }); }   // as it happens
        const lv = B.rb.linvel(), av = B.rb.angvel();
        B.still = Math.hypot(lv.x, lv.y, lv.z) < 0.01 && Math.hypot(av.x, av.y, av.z) < 0.05 ? B.still + dt : 0;
        if ((B.still > 0.3 || B.rb.isSleeping()) && B.disturbed > 0) {   // came to rest after the walker touched it: where it ended up
          const pose = { x: tr.x, y: tr.y, yaw: yawOf(q) };
          const turn = Math.abs(Math.atan2(Math.sin(pose.yaw - B.rest.yaw), Math.cos(pose.yaw - B.rest.yaw)));
          // a brush of a few cm is not a change to the room: the layout keeps the pose until nudges add up past 5 cm / 5°
          if (d > 0.05 || turn > 0.087) { settled.push({ k: B.k, pose, moved_m: d, tipped: B.tipped }); B.rest = pose; }
          B.disturbed = 0; B.announced = false;
        }
      }
      if (flap && !flap.folded && flapAngle() > Math.PI / 2) { flap.folded = true; out.push({ t, kind: 'corner_folded', object: flap.mat.o.name, k: flap.mat.k, value: flapAngle(), at: flap.corner }); }
      if (flap && flap.folded && flapAngle() < Math.PI / 3) flap.folded = false;
      const wq = walker.translation(), poses = bodies.filter(B => !B.fixed && B.rb.isEnabled()).map(B => {
        const tr = B.rb.translation(), q = B.rb.rotation();
        return [B.k, tr.x, tr.y, tr.z, q.x, q.y, q.z, q.w];
      });
      const fq = flap && { p: flap.rb.translation(), q: flap.rb.rotation() };
      return { t, walker: { x: wq.x, y: wq.y, yaw: yawOf(walker.rotation()) }, poses, flap: fq && [fq.p.x, fq.p.y, fq.p.z, fq.q.x, fq.q.y, fq.q.z, fq.q.w], events: out, settled };
    },
    free: () => world.free(),
  };
}

/** Gaussian centres (opacity >= 0.3) from a binary little-endian 3DGS PLY. */
export function plyPoints(buf: ArrayBuffer): Float32Array {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 8192)));
  const end = head.indexOf('end_header\n');
  if (!head.startsWith('ply') || end < 0 || !head.includes('binary_little_endian')) throw new Error('not a binary little-endian PLY');
  const n = Number(/element vertex (\d+)/.exec(head)![1]);
  const props = [...head.slice(0, end).matchAll(/property (\w+) (\w+)/g)].map(m => ({ type: m[1], name: m[2] }));
  const size: Record<string, number> = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4, short: 2, ushort: 2 };
  const off: Record<string, number> = {};
  let stride = 0;
  for (const p of props) { off[p.name] = stride; stride += size[p.type] ?? 4; }
  const dv = new DataView(buf, end + 'end_header\n'.length), out: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = i * stride;
    if ('opacity' in off && 1 / (1 + Math.exp(-dv.getFloat32(b + off.opacity, true))) < 0.3) continue;
    out.push(dv.getFloat32(b + off.x, true), dv.getFloat32(b + off.y, true), dv.getFloat32(b + off.z, true));
  }
  return new Float32Array(out);
}

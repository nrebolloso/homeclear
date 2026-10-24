// Object physics on a SYNTHETIC room (no splat): a light chair is pushed aside, a heavy table stops the walker, a mat
// slides when it is slippery and stays when it grips, a curled corner is caught and folded by a wheel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics } from '../src/physics.ts';
import { createWorld, columns, curledCorner, type PhysObject, type PhysRanges, type PhysEvent } from '../src/objphys.ts';
import type { GridMeta, Pose, XY } from '../src/grid.ts';

const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.02, shape: [250, 150] };   // 5 m x 3 m, no walls
const ny = g.shape[1];
const walker = { width_m: 0.66, depth_m: 0.5, handle_height_m: 0.85, user_gap_m: 0.25, leg_radius_m: 0.015,
  legs: [[0.75, 0.315], [0.75, -0.315], [0.25, 0.315], [0.25, -0.315]] as [number, number][] };
const fixed = (v: number): [number, number] => [v, v];
const ranges = (o: Partial<{ mass: number; fric: number; matFric: number; glide: number; stiff: number }> = {}): PhysRanges => ({
  objects: { chair: { mass_kg: fixed(o.mass ?? 4), floor_friction: fixed(o.fric ?? 0.4) }, other: { mass_kg: fixed(5), floor_friction: fixed(0.5) } },
  mat: { mass_per_m2_kg: fixed(1.2), floor_friction: fixed(o.matFric ?? 0.3), flap_stiffness_nm_per_rad: fixed(o.stiff ?? 0.03), flap_damping: fixed(0.003), curl_min_m: 0.008 },
  walker: { push_max_n: fixed(50), glide_friction: fixed(o.glide ?? 0.35), frame_mass_kg: fixed(3), hand_load_n: fixed(30) },
});
/** A solid box of points (2 cm spacing), pivot-local: x0..x1, y0..y1, z0..z1. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const p: number[] = [];
  for (let x = x0; x <= x1; x += 0.02) for (let y = y0; y <= y1; y += 0.02) for (let z = z0; z <= z1; z += 0.02) p.push(x, y, z);
  return p;
}
/** A chair-ish thing: four legs and a seat, 44 x 44 cm, around its pivot. */
const chairPts = () => new Float32Array([
  ...box(-0.2, -0.17, -0.2, -0.17, 0, 0.44), ...box(0.17, 0.2, -0.2, -0.17, 0, 0.44), ...box(-0.2, -0.17, 0.17, 0.2, 0, 0.44), ...box(0.17, 0.2, 0.17, 0.2, 0, 0.44),
  ...box(-0.22, 0.22, -0.22, 0.22, 0.42, 0.47)]);
const sq = (h: number): XY[] => [[-h, -h], [h, -h], [h, h], [-h, h]];
const obj = (name: string, kind: string, at: XY, points: Float32Array, half: number, height = 0.47): PhysObject =>
  ({ name, kind, pivot: [...at], footprint: sq(half), height_m: height, layer: kind === 'rug' ? 'bump' : 'obstacle', points });

/** Push the walker along +x at `v` m/s from x0 for `secs`, return the events and the walker's end x. */
function drive(objects: PhysObject[], r: PhysRanges, bump = new Float32Array(g.shape[0] * ny), o: { x0?: number; y?: number; v?: number; secs?: number; yaw?: number } = {}) {
  const poses: Pose[] = objects.map(ob => ({ x: ob.pivot[0], y: ob.pivot[1], yaw: 0 }));
  const W = createWorld({ g, obst: new Uint8Array(g.shape[0] * ny), bump, objects, poses, walker, ranges: r, seed: 1, overlap: [] });
  const y = o.y ?? 1.5, v = o.v ?? 0.5, yaw = o.yaw ?? 0, dir: XY = [Math.cos(yaw), Math.sin(yaw)];
  let x = o.x0 ?? 0.5, yy = y;
  W.placeWalker({ x, y: yy, yaw });
  const events: PhysEvent[] = [];
  let last: ReturnType<typeof W.step> | null = null, far = 0;
  for (let i = 0; i < (o.secs ?? 6) * 60; i++) {
    // the person walks on only as far as the walker goes (a blocked walker holds them back)
    const wp = last?.walker ?? { x, y: yy };
    if (Math.hypot(x - wp.x, yy - wp.y) < 0.15) { x += dir[0] * v / 60; yy += dir[1] * v / 60; }
    last = W.step(1 / 60, { x, y: yy, yaw });
    events.push(...last.events);
    far = Math.max(far, last.walker.x * dir[0] + last.walker.y * dir[1]);
  }
  const flap = W.flapInfo();
  W.free();
  return { events, end: last!.walker, far, flap, poses: last!.poses };
}

test('voxel columns keep the legs separate from the seat', () => {
  const c = columns(chairPts());
  const legs = c.filter(b => b.c[2] - b.h[2] < 0.01);
  assert.ok(legs.length >= 4 && legs.length <= 16, `leg columns ${legs.length}`);
  assert.ok(c.every(b => b.c[2] - b.h[2] >= 0.002 - 1e-9), 'nothing starts in the floor');
  assert.ok(c.some(b => b.c[2] - b.h[2] > 0.35), 'the seat is its own cuboid above the legs');
});

test('a light chair in the path is bumped and pushed aside; logged as bumped + moved', async () => {
  await initPhysics();
  const r = drive([obj('chair A', 'chair', [2.0, 1.5], chairPts(), 0.22)], ranges({ mass: 3, fric: 0.3 }));
  const kinds = r.events.map(e => e.kind);
  assert.ok(kinds.includes('bumped'), `events: ${kinds}`);
  assert.ok(kinds.includes('moved'), `events: ${kinds}`);
  assert.ok(r.far > 2.0, `walker got to ${r.far.toFixed(2)}`);
});

test('a heavy grippy object blocks the walker (the person cannot push 60 kg)', async () => {
  await initPhysics();
  const table = obj('table', 'chair', [2.0, 1.5], new Float32Array(box(-0.4, 0.4, -0.6, 0.6, 0, 0.75)), 0.6, 0.75);
  const r = drive([table], ranges({ mass: 60, fric: 0.7 }));
  assert.ok(r.events.some(e => e.kind === 'bumped'), 'bumped');
  assert.ok(!r.events.some(e => e.kind === 'moved' && (e.value ?? 0) > 0.05), `moved: ${JSON.stringify(r.events)}`);
  // walker front (body + 0.75 + wheel) stops at the table's near face (x = 1.6)
  assert.ok(r.far + 0.75 < 1.65, `walker front reached ${(r.far + 0.75).toFixed(2)}`);
});

test('a slippery mat slides under the glides; a grippy one stays', async () => {
  await initPhysics();
  const mat = () => obj('mat', 'rug', [1.8, 1.5], new Float32Array(0), 0.4, 0.006);
  const slip = drive([mat()], ranges({ matFric: 0.08, glide: 0.45 }));
  const grip = drive([mat()], ranges({ matFric: 0.6, glide: 0.2 }));
  const slid = (r: typeof slip) => Math.hypot(r.poses[0][1] - 1.8, r.poses[0][2] - 1.5);   // where the mat ended up
  assert.ok(slid(slip) > 0.05 && slip.events.some(e => e.kind === 'slid'), `slippery mat slid ${slid(slip).toFixed(3)} m; events ${slip.events.map(e => e.kind)}`);
  assert.ok(slid(grip) < 0.02, `grippy mat slid ${slid(grip).toFixed(3)} m`);
  assert.ok(grip.far > 2.5, 'the walker crosses a mat that stays put');
});

test('a curled corner is found in the mat splat points, held at its curl, and folded by a wheel running into it', async () => {
  await initPhysics();
  const bump = new Float32Array(g.shape[0] * ny);
  const at: XY = [2.5, 1.5], h = 0.3;
  for (let i = 0; i < g.shape[0]; i++) for (let j = 0; j < ny; j++) {
    const x = (i + 0.5) * g.cell_m, y = (j + 0.5) * g.cell_m;
    if (Math.abs(x - at[0]) > h || Math.abs(y - at[1]) > h) continue;
    // corner (-h, +h) relative to the mat curls up to 3 cm
    const d = Math.hypot(x - (at[0] - h), y - (at[1] + h));
    bump[i * ny + j] = 0.006 + Math.max(0, 0.03 * (1 - d / 0.12));
  }
  // the same surface as the mat's points (pivot-local, 2 cm spacing)
  const pts: number[] = [];
  for (let x = -h; x <= h + 1e-9; x += 0.02) for (let y = -h; y <= h + 1e-9; y += 0.02) pts.push(x, y, 0.006 + Math.max(0, 0.03 * (1 - Math.hypot(x + h, y - h) / 0.12)));
  const m = obj('mat', 'rug', at, new Float32Array(pts), h, 0.006);
  const c = curledCorner(m.points, m.footprint, 0.008);
  assert.ok(c && c.corner === 3 && c.lift_m > 0.015, `curl ${JSON.stringify(c)}`);
  // standing still: the flap holds its curl (stiffness springs it back to the measured lift)
  const still = drive([m], ranges(), bump, { x0: 0.3, v: 0, secs: 2 });
  assert.ok(still.flap && still.flap.angle > 0.1 && !still.flap.folded, `flap at rest ${JSON.stringify(still.flap)}`);
  // a wheel driven into the corner from outside (diagonally, heading at the hinge) catches it and folds it over
  const yaw = -Math.PI / 4, cx = at[0] - h, cy = at[1] + h, lx = 0.75, ly = 0.315;
  // place the left front wheel 25 cm before the corner along the heading
  const wx = cx - 0.25 * Math.cos(yaw), wy = cy - 0.25 * Math.sin(yaw);
  const bx = wx - (lx * Math.cos(yaw) - ly * Math.sin(yaw)), by = wy - (lx * Math.sin(yaw) + ly * Math.cos(yaw));
  const r = drive([m], ranges({ stiff: 0.02 }), bump, { x0: bx, y: by, yaw, v: 0.4, secs: 3 });
  const kinds = r.events.map(e => e.kind);
  assert.ok(kinds.includes('corner_caught'), `events: ${kinds}`);
  assert.ok(kinds.includes('corner_folded'), `events: ${kinds}; flap ${JSON.stringify(r.flap)}`);
});

test('a door leaf is bumped but never slides (hinged; the swing is not modelled)', async () => {
  await initPhysics();
  const leaf = obj('door', 'door', [2.0, 1.5], new Float32Array(box(-0.02, 0.02, -0.4, 0.4, 0, 2.0)), 0.4, 2.0);
  const r = drive([leaf], ranges());
  assert.ok(r.events.some(e => e.kind === 'bumped'), `events: ${r.events.map(e => e.kind)}`);
  assert.ok(!r.events.some(e => e.kind === 'moved') && r.poses.length === 0, `door moved: ${JSON.stringify(r.events)}`);
});

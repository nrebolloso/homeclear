import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureStair, stairChecks, stairFixes, stairFrame, stairYaml, mirrorRail, inRailBand, stepLights, withRails, parkedPose, walkerPlacement, type Stair, type StairCtx } from '../src/stairs.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyIntervention, placedFixtures, type GridMeta, type XY, type Layout } from '../src/grid.ts';
import { diffLayouts, undoChange } from '../src/reimagine.ts';
import { rng } from '../src/sim.ts';
import { loadScene } from './scene.ts';

// a flight going up +y from y = 0, x from 0 to 0.9: `rise` per step, 27 cm treads, rail on the right (x = 0), wall left
function synthStair(risers: number[], opts: { rail?: 'right' | 'none'; wall?: boolean } = {}) {
  const R = rng(7), pts: number[] = [], depth = 0.27, W = 0.9;
  let z = 0;
  risers.forEach((r, k) => {
    z += r;
    for (let n = 0; n < 60; n++) pts.push(0.05 + R.u() * (W - 0.1), k * depth + R.u() * depth, z + (R.u() - 0.5) * 0.006, 0.95);   // tread
    for (let n = 0; n < 20; n++) pts.push(0.05 + R.u() * (W - 0.1), k * depth, z - R.u() * r, 0.1);                              // riser face
  });
  const run = risers.length * depth, pitch = (y: number) => risers[0] + (z - risers[0]) * (y / ((risers.length - 1) * depth));
  if (opts.rail !== 'none') for (let n = 0; n < 300; n++) {
    const y = R.u() * run, p = Math.min(z, pitch(y));
    pts.push(0.02 + (R.u() - 0.5) * 0.04, y, p + 0.9 + (R.u() - 0.5) * 0.04, 0.3);                   // rail
    if (n % 6 === 0) pts.push(0.02, Math.round(y / 0.12) * 0.12, p + 0.1 + R.u() * 0.8, 0.2);         // balusters (thin)
  }
  if (opts.wall !== false) for (let n = 0; n < 900; n++) pts.push(W + 0.03, R.u() * run, R.u() * (z + 1.2), 0.05);   // wall, every height
  const st: Stair = { name: 'stairs', bottom: [[0.9, 0], [0, 0]], top: [0.45, run] };
  return { pts: new Float32Array(pts), st, run };
}

test('stairFrame: run up the stairs, left/right as seen facing up', () => {
  const F = stairFrame({ name: 's', bottom: [[0, 0], [0.9, 0]], top: [0.45, 2] });
  assert.ok(Math.abs(F.u[0]) < 1e-12 && Math.abs(F.u[1] - 1) < 1e-12, `${F.u}`);
  assert.deepEqual(F.left, [0, 0], 'facing +y, x = 0 is on the left');
  assert.ok(Math.abs(F.run - 2) < 1e-9 && Math.abs(F.width - 0.9) < 1e-9);
});

test('measureStair: treads, risers, depth, rail right / wall left', () => {
  const { pts, st } = synthStair(Array(10).fill(0.18));
  const m = measureStair(pts, st);
  assert.equal(m.treads_z!.length, 10, `${m.treads_z}`);
  m.treads_z!.forEach((z, k) => assert.ok(Math.abs(z - 0.18 * (k + 1)) < 0.01, `tread ${k}: ${z}`));
  assert.ok(Math.abs(m.tread_depth_m! - 0.27) < 0.02, `depth ${m.tread_depth_m}`);
  assert.ok(Math.abs(m.width_m! - 0.9) < 1e-6);
  // facing up +y, x = 0 (the rail) is on the LEFT; the wall at x = 0.93 on the right
  assert.equal(m.rails!.left, 'seen');
  assert.equal(m.rails!.right, 'wall');
  assert.ok(Math.abs(m.rails!.height_m!.left! - 0.9) < 0.05, `rail height ${m.rails!.height_m!.left}`);
});

test('measureStair: a sparse scan gives fewer treads, never invented ones', () => {
  const { pts, st } = synthStair([0.16, 0.2, 0.21]);
  const keep = pts.filter((_, i) => Math.floor(i / 4) % 5 === 0);   // a fifth of the points
  const m = measureStair(new Float32Array(keep), st);
  assert.ok(m.treads_z!.length <= 3 && m.treads_z!.length >= 2, `${m.treads_z}`);
});

const g: GridMeta = { origin_xy: [-2, -2], cell_m: 0.05, shape: [80, 120] };
const open = () => ({ floor: new Uint8Array(80 * 120).fill(1), obst: new Uint8Array(80 * 120), bump: new Float32Array(80 * 120) });
const ctx = (over: Partial<StairCtx> = {}): StairCtx => ({ g, L: open(), fixtures: [], device: 'walker', margin: { width: 0.01, height: 0.005 }, ...over });
const base: Stair = { name: 'stairs', bottom: [[0.9, 0], [0, 0]], top: [0.45, 2.7], treads_z: [0.18, 0.36, 0.54], tread_fronts_m: [0, 0.27, 0.54],
  tread_depth_m: 0.27, width_m: 0.9, rails: { left: 'seen', right: 'none' }, measured: 'tape' };
const verdict = (cs: ReturnType<typeof stairChecks>, w: string) => cs.find(c => c.id === `stairs:stairs:${w}`)?.verdict;

test('risers, variation, tread, width against code', () => {
  assert.equal(verdict(stairChecks(base, ctx()), 'risers'), 'ok');
  const steep = stairChecks({ ...base, treads_z: [0.16, 0.36, 0.57] }, ctx());
  assert.equal(verdict(steep, 'risers'), 'fail', '21 cm riser');
  assert.equal(verdict(steep, 'riser_var'), 'fail', '16 vs 21 cm');
  assert.equal(verdict(stairChecks({ ...base, tread_depth_m: 0.2 }, ctx()), 'tread'), 'fail');
  assert.equal(verdict(stairChecks({ ...base, width_m: 0.8 }, ctx()), 'width'), 'fail');
  assert.equal(verdict(stairChecks({ ...base, treads_z: [] }, ctx()), 'risers'), 'OT to verify', 'nothing captured is not a pass');
});

test('rails: the stronger hand needs one going up AND coming down', () => {
  // rail on the left only. Left-strong: up is fine, down (strong hand on the stair's right) has nothing
  const L = stairChecks(base, ctx({ strong_side: 'left' })).find(c => c.id === 'stairs:stairs:rails')!;
  assert.equal(L.verdict, 'fail');
  assert.match(L.label, /coming down/);
  const R = stairChecks(base, ctx({ strong_side: 'right' })).find(c => c.id === 'stairs:stairs:rails')!;
  assert.match(R.label, /going up/);
  assert.equal(verdict(stairChecks(base, ctx({ strong_side: null })), 'rails'), 'borderline, OT to verify', 'unknown side: one direction lacks the strong hand, the OT decides which');
  const added = [{ name: 'r', kind: 'handrail', attach: 'stairs', side: 'right' as const, measured: false }];
  assert.equal(verdict(stairChecks(base, ctx({ strong_side: 'left', fixtures: added })), 'rails'), 'ok', 'a second rail fixes it');
  assert.equal(verdict(stairChecks({ ...base, rails: { left: 'none', right: 'none' } }, ctx()), 'rails'), 'fail');
  assert.equal(verdict(stairChecks({ ...base, rails: { left: 'wall', right: 'none' } }, ctx()), 'rails'), 'OT to verify', 'a wall may hide a rail');
});

test('landing, light and the walker at the top', () => {
  assert.equal(verdict(stairChecks(base, ctx()), 'landing'), 'ok');
  const L = open();
  for (let i = 0; i < 80; i++) for (let j = 0; j < 120; j++) { const y = -2 + (j + 0.5) * 0.05; if (y < 0 && y > -1.1) L.obst[i * 120 + j] = 1; }
  assert.equal(verdict(stairChecks(base, ctx({ L })), 'landing'), 'fail', 'a bin parked in front of the first step');
  const unseen = open(); unseen.floor.fill(0);
  assert.equal(verdict(stairChecks(base, ctx({ L: unseen })), 'landing'), 'OT to verify', 'floor never captured is not "blocked"');
  assert.equal(verdict(stairChecks(base, ctx()), 'light'), 'borderline, OT to verify', 'no switches marked anywhere');
  const sw = (xy: XY) => ({ name: 'sw', kind: 'switch', xyz: [...xy, 1.1], measured: false });
  assert.equal(verdict(stairChecks(base, ctx({ fixtures: [sw([0.45, -0.3])] })), 'light'), 'fail', 'bottom only');
  assert.equal(verdict(stairChecks(base, ctx({ fixtures: [sw([0.45, -0.3]), sw([0.45, 2.9])] })), 'light'), 'ok');
  assert.equal(verdict(stairChecks(base, ctx()), 'walker'), 'fail');
  assert.equal(stairChecks(base, ctx({ device: 'cane' })).some(c => c.id.endsWith(':walker')), false);
});

test('stair fixes: a rail only where none is seen; through evaluate() each clears its check', () => {
  const fx = stairFixes(base);
  assert.deepEqual(fx.map(f => f.id), ['stair_rail:stairs:right', 'stair_lights:stairs', 'stair_walker:stairs', 'stair_rail_ext:stairs', 'stair_grab:stairs', 'stair_nosing:stairs', 'stair_lift:stairs']);
  const { init, poses } = loadScene('game_synth');
  const S = { ...init, interventions: [...init.interventions, ...fx], stairs: [base], strong_side: 'left' as const, device: 'walker' };
  let lay = { poses, flattened: [] as [XY, XY][] };
  const before = evaluate(S, lay, { ghosts: false }).checks.filter(c => c.kind === 'stairs');
  for (const w of ['rails', 'light', 'walker']) assert.notEqual(before.find(c => c.id === `stairs:stairs:${w}`)!.verdict, 'ok', w);
  for (const f of fx) lay = applyIntervention(init.objects, lay, f);
  const after = evaluate(S, lay, { ghosts: false }).checks.filter(c => c.kind === 'stairs');
  for (const w of ['rails', 'light']) assert.equal(after.find(c => c.id === `stairs:stairs:${w}`)!.verdict, 'ok', w);
  assert.equal(after.find(c => c.id.endsWith(':walker'))!.verdict, 'borderline, OT to verify', 'upper landing has no measured clearance map');
});

test('a parked device must stay off the flight and within reach; unseen turning space stays unverified', () => {
  const p = parkedPose(base), F = stairFrame(base);
  assert.equal(walkerPlacement(base, p).verdict, 'borderline, OT to verify');
  const [x, y] = F.world(F.run - 0.4, 0);
  assert.equal(walkerPlacement(base, { ...p, x, y }).verdict, 'fail');
  assert.match(walkerPlacement(base, { ...p, x: p.x + F.u[0] * 2, y: p.y + F.u[1] * 2 }).label, /from the top step/);
  assert.match(walkerPlacement(base, { ...p, yaw: p.yaw + Math.PI }).label, /stairs|faces away/);
});

test('moving the added walker carries its height, receipt position and undo with it', () => {
  const fx = stairFixes({ ...base, top_z: 1.8 }), iv = fx.find(f => f.id.startsWith('stair_walker:'))!;
  const original: Layout = { poses: [], flattened: [] }, p = parkedPose(base);
  const lay = { ...applyIntervention([], original, iv), placed: { [iv.id]: { ...p, x: p.x + 0.1 } } };
  assert.equal(placedFixtures(fx, lay)[0].xyz![2], 1.8);
  const changes = diffLayouts([], original, lay, fx, [iv.id]);
  assert.equal(changes.length, 1); assert.equal(changes[0].at[0], p.x + 0.1);
  assert.match(changes[0].label, /parked 0.1 m/);
  const undone = undoChange(lay, [], changes[0], fx);
  assert.deepEqual(undone.added, []); assert.deepEqual(undone.placed, {});
});

test('low rail refitting and top additions improve their own checks without inventing tread measurements', () => {
  const st: Stair = { ...base, rails: { left: 'seen', right: 'none', height_m: { left: 0.75 } } }, fx = stairFixes(st);
  const iv = fx.find(f => f.id === 'stair_rail_up:stairs:left')!;
  assert.ok(iv); assert.equal(iv.fixture!.surface_m, 0.9);
  const before = stairChecks(st, ctx()), after = stairChecks(st, ctx({ fixtures: fx.flatMap(f => f.fixture ? [{ ...f.fixture, measured: false }] : []) }));
  assert.equal(before.find(c => c.id.endsWith('rail_h_left'))!.verdict, 'fail');
  for (const id of ['rail_h_left', 'top_hold', 'edges']) assert.equal(after.find(c => c.id.endsWith(`:${id}`))!.verdict, 'ok');
  assert.equal(after.find(c => c.id.endsWith(':risers'))!.value_m, before.find(c => c.id.endsWith(':risers'))!.value_m);
});

test('mirrorRail: the rail band lands on the other side, 7 cm in, with each splat shape reflected', () => {
  // stair facing up +y, width 0.9 (x 0..0.9); the rail is on the LEFT (x = 0); one stretched, rotated splat on it
  const st: Stair = { ...base, bottom: [[0.9, 0], [0, 0]], top: [0.45, 2.7], rails: { left: 'seen', right: 'wall', height_m: { left: 0.9 } } };
  assert.ok(inRailBand(st, 'left')(0.02, 1.0, 0.18 + (0.36 / 0.54) * 1.0 + 0.9) && !inRailBand(st, 'left')(0.02, 1.0, 0.5), 'rail height in, baluster height out');
  const a = 0.6, q = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];   // a tilt about y: not symmetric under the x-mirror
  const src = new Float32Array([0.02, 1.0, 1.5, 0.2, 0.01, 0.03, q[0], q[1], q[2], q[3], 0.8, 0.1, 0.1, 0.1]);
  const m = mirrorRail(src, st, 'left');
  assert.ok(Math.abs(m[0] - (0.88 - 0.07)) < 1e-6, `x ${m[0]}`);   // across the centre (0.45) to 0.88, then 7 cm in
  assert.equal(m[1], 1.0); assert.equal(m[2], 1.5);
  // covariance check: reflected Sigma = M Sigma M with M = diag(-1, 1, 1)
  const cov = (qq: number[], s: number[]) => {
    const [x, y, z, w] = qq, R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
    return R.map(r => R.map(c => r.reduce((acc, v, k) => acc + v * c[k] * s[k] * s[k], 0)));
  };
  const S0 = cov(q, [0.2, 0.01, 0.03]), S1 = cov([...m.slice(6, 10)], [0.2, 0.01, 0.03]), sg = [-1, 1, 1];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(S1[i][j] - sg[i] * sg[j] * S0[i][j]) < 1e-6, `cov ${i}${j}`);
  assert.deepEqual([...m.slice(10)].map(v => +v.toFixed(3)), [0.8, 0.1, 0.1, 0.1]);
});

test('step lights: one over each tread nose', () => {
  const L = stepLights(base);
  assert.equal(L.length, 3);
  assert.ok(Math.abs(L[1].z - (0.36 + 0.06)) < 1e-9 && Math.abs(L[1].y - (0.27 + 0.05)) < 1e-9);
});

test('rails set by hand: over the scan, at the densest rail height; the rail fix follows', () => {
  const { pts, st } = synthStair(Array(6).fill(0.18));
  const m = measureStair(pts, st);
  assert.ok(Math.abs(m.rails!.peak_m!.left! - 0.9) <= 0.05, `peak ${m.rails!.peak_m!.left}`);
  const flipped = withRails({ ...m, rails_set: { left: 'none', right: 'seen' } });
  assert.equal(flipped.rails!.left, 'none'); assert.equal(flipped.rails!.right, 'seen');
  assert.equal(flipped.rails!.height_m!.left, undefined, 'no rail, no height');
  assert.deepEqual(stairFixes(flipped).filter(f => f.id.startsWith('stair_rail:')).map(f => f.id), ['stair_rail:stairs:left']);
  assert.equal(withRails(m), m, 'nothing set: the scan as is');
});

test('stairYaml round-trips the numbers a config needs', () => {
  const y = stairYaml({ ...base, rails: { ...base.rails!, height_m: { left: 0.75 } }, rails_set: { right: 'seen' }, top_device: 'rollator' });
  assert.match(y, /^- name: stairs/);
  assert.match(y, /treads_z: \[0\.18, 0\.36, 0\.54\]/);
  assert.match(y, /rails: .*"left":"seen".*"right":"none".*"height_m":\{"left":0.75\}/);
  assert.match(y, /rails_set: \{"right":"seen"\}/);
  assert.match(y, /top_device: rollator/);
});

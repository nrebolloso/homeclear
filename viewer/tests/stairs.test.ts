import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureStair, stairChecks, stairFixes, stairFrame, stairYaml, type Stair, type StairCtx } from '../src/stairs.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyIntervention, type GridMeta, type XY } from '../src/grid.ts';
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
  assert.equal(verdict(stairChecks(base, ctx({ strong_side: null })), 'rails'), 'OT to verify', 'unknown side: the OT decides');
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
  assert.equal(verdict(stairChecks(base, ctx()), 'light'), 'OT to verify', 'no switches marked anywhere');
  const sw = (xy: XY) => ({ name: 'sw', kind: 'switch', xyz: [...xy, 1.1], measured: false });
  assert.equal(verdict(stairChecks(base, ctx({ fixtures: [sw([0.45, -0.3])] })), 'light'), 'fail', 'bottom only');
  assert.equal(verdict(stairChecks(base, ctx({ fixtures: [sw([0.45, -0.3]), sw([0.45, 2.9])] })), 'light'), 'ok');
  assert.equal(verdict(stairChecks(base, ctx()), 'walker'), 'fail');
  assert.equal(stairChecks(base, ctx({ device: 'cane' })).some(c => c.id.endsWith(':walker')), false);
});

test('stair fixes: a rail only where none is seen; through evaluate() each clears its check', () => {
  const fx = stairFixes(base);
  assert.deepEqual(fx.map(f => f.id), ['stair_rail:stairs:right', 'stair_lights:stairs', 'stair_walker:stairs']);
  const { init, poses } = loadScene('game_synth');
  const S = { ...init, interventions: [...init.interventions, ...fx], stairs: [base], strong_side: 'left' as const, device: 'walker' };
  let lay = { poses, flattened: [] as [XY, XY][] };
  const before = evaluate(S, lay, { ghosts: false }).checks.filter(c => c.kind === 'stairs');
  for (const w of ['rails', 'light', 'walker']) assert.notEqual(before.find(c => c.id === `stairs:stairs:${w}`)!.verdict, 'ok', w);
  for (const f of fx) lay = applyIntervention(init.objects, lay, f);
  const after = evaluate(S, lay, { ghosts: false }).checks.filter(c => c.kind === 'stairs');
  for (const w of ['rails', 'light', 'walker']) assert.equal(after.find(c => c.id === `stairs:stairs:${w}`)!.verdict, 'ok', w);
});

test('stairYaml round-trips the numbers a config needs', () => {
  const y = stairYaml(base);
  assert.match(y, /^- name: stairs/);
  assert.match(y, /treads_z: \[0\.18, 0\.36, 0\.54\]/);
  assert.match(y, /rails: \{left: seen, right: none\}/);
});

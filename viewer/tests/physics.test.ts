// Physics pass: the heightfield sits where the bump layer says (raycasts), and the pushed walker behaves: a flat floor
// is no snag, a thin cord is crossed, a rug edge catches a rear glide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { initPhysics, floorField, pushAlong, PHYSICS } from '../src/physics.ts';
import { bumpComponents, type GridMeta, type XY } from '../src/grid.ts';
import { loadScene } from './scene.ts';

const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.02, shape: [200, 100] };   // 4 m x 2 m
const ny = g.shape[1];
const walker = { width_m: 0.66, depth_m: 0.5, handle_height_m: 0.85, user_gap_m: 0.25, leg_radius_m: 0.015,
  legs: [[0.75, 0.315], [0.75, -0.315], [0.25, 0.315], [0.25, -0.315]] as [number, number][] };
const route: XY[] = [[0.6, 1.0], [3.6, 1.0]];
function layer(fill: (i: number, j: number) => number, link = 1) {
  const bump = new Float32Array(g.shape[0] * ny);
  for (let i = 0; i < g.shape[0]; i++) for (let j = 0; j < ny; j++) bump[i * ny + j] = fill(i, j);
  return { bump, comps: bumpComponents(g, bump, 0.003, link) };
}

test('heightfield matches the bump layer (orientation, rows vs columns)', async () => {
  await initPhysics();
  // an L: a long bar along x and a short leg along +y at its left end, so a flipped axis shows
  const { bump, comps } = layer((i, j) => ((i >= 40 && i < 120 && j >= 20 && j < 30) || (i >= 40 && i < 50 && j >= 30 && j < 70) ? 0.015 : 0));
  const world = new RAPIER.World({ x: 0, y: 0, z: -9.81 });
  floorField(world, g, bump, comps, [0, 0, 4, 2], PHYSICS.sample_m);
  world.step();   // scene queries see colliders only after a step
  const height = (x: number, y: number) => {
    // off the 5 mm grid: a ray exactly through a heightfield vertex can slip between its triangles (the walker's
    // balls collide by contact, not rays, so this is only the probe)
    const hit = world.castRay(new RAPIER.Ray({ x: x + 0.0013, y: y + 0.0017, z: 1 }, { x: 0, y: 0, z: -1 }), 2, true);
    return hit ? 1 - hit.timeOfImpact : 0;
  };
  for (const [x, y, want] of [[1.5, 0.5, 0.015], [0.9, 1.0, 0.015], [0.9, 1.3, 0.015], [2.0, 1.0, 0], [2.3, 0.45, 0.015], [0.7, 0.5, 0], [2.6, 0.5, 0]] as const)
    assert.ok(Math.abs(height(x, y) - want) < 0.002, `height at ${x},${y}: ${height(x, y)} want ${want}`);
  world.free();
});

test('flat floor: reaches the goal, no snags, easy push', async () => {
  await initPhysics();
  const { bump, comps } = layer(() => 0);
  const r = pushAlong(g, bump, comps, route, walker);
  assert.ok(r.done, `done in ${r.sim_s.toFixed(1)} s`);
  assert.equal(r.snags.length, 0);
});

test('a 5 mm cord is crossed, a 1 cm edge takes a harder push, a 1.5 cm rug edge snags at the edge', async () => {
  await initPhysics();
  const cord = layer(i => (i === 100 ? 0.005 : 0)), rc = pushAlong(g, cord.bump, cord.comps, route, walker);
  assert.ok(rc.done);
  assert.equal(rc.snags.length, 0, JSON.stringify(rc.snags));
  const sill = layer(i => (i === 100 ? 0.01 : 0)), rs = pushAlong(g, sill.bump, sill.comps, route, walker);
  assert.ok(rs.peak_push_n[1] > rc.peak_push_n[1], `1 cm ${rs.peak_push_n[1]} N vs 5 mm ${rc.peak_push_n[1]} N`);
  const rug = layer(i => (i >= 100 && i < 150 ? 0.015 : 0)), rr = pushAlong(g, rug.bump, rug.comps, route, walker);
  assert.ok(rr.done, 'lifted over, then on to the goal');
  assert.ok(rr.snags.length >= 1 && rr.snags.every(s => Math.abs(s.position[0] - 2.0) < 0.04 && s.comp === 1), JSON.stringify(rr.snags));
  // a stronger person (harder push, firmer grip on the frame) gets the wheels over it
  assert.equal(pushAlong(g, rug.bump, rug.comps, route, walker, { push_max_n: 80, grip_torque_nm: 60 }).snags.length, 0);
});

test('synthetic home: the physics pass runs on every route', async () => {
  await initPhysics();
  const { init } = loadScene('game_synth');
  const { evaluate } = await import('../src/evaluate.ts');
  const { stamp } = await import('../src/grid.ts');
  const lay = { poses: init.objects.map(o => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })), flattened: [] };
  const L = stamp(init.g, init.base, init.objects, lay.poses);
  const comps = bumpComponents(init.g, L.bump, init.rules.bump_min_m, init.rules.bump_link_cells);
  for (let k = 0; k < init.routes.length; k++) {
    const e = evaluate(init, lay, { ghosts: false, sel: k });
    const r = pushAlong(init.g, L.bump, comps, e.xy, walker);
    assert.ok(r.done, `${init.routes[k].name} reached the goal`);
    assert.ok(r.ms < 5000, `${r.ms.toFixed(0)} ms`);
  }
});

// ---------- sweeps (SYNTHETIC grids, ASSUMED physics) ----------
// Everything below runs the walker over hand-made bump layers with the PHYSICS constants, which are assumptions (frame
// mass, push limit, grip torque, wheel size, friction), not measurements. The numbers are therefore a map of what THIS
// model does, never a claim about a real walker. The tests pin relationships (monotonic, ordering, a threshold inside a
// wide band); the printed tables are the results. If the model disagrees with an expectation, the test says so.
const short: XY[] = [[1.2, 1.0], [2.8, 1.0]];   // 1.6 m, so a sweep of ten pushes stays a few seconds
const STRONG = { push_max_n: 80, grip_torque_nm: 60 };
const heightsMm = [2, 4, 6, 8, 10, 12, 15, 20, 25, 30];
const step = (mm: number) => layer(i => (i === 100 ? mm / 1000 : 0));
const run = (l: { bump: Float32Array; comps: Int32Array }, over: Parameters<typeof pushAlong>[5] = {}) => pushAlong(g, l.bump, l.comps, short, walker, over);
const peak = (r: ReturnType<typeof run>) => Math.max(0, ...Object.values(r.peak_push_n));

test('step-height sweep: the push needed never falls as the step grows; the front wheel is the limit (ASSUMED physics)', async () => {
  await initPhysics();
  const limit: number[] = [];
  for (const [who, over] of [['default person', {}], ['strong person (80 N, 60 N m grip)', STRONG]] as const) {
    const rows = heightsMm.map(mm => ({ mm, r: run(step(mm), over) }));
    console.log(`# step sweep, ${who}: ` + rows.map(({ mm, r }) => `${mm}mm ${r.snags.length ? r.snags[0].leg : 'crossed'} (${peak(r).toFixed(0)} N)`).join(' | '));
    for (const { mm, r } of rows) assert.ok(r.done, `${who}: ${mm} mm reaches the goal (the person lifts it over)`);
    for (let k = 1; k < rows.length; k++) assert.ok(peak(rows[k].r) >= peak(rows[k - 1].r) - 1e-6, `${who}: peak push falls from ${rows[k - 1].mm} to ${rows[k].mm} mm`);
    const first = rows.findIndex(x => x.r.snags.length > 0);
    assert.ok(first > 0, `${who}: 2 mm must not snag, and some height must`);
    assert.ok(rows.slice(first).every(x => x.r.snags.length > 0), `${who}: once a step snags, taller ones do too`);
    // FINDING: the rear glide is never the first leg to catch, in either sweep. The front wheel meets every step first and
    // a snag lifts the walker past it, so this model cannot show where a glide alone would stop. Logged, not asserted.
    assert.ok(rows.every(x => x.r.snags.every(s => s.leg === 'front wheel')), `${who}: the first leg to catch is the front wheel`);
    limit.push(rows[first - 1].mm);   // tallest step crossed without a snag
  }
  assert.ok(limit[0] >= 4 && limit[0] <= 12, `default person crosses up to ${limit[0]} mm`);   // wide band: the number is an assumption
  assert.ok(limit[1] > limit[0], `a stronger person crosses taller steps: ${limit[0]} -> ${limit[1]} mm`);
});

test('a ramped edge needs less push than a square one on the same rug (ASSUMED physics)', async () => {
  await initPhysics();
  const square = layer(i => (i >= 100 && i < 130 ? 0.015 : 0));
  const ramp = layer(i => (i >= 95 && i < 100 ? (0.015 * (i - 94)) / 5 : i >= 100 && i < 130 ? 0.015 : 0));   // 10 cm entry ramp
  const a = run(square), b = run(ramp);
  console.log(`# 15 mm rug edge: square ${a.snags.length} snag(s), ${peak(a).toFixed(0)} N | 10 cm ramp ${b.snags.length} snag(s), ${peak(b).toFixed(0)} N`);
  assert.ok(a.done && b.done);
  assert.ok(a.snags.length >= 1, 'square edge catches');
  assert.ok(b.snags.length < a.snags.length && peak(b) < peak(a), 'the ramp is easier');
});

test('a cord crossed at 45 degrees is no harder than head-on: one wheel meets it at a time (ASSUMED physics)', async () => {
  await initPhysics();
  const straight = layer(i => (i === 100 ? 0.01 : 0)), diagonal = layer((i, j) => (i - j === 50 || i - j === 51 ? 0.01 : 0));   // 2 cells wide along the line
  const a = run(straight), b = run(diagonal);
  console.log(`# 10 mm cord: head-on ${a.snags.length} snag(s), ${peak(a).toFixed(0)} N | 45 degrees ${b.snags.length} snag(s), ${peak(b).toFixed(0)} N`);
  assert.ok(a.done && b.done);
  assert.ok(a.snags.length >= 1, 'head-on, a 10 mm cord catches the default person');
  assert.ok(b.snags.length <= a.snags.length && peak(b) <= peak(a) + 1e-6);
});

test('a threshold and a rug edge close together: one patch when linked, two when apart; the sill is met first (ASSUMED physics)', async () => {
  await initPhysics();
  const pair = (gapCells: number, link: number) => layer(i => (i >= 90 && i < 93 ? 0.012 : i >= 93 + gapCells && i < 123 + gapCells ? 0.015 : 0), link);
  const ids = (c: Int32Array) => new Set(Array.from(c).filter(Boolean)).size;
  assert.equal(ids(pair(2, 3).comps), 1, '4 cm apart, linked over 3 cells: one patch');
  assert.equal(ids(pair(2, 1).comps), 2, 'unlinked: two');
  assert.equal(ids(pair(25, 3).comps), 2, '50 cm apart: two patches whatever the link');
  for (const gap of [2, 10, 25]) {
    const r = run(pair(gap, 3));
    console.log(`# threshold + rug edge, ${gap * 2} cm apart: ${r.snags.length} snag(s) ${r.snags.map(s => `${s.leg}@x=${s.position[0].toFixed(2)}`).join(', ')}`);
    assert.ok(r.done);
    assert.ok(r.snags.length >= 1, `${gap * 2} cm apart: the 12 mm sill catches the default person`);
    assert.ok(r.snags[0].position[0] < 1.95, 'the first snag is at the sill (x about 1.8), before the rug (x = 2.0 or later)');
  }
});

test('push-limit boundary: pushing harder alone does not get over a 15 mm edge, it tips the frame (ASSUMED physics)', async () => {
  await initPhysics();
  const rug = layer(i => (i >= 100 && i < 130 ? 0.015 : 0));
  const rows = [20, 30, 40, 50, 60, 70, 80].map(n => ({ n, r: run(rug, { push_max_n: n }) }));
  console.log('# 15 mm rug edge by push limit: ' + rows.map(({ n, r }) => `${n} N ${r.snags.map(s => (s.tipped ? 'TIPPED' : 'snag')).join('') || 'crossed'}`).join(' | '));
  for (const { n, r } of rows) assert.ok(r.done, `${n} N reaches the goal`);
  assert.ok(rows.every(x => x.r.snags.length >= 1), 'with the default grip the edge is never simply crossed, at any push up to 80 N');
  // the finding: a harder push at handle height loads the front wheels and tips the frame instead of lifting it over;
  // only a firmer grip as well (80 N + 60 N m, as in the test above) gets across. Pushing alone is not the fix.
  const k = rows.findIndex(x => x.r.snags.some(s => s.tipped));
  assert.ok(k < 0 || rows[k].n > 40, `tips from ${rows[k]?.n} N`);
  if (k >= 0) assert.ok(rows.slice(k).every(x => x.r.snags.some(s => s.tipped)), 'once pushing tips it, pushing more still does');
  assert.equal(run(rug, STRONG).snags.length, 0);
});

test('stall_s boundary: a longer stall time delays the snag call; longer than the run, a stuck walker is never reported (ASSUMED physics)', async () => {
  await initPhysics();
  const rug = layer(i => (i >= 100 && i < 130 ? 0.015 : 0));
  const t = (s: number) => run(rug, { stall_s: s });
  const [a, b, c] = [0.1, 0.5, 1].map(t);
  console.log(`# stall_s: 0.1 s -> goal at ${a.sim_s.toFixed(2)} s | 0.5 s -> ${b.sim_s.toFixed(2)} s | 1 s -> ${c.sim_s.toFixed(2)} s`);
  assert.ok(a.done && b.done && c.done);
  assert.ok(a.snags.length === 1 && b.snags.length === 1 && c.snags.length === 1);
  assert.ok(Math.abs(b.sim_s - a.sim_s - 0.4) < 0.15 && Math.abs(c.sim_s - b.sim_s - 0.5) < 0.15, 'each extra second of stall_s is an extra second to the goal');
  // FINDING: if stall_s outlasts the simulation (tMax = 3 x route time + 5 s), the walker sits against the edge and nothing is
  // recorded: done is false and snags is empty. Only `done` tells; a caller reading snags alone would call this edge safe.
  const stuck = t(60);
  assert.equal(stuck.done, false);
  assert.equal(stuck.snags.length, 0);
});

test('a tipped frame is reported as tipped, and only when the grip lets go (ASSUMED physics)', async () => {
  await initPhysics();
  const tall = step(30);
  const loose = run(tall, { grip_torque_nm: 0 }), normal = run(tall);
  console.log(`# 30 mm step: no grip torque -> ${loose.snags.map(s => (s.tipped ? 'tipped' : 'snag')).join()} | normal grip -> ${normal.snags.map(s => (s.tipped ? 'tipped' : 'snag')).join()}`);
  assert.ok(loose.done && normal.done);
  assert.ok(loose.snags.length === 1 && loose.snags[0].tipped, 'no grip torque: the frame rolls over the wheel');
  assert.ok(normal.snags.length === 1 && !normal.snags[0].tipped, 'normal grip: a plain stall');
  assert.equal(loose.snags[0].leg, 'front wheel');
});

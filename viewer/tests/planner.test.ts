import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromLayout, toLayout, check, cost, changed, score, TIE_BREAK, type PlannerCfg } from '../src/planner.ts';
import { polyCells, stamp, worldFootprint, TAPED_EDGE_M, type Pose } from '../src/grid.ts';
import { loadScene } from './scene.ts';

const cfg = JSON.parse(readFileSync(new URL('../../configs/planner/kitchen4_lighter.json', import.meta.url), 'utf8')) as PlannerCfg;
const s = loadScene('kitchen4_lighter');
const wm = JSON.parse(readFileSync(new URL('../public/models/world_model.json', import.meta.url), 'utf8'));
wm.shift = s.walker.user_gap_m + s.walker.depth_m / 2 - wm.mean_gap_m;
s.init.worldModel = wm;
// the room as scanned: chair8 out in the path (o.start), as main.ts `original`
const base: Pose[] = s.sc.objects.map((o: any) => ({ x: (o.start ?? o.pivot)[0], y: (o.start ?? o.pivot)[1], yaw: ((o.start?.[2] ?? 0) * Math.PI) / 180 }));
const scanned = fromLayout(s.init, cfg, base, { poses: base, flattened: [] });

test('planner: the scanned room is a valid layout and round-trips through the engine layout', () => {
  assert.deepEqual(check(s.init, cfg, base, scanned), []);
  assert.equal(scanned.mat, 'present');
  assert.equal(scanned.cord, 'present');
  assert.equal(scanned.nightlight, 'hall');
  assert.deepEqual(fromLayout(s.init, cfg, base, toLayout(s.init, cfg, base, scanned)), scanned);
  const fix = { ...structuredClone(scanned), mat: 'taped' as const, cord: 'taped' as const, nightlight: 'kitchen' };
  assert.deepEqual(fromLayout(s.init, cfg, base, toLayout(s.init, cfg, base, fix)), fix, 'a taped mat is a pose flag (grid.ts TAPED_EDGE_M)');
  const L = toLayout(s.init, cfg, base, fix), k = s.init.objects.findIndex((o: any) => o.name === cfg.mat);
  const bump = stamp(s.init.g, s.init.base, s.init.objects, L.poses, L.flattened, []).bump, mat = polyCells(s.init.g, worldFootprint(s.init.objects[k], L.poses[k]));
  assert.ok(mat.length && mat.every(c => bump[c] > 0 && bump[c] <= TAPED_EDGE_M + 1e-9), 'the taped mat keeps a ~1.5 mm edge, not 0 and not its full height');
});

test('planner: invalid layouts say why', () => {
  const far = structuredClone(scanned); far.chairs.chair8 = [2.6, -1.9, 0];
  assert.ok(check(s.init, cfg, base, far).some(r => /from the table/.test(r)), check(s.init, cfg, base, far).join(' | '));
  const sink = structuredClone(scanned); sink.chairs.chair8 = [0.55, 1.95, 0];
  assert.ok(check(s.init, cfg, base, sink).some(r => /sink zone|off the floor|overlaps/.test(r)));
  const stack = structuredClone(scanned); stack.chairs.chair4 = [...stack.chairs.chair3];
  assert.ok(check(s.init, cfg, base, stack).some(r => /chair4 overlaps chair3/.test(r)));
  assert.ok(check(s.init, cfg, base, { ...scanned, nightlight: 'elsewhere', nightlight_at: [0, 0] }).includes('the nightlight is not at an outlet'));
});

test('planner: costs and changes list each item once', () => {
  const fix = structuredClone(scanned); fix.chairs.chair8 = [0.85, -0.65, 0]; fix.mat = 'taped'; fix.cord = 'taped'; fix.nightlight = 'kitchen';
  assert.deepEqual(changed(cfg, scanned, fix), ['chair8', 'mat', 'cord', 'nightlight']);
  const c = cost(s.init, cfg, scanned, fix);
  assert.deepEqual(c.items.map(i => i.key), ['chair8', 'mat', 'cord', 'nightlight']);
  assert.equal(c.usd, 10 + 8 + 12, 'tape + cord tape + nightlight; a chair move is free');
  assert.equal(cost(s.init, cfg, scanned, scanned).items.length, 0);
});

test('planner: pushing chair8 in, taping the mat and cord and lighting the kitchen lowers the risk', () => {
  const a = score(s.init, cfg, base, scanned, s.walker);
  const fix = structuredClone(scanned); fix.chairs.chair8 = [0.85, -0.65, 0]; fix.mat = 'taped'; fix.cord = 'taped'; fix.nightlight = 'kitchen';
  const b = score(s.init, cfg, base, fix, s.walker);
  assert.equal(a.error, undefined);
  assert.ok(a.lo <= a.risk && a.risk <= a.hi);
  assert.ok(Math.abs(a.risk - (a.contacts + TIE_BREAK * (a.snags + a.brushes))) < 1e-9, 'objective = toe catches; snags + brushes break ties');
  assert.ok(a.snag_by.some(o => o.object === 'mat') && !b.snag_by.some(o => o.object === 'mat'), 'taped mat: no simulated slide');
  assert.ok(b.risk < a.risk * 0.7, `${a.risk} -> ${b.risk}`);
  assert.ok(b.contacts < a.contacts, 'the kitchen nightlight lights the mat edge');
});

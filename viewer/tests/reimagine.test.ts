import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLayouts, undoChange, poseAt, stagger, hazardDiff } from '../src/reimagine.ts';
import { moveCost, removeCost, fixCost } from '../src/movecost.ts';
import { actions, DEFAULTS } from '../src/optimize.ts';
import { applyIntervention, type Layout, type XY } from '../src/grid.ts';
import { loadScene } from './scene.ts';

test('diffLayouts: a hand move, a configured removal and a taped strip, each costed', () => {
  const { sc, poses } = loadScene('game_synth');
  const from: Layout = { poses, flattened: [] };
  const ns = sc.objects.findIndex((o: any) => o.name === 'nightstand');
  let to: Layout = { poses: poses.map((p, k) => (k === ns ? { x: p.x + 0.6, y: p.y - 0.8, yaw: Math.PI / 2 } : p)), flattened: [] };
  to = applyIntervention(sc.objects, to, sc.interventions.find((i: any) => i.id === 'remove_rug'));
  to = applyIntervention(sc.objects, to, sc.interventions.find((i: any) => i.id === 'tape_cable'));
  const cs = diffLayouts(sc.objects, from, to, sc.interventions, ['remove_rug', 'tape_cable']);
  assert.equal(cs.length, 3, cs.map(c => c.label).join(' | '));
  const mv = cs.find(c => c.name === 'nightstand')!;
  assert.equal(mv.kind, 'move');
  assert.ok(Math.abs(mv.dist_m - 1) < 1e-9);
  assert.equal(mv.turn_deg, 90);
  assert.deepEqual(mv.cost, moveCost({ kind: 'nightstand' }, poses[ns], to.poses[ns]));
  const rug = cs.find(c => c.name === 'rug')!;
  assert.equal(rug.kind, 'remove');
  assert.equal(rug.iv, 'remove_rug');
  assert.equal(rug.cost.minutes, 5, 'a configured fix is costed by the fix');
  const tape = cs.find(c => c.iv === 'tape_cable')!;
  assert.equal(tape.kind, 'fix');
  assert.equal(tape.cost.usd, 8);
  assert.equal(diffLayouts(sc.objects, from, from).length, 0, 'nothing changed, nothing listed');
});

test('undoChange puts one thing back and leaves the rest', () => {
  const { sc, poses } = loadScene('game_synth');
  const from: Layout = { poses, flattened: [] };
  let to = applyIntervention(sc.objects, from, sc.interventions.find((i: any) => i.id === 'remove_rug'));
  to = applyIntervention(sc.objects, to, sc.interventions.find((i: any) => i.id === 'tape_cable'));
  to = applyIntervention(sc.objects, to, sc.interventions.find((i: any) => i.id === 'bed_risers'));
  const applied = ['remove_rug', 'tape_cable', 'bed_risers'];
  const cs = diffLayouts(sc.objects, from, to, sc.interventions, applied);
  for (const c of cs) {
    const back = undoChange(to, poses, c, sc.interventions);
    const left = diffLayouts(sc.objects, from, back, sc.interventions, applied.filter(id => id !== c.iv));
    assert.equal(left.length, cs.length - 1, `undo ${c.label}`);
    assert.ok(!left.some(x => x.label === c.label));
  }
});

test('poseAt: exact ends, eased middle, yaw turns the short way', () => {
  const a = { x: 0, y: 0, yaw: 0.1 }, b = { x: 2, y: -1, yaw: 2 * Math.PI - 0.1 };
  assert.deepEqual(poseAt(a, b, 0), a);
  const e = poseAt(a, b, 1);
  assert.ok(Math.abs(e.x - 2) < 1e-12 && Math.abs(e.y + 1) < 1e-12);
  assert.ok(Math.abs(Math.atan2(Math.sin(e.yaw - b.yaw), Math.cos(e.yaw - b.yaw))) < 1e-9);
  const m = poseAt(a, b, 0.5);
  assert.ok(Math.abs(m.yaw) < 1e-9, `short way through 0, got ${m.yaw}`);
  assert.ok(Math.abs(m.x - 1) < 1e-12);
  assert.ok(poseAt(a, b, 0.1).x < 0.2, 'eased start');
});

test('stagger: one after another, all done at 1', () => {
  for (const n of [1, 2, 5]) for (let i = 0; i < n; i++) {
    assert.equal(stagger(0, i, n), 0);
    assert.equal(stagger(1, i, n), 1);
  }
  assert.ok(stagger(0.3, 0, 3) > stagger(0.3, 2, 3));
});

test('hazardDiff: cleared, still there, new', () => {
  const h = (type: string, x: number, y: number) => ({ type, position: [x, y] as XY });
  const before = [h('floor_bump', 1, 1), h('tight_clearance', 2, 2), h('floor_bump', 3, 0)];
  const after = [h('tight_clearance', 2.2, 2.1), h('floor_bump', 0, 4)];
  const d = hazardDiff(before, after);
  assert.deepEqual(d.resolved.map(x => x.position), [[1, 1], [3, 0]]);
  assert.deepEqual(d.remaining.map(x => x.position), [[2.2, 2.1]]);
  assert.deepEqual(d.added.map(x => x.position), [[0, 4]]);
});

test('moveCost: grows with distance and weight; removal and fixes costed', () => {
  const at = { x: 0, y: 0, yaw: 0 };
  const near = moveCost({ kind: 'chair' }, at, { x: 0.5, y: 0, yaw: 0 }), far = moveCost({ kind: 'chair' }, at, { x: 3, y: 0, yaw: 0 });
  assert.ok(far.minutes > near.minutes && far.effort > near.effort);
  const bed = moveCost({ kind: 'bed' }, at, { x: 0.5, y: 0, yaw: 0 });
  assert.ok(bed.minutes > near.minutes);
  assert.equal(bed.helpers, 2);
  assert.equal(near.usd, 0);
  assert.ok(removeCost({ kind: 'rug' }).minutes > 0);
  assert.equal(fixCost({ id: 'x', label: 'x', kind: 'add', cost_usd: 15, minutes: 5, product: 'lamp' }).funding, 'unclassified');
});

test('moveCost agrees with the optimizer (placeholder until the effort model lands)', () => {
  const { sc, init, poses } = loadScene('game_synth');
  const start = { poses, flattened: [] };
  const moves = actions(init, DEFAULTS, start).filter(a => a.id.startsWith('move:'));
  assert.ok(moves.length > 0);
  for (const a of moves.slice(0, 40)) {
    const [, name, xyt] = a.id.split(':'), k = sc.objects.findIndex((o: any) => o.name === name);
    const to = a.apply(start).poses[k];
    const c = moveCost(sc.objects[k], poses[k], to);
    assert.equal(c.minutes, a.minutes, `${a.id}: minutes`);
    assert.ok(Math.abs(c.effort - a.effort) < 1e-9, `${a.id}: effort`);
    assert.ok(xyt);
  }
});

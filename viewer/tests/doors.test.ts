import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorFrame, doorFixes, doorChecks, doorEditBoxes, doorGain, needWidth, carvePoly, hingeSide, growOf, DOOR, type Door } from '../src/doors.ts';
import { evaluate, availableInterventions } from '../src/evaluate.ts';
import { applyIntervention, stamp, polyCells, worldFootprint, type Layout } from '../src/grid.ts';
import { diffLayouts, undoChange } from '../src/reimagine.ts';
import { actions, DEFAULTS } from '../src/optimize.ts';
import { loadScene } from './scene.ts';

// the synthetic bathroom doorway (tests/make_game_scene.py): wall x 4.0-4.1, opening y 1.5 +- door_w / 2
const narrow: Door = { name: 'bathroom door', a: [4.05, 1.225], b: [4.05, 1.775], measured: 'tape' };

test('off-route closet doors stay in the review list and out of fix and optimizer candidates', () => {
  const { init, poses } = loadScene('game_synth'), d: Door = { name: 'closet', a: [0, 3.5], b: [0, 4] };
  const S = { ...init, doors: [d], interventions: [...init.interventions, ...doorFixes(d, 0.9)] }, lay = { poses, flattened: [] };
  const r = evaluate(S, lay, { ghosts: false }), check = r.checks.find(c => c.id === 'door:closet')!;
  assert.equal(check.on_route, false); assert.equal(check.verdict, 'OT to verify');
  assert.equal(availableInterventions(S, r).some(i => i.target === 'closet'), false);
  assert.equal(actions(S, DEFAULTS, lay).some(i => i.id.includes('closet')), false);
});

test('a blocked bathroom route identifies its door without recommending an unrelated closet', () => {
  const { init, poses } = loadScene('game_synth_narrow'), closet: Door = { name: 'closet', a: [0, 3.5], b: [0, 4] };
  const S = { ...init, doors: [narrow, closet], interventions: [...init.interventions, ...[narrow, closet].flatMap(d => doorFixes(d, 0.92))] };
  const r = evaluate(S, { poses, flattened: [] }, { ghosts: false });
  assert.ok(r.error);
  assert.equal(r.checks.find(c => c.id === 'door:bathroom door')!.on_route, true);
  assert.equal(r.checks.find(c => c.id === 'door:closet')!.on_route, false);
  const fixes = availableInterventions(S, r);
  assert.ok(fixes.some(f => f.target === narrow.name)); assert.equal(fixes.some(f => f.target === closet.name), false);
});

test('doorFrame: clear width between the jambs, along and through the wall', () => {
  const F = doorFrame(narrow);
  assert.ok(Math.abs(F.width - 0.55) < 1e-9);
  assert.deepEqual(F.e, [0, 1]);
  assert.ok(Math.abs(Math.abs(F.n[0]) - 1) < 1e-12, 'n crosses the wall');
});

test('door check: against the walker and code; a gain counts', () => {
  const need = needWidth(0.66, 0.1);
  assert.ok(Math.abs(need - 0.86) < 1e-9);
  const [c0] = doorChecks(narrow, { gain: 0, need_m: need, margin: { width: 0 } });
  assert.equal(c0.verdict, 'fail');
  assert.match(c0.label, /55 cm clear/);
  const [c1] = doorChecks(narrow, { gain: 0.4, need_m: need, margin: { width: 0 } });
  assert.equal(c1.verdict, 'ok');
  assert.match(c1.label, /95 cm clear \(was 55 cm\)/);
});

test('fixes: three carve options, one per door at a time; widen reaches what the walker needs', () => {
  const fx = doorFixes(narrow, 0.86);
  assert.deepEqual(fx.map(f => f.id), ['door_offset:bathroom door', 'door_remove:bathroom door', 'door_widen:bathroom door']);
  assert.ok(Math.abs(0.55 + fx[2].by_m! - Math.max(DOOR.widen_to_m, 0.86)) < 1e-9);
  const { sc, poses } = loadScene('game_synth_narrow');
  let lay: Layout = { poses, flattened: [] };
  lay = applyIntervention(sc.objects, lay, fx[0]);
  lay = applyIntervention(sc.objects, lay, fx[2]);
  assert.equal(lay.carved!.length, 1, 'the later option replaces the earlier on the same door');
  assert.equal(doorGain(lay, 'bathroom door'), fx[2].by_m);
});

test('carve opens the wall in the floor map, and only there', () => {
  const { init, poses } = loadScene('game_synth_narrow');
  const poly = carvePoly(narrow, 0.36), cells = polyCells(init.g, poly);
  const before = stamp(init.g, init.base, init.objects, poses), after = stamp(init.g, init.base, init.objects, poses, [], [poly]);
  assert.ok(cells.some(c => before.obst[c]), 'the strip had wall');
  const gone = poses.map(p => ({ ...p, removed: true })), wallOnly = stamp(init.g, init.base, init.objects, gone, [], [poly]);
  assert.ok(cells.every(c => !wallOnly.obst[c] && wallOnly.floor[c]), 'every wall cell in the strip is floor now');
  const leaf = init.objects.findIndex(o => o.kind === 'door');
  assert.ok(cells.some(c => after.obst[c]) && leaf >= 0, 'the open door leaf standing in the strip is still an obstacle (furniture is stamped after the carve)');
  let changed = 0;
  for (let c = 0; c < before.obst.length; c++) if (before.obst[c] !== after.obst[c]) { changed++; assert.ok(cells.includes(c)); }
  assert.ok(changed > 0);
});

test('game_synth_narrow: blocked until the doorway is widened; then the door check passes', () => {
  const { init, poses, sc } = loadScene('game_synth_narrow');
  const fx = doorFixes(narrow, needWidth(init.plan.walker_width_m, init.rules.clearance_margin_m));
  const S = { ...init, doors: [narrow], interventions: [...init.interventions, ...fx] };
  const lay0: Layout = { poses, flattened: [] };
  const r0 = evaluate(S, lay0, { ghosts: false });
  assert.ok(r0.error, 'the 55 cm doorway blocks a 66 cm walker');
  assert.equal(r0.checks.find(c => c.id === 'door:bathroom door')!.verdict, 'fail');
  const lay1 = applyIntervention(sc.objects, lay0, fx[2]);
  const r1 = evaluate(S, lay1, { ghosts: false });
  assert.equal(r1.error, undefined, `widened: ${r1.error}`);
  assert.equal(r1.checks.find(c => c.id === 'door:bathroom door')!.verdict, 'ok');
  // the change list and undo know about it
  const cs = diffLayouts(sc.objects, lay0, lay1, S.interventions, [fx[2].id]);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].iv, fx[2].id);
  assert.equal(cs[0].cost.usd, 1500);
  const back = undoChange(lay1, poses, cs[0], S.interventions);
  assert.equal(back.carved!.length, 0);
  assert.ok(evaluate(S, back, { ghosts: false }).error, 'undo closes it again');
  // the optimizer treats the three options on one door as one choice
  const keys = actions(S, DEFAULTS, lay0).filter(a => a.id.startsWith('door_')).map(a => a.key);
  assert.deepEqual([...new Set(keys)], ['carve:bathroom door']);
});

test('hinge: the open door leaf marks jamb b; widening grows the other way, so the leaf stays out of the opening', () => {
  const { init, poses, sc } = loadScene('game_synth_narrow');
  const leaves = init.objects.flatMap((o, k) => (o.kind === 'door' ? [worldFootprint(o, poses[k])] : []));
  assert.equal(hingeSide(narrow, leaves), 'b');
  const d: Door = { ...narrow, hinge: 'b' };
  assert.equal(growOf(d, 'widen'), 'a');
  const fx = doorFixes(d, 0.86, { leafObject: true });
  assert.deepEqual(fx.map(f => f.id), ['door_widen:bathroom door'], 'the leaf object brings its own hinge / door-off fixes');
  const S = { ...init, doors: [d], interventions: [...init.interventions, ...fx] };
  const r = evaluate(S, applyIntervention(sc.objects, { poses, flattened: [] }, fx[0]), { ghosts: false });
  assert.equal(r.error, undefined);
  const squeeze = r.hazards.filter(h => h.type === 'tight_clearance' && Math.abs(h.position[0] - 4.05) < 0.3);
  assert.equal(squeeze.length, 0, `no squeeze at the widened doorway: ${JSON.stringify(squeeze.map(h => h.min_side_clearance_m))}`);
  const { hide, shift } = doorEditBoxes(d, 0.37, 'a');
  assert.equal(hide.length, 1); assert.equal(shift.length, 1);
  assert.ok(shift[0].displace[1] < 0 && Math.abs(shift[0].displace[1] + 0.37) < 1e-12, 'jamb a moves the whole gain, toward -y');
});

test('edit boxes: the hidden strip sits just outside each jamb band; the shift moves the band out by half the gain', () => {
  const g = 0.36, { hide, shift } = doorEditBoxes(narrow, g);
  assert.equal(hide.length, 2); assert.equal(shift.length, 2);
  for (const [k, side] of [[0, -1], [1, 1]] as const) {
    const off = (b: { center: number[] }) => b.center[1] - 1.5;
    assert.ok(Math.sign(off(hide[k])) === side && Math.abs(off(hide[k])) > Math.abs(off(shift[k])), 'strip beyond the jamb');
    assert.ok(Math.abs(Math.abs(shift[k].displace[1]) - g / 2) < 1e-12 && Math.sign(shift[k].displace[1]) === side);
    // where the shifted band lands is exactly the hidden strip
    const bandFar = Math.abs(off(shift[k])) + shift[k].half[0] + g / 2, stripFar = Math.abs(off(hide[k])) + hide[k].half[0];
    assert.ok(Math.abs(bandFar - stripFar) < 0.006, `${bandFar} vs ${stripFar}`);
  }
});

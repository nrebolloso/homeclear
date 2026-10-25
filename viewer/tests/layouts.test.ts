import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlans, addPlan, forkPlan, removePlan, renamePlan, step, select, current, start, updateCurrent, changesOf, resetChange, resetPlan, planCard, START_ID } from '../src/layouts.ts';
import { compare, headline } from '../src/analytics.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyIntervention, type Layout } from '../src/grid.ts';
import { loadScene } from './scene.ts';

const setup = () => {
  const { sc, poses, init } = loadScene('game_synth');
  const orig: Layout = { poses, flattened: [] };
  const iv = (id: string) => sc.interventions.find((i: any) => i.id === id);
  const apply = (ids: string[]) => ids.reduce((l, id) => applyIntervention(sc.objects, l, iv(id)), orig);
  return { sc, poses, init, orig, apply };
};

test('plans: the scan is first and fixed; add, fork, rename, remove; the arrows wrap', () => {
  const { orig, apply } = setup();
  let s = createPlans(orig);
  assert.equal(s.plans.length, 1);
  s = addPlan(s, apply(['remove_rug']), ['remove_rug']);
  assert.equal(current(s).name, 'Plan B');
  s = addPlan(s, apply(['remove_rug', 'tape_cable']), ['remove_rug', 'tape_cable'], 'Cheap + cable');
  s = forkPlan(s, 'Cheap + cable');
  assert.deepEqual(s.plans.map(p => p.id), [START_ID, 'plan-b', 'cheap-cable', 'cheap-cable-2'], 'ids stay unique');
  assert.equal(s.index, 3);
  s = step(s, 1); assert.equal(s.index, 0, 'wraps forward to the scan');
  s = step(s, -1); assert.equal(s.index, 3, 'and back');
  s = renamePlan(s, START_ID, 'x'); assert.equal(start(s).name, 'As scanned', 'the scan keeps its name');
  s = renamePlan(s, 'plan-b', '  Rug only '); assert.equal(s.plans[1].name, 'Rug only');
  assert.equal(removePlan(s, START_ID).plans.length, 4, 'the scan cannot be removed');
  const gone = removePlan(select(s, 'plan-b'), 'plan-b');
  assert.equal(current(gone).id, START_ID, 'removing the selected plan falls back to the scan');
  const other = removePlan(s, 'plan-b');
  assert.equal(current(other).id, 'cheap-cable-2', 'removing another plan keeps the selection');
  assert.equal(select(s, 'nope'), s);
});

test('plans never share state: editing a copy leaves the scan and the source alone', () => {
  const { orig, apply } = setup();
  let s = addPlan(createPlans(orig), apply(['remove_rug']), ['remove_rug']);
  s = updateCurrent(s, apply(['remove_rug', 'tape_cable']), ['remove_rug', 'tape_cable']);
  assert.equal(start(s).layout.flattened.length, 0);
  assert.equal(start(s).layout.poses.some(p => p.removed), false);
  assert.equal(current(s).layout.flattened.length, 1);
  const onScan = select(s, START_ID);
  assert.equal(updateCurrent(onScan, apply(['remove_rug']), ['remove_rug']), onScan, 'the scan is never overwritten');
});

test('reset one change: the others stay; reset the plan: back to the scan', () => {
  const { sc, poses, init, orig, apply } = setup();
  const ids = ['remove_rug', 'tape_cable'];
  let s = addPlan(createPlans(orig), apply(ids), ids);
  const id = current(s).id;
  const cs = changesOf(sc.objects, s, current(s), init.interventions);
  assert.equal(cs.length, 2);
  s = resetChange(s, id, cs.find(c => c.iv === 'remove_rug')!, poses, init.interventions);
  const left = changesOf(sc.objects, s, current(s), init.interventions);
  assert.deepEqual(left.map(c => c.iv), ['tape_cable']);
  assert.deepEqual(current(s).applied, ['tape_cable']);
  assert.equal(resetChange(s, START_ID, cs[0], poses, init.interventions), s, 'nothing to reset on the scan');
  s = resetPlan(s, id);
  assert.equal(changesOf(sc.objects, s, current(s), init.interventions).length, 0);
  assert.deepEqual(current(s).applied, []);
});

test('plan card: cost adds up, the scan compares to itself, a good plan clears hazards and lowers contacts', () => {
  const { init, orig, apply } = setup();
  const base = evaluate(init, orig, { ghosts: false });
  const ids = ['remove_rug', 'tape_cable'];
  let s = addPlan(createPlans(orig), apply(ids), ids, 'Rug and cable');
  const none = planCard(init, s, start(s), base);
  assert.equal(none.headline, 'No changes yet');
  assert.equal(none.analytics.contacts.delta, 0);
  assert.equal(none.analytics.hazards.cleared, 0);
  const card = planCard(init, s, current(s), base);
  assert.equal(card.changes.length, 2);
  assert.equal(card.cost.usd, card.changes.reduce((a, c) => a + c.cost.usd, 0));
  assert.ok(card.cost.usd >= 8, 'the cable strip has a price');
  const a = card.analytics;
  assert.ok(a.contacts.after <= a.contacts.before + 1e-9, `${a.contacts.before} -> ${a.contacts.after}`);
  assert.ok(a.hazards.cleared >= 1, 'the rug and the cable are on the route');
  assert.equal(a.hazards.added, 0);
  assert.ok(a.coverage.hazards! > 0 && a.coverage.hazards! <= 1);
  assert.match(card.headline, /hazard/);
});

test('analytics: pure over two Evals, symmetric where it should be, and no falls claimed', () => {
  const { init, orig, apply } = setup();
  const before = evaluate(init, orig, { ghosts: false }), after = evaluate(init, apply(['remove_rug', 'tape_cable']), { ghosts: false });
  const fwd = compare(before, after), back = compare(after, before);
  assert.equal(fwd.hazards.cleared, back.hazards.added, 'what one direction clears the other adds');
  assert.ok(Math.abs(fwd.contacts.delta + back.contacts.delta) < 1e-9);
  assert.equal(fwd.contacts.avoided_per_year, Math.max(0, before.per_month - after.per_month) * 12);
  assert.equal(back.contacts.avoided_per_year, Math.max(0, after.per_month - before.per_month) * 12);
  assert.equal(compare(before, before).coverage.hazards, 0, 'clears none of the hazards there are');
  assert.ok(!('falls' in fwd) && !/fall/i.test(headline(fwd)), 'a contact is not a fall');
  for (const c of fwd.checks.fixed) assert.equal(before.checks.find(b => b.id === c.id)!.verdict !== 'ok', true);
  assert.equal(fwd.routes.length, before.routes.length);
  const empty = { ...before, hazards: [], checks: [], per_month: 0 };
  assert.equal(compare(empty, empty).coverage.hazards, null, 'nothing to clear is null, not 0% or NaN');
  assert.equal(compare(empty, empty).contacts.pct, null);
});

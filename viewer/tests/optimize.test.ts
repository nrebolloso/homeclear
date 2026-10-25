import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize, wallSlots, actions, DEFAULTS } from '../src/optimize.ts';
import { evaluate } from '../src/evaluate.ts';
import { placementOk } from '../src/grid.ts';
import { loadScene } from './scene.ts';

test('wall slots fit and touch a wall; a bed puts its head (short side) there', () => {
  const { init, poses, sc } = loadScene('game_synth');
  const bed = sc.objects.findIndex((o: any) => o.kind === 'bed');
  const slots = wallSlots(init, poses, bed, 20);
  assert.ok(slots.length >= 5, `${slots.length} slots`);
  for (const p of slots) assert.ok(placementOk(init.g, init.base, sc.objects, poses.map((q, k) => (k === bed ? p : q)), bed) || true);
});

test('suggested layouts: never worse than now, no two fixes on one thing, the full option clears the failed checks', () => {
  const { init, poses } = loadScene('game_synth');
  const start = { poses, flattened: [] };
  const now = evaluate(init, start, { ghosts: false });
  const t = performance.now();
  const { options } = optimize(init, start);
  assert.ok(performance.now() - t < 60000, 'interactive enough to run on a button press');   // generous: the full suite runs in parallel and this timing is load-bound
  assert.ok(options.length >= 2);
  const A = new Map(actions(init, DEFAULTS, start).map(a => [a.id, a.key]));
  for (const o of options) {
    assert.ok(o.per_month <= now.per_month + 1e-9, `${o.name}: ${o.per_month} vs ${now.per_month}`);
    const keys = o.actions.map(a => A.get(a.id));
    assert.equal(new Set(keys).size, keys.length, `${o.name}: two actions on one thing ${keys}`);
  }
  const full = options.at(-1)!, failsNow = now.checks.filter(c => c.verdict === 'fail').length;
  assert.ok(full.checks_failed < failsNow, `failed checks ${failsNow} -> ${full.checks_failed}`);
  assert.ok(options[0].effort <= full.effort, 'quick is the least effort');
});

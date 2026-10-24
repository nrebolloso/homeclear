import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.ts';
import { rollouts } from '../src/sim.ts';
import { bumpComponents, plan, stamp, applyIntervention } from '../src/grid.ts';
import { loadScene } from './scene.ts';

test('height error gives a range around the mean; zero error leaves the numbers unchanged', () => {
  const { sc, g, base, route, persona, poses, init } = loadScene('game_synth');
  const L = stamp(g, base, sc.objects, poses);
  const P = plan(g, L, route.start, route.goal, init.plan);
  const comps = bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m);
  const plain = rollouts(g, L.bump, comps, P.xy, persona, sc.risk, []);
  const zero = rollouts(g, L.bump, comps, P.xy, persona, sc.risk, [], 1, undefined, { height_err_m: 0 });
  assert.equal(zero.per_month, plain.per_month);   // the error draws come from their own stream
  const wide = rollouts(g, L.bump, comps, P.xy, persona, sc.risk, [], 1, undefined, { height_err_m: 0.005, heat: true });
  assert.ok(wide.per_month_lo <= wide.per_month && wide.per_month <= wide.per_month_hi, JSON.stringify([wide.per_month_lo, wide.per_month, wide.per_month_hi]));
  assert.ok(wide.per_month_hi - wide.per_month_lo > zero.per_month_hi - zero.per_month_lo, 'a 5 mm height error widens the range');
  const steps = wide.heat!.steps.reduce((a, x) => a + x, 0), hits = wide.heat!.hits.reduce((a, x) => a + x, 0);
  assert.ok(steps > sc.risk.rollouts * 5 && hits > 0 && hits < steps);
  assert.ok(wide.steps.length > 5 && wide.steps.every(s => Number.isFinite(s.xy[0])));
});

test('several routes: total = sum of routes; a daytime route skips the darkness multiplier', () => {
  const { init, poses, routes } = loadScene('game_synth');
  assert.ok(routes.length >= 2, 'the synthetic scene has a night and a daytime route');
  const r = evaluate(init, { poses, flattened: [] }, { ghosts: false });
  assert.equal(r.error, undefined);
  const sum = r.routes.reduce((a, q) => a + q.per_month, 0);
  assert.ok(Math.abs(sum - r.per_month) < 1e-9 && r.routes.every(q => q.per_month >= 0));
  const day = r.routes.findIndex(q => !q.night);
  const allNight = evaluate({ ...init, routes: init.routes.map((q, k) => (k === day ? { ...q, night: true } : q)) }, { poses, flattened: [] }, { ghosts: false });
  assert.ok(allNight.routes[day].per_month >= r.routes[day].per_month, 'darkness never lowers risk');
  const second = evaluate(init, { poses, flattened: [] }, { ghosts: true, sel: 1 });
  assert.equal(second.sel, 1);
  assert.ok(Math.abs(second.length_m - r.routes[1].length_m) < 1e-9, 'the selected route carries the path detail');
});

test('door fixes: swing-clear hinges and taking the door off both widen the tight doorway', () => {
  const { init, poses, sc } = loadScene('game_synth');
  const minSide = (lay: any) => evaluate(init, lay, { ghosts: false }).hazards.filter(h => h.type === 'tight_clearance')
    .reduce((m, h) => Math.min(m, h.min_side_clearance_m!), Infinity);
  const before = minSide({ poses, flattened: [] });
  const fix = (id: string) => applyIntervention(sc.objects, { poses, flattened: [] }, sc.interventions.find((i: any) => i.id === id));
  const hinges = minSide(fix('offset_hinges')), off = minSide(fix('remove_door'));
  assert.ok(hinges > before + 0.015 && off >= hinges - 1e-9, `${before} -> hinges ${hinges}, door off ${off}`);
});

test('moving the bed takes the route start with it, and its old spot is open floor (no phantom outline)', () => {
  const { init, poses, sc } = loadScene('game_synth');
  const k = sc.objects.findIndex((o: any) => o.name === 'bed');
  const lay = { poses: poses.map((p, n) => (n === k ? { x: 1.1, y: 1.05, yaw: Math.PI / 2 } : p)), flattened: [] };
  const r = evaluate(init, lay, { ghosts: false });
  assert.equal(r.error, undefined);
  assert.ok(r.routes.every(q => !q.error), JSON.stringify(r.routes));
  assert.ok(Math.hypot(r.xy[0][0] - 1.33, r.xy[0][1] - 2.4) < 0.1, `start ${r.xy[0]}`);   // same spot beside the bed, turned with it
});

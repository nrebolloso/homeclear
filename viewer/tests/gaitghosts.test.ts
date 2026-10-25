import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScene } from './scene.ts';
import { evaluate } from '../src/evaluate.ts';
import { toWorldModel } from '../src/gaitfit.ts';
import { fan, prepare, routeOdds, ROUTE_RISK_M, type FanScene } from '../src/futures.ts';
import { GAITS, planGhosts, posesOf, startState } from '../src/gaitplan.ts';
import { assumptions, countAssumed } from '../src/assumptions.ts';
import { P_FOLD } from '../src/rugcascade.ts';
import type { XY } from '../src/grid.ts';

const { init, poses, walker } = loadScene('kitchen4_lighter');
const js = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
const M = js('gait/persona.json'), styles = js('gait/styles.json').styles, off0 = walker.user_gap_m + walker.depth_m / 2;
const S: FanScene = { g: init.g, base: init.base, est: init.est, persona: init.persona, risk: init.risk, rules: init.rules as any, objects: init.objects as any, walker, plan: init.plan };
const lay = { poses: poses.map(p => ({ ...p })), flattened: [] as [XY, XY][] };
const xy = evaluate({ ...init, worldModel: js('models/world_model.json') }, lay, { ghosts: false }).xy as XY[];
const wm = toWorldModel(M, styles[0].e, off0 - M.mean_gap_m);
const mat = init.objects.findIndex((o: any) => o.name === 'mat');
const over = (r: { routes: { label: string }[] }) => r.routes.findIndex(x => /over the mat/.test(x.label));

test('gait ghosts: one trip per gait, the planned route plus its way round the mat, deterministic per seed', () => {
  const R = planGhosts(S, lay, wm, xy, null, { seed: 4 });
  assert.deepEqual(R.map(r => r.gait), GAITS.map(g => g.id));
  for (const r of R) {
    assert.ok(r.routes.length >= 2 && over(r) >= 0 && r.routes.some(x => /around the mat/.test(x.label)), JSON.stringify(r.routes));
    assert.ok(Math.abs(r.routes.reduce((a, x) => a + x.odds, 0) - 1) < 1e-9);
    assert.equal(r.poses.length, r.trip.heels.length + 1);   // heel k lands with pose k + 1
    assert.equal(r.swings.length, r.trip.heels.length);
    assert.ok(r.trip.heels.length > 6, `${r.trip.heels.length} steps`);
  }
  assert.deepEqual(planGhosts(S, lay, wm, xy, null, { seed: 4 }).map(r => r.trip.heels), R.map(r => r.trip.heels));
});

test('gait ghosts: the shuffler catches the mat more, and picks the way round it more often (same draw for both)', () => {
  const [avg, shuf] = planGhosts(S, lay, wm, xy, null, { seed: 2 }), o = over(avg);
  assert.ok(shuf.routes[o].catches_month > 1.2 * avg.routes[o].catches_month, JSON.stringify([avg.routes[o], shuf.routes[o]]));
  assert.ok(shuf.routes[o].odds < avg.routes[o].odds, 'shuffler over-the-mat odds are lower');
  // with no risk aversion the odds are the length-only ones and the same for both gaits
  const [a0, s0] = planGhosts(S, lay, wm, xy, null, { seed: 2, riskM: 0 });
  assert.deepEqual(a0.routes.map(r => r.odds), s0.routes.map(r => r.odds));
  assert.deepEqual(a0.routes.map(r => +r.odds.toFixed(9)), routeOdds(a0.routes.map(r => r.length_m), [0, 0], 0).map(v => +v.toFixed(9)));
  assert.ok(ROUTE_RISK_M > 0);
});

test('gait ghosts: the rug folds with the same chance for every gait; a folded corner is a taller bump for the toes behind it; a taped rug never folds', () => {
  const p0 = planGhosts(S, lay, wm, xy, null, { seed: 3, riskM: 0, foldP: P_FOLD }), none = planGhosts(S, lay, wm, xy, null, { seed: 3, riskM: 0, foldP: null });
  for (const r of none) assert.equal(r.folds, 0);
  const [a, s] = p0.map(r => r.folds);
  if (p0.every(r => r.routes[r.pick].label.includes('over'))) assert.ok(a > 20 && s > 20 && Math.abs(a - s) <= 8, `folds ${a} vs ${s}`);   // P_FOLD per edge crossing, both gaits
  const st = prepare(S, lay, null), start = startState(xy, off0), o = { full_route: true, max_steps: 80 };
  for (const lift of ['average', 'shuffler'] as const) {
    const folded = fan(S, st, wm, start, xy, 60, 9, { ...o, lift, fold: { p: 1 } });
    assert.ok(folded.futures.some(f => f.fold && f.foldStep !== undefined && f.heels[f.foldStep]), `${lift}: crossing the mat edge folds a corner`);
  }
  const taped = prepare(S, { ...lay, poses: lay.poses.map((p, k) => (k === mat ? { ...p, taped: true } : p)) }, null);
  const T = fan(S, taped, wm, start, xy, 60, 9, { ...o, fold: { p: 1 } });
  assert.ok(T.futures.every(f => !f.fold), 'taped: no fold');
});

test('gait ghosts: the way back over a corner folded on the way out is never safer, and the way back is costlier for the shuffler (the rug cascade)', () => {
  // a seed whose draw sends both gaits over the mat (no risk aversion: 84% do), so both fold the same corner of it
  let R: ReturnType<typeof planGhosts> = [];
  for (let seed = 1; seed < 12 && !(R.length && R.every(r => r.back)); seed++) R = planGhosts(S, lay, wm, xy, null, { seed, riskM: 0, foldP: 1 });
  assert.ok(R.every(r => r.back), 'a seed that crosses the mat folds it');
  const [a, s] = R.map(r => r.back!);
  for (const b of [a, s]) assert.ok(b.folded_month >= b.flat_month - 0.05, JSON.stringify(b));
  assert.ok(s.folded_month > a.folded_month, JSON.stringify([a, s]));
});

test('gait ghosts: without the new options the fan is the one it was (a step record per heel, no fold, 30-step cap)', () => {
  const F = fan(S, prepare(S, lay, null), wm, startState(xy, off0), xy, 10, 1);
  assert.ok(F.futures.every(f => f.steps.length === f.heels.length && !f.fold));
  assert.ok(F.futures.every(f => f.heels.length <= 30));
});

test('gait ghosts: poses follow the path and the person starts facing along the route', () => {
  const st = startState(xy, off0), F = fan(S, prepare(S, lay, null), wm, st, xy, 3, 1, { full_route: true, max_steps: 80 }), P = posesOf(F.futures[0], st.yaw);
  assert.equal(P.length, F.futures[0].walker.length);
  assert.ok(Math.abs(Math.atan2(Math.sin(P[1][2] - st.yaw), Math.cos(P[1][2] - st.yaw))) < 0.8, 'the first step heads along the route');
});

test('assumptions: every number the ghosts lean on says where it comes from; the assumed ones say why', () => {
  const A = assumptions(init.risk, 0.45), kinds = new Set(['measured', 'published', 'simulated', 'assumed']);
  for (const a of A) assert.ok(kinds.has(a.kind) && a.label && a.value && a.note.length > 10, JSON.stringify(a));
  assert.equal(new Set(A.map(a => a.key)).size, A.length);
  assert.equal(A.find(a => a.key === 'p_fold')!.kind, 'measured');
  for (const k of ['shuffler', 'route_tau', 'route_risk', 'fold_size', 'speed']) assert.equal(A.find(a => a.key === k)!.kind, 'assumed', k);
  assert.ok(countAssumed(A) >= 5 && A.some(a => a.key === 'dark') && !assumptions().some(a => a.key === 'dark'));
});

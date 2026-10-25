import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScene } from './scene.ts';
import { evaluate } from '../src/evaluate.ts';
import { prepare, fan, fanLabel, routeOptions, routeLabel, type FanScene } from '../src/futures.ts';
import { toWorldModel } from '../src/gaitfit.ts';
import { worldFootprint, type XY } from '../src/grid.ts';
import { frame, predict, smoothRoute, toLocal, toWorld } from '../src/worldmodel.ts';

const { init, poses, walker } = loadScene('kitchen4_lighter');
const js = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
const M = js('gait/persona.json'), styles = js('gait/styles.json').styles, off0 = walker.user_gap_m + walker.depth_m / 2;
const S: FanScene = { g: init.g, base: init.base, est: init.est, persona: init.persona, risk: init.risk, rules: init.rules as any, objects: init.objects as any, walker, plan: init.plan };
const lay = { poses: poses.map(p => ({ ...p })), flattened: [] as [XY, XY][] };
const xy = evaluate({ ...init, worldModel: js('models/world_model.json') }, lay, { ghosts: false }).xy as XY[];
const rt = smoothRoute(xy);
/** the person's state with the walker frame on the (1 cm, smoothed) route at arc u */
const at = (u: number) => { const i = Math.round(u * 100), q = rt[i + 10], yaw = Math.atan2(q[1] - rt[i][1], q[0] - rt[i][0]); return { x: rt[i][0] - off0 * Math.cos(yaw), y: rt[i][1] - off0 * Math.sin(yaw), yaw }; };
const wm = toWorldModel(M, styles[0].e, off0 - M.mean_gap_m);
const mat = init.objects.findIndex((o: any) => o.name === 'mat');

test('futures fan: likely catches at the mat (sim.ts p), none once the mat is taped flat or removed', () => {
  const fp = worldFootprint(init.objects[mat] as any, lay.poses[mat]), xs = fp.map(p => p[0]), ys = fp.map(p => p[1]);
  const taped = { ...lay, flattened: [[[Math.min(...xs) - 0.03, Math.min(...ys) - 0.03], [Math.max(...xs) + 0.03, Math.max(...ys) + 0.03]]] as [XY, XY][] };
  const removed = { ...lay, poses: lay.poses.map((p, k) => (k === mat ? { ...p, removed: true } : p)) };
  const tapedPose = { ...lay, poses: lay.poses.map((p, k) => (k === mat ? { ...p, taped: true } : p)) };   // the one "taped" (grid.ts TAPED_EDGE_M)
  for (const m of [wm, null]) {
    const F = fan(S, prepare(S, lay, null), m, at(0.7), xy, 30, 3);
    assert.equal(F.futures.length, 30);
    // 1.1/month on the whole route (evaluate), almost all of it the mat: the fan over the mat says ~1
    assert.ok(F.crossed.mat >= 20 && F.catches_month > 0.5 && F.catches_month < 2, JSON.stringify([F.crossed, F.catches_month]));
    assert.match(fanLabel(F, 'World model'), /^World model: 30 futures · \d+ cross the mat · ≈[\d.]+ toe catches\/month here/);
    for (const L of [taped, tapedPose, removed]) {
      const G = fan(S, prepare(S, L, null), m, at(0.7), xy, 30, 3);
      assert.ok(!G.crossed.mat && G.catches_month < 0.1 * F.catches_month, JSON.stringify([G.crossed, G.catches_month]));
    }
  }
});

test('futures fan: the hand rule is one width everywhere, the learned fan opens at the turn', () => {
  // 0.9 m: the route bends <= 10 deg in the next 1.1 m; 1.9 m: 34 deg
  // 2.5 s windows, so the straight one ends before the turn (the 4-5 s fan's end spread mixes both: 0.014-0.047 m learned
  // vs 0.041-0.053 m hand along this route)
  const sd = (m: typeof wm | null, u: number) => fan(S, prepare(S, lay, null), m, at(u), xy, 100, 5, { ahead_s: 2.5 }).spread_m;
  const hand = [0.9, 1.9].map(u => sd(null, u)), learned = [0.9, 1.9].map(u => sd(wm, u));
  assert.ok(Math.max(...hand) / Math.min(...hand) < 1.3, `hand ${hand}`);
  assert.ok(learned[1] > 1.8 * learned[0], `learned ${learned}`);
});

test('futures fan: a folded corner on the path is a hazard of its own', () => {
  const p = at(2.1), fold = { corner: [p.x + 0.6 * Math.cos(p.yaw), p.y + 0.6 * Math.sin(p.yaw)] as XY, lift_m: 0.03, size_m: 0.6 };
  const F = fan(S, prepare(S, lay, fold), wm, p, xy, 30, 3);
  assert.ok((F.crossed['folded corner'] ?? 0) > 0 && F.futures.some(f => f.crossed === 'folded corner' && f.p > 0.01), JSON.stringify([F.crossed, F.catches_month]));
});

test('futures fan model = the trained checkpoint: toWorldModel + predict match torch on 24 fresh states x every style (worldmodel/fan_parity.py)', () => {
  const P = js('gait/fan_parity.json');
  let worst = 0;
  for (const r of P.rows) {
    near(featuresOf(r), r.x, 1e-4, 'features');
    for (const st of styles) {
      const o = r.out[st.name], p = predict(toWorldModel(M, st.e, 0), r.heels, r.sides, r.action);
      const kept = o.w.map((w: number, k: number) => [w, k]).filter(([w]: number[]) => w >= Math.min(M.min_w, Math.max(...o.w))), z = kept.reduce((a: number, [w]: number[]) => a + w, 0);
      assert.equal(p.mix.w.length, kept.length);
      kept.forEach(([w, k]: number[], j: number) => {
        worst = Math.max(worst, Math.abs(p.mix.w[j] - w / z), ...[0, 1].map(d => Math.abs(toWorld(p.f, o.mu[k] as XY)[d] - p.mix.mu[j][d])), ...[0, 1].map(d => Math.abs(p.mix.sd[j][d] - o.sd[k][d])));
      });
      const wc = toWorld(p.f, [o.walker[0], o.walker[1]]);
      worst = Math.max(worst, Math.abs(wc[0] - p.walker[0]), Math.abs(wc[1] - p.walker[1]), Math.abs(Math.atan2(p.f.t[1], p.f.t[0]) + p.f.mir * o.walker[2] - p.walker[2]));
    }
  }
  console.log(`fan model vs torch checkpoint: ${P.rows.length} states x ${styles.length} styles, worst |diff| ${worst.toExponential(1)}, weights ${P.weight_diff.toExponential(1)}`);
  assert.ok(worst < 1e-4, `worst ${worst}`);
});
const near = (a: number[], b: number[], tol: number, what: string) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tol, `${what} ${i}: ${v} vs ${b[i]}`));
const featuresOf = (r: { heels: XY[]; sides: number[]; action: XY[] }) => { const f = frame(r.heels, r.sides, r.action); return [r.heels[1], r.heels[2], ...r.action].flatMap(p => toLocal(f, p)); };

test('futures fan: forks over vs around the mat ahead of it, each future follows one route, none once the frame is at it', () => {
  const st = prepare(S, lay, null), R = routeOptions(S, st, lay, at(0.3), xy, 2.25);
  assert.deepEqual(R.map(r => r.label), ['over the mat', 'around the mat']);
  assert.ok(R[1].fork && Math.abs(R[0].p + R[1].p - 1) < 1e-9 && R[0].p > R[1].p, JSON.stringify(R.map(r => [r.p, r.fork])));
  const F = fan(S, st, wm, at(0.3), xy, 30, 3, { routes: R });
  assert.equal(F.routes.reduce((a, r) => a + r.n, 0), 30);
  assert.ok(F.routes[1].n > 0 && F.futures.filter(f => f.route === 1).every(f => f.crossed !== 'mat'), JSON.stringify(F.routes));
  assert.match(routeLabel(F), /^\d+ over the mat · \d+ around the mat$/);
  assert.equal(routeOptions(S, st, lay, at(1.0), xy, 2.25).length, 1);
});

test('futures fan: the low-clearance shuffler catches the mat edge more often than average foot lift; taped, neither does', () => {
  const st = prepare(S, lay, null), month = (lift: 'average' | 'shuffler', L = st) => [0.7, 1.0, 1.2].flatMap(u => [1, 2, 3].map(sd => fan(S, L, wm, at(u), xy, 30, sd, { lift }).catches_month)).reduce((a, b) => a + b) / 9;
  const avg = month('average'), shuf = month('shuffler');
  console.log(`fan over the mat: average ${avg.toFixed(2)} vs shuffler ${shuf.toFixed(2)} toe catches/month`);
  assert.ok(shuf > 1.3 * avg, `average ${avg} vs shuffler ${shuf}`);
  const taped = prepare(S, { ...lay, poses: lay.poses.map((p, k) => (k === mat ? { ...p, taped: true } : p)) }, null);
  assert.ok(month('shuffler', taped) < 0.2 * shuf, `taped ${month('shuffler', taped)}`);   // what is left is the cord the mat lay over
});

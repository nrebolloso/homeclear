import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScene } from './scene.ts';
import { evaluate } from '../src/evaluate.ts';
import { prepare, fan, fanLabel, type FanScene } from '../src/futures.ts';
import { toWorldModel } from '../src/gaitfit.ts';
import { worldFootprint, type XY } from '../src/grid.ts';
import { smoothRoute } from '../src/worldmodel.ts';

const { init, poses, walker } = loadScene('kitchen4_lighter');
const js = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'));
const M = js('gait/persona.json'), styles = js('gait/styles.json').styles, off0 = walker.user_gap_m + walker.depth_m / 2;
const S: FanScene = { g: init.g, base: init.base, est: init.est, persona: init.persona, risk: init.risk, rules: init.rules as any, objects: init.objects as any, walker };
const lay = { poses: poses.map(p => ({ ...p })), flattened: [] as [XY, XY][] };
const xy = evaluate({ ...init, worldModel: js('models/world_model.json') }, lay, { ghosts: false }).xy as XY[];
const rt = smoothRoute(xy);
/** the person's state with the walker frame on the (1 cm, smoothed) route at arc u */
const at = (u: number) => { const i = Math.round(u * 100), q = rt[i + 10], yaw = Math.atan2(q[1] - rt[i][1], q[0] - rt[i][0]); return { x: rt[i][0] - off0 * Math.cos(yaw), y: rt[i][1] - off0 * Math.sin(yaw), yaw }; };
const wm = toWorldModel(M, styles[0].e, off0 - M.mean_gap_m);
const mat = init.objects.findIndex((o: any) => o.name === 'mat');

test('futures fan: red at the mat, green once the mat is taped flat or removed', () => {
  const fp = worldFootprint(init.objects[mat] as any, lay.poses[mat]), xs = fp.map(p => p[0]), ys = fp.map(p => p[1]);
  const taped = { ...lay, flattened: [[[Math.min(...xs) - 0.03, Math.min(...ys) - 0.03], [Math.max(...xs) + 0.03, Math.max(...ys) + 0.03]]] as [XY, XY][] };
  const removed = { ...lay, poses: lay.poses.map((p, k) => (k === mat ? { ...p, removed: true } : p)) };
  for (const m of [wm, null]) {
    const F = fan(S, prepare(S, lay, null), m, at(0.7), xy, 30, 3);
    assert.equal(F.futures.length, 30);
    assert.ok(Object.keys(F.counts).some(k => k.startsWith('mat')) && F.futures.filter(f => f.hazard).length >= 25, JSON.stringify(F.counts));
    assert.match(fanLabel(F, 'World model'), /^World model: 30 imagined futures · \d+ hit the mat/);
    for (const L of [taped, removed]) assert.deepEqual(fan(S, prepare(S, L, null), m, at(0.7), xy, 30, 3).counts, {});
  }
});

test('futures fan: the hand rule is one width everywhere, the learned fan opens at the turn', () => {
  // 0.9 m: the route bends <= 10 deg in the next 1.1 m; 1.9 m: 34 deg
  const sd = (m: typeof wm | null, u: number) => fan(S, prepare(S, lay, null), m, at(u), xy, 100, 5).spread_m;
  const hand = [0.9, 1.9].map(u => sd(null, u)), learned = [0.9, 1.9].map(u => sd(wm, u));
  assert.ok(Math.max(...hand) / Math.min(...hand) < 1.3, `hand ${hand}`);
  assert.ok(learned[1] > 1.8 * learned[0], `learned ${learned}`);
});

test('futures fan: a folded corner on the path is a hazard of its own', () => {
  const p = at(2.1), fold = { corner: [p.x + 0.6 * Math.cos(p.yaw), p.y + 0.6 * Math.sin(p.yaw)] as XY, lift_m: 0.03, size_m: 0.6 };
  const F = fan(S, prepare(S, lay, fold), wm, p, xy, 30, 3);
  assert.ok((F.counts['folded corner'] ?? 0) > 0, JSON.stringify(F.counts));
});

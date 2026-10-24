import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { predict, smoothRoute, type WorldModel } from '../src/worldmodel.ts';
import { rollouts } from '../src/sim.ts';
import { bumpComponents, plan, stamp, type GridMeta, type Layers } from '../src/grid.ts';

const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
const model: WorldModel = JSON.parse(readFileSync(pub('models/world_model.json'), 'utf8'));

test('TS world model matches worldmodel/learned.py (export_web.py world_model_check.json)', () => {
  for (const c of JSON.parse(readFileSync(pub('models/world_model_check.json'), 'utf8'))) {
    const W = c.walker_cfg, p = predict({ ...model, shift: W.user_gap_m + W.depth_m / 2 - model.mean_gap_m }, c.heels, c.sides, c.action);
    assert.equal(p.mix.w.length, c.w.length);
    c.w.forEach((w: number, k: number) => {
      assert.ok(Math.abs(p.mix.w[k] - w) < 1e-4, `w ${k}`);
      for (const d of [0, 1]) {
        assert.ok(Math.abs(p.mix.mu[k][d] - c.mu[k][d]) < 1e-4, `mu ${k},${d}`);
        assert.ok(Math.abs(p.mix.sd[k][d] - c.sd[k][d]) < 1e-4, `sd ${k},${d}`);
      }
    });
    c.walker.forEach((v: number, d: number) => assert.ok(Math.abs(p.walker[d] - v) < 1e-4, `walker ${d}: ${p.walker[d]} vs ${v}`));
  }
});

test('smoothRoute rounds the corner, 1 cm spacing (as rollout.py plan_route)', () => {
  const r = smoothRoute([[0, 0], [1, 0], [1, 1]]);
  assert.ok(Math.min(...r.map(p => Math.hypot(p[0] - 1, p[1]))) > 0.1, 'corner cut');
  for (let k = 1; k < r.length - 1; k++) assert.ok(Math.abs(Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]) - 0.01) < 1e-3);
});

test('world model rollouts on the synthetic scene: plausible steps, walker near the feet', () => {
  const d = pub('scene/game_synth/'), buf = (f: string) => readFileSync(new URL(f, d));
  const sc = JSON.parse(buf('scene.json').toString()), g = sc.grid as GridMeta, b = buf(sc.grid.bump_height_m);
  const base: Layers = { floor: new Uint8Array(buf(sc.grid.floor)), obst: new Uint8Array(buf(sc.grid.obstacles)), bump: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  const persona = JSON.parse(buf('persona.json').toString()), route = JSON.parse(buf('route.json').toString());
  const L = stamp(g, base, sc.objects, sc.objects.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })));
  const P = plan(g, L, route.start, route.goal, { walker_width_m: 0.66, ...sc.plan });
  const comps = bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m);
  const t = performance.now();
  const R = rollouts(g, L.bump, comps, P.xy, { ...persona, step_model: 'world' }, { ...sc.risk, ghosts: 24 }, [], 1, undefined, { ...model, shift: 0.25 + 0.5 / 2 - model.mean_gap_m });
  const steps = R.ghosts.flatMap(gh => gh.pts.slice(1).map((p, k) => Math.hypot(p[0] - gh.pts[k][0], p[1] - gh.pts[k][1])));
  const bad = steps.filter(s => s < 0.1 || s > 0.8).length / steps.length;
  const gap = R.ghosts.flatMap(gh => gh.walker!.map((w, k) => Math.hypot(w[0] - gh.pts[k][0], w[1] - gh.pts[k][1])));
  console.log(`world ${R.per_month.toFixed(2)}/month; ${(performance.now() - t).toFixed(0)} ms for ${sc.risk.rollouts} trips; impossible steps ${(100 * bad).toFixed(2)}%; heel->walker max ${Math.max(...gap).toFixed(2)} m`);
  assert.ok(Number.isFinite(R.per_month) && R.per_month >= 0);
  assert.ok(bad < 0.02, `impossible steps ${bad}`);
  assert.ok(Math.max(...gap) < 1.2, `walker ${Math.max(...gap)} m from the heel`);
  assert.throws(() => rollouts(g, L.bump, comps, P.xy, { ...persona, step_model: 'world' }, sc.risk, []));
});

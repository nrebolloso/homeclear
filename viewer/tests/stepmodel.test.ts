import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mdn, type StepModel } from '../src/stepmodel.ts';
import { rollouts } from '../src/sim.ts';
import { bumpComponents, plan, stamp, type GridMeta, type Layers } from '../src/grid.ts';

const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
const model: StepModel = JSON.parse(readFileSync(pub('models/step_model.json'), 'utf8'));

test('TS step model matches PyTorch (train_eval.py step_model_check.json)', () => {
  const c = JSON.parse(readFileSync(pub('models/step_model_check.json'), 'utf8'));
  c.x.forEach((x: number[], n: number) => {
    const m = mdn(model, x);
    for (let k = 0; k < model.K; k++) {
      assert.ok(Math.abs(m.w[k] - c.w[n][k]) < 1e-4, `w ${n},${k}: ${m.w[k]} vs ${c.w[n][k]}`);
      for (const d of [0, 1]) {
        assert.ok(Math.abs(m.mu[k][d] - c.mu[n][k][d]) < 1e-4, `mu ${n},${k},${d}`);
        assert.ok(Math.abs(m.sd[k][d] - c.sd[n][k][d]) < 1e-4, `sd ${n},${k},${d}`);
      }
    }
  });
});

test('learned rollouts on the synthetic scene: feet stay near the route, contacts per month finite', () => {
  const d = pub('scene/game_synth/'), buf = (f: string) => readFileSync(new URL(f, d));
  const sc = JSON.parse(buf('scene.json').toString()), g = sc.grid as GridMeta, b = buf(sc.grid.bump_height_m);
  const base: Layers = { floor: new Uint8Array(buf(sc.grid.floor)), obst: new Uint8Array(buf(sc.grid.obstacles)), bump: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  const persona = JSON.parse(buf('persona.json').toString()), route = JSON.parse(buf('route.json').toString());
  const L = stamp(g, base, sc.objects, sc.objects.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })));
  const P = plan(g, L, route.start, route.goal, { walker_width_m: 0.66, ...sc.plan });
  const comps = bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m);
  const t = performance.now();
  const R = rollouts(g, L.bump, comps, P.xy, { ...persona, step_model: 'learned' }, { ...sc.risk, ghosts: 24 }, [], 1, model);
  const ms = performance.now() - t, H = rollouts(g, L.bump, comps, P.xy, persona, { ...sc.risk, ghosts: 24 }, []);
  const off = R.ghosts.flatMap(gh => gh.pts.map(p => Math.min(...P.xy.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])))));
  console.log(`learned ${R.per_month.toFixed(2)}/month vs hand ${H.per_month.toFixed(2)}; ${ms.toFixed(0)} ms for ${sc.risk.rollouts} trips; body-to-route max ${Math.max(...off).toFixed(3)} m`);
  assert.ok(Number.isFinite(R.per_month) && R.per_month >= 0);
  assert.ok(Math.max(...off) < 0.35, `walker body strays ${Math.max(...off)} m from the route`);
  assert.throws(() => rollouts(g, L.bump, comps, P.xy, { ...persona, step_model: 'learned' }, sc.risk, []));
});

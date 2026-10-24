import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, stamp, type XY } from '../src/grid.ts';
import { evaluate } from '../src/evaluate.ts';
import { loadScene } from './scene.ts';

const turning = (xy: XY[]) => {   // total absolute heading change along a path, radians
  let t = 0;
  for (let k = 2; k < xy.length; k++) {
    const a = Math.atan2(xy[k - 1][1] - xy[k - 2][1], xy[k - 1][0] - xy[k - 2][0]), b = Math.atan2(xy[k][1] - xy[k - 1][1], xy[k][0] - xy[k - 1][0]);
    t += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  }
  return t;
};

test('turn-penalised planning turns less; zero penalty is the plain planner', () => {
  const { sc, g, base, route, poses, init } = loadScene('game_synth');
  const L = stamp(g, base, sc.objects, poses);
  const plain = plan(g, L, route.start, route.goal, init.plan);
  const zero = plan(g, L, route.start, route.goal, { ...init.plan, turn_weight_m: 0, narrow_weight: 0 });
  assert.deepEqual(zero.cells, plain.cells);
  const t0 = performance.now();
  const turny = plan(g, L, route.start, route.goal, { ...init.plan, turn_weight_m: 0.6 });
  assert.equal(turny.error, undefined);
  assert.ok(turning(turny.xy) < turning(plain.xy), `${turning(turny.xy).toFixed(2)} vs ${turning(plain.xy).toFixed(2)} rad`);
  assert.ok(performance.now() - t0 < 3000, 'heading A* stays interactive');
});

test('personas: Parkinson persona has more contacts than the patient; the cane persona plans with its own width', () => {
  const { init, poses, js } = loadScene('game_synth');
  const P = js('personas.json');
  assert.deepEqual(Object.keys(P).sort(), ['cane', 'parkinsons', 'patient']);
  const as = (k: string) => evaluate({ ...init, persona: P[k].gait, plan: { ...init.plan, ...P[k].plan, walker_width_m: P[k].walker.width_m } },
    { poses, flattened: [] }, { ghosts: false });
  const pat = as('patient'), pk = as('parkinsons'), cane = as('cane');
  assert.ok(pk.per_month > pat.per_month, `${pk.per_month} vs ${pat.per_month}`);   // lower swing (clearance_scale 0.7)
  assert.equal(cane.error, undefined);
  assert.ok(P.cane.walker.device === 'cane' && P.cane.walker.legs.length === 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type GridMeta, type Layers, type XY } from '../src/grid.ts';
import { planVia } from '../src/route_via.ts';

// 6 x 6 m floor at 10 cm, a 2 x 2 m block in the middle (the tower): start == goal, via points round it
const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.1, shape: [60, 60] };
const L: Layers = { floor: new Uint8Array(3600).fill(1), obst: new Uint8Array(3600), bump: new Float32Array(3600) };
for (let i = 20; i < 40; i++) for (let j = 20; j < 40; j++) L.obst[i * 60 + j] = 1;
const pp = { walker_width_m: 0.6, preferred_clearance_m: 0.3, clearance_weight: 5 };
const home: XY = [0.8, 3];

test('via points make a full loop round the block', () => {
  const P = planVia(g, L, home, [[3, 0.8], [5.2, 3], [3, 5.2]], home, pp);
  assert.equal(P.error, undefined);
  assert.deepEqual(P.xy[0], P.xy.at(-1));
  let turn = 0;   // winding angle round the block centre: one full circle
  for (let k = 1; k < P.xy.length; k++) {
    const a = Math.atan2(P.xy[k - 1][1] - 3, P.xy[k - 1][0] - 3), b = Math.atan2(P.xy[k][1] - 3, P.xy[k][0] - 3);
    turn += Math.atan2(Math.sin(b - a), Math.cos(b - a));
  }
  assert.ok(Math.abs(Math.abs(turn) - 2 * Math.PI) < 0.1, `winding ${turn}`);
  assert.ok(P.length_m > 12, `length ${P.length_m}`);
  for (let k = 1; k < P.cells.length; k++) assert.notEqual(P.cells[k], P.cells[k - 1]);   // legs joined without a repeated cell
});

test('no via: plain plan; a blocked leg names itself', () => {
  assert.match(planVia(g, L, home, undefined, home, pp).error ?? '', /same spot/);
  const walled = { ...L, obst: L.obst.slice() };
  for (let j = 0; j < 60; j++) for (let i = 45; i < 50; i++) walled.obst[i * 60 + j] = 1;   // cut off the east side
  assert.match(planVia(g, walled, home, [[3, 0.8], [5.5, 3]], home, pp).error ?? '', /leg 2 of 3/);
});

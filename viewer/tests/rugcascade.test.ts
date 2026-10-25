// rugcascade.ts on a hand-made rug and route (SYNTHETIC geometry): a route across the rug crosses two edges; with P = 1
// the corner nearest the first crossing folds, with P = 0 nothing does; the fold raises the bump map within its size and
// the cascade keeps one fold per rug until the rug moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeCrossings, foldOnPass, createRugCascade, P_FOLD, FOLD_LIFT_M } from '../src/rugcascade.ts';
import { stampFolds, type XY, type Layout, type GridMeta } from '../src/grid.ts';

const rug: XY[] = [[0, 0], [0.9, 0], [0.9, 0.6], [0, 0.6]];
const route: XY[] = [[-0.5, 0.1], [0.5, 0.1], [1.5, 0.1]];

test('crossings and the folded corner', () => {
  assert.equal(edgeCrossings(rug, route).length, 2);
  assert.deepEqual(foldOnPass(rug, route, 1, 1)?.corner, [0, 0]);   // onto at x=0, y=0.1: the near corner
  assert.equal(foldOnPass(rug, route, 1, 0), null);
  assert.ok(P_FOLD > 0.5 && P_FOLD <= 1 && FOLD_LIFT_M > 0.01 && FOLD_LIFT_M < 0.15, `${P_FOLD} ${FOLD_LIFT_M}`);
});

test('the fold is a taller bump within its size', () => {
  const g = { origin_xy: [-1, -1], cell_m: 0.05, shape: [60, 60] } as unknown as GridMeta, bump = new Float32Array(3600).fill(0.015);
  const cells = stampFolds(g, bump, [{ corner: [0, 0], lift_m: 0.05, size_m: 0.15 }]);
  assert.ok(cells.length > 20 && cells.every(c => bump[c] === Math.fround(0.05)));
  assert.equal(bump.filter(h => h === Math.fround(0.05)).length, cells.length);
});

test('one fold per rug, cleared when the rug moves', () => {
  const pose = { x: 0, y: 0, yaw: 0 };
  const C = createRugCascade({ index: 0, poly: p => rug.map(([x, y]) => [x + p.x, y + p.y] as XY) });
  let lay: Layout = { poses: [pose], flattened: [] };
  for (let k = 0; k < 20 && !lay.folds?.length; k++) lay = C.lap(route, lay) ?? lay;
  assert.equal(lay.folds?.length, 1);
  assert.equal(C.lap(route, lay), null);                       // already folded: stays
  const moved = C.lap(route, { ...lay, poses: [{ x: 2, y: 0, yaw: 0 }] });
  assert.deepEqual(moved?.folds, []);
});

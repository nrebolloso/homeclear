import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provenanceOf, provenanceShare, provenanceTexels, PROVENANCE_LEGEND } from '../src/provenance.ts';

const g = { origin_xy: [0, 0] as [number, number], cell_m: 0.1, shape: [3, 2] as [number, number] };
// index = i * ny + j; cells: (0,0) measured, (0,1) thin, (1,0) never seen, (1,1) off the floor, (2,0) never seen, (2,1) measured
const floor = [1, 1, 1, 0, 1, 1], cov = [9, 2, 0, 5, 0, 7];

test('a cell is measured at the good threshold, thin below it, inferred at zero', () => {
  assert.equal(provenanceOf(5, 5), 'measured'); assert.equal(provenanceOf(4, 5), 'thin'); assert.equal(provenanceOf(1, 5), 'thin'); assert.equal(provenanceOf(0, 5), 'inferred');
});
test('the share counts floor cells only', () => {
  assert.deepEqual(provenanceShare(floor, cov, 5), { measured: 2, thin: 1, inferred: 2, total: 5 });
});
test('texels: faint teal measured, amber thin, violet inferred and hatched, nothing off the floor', () => {
  const t = provenanceTexels(g, floor, cov, 5), px = (i: number, j: number) => [...t.slice((j * 3 + i) * 4, (j * 3 + i) * 4 + 4)];
  assert.deepEqual(px(0, 0), [73, 212, 199, 46]);
  assert.deepEqual(px(0, 1), [255, 179, 71, 120]);
  assert.deepEqual(px(1, 1), [0, 0, 0, 0]);
  assert.equal(px(1, 0)[0], 204); assert.equal(px(2, 0)[0], 204);
  assert.notEqual(px(1, 0)[3], px(2, 0)[3], 'neighbouring inferred cells alternate (the hatch)');
});
test('the legend has one entry per kind of evidence, each with a colour and a plain-words detail', () => {
  assert.deepEqual(PROVENANCE_LEGEND.map(l => l.key), ['measured', 'thin', 'inferred', 'estimated', 'proposed', 'designed', 'simulated']);
  for (const l of PROVENANCE_LEGEND) assert.ok(/^#[0-9a-f]{6}$/.test(l.css) && l.detail.length > 10, l.key);
});

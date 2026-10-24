// objrisk.ts on a hand-made batch table (SYNTHETIC numbers): a route across the mat counts one crossing per trip at the
// route's angle; a chair the route passes far from is left out, one it brushes gets a contact chance from the sway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { objectRisk, type BatchResults } from '../src/objrisk.ts';
import type { XY } from '../src/grid.ts';

const bin = (a0: number, a1: number, p: number) => ({ speed_mps: [0.1, 0.6], angle_deg: [a0, a1], n: 100, slid: p, slid_ci95: [p / 2, p * 2], folded: 0, folded_ci95: [0, 0.03],
  moved: p, moved_ci95: [0, 1], tipped: 0.1, tipped_ci95: [0, 1] });
const R = { label: 'test', scenarios: {
  mat_edge: { trials: 200, given_contact: {}, bins: [bin(0, 45, 0.2), bin(45, 90, 0.6)] },
  chair: { trials: 200, given_contact: {}, bins: [bin(0, 45, 0.5), bin(45, 90, 0.3)] },
} } as unknown as BatchResults;
const mat: XY[] = [[1, -0.5], [2, -0.5], [2, 0.5], [1, 0.5]];

test('a straight route over the mat: one head-on crossing per trip', () => {
  const ev = objectRisk(R, 'r', [[0, 0], [3, 0]], [{ name: 'rug', kind: 'rug', poly: mat }], 0.4, 60, 0.33, 0.05);
  const slid = ev.find(e => e.event === 'slid')!;
  assert.equal(ev.filter(e => e.event === 'slid').length, 1);   // stepping off the far edge doesn't count again
  assert.ok(slid.angle_deg < 1 && slid.p === 0.2 && slid.p_contact === 1);
  assert.equal(slid.per_month, 60 * 0.2);
});

test('a diagonal crossing is 45° off head-on', () => {
  const ev = objectRisk(R, 'r', [[0.2, -1.4], [2.2, 0.6]], [{ name: 'rug', kind: 'rug', poly: mat }], 0.4, 60, 0.33, 0.05);
  assert.ok(ev.every(e => Math.abs(e.angle_deg - 45) < 1));
});

test('chairs: far ones are skipped, a brushed one gets the sway contact chance', () => {
  const chair = (y: number) => ({ name: `c${y}`, kind: 'chair', poly: [[1, y], [1.4, y], [1.4, y + 0.4], [1, y + 0.4]] as XY[] });
  const ev = objectRisk(R, 'r', [[0, 0], [3, 0]], [chair(2), chair(0.33)], 0.4, 60, 0.33, 0.05);
  assert.deepEqual([...new Set(ev.map(e => e.object))], ['c0.33']);
  const m = ev.find(e => e.event === 'moved')!;
  assert.ok(Math.abs(m.p_contact - 0.5) < 1e-6 && m.angle_deg > 89 && m.p === 0.3);   // edge exactly at the walker's side; grazing
  assert.ok(Math.abs(m.per_month - 60 * 0.5 * 0.3) < 1e-6);
});

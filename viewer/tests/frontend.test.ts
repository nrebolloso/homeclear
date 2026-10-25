import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctOptions, summarizeChanges, escapeHTML } from '../src/frontend-model.ts';
import type { Change } from '../src/reimagine.ts';

const change = (source: string, usd: number, minutes = 10): Change => ({ k: -1, name: 'light', kind: 'fix', label: 'Add light', at: [0, 0], dist_m: 0, turn_deg: 0,
  cost: { source, usd, minutes, helpers: 2, effort: 1, funding: 'unclassified' } });
test('unknown placeholder prices and labor are excluded from known totals', () => {
  const s = summarizeChanges([change('catalog', 25), change('placeholder', 999, 999)]);
  assert.equal(s.knownSubtotal, 25); assert.equal(s.setupMinutes, 10); assert.equal(s.unpriced, 1); assert.equal(s.untimed, 1); assert.equal(s.helpers, null);
});
test('effort cost is a 0..100 dial over summed effort', () => {
  const s = summarizeChanges([change('catalog', 25), change('placeholder', 999, 999)]);
  assert.equal(s.effortTotal, 2); assert.equal(s.effortScore, 15); assert.equal(summarizeChanges([]).effortScore, 0);
});
test('a verified zero-dollar change is distinguished from a missing estimate', () => {
  const s = summarizeChanges([change('catalog', 0)]);
  assert.equal(s.knownSubtotal, 0); assert.equal(s.unpriced, 0); assert.equal(s.helpers, 2);
  assert.equal(summarizeChanges([]).helpers, null);
});
test('identical proposal outcomes collapse and retain their original Apply index', () => {
  const options = [
    { layout: { poses: [1] }, score: 5, actions: ['a'] },
    { layout: { poses: [2] }, score: 3, actions: ['b'] },
    { layout: { poses: [1] }, score: 1, actions: ['c'] },
  ];
  assert.deepEqual(distinctOptions(options).map(x => x.index), [2, 1]);
});
test('scene labels cannot inject markup into the planning shell', () => assert.equal(escapeHTML('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;'));

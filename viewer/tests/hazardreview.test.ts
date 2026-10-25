import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewKey, setVerdict, setNote, visibleSpots, reviewCounts, parseReview, exportReview } from '../src/hazardreview.ts';

const spot = (n: number, kind: 'measured' | 'reason-ot' = 'measured') => ({ kind, xy: [n + 0.123, 2] as [number, number], label: `rug ${n} cm`, detail: `d${n}`, severity: 0.5 });
const T = '2026-10-24T12:00:00.000Z';

test('a spot keeps its key across re-plans: kind, position to 1 cm, headline', () => {
  assert.equal(reviewKey(spot(1)), 'measured|1.12,2.00|rug 1 cm');
  assert.equal(reviewKey({ ...spot(1), xy: [1.1204, 2.001] }), reviewKey(spot(1)));
  assert.notEqual(reviewKey(spot(1)), reviewKey(spot(1, 'reason-ot')));
});
test('confirm, dismiss, and a second click on the same verdict clears it; state is never mutated', () => {
  const k = reviewKey(spot(1)), s0 = {};
  const s1 = setVerdict(s0, k, 'confirmed', T); assert.equal(s1[k].verdict, 'confirmed'); assert.deepEqual(s0, {});
  const s2 = setVerdict(s1, k, 'dismissed', T); assert.equal(s2[k].verdict, 'dismissed');
  assert.deepEqual(setVerdict(s2, k, 'dismissed', T), {});
});
test('a note survives a verdict change; an empty note with no verdict removes the entry', () => {
  const k = reviewKey(spot(1));
  let s = setNote({}, k, '  edge lifts near the bed  ', T); assert.equal(s[k].note, 'edge lifts near the bed');
  s = setVerdict(s, k, 'confirmed', T); assert.equal(s[k].note, 'edge lifts near the bed');
  s = setVerdict(s, k, 'confirmed', T); assert.equal(s[k].verdict, undefined); assert.ok(s[k].note);
  assert.deepEqual(setNote(s, k, '   ', T), {});
});
test('dismissed spots are hidden from the view, confirmed ones stay, counts add up', () => {
  const spots = [spot(1), spot(2), spot(3, 'reason-ot')];
  let s = setVerdict({}, reviewKey(spots[0]), 'dismissed', T); s = setVerdict(s, reviewKey(spots[1]), 'confirmed', T); s = setNote(s, reviewKey(spots[2]), 'ask the family', T);
  assert.deepEqual(visibleSpots(spots, s).map(x => x.label), ['rug 2 cm', 'rug 3 cm']);
  assert.deepEqual(reviewCounts(spots, s), { total: 3, confirmed: 1, dismissed: 1, noted: 1, unreviewed: 1 });
});
test('parseReview ignores junk and unknown verdicts instead of breaking the page', () => {
  assert.deepEqual(parseReview(null), {}); assert.deepEqual(parseReview('{not json'), {}); assert.deepEqual(parseReview('[1,2]'), {});
  assert.deepEqual(parseReview(JSON.stringify({ a: { verdict: 'maybe' }, b: { verdict: 'dismissed', note: 'x', at: T }, c: 5 })), { b: { verdict: 'dismissed', note: 'x', at: T } });
});
test('the export lists only reviewed spots, says what it is, and is not an answer key', () => {
  const spots = [spot(1), spot(2)], s = setVerdict({}, reviewKey(spots[1]), 'confirmed', T);
  const out = exportReview('game_synth', spots, s, T);
  assert.equal(out.kind, 'viewer-hazard-review'); assert.equal(out.items.length, 1); assert.equal(out.items[0].label, 'rug 2 cm'); assert.equal(out.items[0].verdict, 'confirmed');
  assert.match(out.note, /Not a hand-labelled answer key/);
});

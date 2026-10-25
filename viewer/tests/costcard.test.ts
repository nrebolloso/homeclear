import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costCardModel, nearbyCleared, FUNDING_LABEL, NEAR_M } from '../src/costcard.ts';
import type { Change } from '../src/reimagine.ts';

const cost = (o: Partial<Change['cost']> = {}) => ({ usd: 0, minutes: 25, helpers: 1, effort: 2.5, funding: 'self_pay' as const, source: 'placeholder', ...o });
const move: Change = { k: 3, name: 'chair', kind: 'move', label: 'Move the chair 1.2 m', from: { x: 1, y: 1, yaw: 0 }, to: { x: 2, y: 1, yaw: 0 }, dist_m: 1.2, turn_deg: 30, at: [2, 1], cost: cost() };
const row = (m: ReturnType<typeof costCardModel>, label: string) => m.rows.find(r => r.label === label)!;

test('a placeholder hand move is labelled placeholder, never a confirmed price', () => {
  const m = costCardModel(move);
  assert.equal(m.placeholder, true);
  assert.equal(row(m, 'Price').value, 'No purchase'); assert.equal(row(m, 'Price').status, 'placeholder'); assert.match(row(m, 'Price').note!, /not a quote/);
  assert.equal(row(m, 'Time').value, '25 min'); assert.equal(row(m, 'Time').status, 'placeholder');
  assert.equal(row(m, 'Move').value, '1.2 m, turned 30°');
});
test('a configured fix with a price shows it; a fix with no price reads Pending, not zero', () => {
  const priced = costCardModel({ ...move, kind: 'fix', k: -1, label: 'Tape the cable', cost: cost({ usd: 12, source: 'effort.ts' }) });
  assert.equal(row(priced, 'Price').value, '$12'); assert.equal(row(priced, 'Price').status, 'known'); assert.equal(priced.placeholder, false);
  const free = costCardModel({ ...move, kind: 'fix', k: -1, cost: cost({ usd: 0 }) });
  assert.equal(row(free, 'Price').value, 'Pending');
  const nan = costCardModel({ ...move, cost: cost({ usd: NaN, minutes: NaN }) });
  assert.equal(row(nan, 'Price').status, 'pending'); assert.equal(row(nan, 'Time').value, 'Pending');
});
test('installation is always pending, and funding is a classification to verify', () => {
  const m = costCardModel(move);
  assert.equal(row(m, 'Installation').status, 'pending'); assert.match(row(m, 'Installation').note!, /verify on site/);
  assert.equal(m.funding.label, FUNDING_LABEL.self_pay); assert.match(m.funding.note, /not a promise of coverage/);
  assert.equal(costCardModel({ ...move, cost: cost({ funding: 'unclassified' }) }).funding.label, 'Not classified yet');
  assert.equal(row(costCardModel({ ...move, cost: cost({ helpers: 2 }) }), 'People').value, '2 people');
});
test('only hazards within reach of the change are listed as cleared', () => {
  const resolved = [{ type: 'floor_bump', position: [2.3, 1] as [number, number], name: 'rug', height_m: 0.015 }, { type: 'tight_clearance', position: [2, 1.5] as [number, number], min_side_clearance_m: 0.06 }, { type: 'floor_bump', position: [6, 6] as [number, number], name: 'cable' }];
  assert.deepEqual(nearbyCleared(move, resolved), ['rug 1.5 cm', 'tight gap 6 cm/side']);
  assert.equal(costCardModel(move, resolved).clears.length, 2);
  assert.deepEqual(nearbyCleared(move, resolved, 0.1), []);
  assert.ok(NEAR_M > 0.3);
});

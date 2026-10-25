import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeScan, groupScans, validScanId } from '../src/scan-catalog.ts';
test('quality exports group under the same real room and capabilities come from the export', () => {
  const a = describeScan('kitchen4_vr200', { objects: [], route: 'route.json' });
  const b = describeScan('kitchen4_lighter_objects', { objects: [{ movable: true }, { movable: false }], interventions: [{}] });
  assert.equal(groupScans([a, b]).length, 1); assert.equal(a.objects, 0); assert.equal(b.objects, 1); assert.equal(b.fixes, true);
  assert.equal(describeScan('game_synth', {}).sample, true);
});
test('scene identities cannot escape the scene directory', () => {
  assert.equal(validScanId('juan_bedroom_bathroom'), true); assert.equal(validScanId('kitchen4_lighter_v1.0.3'), true);
  for (const id of ['../secret', 'room/file', '', 'a?b']) assert.equal(validScanId(id), false);
});

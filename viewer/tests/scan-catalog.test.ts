import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoScans, describeScan, groupScans, validScanId } from '../src/scan-catalog.ts';
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
test('renamed rooms: both Ale Room captures group together, versions keep their capture number', () => {
  const r = ['nicoroom1_lighter', 'aleroom_lighter', 'aleroom2_lighter', 'newell_lounge1_lighter', 'newell_stair_lighter', 'century_tower_lighter', 'turlington'].map(id => describeScan(id, {}));
  assert.deepEqual(r.map(e => e.room), ['Nico Room', 'Ale Room', 'Ale Room', 'Newell Lounge', 'Newell Stairs', 'Century Tower', 'Turlington']);
  assert.equal(r[2].version, 'lighter'); assert.equal(groupScans(r).length, 6);
});
test('the picker lists demo exports only: old names, raw and experiment exports are hidden', () => {
  const ids = ['kitchen4_lighter', 'kitchen4_raw', 'kitchen4_sam1_lighter', 'aleroom_lighter', 'aleroom2_lighter', 'bedroom3', 'gator_lounge', 'turlington', 'turlington_lighter', 'juan_bedroom_bathroom', 'game_synth'];
  assert.deepEqual(demoScans(ids.map(id => describeScan(id, {}))).map(e => e.id),
    ['kitchen4_lighter', 'aleroom_lighter', 'aleroom2_lighter', 'turlington_lighter', 'juan_bedroom_bathroom', 'game_synth']);
});

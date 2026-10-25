import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS, PRESETS, PRESET_ORDER, applyPreset, activePreset, chromeKey, perfSkips, type LayerIO, type LayerValue } from '../src/layers.ts';

/** A fake set of controls: every layer exists, all off (reimtags 'selected'), recording each write. */
function fake(missing: string[] = []) {
  const v: Record<string, LayerValue> = Object.fromEntries(LAYERS.map(l => [l.id, l.options ? 'selected' : false]));
  const writes: string[] = [];
  const io: LayerIO = { has: id => id in v && !missing.includes(id), get: id => v[id], set: (id, x) => { v[id] = x; writes.push(id); } };
  return { v, io, writes };
}
const key = (o: Partial<Parameters<typeof chromeKey>[0]> = {}) => ({ code: 'KeyV', ctrlKey: false, metaKey: false, altKey: false, target: { tagName: 'DIV' }, ...o });

test('every preset names only real layers, with values the control can take', () => {
  const byId = new Map(LAYERS.map(l => [l.id, l]));
  for (const name of PRESET_ORDER) for (const [id, value] of Object.entries(PRESETS[name].set)) {
    const d = byId.get(id); assert.ok(d, `${name}: unknown layer ${id}`);
    if (d.options) assert.ok(d.options.some(o => o.value === value), `${name}.${id}=${value}`); else assert.equal(typeof value, 'boolean', `${name}.${id}`);
  }
});
test('applyPreset writes only the layers that differ, and returns them', () => {
  const { v, io, writes } = fake();
  const changed = applyPreset('hazards', io);
  assert.deepEqual(changed.sort(), ['ghosts', 'heights', 'particle-path', 'reimtags', 'spot']);
  assert.deepEqual(writes.sort(), changed.sort());
  assert.equal(v.spot, true); assert.equal(v.reimtags, 'off');
  assert.deepEqual(applyPreset('hazards', io), [], 'a second apply is a no-op');
});
test('applyPreset then activePreset round-trips for every preset', () => {
  for (const name of PRESET_ORDER) { const { io } = fake(); applyPreset(name, io); assert.equal(activePreset(io), name, name); }
});
test('a manual change after a preset reads as custom; a fresh room matches none', () => {
  const { io } = fake();
  assert.equal(activePreset(io), 'custom');
  applyPreset('clean', io); io.set('spot', true);
  assert.equal(activePreset(io), 'custom');
});
test('layers that do not exist (no re-scan) are skipped and do not block a match', () => {
  const { v, io, writes } = fake(['verify']);
  applyPreset('evidence', io);
  assert.ok(!writes.includes('verify')); assert.equal(v.verify, false);
  assert.equal(activePreset(io), 'evidence');
});
test('presets are distinguishable: each one differs from the others in at least one layer', () => {
  const { io } = fake();
  for (const n of PRESET_ORDER) { applyPreset(n, io); assert.equal(activePreset(io), n, `after ${n}`); }   // one room walked through all four, in order
});
test('performance mode leaves heat, the imagined ceiling and all-cost-labels alone', () => {
  assert.ok(perfSkips('heat', true) && perfSkips('imagceil', true) && perfSkips('reimtags', 'all'));
  assert.ok(!perfSkips('reimtags', 'off') && !perfSkips('spot', true));
  const { v, io } = fake();
  applyPreset('evidence', io, { perf: true }); assert.equal(v.imagceil, false); assert.equal(v.imagfill, true);
  assert.equal(activePreset(io, { perf: true }), 'evidence');
  const c = fake(); applyPreset('compare', c.io, { perf: true }); assert.equal(c.v.reimtags, 'selected');
});
test('V toggles the interface, but not with a modifier, a repeat, typing, or a mark/edit/grab under way', () => {
  assert.equal(chromeKey(key(), false), true);
  assert.equal(chromeKey(key({ ctrlKey: true }), false), false);
  assert.equal(chromeKey(key({ metaKey: true }), false), false);
  assert.equal(chromeKey(key({ altKey: true }), false), false);
  assert.equal(chromeKey(key({ repeat: true }), false), false);
  assert.equal(chromeKey(key(), true), false);
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA']) assert.equal(chromeKey(key({ target: { tagName } }), false), false);
  assert.equal(chromeKey(key({ target: { tagName: 'DIV', isContentEditable: true } }), false), false);
  assert.equal(chromeKey(key({ code: 'KeyB' }), false), false);
});

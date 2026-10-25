import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlHints, hintMode, hintLines, hintRows, statusPills, MAX_CHIPS, VR_CHIPS, type HintCtx } from '../src/hints.ts';

const base: HintCtx = { device: 'desktop', persona: 'patient', nav: 'free', inspect: false, marking: null, editingMarks: false, grabbing: false, selected: false, locked: false, mounted: false };
const ctx = (o: Partial<HintCtx> = {}): HintCtx => ({ ...base, ...o });
const keys = (o: Partial<HintCtx>) => controlHints(ctx(o)).chips.map(k => k.keys.join('+'));

test('priority: marking beats editing, grabbing, selected, inspect, then the walk mode', () => {
  const all = { marking: { kind: 'stairs' as const, step: 1, total: 3 }, editingMarks: true, grabbing: true, selected: true, inspect: true, nav: 'fly' as const };
  assert.equal(hintMode(ctx(all)), 'marking');
  assert.equal(hintMode(ctx({ ...all, marking: null })), 'editing');
  assert.equal(hintMode(ctx({ ...all, marking: null, editingMarks: false })), 'grabbing');
  assert.equal(hintMode(ctx({ ...all, marking: null, editingMarks: false, grabbing: false })), 'selected');
  assert.equal(hintMode(ctx({ nav: 'fly', inspect: true })), 'inspect');
  assert.equal(hintMode(ctx({ nav: 'auto' })), 'route');
  assert.equal(hintMode(ctx({ nav: 'fly' })), 'fly');
  assert.equal(hintMode(ctx()), 'free');
});
test('every state has chips, never more than MAX_CHIPS, and a text label', () => {
  for (const device of ['desktop', 'vr'] as const) for (const nav of ['auto', 'free', 'fly'] as const)
    for (const o of [{}, { selected: true }, { grabbing: true }, { editingMarks: true }, { inspect: true }, { locked: true }, { mounted: true }, { marking: { kind: 'door' as const, step: 2, total: 2 } }]) {
      const h = controlHints(ctx({ device, nav, ...o }));
      assert.ok(h.chips.length > 0 && h.chips.length <= MAX_CHIPS && h.label.length > 0, JSON.stringify([device, nav, o]));
    }
});
test('free walk idle shows the mark keybind; the wheelchair rolls, steers and spins', () => {
  assert.deepEqual(keys({}), ['W+S', 'A+D', 'Mouse', 'C', 'M+1/2']);
  const chair = controlHints(ctx({ persona: 'wheelchair' }));
  assert.equal(chair.label, 'Driving');
  assert.deepEqual(chair.chips.map(k => k.text), ['roll', 'steer', 'spin', 'look', 'mark']);
});
test('marking shows the step and the placing keys; VR uses the controller', () => {
  const m = { marking: { kind: 'stairs' as const, step: 2, total: 3 } };
  assert.equal(controlHints(ctx(m)).label, 'Marking stairs · 2/3');
  assert.deepEqual(keys(m), ['Click', 'Space', 'Shift', 'Ctrl+Z', 'Esc']);
  assert.deepEqual(keys({ ...m, device: 'vr' }), ['Trigger', 'B', 'Grip']);
  assert.equal(controlHints(ctx(m)).tone, 'mark');
});
test('VR: mounted walks along the walker, free walks with sticks, pointing at an object offers move, delete, reset', () => {
  assert.deepEqual(keys({ device: 'vr', mounted: true }).slice(0, 2), ['Stick ↑↓', 'Stick ←→']);
  assert.deepEqual(keys({ device: 'vr' }).slice(0, 2), ['Left stick', 'Right stick']);
  assert.deepEqual(keys({ device: 'vr', selected: true }), ['Trigger', 'Hold A', 'Grip']);
  assert.deepEqual(controlHints(ctx({ device: 'vr', selected: true })).chips.map(k => k.text), ['move', 'delete', 'reset']);
});
test('VR shows at most VR_CHIPS rows, and every VR walk state names the menu', () => {
  for (const nav of ['auto', 'free', 'fly'] as const) for (const o of [{}, { mounted: true }, { selected: true }, { grabbing: true }, { editingMarks: true }, { marking: { kind: 'stairs' as const, step: 1, total: 3 } }])
    assert.ok(controlHints(ctx({ device: 'vr', nav, ...o })).chips.length <= VR_CHIPS, JSON.stringify([nav, o]));
  assert.ok(keys({ device: 'vr' }).includes('Click stick') && keys({ device: 'vr', mounted: true }).includes('Click stick'));
});
test('hint lines: label, then chips on one line; hint rows: one row per chip', () => {
  const h = controlHints(ctx({ device: 'vr', selected: true }));
  const l = hintLines(h);
  assert.equal(l.length, 2); assert.match(l[1], /Trigger move · Hold A delete · Grip reset/);
  assert.deepEqual(hintRows(h).rows, [{ key: 'Trigger', text: 'move' }, { key: 'Hold A', text: 'delete' }, { key: 'Grip', text: 'reset' }]);
  assert.equal(hintRows(h).label, 'Pointing at an object');
});
test('status pills: persona, view, mode, and the marking step first', () => {
  const p = statusPills({ ...ctx(), thirdPerson: false, personaLabel: 'Walker', proposed: false });
  assert.deepEqual(p.map(x => x.text), ['Walker', 'First person', 'Walk', 'Original']);
  const q = statusPills({ ...ctx({ marking: { kind: 'door', step: 1, total: 2 } }), thirdPerson: true, personaLabel: 'Wheelchair', proposed: null });
  assert.equal(q[0].text, 'Marking doorway · 1/2'); assert.equal(q[0].tone, 'mark');
  assert.ok(q.some(x => x.text === 'Third person') && !q.some(x => /Original|Proposed/.test(x.text)));
});
test('look around: parked walker has its own mode, pill and chips; a head turn adds the C chip to walking', () => {
  assert.equal(hintMode(ctx({ parked: true })), 'explore');
  assert.equal(controlHints(ctx({ parked: true })).label, 'Looking around · walker parked');
  assert.equal(statusPills({ ...ctx({ parked: true }), thirdPerson: false, personaLabel: 'Walker', proposed: null })[2].text, 'Look around');
  assert.equal(hintMode(ctx({ parked: true, device: 'vr' })), 'free');
  assert.equal(controlHints(ctx({ mismatch: true })).chips[0].keys[0], 'C');
  assert.ok(controlHints(ctx({ mismatch: true })).chips.length <= MAX_CHIPS);
  assert.equal(statusPills({ ...ctx({ nav: 'fly' }), thirdPerson: false, personaLabel: 'Walker', proposed: null })[2].text, 'Fly · noclip');
});

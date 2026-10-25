import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyIntent, createHistory, type KeyLike, type KeyCtx } from '../src/controls.ts';

const k = (code: string, o: Partial<KeyLike> = {}): KeyLike => ({ code, key: o.key ?? code.replace(/^Key|^Digit/, '').toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
const ctx = (o: Partial<KeyCtx> = {}): KeyCtx => ({ typing: false, grabbing: false, choosing: false, ...o });

test('hotkeys map to intents', () => {
  assert.equal(keyIntent(k('KeyM'), ctx()), 'mark');
  assert.equal(keyIntent(k('KeyX'), ctx()), 'remove');
  assert.equal(keyIntent(k('KeyG'), ctx()), 'grab');
  assert.equal(keyIntent(k('KeyL'), ctx()), 'lock');
  assert.equal(keyIntent(k('KeyC'), ctx()), 'recenter');
  assert.equal(keyIntent(k('KeyP'), ctx()), 'persona');
  assert.equal(keyIntent(k('KeyP'), ctx({ typing: true })), null, 'not while typing in a field');
  assert.equal(keyIntent(k('KeyK'), ctx()), 'vr-toggle');
  assert.equal(keyIntent(k('KeyK'), ctx({ grabbing: true })), null, 'not while carrying an object');
  for (const drive of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) assert.equal(keyIntent(k(drive), ctx()), null, `${drive} stays with the driving keys`);
  assert.equal(keyIntent(k('KeyZ'), ctx()), null, 'plain Z stays with the existing reset handler');
});
test('F1 and ? open the key list, even F1 while typing', () => {
  assert.equal(keyIntent(k('F1', { key: 'F1' }), ctx({ typing: true })), 'help');
  assert.equal(keyIntent(k('Slash', { key: '?', shiftKey: true }), ctx()), 'help');
  assert.equal(keyIntent(k('Slash', { key: '?', shiftKey: true }), ctx({ typing: true })), null);
});
test('typing in a field takes every other key', () => {
  for (const c of ['KeyM', 'KeyX', 'KeyG', 'KeyL']) assert.equal(keyIntent(k(c), ctx({ typing: true })), null);
  assert.equal(keyIntent(k('KeyZ', { ctrlKey: true }), ctx({ typing: true })), null);
});
test('Ctrl/Cmd+Z undoes, +Shift or Y redoes, other chords are left to the browser', () => {
  assert.equal(keyIntent(k('KeyZ', { ctrlKey: true }), ctx()), 'undo');
  assert.equal(keyIntent(k('KeyZ', { metaKey: true }), ctx()), 'undo');
  assert.equal(keyIntent(k('KeyZ', { ctrlKey: true, shiftKey: true }), ctx()), 'redo');
  assert.equal(keyIntent(k('KeyY', { ctrlKey: true }), ctx()), 'redo');
  assert.equal(keyIntent(k('KeyL', { ctrlKey: true }), ctx()), null, 'Ctrl+L focuses the address bar');
  assert.equal(keyIntent(k('KeyG', { ctrlKey: true }), ctx()), null);
});
test('M then 1 or 2 picks the tool; any other key drops the choice', () => {
  assert.equal(keyIntent(k('Digit1'), ctx({ choosing: true })), 'mark-stairs');
  assert.equal(keyIntent(k('Digit2'), ctx({ choosing: true })), 'mark-door');
  assert.equal(keyIntent(k('KeyW'), ctx({ choosing: true })), 'choose-cancel');
  assert.equal(keyIntent(k('Escape'), ctx({ choosing: true })), 'choose-cancel');
  assert.equal(keyIntent(k('Digit1'), ctx()), 'nav-route');
  assert.equal(keyIntent(k('Digit4'), ctx()), 'nav-fly');
  assert.equal(keyIntent(k('Digit2'), ctx({ typing: true })), null);
  assert.equal(keyIntent(k('Digit2'), ctx({ grabbing: true })), null);
});
test('while grabbing: Enter or G drops, Esc cancels, R turns, movement keys pass through', () => {
  const c = ctx({ grabbing: true });
  assert.equal(keyIntent(k('Enter'), c), 'grab-drop');
  assert.equal(keyIntent(k('KeyG'), c), 'grab-drop');
  assert.equal(keyIntent(k('Escape'), c), 'grab-cancel');
  assert.equal(keyIntent(k('KeyR'), c), 'grab-turn');
  assert.equal(keyIntent(k('KeyX'), c), null);
  assert.equal(keyIntent(k('KeyW'), c), null);
});

const snap = (layout: object) => ({ layout });
test('history: undo and redo walk the edits in order', () => {
  const h = createHistory<{ layout: object }>(s => s.layout);
  const a = snap({}), b = snap({}), c = snap({});
  h.record('moved bed', a, b); h.record('removed rug', b, c);
  assert.deepEqual(h.size(), { undo: 2, redo: 0 });
  let r = h.undo(c); assert.ok(r && r !== 'stale' && r.label === 'removed rug' && r.to === b);
  r = h.undo(b); assert.ok(r && r !== 'stale' && r.label === 'moved bed' && r.to === a);
  assert.equal(h.undo(a), null);
  r = h.redo(a); assert.ok(r && r !== 'stale' && r.to === b);
  r = h.redo(b); assert.ok(r && r !== 'stale' && r.to === c);
  assert.equal(h.redo(c), null);
});
test('history: a new edit clears redo; an unchanged layout records nothing', () => {
  const h = createHistory<{ layout: object }>(s => s.layout);
  const a = snap({}), b = snap({}), c = snap({}), same = { layout: a.layout };
  h.record('x', a, same); assert.deepEqual(h.size(), { undo: 0, redo: 0 });
  h.record('moved', a, b); h.undo(b); h.record('removed', a, c);
  assert.deepEqual(h.size(), { undo: 1, redo: 0 });
});
test('history: when the room changed another way, undo refuses and drops the history', () => {
  const h = createHistory<{ layout: object }>(s => s.layout);
  const a = snap({}), b = snap({}), elsewhere = snap({});
  h.record('moved', a, b);
  assert.equal(h.undo(elsewhere), 'stale');
  assert.deepEqual(h.size(), { undo: 0, redo: 0 });
});
test('history keeps at most `limit` edits', () => {
  const h = createHistory<{ layout: object }>(s => s.layout, 3);
  let prev = snap({});
  for (let i = 0; i < 5; i++) { const n = snap({}); h.record(String(i), prev, n); prev = n; }
  assert.equal(h.size().undo, 3);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMarking, place, undo, isComplete, checkAll, preview, edgeFrame, buildLevels, snapZ, moveStairHandle, stairPoints, moveDoorHandle } from '../src/marker.ts';
import type { Stair } from '../src/stairs.ts';

test('marking rejects mistaken points without advancing; undo restores the previous step', () => {
  let m = startMarking('stairs');
  const wrong = place(m, [0, 0, 1]);
  assert.match(wrong.error!, /bottom step/); assert.equal(wrong.m, m);
  m = place(m, [0, 0, 0.18]).m;
  assert.match(place(m, [0.1, 0, 0.18]).error!, /other end/);
  assert.match(place(m, [0.9, 0, 0.6]).error!, /same step/);
  m = place(m, [0.9, 0, 0.18]).m;
  assert.match(place(m, [0.45, 1, 0.18]).error!, /top of the flight/);
  m = place(m, [0.45, 1, 0.9]).m;
  assert.equal(isComplete(m), true);
  assert.equal(undo(m).pts.length, 2); assert.equal(m.pts.length, 3);
  assert.equal(undo(startMarking('door')).pts.length, 0);
});

test('door preview compares jamb width with the walker, and refuses implausible openings', () => {
  const m = place(startMarking('door'), [0, 0, 1]).m;
  assert.ok(place(m, [0.2, 0, 1]).error);
  assert.ok(place(m, [2.1, 0, 1]).error);
  const p = preview(m, [0.7, 0, 1], { eye: [1, -1], need_m: 0.86 });
  assert.equal(p.tags[0].tone, 'bad'); assert.match(p.tags[0].text, /70 cm.*86 cm/);
  assert.equal(isComplete(place(m, [0.9, 0, 1]).m), true);
});

test('left and right preview agree whichever end of the bottom edge is marked first', () => {
  for (const [a, b] of [[[0, 0, 0.18], [0.9, 0, 0.18]], [[0.9, 0, 0.18], [0, 0, 0.18]]] as const) {
    const f = edgeFrame([...a], [...b], [0.45, 2]);
    assert.deepEqual(f.left, [0, 0, 0.18]);
    const pv = preview({ kind: 'stairs', pts: [[...a], [...b]] }, [0.45, 2, 1.44], { eye: [0.45, -1], need_m: 0.86 });
    assert.equal(pv.tags.find(t => t.text === 'LEFT')!.at[0], 0);
    assert.match(pv.tags.at(-1)!.text, /about .*steps/);
  }
});

test('snapping uses supported horizontal surfaces and leaves an unseen height alone', () => {
  const pts = new Float32Array([0, 0, 0.18, 1, 0.01, 0, 0.181, 1, 0.02, 0, 0.182, 1, 0, 0, 0.5, 0.1]);
  const levels = buildLevels(pts);
  assert.ok(Math.abs(snapZ(levels, 0, 0, 0.2)! - 0.181) < 1e-6);
  assert.equal(snapZ(levels, 0, 0, 0.5), null);
  assert.equal(snapZ(levels, 10, 10, 0.18), null);
});

test('editing a handle discards stale measurements but preserves explicit rail and device choices', () => {
  const st: Stair = { name: 's', bottom: [[0, 0], [0.9, 0]], top: [0.45, 1], top_z: 0.72, treads_z: [0.18, 0.36],
    tread_fronts_m: [0, 0.27], tread_depth_m: 0.27, rails: { left: 'wall', right: 'none' }, rails_set: { left: 'seen' }, top_device: 'rollator' };
  const moved = moveStairHandle(st, 'top', [0.45, 2, 1.44]);
  assert.deepEqual(moved.top, [0.45, 2]); assert.equal(moved.top_z, 1.44);
  assert.equal(moved.treads_z, undefined); assert.equal(moved.rails, undefined);
  assert.deepEqual(moved.rails_set, st.rails_set); assert.equal(moved.top_device, 'rollator');
  assert.equal(checkAll('stairs', stairPoints(moved)), null);
  const d = moveDoorHandle({ name: 'd', a: [0, 0], b: [0.8, 0], hinge: 'a' }, 'b', [1, 0, 1]);
  assert.deepEqual(d.b, [1, 0]); assert.equal(d.hinge, undefined);
});

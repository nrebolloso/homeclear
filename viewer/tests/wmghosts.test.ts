// The ghosts' clock: every style is played by walker-centre arc length, so poses must interpolate along it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { arc, caught, poseAtArc } from '../src/wmghosts.ts';

test('arc length and pose lookup along an imagined trip', () => {
  const W: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [1, 1, Math.PI / 2]];
  const d = arc(W);
  assert.deepEqual(d, [0, 1, 2]);
  assert.deepEqual(poseAtArc(W, d, 0.5), [0.5, 0, 0]);
  const p = poseAtArc(W, d, 1.5);
  assert.ok(Math.abs(p[0] - 1) < 1e-9 && Math.abs(p[1] - 0.5) < 1e-9 && Math.abs(p[2] - Math.PI / 4) < 1e-9);
  assert.deepEqual(poseAtArc(W, d, 9), W[2]);   // past the end it waits at the goal
  // yaw takes the short way round (from +170° to -170° is +20°, not -340°)
  const Y: [number, number, number][] = [[0, 0, (170 * Math.PI) / 180], [1, 0, (-170 * Math.PI) / 180]];
  assert.ok(Math.abs(poseAtArc(Y, arc(Y), 0.5)[2] - Math.PI) < 1e-9);
});

test('a toe catch outranks a brush on the same step', () => {
  assert.equal(caught({ heel: [0, 0], side: 1, walker: [0, 0, 0], toe: true, brush: 'chair8' }), 'toe catch');
  assert.equal(caught({ heel: [0, 0], side: 1, walker: [0, 0, 0], toe: false, brush: 'chair8' }), 'chair8');
  assert.equal(caught({ heel: [0, 0], side: 1, walker: [0, 0, 0], toe: false, brush: null }), null);
});

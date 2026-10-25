import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navOf, headingMismatch, nearestStandable, routeResume } from '../src/navmode.ts';

test('navOf: one toolbar mode per state, inspect wins', () => {
  assert.equal(navOf('auto', false), 'route');
  assert.equal(navOf('auto', true), 'route');
  assert.equal(navOf('free', false), 'walk');
  assert.equal(navOf('free', true), 'explore');
  assert.equal(navOf('fly', false), 'fly');
  assert.equal(navOf('fly', true), 'fly');
  assert.equal(navOf('free', false, true), 'inspect');
});
test('headingMismatch: only a clear head turn counts, either way', () => {
  assert.equal(headingMismatch(0), false);
  assert.equal(headingMismatch(0.4), false);
  assert.equal(headingMismatch(-0.6), true);
  assert.equal(headingMismatch(0.6, 1), false);
});
test('nearestStandable: the spot itself, then the closest ring, else null', () => {
  assert.deepEqual(nearestStandable(1, 1, () => true), [1, 1]);
  const p = nearestStandable(0, 0, (x) => x >= 0.3)!;   // floor starts 30 cm to the right
  assert.ok(p && p[0] >= 0.3 && Math.hypot(p[0], p[1]) < 0.45, JSON.stringify(p));
  assert.equal(nearestStandable(0, 0, () => false), null);
  assert.equal(nearestStandable(0, 0, (x) => x >= 2, 1), null);   // beyond maxR
});
test('routeResume: same fraction of the playback length, clamped', () => {
  assert.equal(routeResume(2, 4), 2);
  assert.equal(routeResume(2, 4, 8), 4);
  assert.equal(routeResume(9, 4, 8), 8);
  assert.equal(routeResume(-1, 4), 0);
  assert.equal(routeResume(1, 0), 0);
});

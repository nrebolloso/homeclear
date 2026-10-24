import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMoved, movedText, resetPose, resetHoldProgress, RESET_ALL_HOLD_S } from '../src/resets.ts';

const o = { x: 1, y: 2, yaw: 0 };

test('isMoved: under 1 cm and 0.01 rad is not moved; a move, a turn or a removal is', () => {
  assert.equal(isMoved({ ...o }, o), false);
  assert.equal(isMoved({ x: 1.005, y: 2, yaw: 0.005 }, o), false);
  assert.equal(isMoved({ x: 1.02, y: 2, yaw: 0 }, o), true);
  assert.equal(isMoved({ ...o, yaw: Math.PI / 2 }, o), true);
  assert.equal(isMoved({ ...o, removed: true }, o), true);
});

test('movedText: distance and turn in words, nothing when unmoved', () => {
  assert.equal(movedText({ ...o }, o), '');
  assert.equal(movedText({ x: 2, y: 2, yaw: 0 }, o), 'moved 1.0 m');
  assert.equal(movedText({ ...o, yaw: Math.PI / 2 }, o), 'turned 90°');
  assert.equal(movedText({ x: 1, y: 2.5, yaw: -Math.PI / 2 }, o), 'moved 0.5 m · turned 90°');
  assert.equal(movedText({ x: 1, y: 2, yaw: 2 * Math.PI }, o), '');   // a full turn is no turn
});

test('resetPose: a fresh copy of the original, removed flag gone', () => {
  const p = resetPose(o);
  assert.deepEqual(p, o);
  assert.notEqual(p, o);
  assert.equal('removed' in resetPose({ ...o, removed: true } as any), false);
});

test('resetHoldProgress: both grips held for RESET_ALL_HOLD_S fills the ring; letting go resets it', () => {
  assert.equal(resetHoldProgress(0), 0);
  assert.equal(resetHoldProgress(RESET_ALL_HOLD_S / 2), 0.5);
  assert.equal(resetHoldProgress(RESET_ALL_HOLD_S * 3), 1);
});

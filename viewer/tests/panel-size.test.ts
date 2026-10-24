import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelSnaps, clampPanel, snapPanel, stepPanel, panelMax } from '../src/panel-size.ts';

test('wide steps appear only when they fit in 55% of the window', () => {
  assert.deepEqual(panelSnaps(370, 1920), [370, 480, 640]);
  assert.deepEqual(panelSnaps(370, 1000), [370, 480]);   // 55% = 550
  assert.deepEqual(panelSnaps(370, 700), [370]);          // small window: no widening
  assert.equal(panelMax(1000), 550);
});
test('a dragged width is clamped, then snaps to the nearest step', () => {
  assert.equal(clampPanel(200, 370, 1920), 370);
  assert.equal(clampPanel(5000, 370, 1920), 1056);
  assert.equal(snapPanel(420, 370, 1920), 370);
  assert.equal(snapPanel(440, 370, 1920), 480);
  assert.equal(snapPanel(900, 370, 1920), 640);
  assert.equal(snapPanel(900, 370, 1000), 480);
});
test('keyboard steps walk the snaps and stop at the ends', () => {
  assert.equal(stepPanel(370, 370, 1920, 1), 480);
  assert.equal(stepPanel(480, 370, 1920, 1), 640);
  assert.equal(stepPanel(640, 370, 1920, 1), 640);
  assert.equal(stepPanel(640, 370, 1920, -1), 480);
  assert.equal(stepPanel(370, 370, 1920, -1), 370);
});
test('when the normal width already exceeds a step (narrow layouts), that step is skipped', () => {
  assert.deepEqual(panelSnaps(500, 1920), [500, 640]);
});

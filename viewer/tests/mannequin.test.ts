import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feetAt, type Step } from '../src/mannequin.ts';

test('feet: planted on their last step, swinging with lift toward the next, never behind the start', () => {
  const steps: Step[] = [0, 1, 2, 3, 4].map(k => ({ xy: [k * 0.35, k % 2 ? 0.1 : -0.1], side: k % 2, hit: k === 3, s: k * 0.35 }));
  const [r0, l0] = feetAt(steps, 0, 0.7);
  assert.deepEqual(r0.pos, [0, -0.1, 0]);
  const mid = feetAt(steps, 0.5, 0.7)[0];   // right foot halfway from step 0 to step 2 (s = 0.7)
  assert.ok(mid.pos[0] > 0 && mid.pos[0] < 0.7 && mid.pos[2] > 0, JSON.stringify(mid));
  const planted = feetAt(steps, 0.36, 0.7)[1];   // left just landed on step 1
  assert.deepEqual(planted.pos, [0.35, 0.1, 0]);
  assert.ok(feetAt(steps, 1.05, 0.7)[1].red, 'the step that touched a bump shows red as it lands');
  assert.ok(l0.pos[2] === 0);
});

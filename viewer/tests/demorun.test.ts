import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockstep, demoSeed, MAX_LAG_S, TICK_S } from '../src/demorun.ts';

test('lockstep live clock: banked wall time ticked off between frames, waiting on busy workers, lag capped', async () => {
  let busy = 0, on = true;
  const L = createLockstep(() => busy-- <= 0, () => on), dts: number[] = [], flush = () => new Promise(r => setTimeout(r, 30));
  L.frame(TICK_S / 2, dt => dts.push(dt)); await flush();
  assert.equal(dts.length, 0);                    // not a tick of wall time yet
  L.frame(3.5 * TICK_S, dt => { dts.push(dt); busy = 2; }); await flush();
  assert.deepEqual(dts, [TICK_S, TICK_S, TICK_S, TICK_S]);   // a 15 fps frame still walks 4 ticks, each after the worker answers
  L.frame(10, dt => dts.push(dt)); await flush();
  assert.equal(dts.length, 4 + Math.floor(MAX_LAG_S / TICK_S));   // a long stall is not fast-forwarded
  on = false; L.frame(1, dt => dts.push(dt)); await flush();
  assert.equal(L.ticks(), dts.length);            // off (free walk, manual recorder): no live ticks
});

test('lockstep advance: whole ticks, each after the workers answer', async () => {
  let busy = 0;
  const L = createLockstep(() => busy-- <= 0, () => true), dts: number[] = [];
  await L.advance(1 / 30, dt => { dts.push(dt); busy = 2; });
  assert.deepEqual(dts, [TICK_S, TICK_S]);
});

test('demo seed: only with ?demo=1 or ?seed, the scene config, else 1', () => {
  assert.equal(demoSeed(new URLSearchParams(''), 'kitchen4_lighter'), null);
  assert.equal(demoSeed(new URLSearchParams('seed=42'), 'kitchen4_lighter'), 42);
  assert.equal(demoSeed(new URLSearchParams('seed'), 'no_such_scene'), 1);
  assert.equal(typeof demoSeed(new URLSearchParams('demo=1'), 'kitchen4_lighter'), 'number');
});

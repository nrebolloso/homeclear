import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditLocks } from '../src/edit-locks.ts';
test('held VR objects reject desktop ownership; other objects remain available', () => {
  const locks = createEditLocks(); assert.ok(locks.acquire('chair', 'vr')); assert.equal(locks.acquire('chair', 'desktop'), false);
  assert.ok(locks.acquire('rug', 'desktop')); assert.equal(locks.acquire('*', 'desktop'), false);
  locks.release('chair', 'desktop'); assert.equal(locks.owner('chair'), 'vr'); locks.release('chair', 'vr'); assert.ok(locks.acquire('chair', 'desktop'));
});
test('an edit failure releases its lock and a global change excludes object edits', async () => {
  const locks = createEditLocks(); await assert.rejects(locks.run('chair', 'desktop', () => { throw Error('failed'); })); assert.equal(locks.busy(), false);
  assert.ok(locks.acquire('*', 'desktop')); assert.equal(locks.acquire('chair', 'vr'), false); locks.release('*', 'desktop'); assert.equal(locks.busy(), false);
});

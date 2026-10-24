import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXRComparison, type LayoutSnapshot } from '../src/xrcompare.ts';

function fixture() {
  const prior: LayoutSnapshot = { layout: { poses: [{ x: 1, y: 2, yaw: 0 }], flattened: [], placed: { top: { x: 3, y: 4, yaw: 1 } } }, applied: ['top'] };
  const safer: LayoutSnapshot = { layout: { poses: [{ x: 2, y: 2, yaw: 1 }], flattened: [], added: ['lamp'] }, applied: ['lamp'] };
  let current = structuredClone(prior), context = 'patient', evaluations = 0, previews = 0, ended = 0;
  const c = createXRComparison({ capture: () => current, context: () => context,
    async search() { current = structuredClone(safer); evaluations++; },
    async apply(s) { current = s; evaluations++; }, preview() { previews++; }, endPreview() { ended++; } });
  return { c, prior, safer, get: () => ({ current, evaluations, previews, ended }), change: () => { context = 'cane'; } };
}
test('Restore and Use safer layout apply independent snapshots and recalculate, including placed fixtures and applied fixes', async () => {
  const f = fixture();
  await f.c.button.press(); assert.deepEqual(f.get().current, f.safer);
  assert.equal(f.c.button.text()[0], 'Restore my room');
  await f.c.button.press(); assert.deepEqual(f.get().current, f.prior); assert.equal(f.get().evaluations, 2);
  await f.c.button.press(); assert.deepEqual(f.get().current, f.safer); assert.equal(f.get().evaluations, 3);
  f.get().current.layout.poses[0].x = 99;   // a live edit must not mutate the stored snapshot
  assert.equal(f.prior.layout.poses[0].x, 1);
});
test('visual comparison changes neither layout nor evaluations and explicitly names the active calculations', async () => {
  const f = fixture(); await f.c.button.press();
  f.c.previewButton.press(); f.c.step(1); f.c.step(2);
  assert.deepEqual(f.get().current, f.safer); assert.equal(f.get().evaluations, 1); assert.equal(f.get().previews, 2);
  assert.match(f.c.previewButton.text().join(' '), /Preview: prior room.*Checks and walking: safer layout/);
  f.c.previewButton.press(); f.c.step(3); assert.equal(f.c.previewing(), false); assert.equal(f.get().ended, 1);
  await f.c.button.press(); f.c.previewButton.press(); f.c.step(3);
  assert.deepEqual(f.get().current, f.prior); assert.equal(f.get().evaluations, 2);
  assert.match(f.c.previewButton.text().join(' '), /Preview: safer room.*Checks and walking: prior layout/);
});
test('persona or manual-layout changes invalidate the cached comparison rather than restoring stale edits', async () => {
  const f = fixture(); await f.c.button.press(); f.c.previewButton.press(); f.c.step(1);
  f.change(); assert.equal(f.c.button.text()[0], 'See a safer room'); assert.equal(f.c.previewing(), false);
  assert.equal(f.c.state().hasComparison, false);
  const edited = fixture(); await edited.c.button.press(); edited.get().current.layout.poses[0].x += 0.2;
  assert.equal(edited.c.button.text()[0], 'See a safer room'); assert.equal(edited.c.state().hasComparison, false);
});
test('an unchanged search never calls a room safe; a failed search can be retried', async () => {
  const s: LayoutSnapshot = { layout: { poses: [], flattened: [] }, applied: [] };
  let fail = true;
  const c = createXRComparison({ capture: () => s, context: () => '', async search() { if (fail) throw Error('worker failed'); },
    async apply() {}, preview() {}, endPreview() {} });
  await c.button.press(); assert.equal(c.button.text()[0], 'Retry safer layout');
  fail = false; await c.button.press(); assert.equal(c.button.text()[0], 'No suggested changes');
  assert.equal(c.button.text().join(' ').includes('already safe'), false);
});

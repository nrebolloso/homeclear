import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceAt, ringPages, STICK_DEAD } from '../src/xrradial.ts';

test('sliceAt: slice 0 is straight up, the rest clockwise; a centred stick picks nothing', () => {
  assert.equal(sliceAt(0, -1, 4), 0);   // pushed forward (WebXR y is negative forward)
  assert.equal(sliceAt(1, 0, 4), 1);    // right
  assert.equal(sliceAt(0, 1, 4), 2);    // pulled back
  assert.equal(sliceAt(-1, 0, 4), 3);   // left
  assert.equal(sliceAt(0, 0, 4), -1);
  assert.equal(sliceAt(STICK_DEAD * 0.9, 0, 4), -1);
  assert.equal(sliceAt(0.7, -0.7, 8), 1);   // up-right of eight
  assert.equal(sliceAt(-0.05, -1, 5), 0);   // just left of up still rounds to the top slice
  assert.equal(sliceAt(1, 0, 0), -1);
});

test('ringPages: the story plus "More", then the rest plus "Back"; one page when everything fits', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepEqual(ringPages(items, 4, 'More', 'Back'), [['a', 'b', 'c', 'd', 'More'], ['e', 'f', 'Back']]);
  assert.deepEqual(ringPages(items, 6, 'More', 'Back'), [items]);
  assert.deepEqual(ringPages(items, 99, 'More', 'Back'), [items]);
});

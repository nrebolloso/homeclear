import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceAt, subPage, shortOf, STICK_DEAD, type RingItem } from '../src/xrradial.ts';

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

test('subPage: a second ring is its items then Back, so Back is the last slice clockwise', () => {
  assert.deepEqual(subPage(['a', 'b', 'c'], 'Back'), ['a', 'b', 'c', 'Back']);
  assert.deepEqual(subPage([], 'Back'), ['Back']);
  // an odd count of items puts Back (the last slice) at the bottom of the ring
  const ring = subPage(['a', 'b', 'c'], 'Back');
  assert.equal(sliceAt(0, 1, ring.length), ring.indexOf('Back') - 1);
});

test('shortOf: short() wins, else the title up to a colon', () => {
  const btn = (text: string, short?: string): RingItem =>
    ({ text: () => [text], press: () => {}, ...(short ? { short: () => short } : {}) });
  assert.equal(shortOf(btn('Vision: Cataract')), 'Vision');
  assert.equal(shortOf(btn('Average vs Shuffler', 'Walkers')), 'Walkers');
  assert.equal(shortOf(btn('Fan')), 'Fan');
});

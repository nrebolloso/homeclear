import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripSize, STRIP_MIN_W, STRIP_PAD, STRIP_HEAD_PX, STRIP_ROW_PX, M_PER_PX } from '../src/xrstrip.ts';

test('strip: height is the header plus one row per action; width follows the widest row but never goes under the minimum', () => {
  const s = stripSize([{ keyW: 150, textW: 120 }, { keyW: 90, textW: 200 }, { keyW: 100, textW: 80 }], 300);
  assert.equal(s.h, STRIP_PAD * 2 + STRIP_HEAD_PX + 3 * STRIP_ROW_PX);
  assert.equal(s.w, STRIP_MIN_W + STRIP_PAD * 2);
  assert.equal(stripSize([{ keyW: 400, textW: 300 }], 100).w, 724 + STRIP_PAD * 2);
  assert.equal(stripSize([], 700).w, 700 + STRIP_PAD * 2);
});
test('strip: a row reads at least 3 cm tall and the card stays under 35 cm wide for ordinary rows', () => {
  assert.ok(STRIP_ROW_PX * M_PER_PX >= 0.03);
  assert.ok(stripSize([{ keyW: 330, textW: 130 }], 330).w * M_PER_PX < 0.35);   // 'Hold stick click' + 'menu'
});

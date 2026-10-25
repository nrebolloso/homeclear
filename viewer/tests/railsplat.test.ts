import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barSplats, railSplats, toneOf, fitRail, overNosing, NEUTRAL_RAIL } from '../src/railsplat.ts';
import { SPLAT_STRIDE, mirrorRail, type Stair } from '../src/stairs.ts';

// stair facing up +y, width 0.9 (x 0..0.9), run 2.7 m
const st: Stair = { name: 'stairs', bottom: [[0.9, 0], [0, 0]], top: [0.45, 2.7], treads_z: [0.18, 0.54, 0.9, 1.26, 1.62, 1.98], tread_fronts_m: [0, 0.54, 1.08, 1.62, 2.16, 2.7], tread_depth_m: 0.27, width_m: 0.9, rails: { left: 'seen', right: 'wall', height_m: { left: 0.9 } }, measured: 'tape' } as Stair;
const rec = (i: number) => (a: Float32Array) => [...a.slice(i * SPLAT_STRIDE, (i + 1) * SPLAT_STRIDE)];

test('barSplats: a dense run along the bar, elongated along it, in the given colour', () => {
  const m = barSplats([[0, 0, 1], [1, 0, 1]], 0.02, [0.5, 0.4, 0.3]);
  assert.ok(m.length / SPLAT_STRIDE > 200, 'dense enough to read as one bar');
  const r = rec(0)(m);
  assert.ok(r[3] > r[4] && r[3] > r[5], 'stretched along the bar');
  for (let i = 0; i < m.length; i += SPLAT_STRIDE) {
    assert.ok(m[i] >= -1e-6 && m[i] <= 1 + 1e-6 && Math.abs(m[i + 2] - 1) <= 0.02 && Math.abs(m[i + 1]) <= 0.02, 'stays on the bar');
    assert.ok(Math.abs(Math.hypot(m[i + 6], m[i + 7], m[i + 8], m[i + 9]) - 1) < 1e-5, 'unit quaternion');
    assert.ok(m[i + 11] <= 0.5 * 1.1 + 1e-6 && m[i + 11] >= 0.5 * 0.7 - 1e-6, 'shaded around the tone');
  }
  assert.ok(barSplats([[0, 0, 0.7], [0, 0, 1.2]], 0.018, NEUTRAL_RAIL).length > 0, 'a vertical bar works too');
});

test('railSplats: flight, level returns and wall brackets, on the requested side', () => {
  const t = 0.36, m = railSplats(st, { t, z: overNosing(st, 0.9), tone: NEUTRAL_RAIL });
  let lo = Infinity, hi = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < m.length; i += SPLAT_STRIDE) { lo = Math.min(lo, m[i]); hi = Math.max(hi, m[i]); ymin = Math.min(ymin, m[i + 1]); ymax = Math.max(ymax, m[i + 1]); }
  assert.ok(ymin < -0.25 && ymax > 2.7 + 0.25, 'returns run 30 cm past each end');
  assert.ok(lo >= 0.45 - 0.45 - 0.01 && hi <= 0.9 + 0.01, 'inside the flight width, brackets reaching the wall');
  const flightOnly = railSplats(st, { t, z: overNosing(st, 0.9), tone: NEUTRAL_RAIL, returns: false }), ext = railSplats(st, { t, z: overNosing(st, 0.9), tone: NEUTRAL_RAIL, flight: false });
  assert.ok(flightOnly.length > 0 && ext.length > 0 && flightOnly.length + ext.length === m.length);
});

test('a scanned rail: its colour, side and height line carry into the designed copy', () => {
  const src: number[] = [];
  for (let k = 0; k < 40; k++) { const y = 0.2 + k * 0.06; src.push(0.02, y, 0.18 + (0.36 / 0.54) * y + 0.9, 0.02, 0.01, 0.01, 0, 0, 0, 1, 0.9, 0.2, 0.3, 0.4); }
  const s = new Float32Array(src), tone = toneOf(s);
  assert.deepEqual(tone.map(v => +v.toFixed(2)), [0.2, 0.3, 0.4]);
  assert.deepEqual(toneOf(new Float32Array(0)), NEUTRAL_RAIL);
  const m = mirrorRail(s, st, 'left'), fit = fitRail(m, st);
  assert.ok(fit.t < 0, 'copy on the right (negative t)');
  assert.ok(Math.abs(fit.z(1.5) - fit.z(0.5) - (0.36 / 0.54)) < 0.01, 'same slope as the scanned rail');
});

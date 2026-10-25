import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTube, sampleBox, sampleShapes, BAKE_STRIDE, type BakeTube, type BakeBox } from '../src/bake.ts';

const rows = (a: number[] | Float32Array) => Array.from({ length: a.length / BAKE_STRIDE }, (_, i) => Array.from(a).slice(i * BAKE_STRIDE, (i + 1) * BAKE_STRIDE));
const tube: BakeTube = { kind: 'tube', a: [0, 0, 1], b: [2, 0, 1.5], r: 0.022, color: [0.18, 0.84, 0.78] };

test('a tube becomes Gaussians that hug its axis, in the splat layout, with unit rotations', () => {
  const g = rows(sampleTube(tube)), L = Math.hypot(2, 0.5);
  assert.ok(g.length > 200 && g.length < 4000, `${g.length} Gaussians`);
  for (const r of g) {
    assert.equal(r.length, BAKE_STRIDE);
    const [x, y, z, , , , qx, qy, qz, qw, op] = r;
    // distance from the axis a->b stays within the tube radius
    const s = Math.max(0, Math.min(1, (x * 2 + (z - 1) * 0.5) / (L * L))), d = Math.hypot(x - 2 * s, y, z - 1 - 0.5 * s);
    assert.ok(d <= tube.r + 1e-6, `off the tube by ${d}`);
    assert.ok(Math.abs(Math.hypot(qx, qy, qz, qw) - 1) < 1e-6);
    assert.ok(op > 0.9 && op <= 1);
  }
});

test('a tube is long along its own axis: the Gaussian turned by its rotation points down the tube', () => {
  const [r] = rows(sampleTube(tube, 0.05)), [, , , sx, sy, sz, qx, qy, qz, qw] = r;
  assert.ok(sx > sy && sx > sz);
  // rotate local x by q: the first column of the rotation matrix
  const ax = 1 - 2 * (qy * qy + qz * qz), ay = 2 * (qx * qy + qz * qw), az = 2 * (qx * qz - qy * qw), u = [2, 0, 0.5].map(v => v / Math.hypot(2, 0.5));
  assert.ok(Math.abs(ax * u[0] + ay * u[1] + az * u[2]) > 0.999, [ax, ay, az].join());
});

test('the lit side of a tube is brighter than the shaded one', () => {
  const g = rows(sampleTube(tube)), top = g.filter(r => r[2] > 1.0 + 0.5 * (r[0] / 2) + 0.012), under = g.filter(r => r[2] < 1.0 + 0.5 * (r[0] / 2) - 0.012);
  const mean = (a: number[][]) => a.reduce((s, r) => s + r[11], 0) / a.length;
  assert.ok(mean(top) > mean(under) * 1.15, `${mean(top)} vs ${mean(under)}`);
});

test('a flat strip on a tread: top face dominates, flat Gaussians, turned with the stair', () => {
  const box: BakeBox = { kind: 'box', c: [3, -1, 0.35], half: [0.02, 0.4, 0.003], yaw: Math.PI / 2, color: [1, 0.78, 0.24] };
  const g = rows(sampleBox(box));
  assert.ok(g.length > 100 && g.length < 3000, `${g.length}`);
  const top = g.filter(r => Math.abs(r[2] - (0.35 + 0.003)) < 1e-6);
  assert.ok(top.length > g.length * 0.6, `${top.length} of ${g.length} on top`);   // the two long edges (0.6 cm tall) are most of the rest
  // yaw 90 deg: the strip's length (local y, +-0.4) runs along world x, its width (+-0.02) along world y
  const xs = top.map(r => r[0]), ys = top.map(r => r[1]);
  assert.ok(Math.min(...xs) > 3 - 0.4 - 0.02 && Math.max(...xs) < 3 + 0.4 + 0.02);
  assert.ok(Math.min(...ys) > -1 - 0.03 && Math.max(...ys) < -1 + 0.03);
  assert.ok(top.every(r => r[5] < 0.005), 'the top face Gaussians are flat along z');
});

test('shapes concatenate into one array and an empty list is empty', () => {
  const a = sampleTube(tube).length, b = sampleBox({ kind: 'box', c: [0, 0, 0], half: [0.02, 0.1, 0.003], yaw: 0, color: [1, 1, 1] }).length;
  assert.equal(sampleShapes([tube, { kind: 'box', c: [0, 0, 0], half: [0.02, 0.1, 0.003], yaw: 0, color: [1, 1, 1] }]).length, a + b);
  assert.equal(sampleShapes([]).length, 0);
});

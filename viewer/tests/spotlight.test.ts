// Hazard spotlights: which hazards to point at (measured vs proposed kept apart) and the height overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spots, vantage, heightRGB, heightTexels } from '../src/spotlight.ts';
import type { GridMeta, XY } from '../src/grid.ts';

const objects = [{ name: 'bed' }, { name: 'rug' }, { name: 'cable' }];
const hz = [
  { type: 'floor_bump', name: 'rug', position: [2, 1] as XY, height_m: 0.015, per_month: 1.2 },
  { type: 'floor_bump', name: 'cable', position: [3, 1] as XY, height_m: 0.006, per_month: 0.3, estimated: true },
  { type: 'tight_clearance', name: 'doorway', position: [4, 1] as XY, min_side_clearance_m: 0.05 },
];

test('measured spots: the worst bump first, bumps tied to their object, gaps to none', () => {
  const s = spots(hz, objects, [], 0.012);
  assert.deepEqual(s.map(x => x.kind), ['measured', 'measured', 'measured']);
  assert.equal(s[0].label, 'rug 1.5 cm ±1.2');
  assert.equal(s[0].object, 1);
  assert.equal(s[0].severity, 1);
  const cable = s.find(x => x.label.startsWith('cable'))!;
  assert.match(cable.label, /~0\.6 cm \(est\.\)/, 'an estimated height is marked, no range on a typical value');
  assert.equal(cable.object, 2);
  const gap = s.find(x => x.label.endsWith('cm/side'))!;
  assert.equal(gap.object, -1);
  assert.ok(gap.severity > 0.9, 'a 5 cm gap glows hard');
  assert.deepEqual(s.map(x => x.severity), [...s.map(x => x.severity)].sort((a, b) => b - a));
});

test('Cosmos Reason: dismissed are dropped, confirmed ones merge into the spot they agree with, the rest stay proposed', () => {
  const reason = [
    { source: 'cosmos_reason', type: 'rug', position_m: [2.1, 1.05, 0], verdict: 'confirmed', measured: 'rug 1.5 cm', note: 'rug edge curls up' },
    { source: 'cosmos_reason', type: 'cable', position_m: [0.5, 0.5, 0], verdict: 'dismissed', note: 'floor is clear' },
    { source: 'cosmos_reason', type: 'grab_bar', position_m: [1, 2, 0.8], verdict: 'unmeasurable', note: 'no grab bar by the toilet' },
    { source: 'cosmos_reason', type: 'clutter', position_m: [3.5, 2, 0], verdict: 'confirmed', measured: 'shoes, 4 cm', note: 'shoes by the door' },
    { source: 'geometry', type: 'floor_bump', position_m: [9, 9, 0], verdict: 'confirmed' },
  ];
  const s = spots(hz, objects, reason);
  assert.equal(s.filter(x => x.kind === 'measured').length, 3);
  assert.match(s.find(x => x.kind === 'measured' && x.object === 1)!.detail, /Cosmos Reason also flagged it: rug edge curls up/);
  const prop = s.filter(x => x.kind !== 'measured');
  assert.deepEqual(prop.map(x => x.kind).sort(), ['reason-confirmed', 'reason-ot']);
  assert.ok(prop.every(x => /proposed/.test(x.label) && /proposed by Cosmos Reason/.test(x.detail)), 'always labelled as proposed');
  assert.ok(!s.some(x => x.detail.includes('floor is clear')), 'dismissed is not shown');
});

test('vantage: stand back along the route, look at the hazard, pitch down', () => {
  const route: XY[] = [[0, 0], [1, 0], [2, 0], [3, 0]];
  const v = vantage([2, 0.2], route, 1.5, 0.9);
  assert.ok(Math.abs(v.x - 0.5) < 1e-9 && Math.abs(v.y - 0.2) < 1e-9 && v.z === 0.9);
  assert.ok(Math.abs(v.yaw) < 1e-9, 'looking along +x');
  assert.ok(v.pitch < 0 && Math.abs(v.pitch - Math.atan2(-0.85, 1.5)) < 1e-9);
  assert.doesNotThrow(() => vantage([1, 1], [[0, 0]], 1, 1));
});

test('height colours run cool to amber to red; texels: bump cells only, estimated ones hatched', () => {
  const [r0, , b0] = heightRGB(0.001), [r1, g1, b1] = heightRGB(0.01), [r2, g2] = heightRGB(0.05);
  assert.ok(b0 > 200 && r0 < 120, 'low is blue');
  assert.ok(r1 > 200 && g1 > 150 && b1 < 160, 'a centimetre is amber');
  assert.equal(r2, 255);
  assert.ok(g2 < g1, 'tall is red');
  const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.02, shape: [4, 3] };
  const bump = new Float32Array(12), est = new Uint8Array(12);
  bump[1 * 3 + 2] = 0.015;                       // cell i=1, j=2
  bump[2 * 3 + 0] = 0.006; est[2 * 3 + 0] = 1;   // i=2, j=0 (i + j even: not hatched)
  bump[3 * 3 + 0] = 0.001;                       // under 3 mm: no overlay
  const t = heightTexels(g, bump, est);
  const at = (i: number, j: number) => Array.from(t.slice((j * 4 + i) * 4, (j * 4 + i) * 4 + 4));
  assert.equal(at(1, 2)[3], 170);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(3, 0), [0, 0, 0, 0]);
  assert.equal(at(2, 0)[3], 170, 'estimated, even parity: solid');
  est[1 * 3 + 2] = 1;
  assert.deepEqual(Array.from(heightTexels(g, bump, est).slice((2 * 4 + 1) * 4, (2 * 4 + 1) * 4 + 4)), [200, 90, 255, 150], 'estimated, odd parity: hatch');
});

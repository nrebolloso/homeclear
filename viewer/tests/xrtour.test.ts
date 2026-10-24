import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainSpot, tourStand } from '../src/xrtour.ts';
import type { Spot } from '../src/spotlight.ts';

const spot = (o: Partial<Spot>): Spot => ({ id: 's', kind: 'measured', xy: [0, 0], label: '', detail: '', severity: 1, object: -1, ...o });

test('plainSpot: bumps, cords and squeezes in plain words; proposals are never given a number', () => {
  assert.deepEqual(plainSpot(spot({ detail: 'rug: 1.5 cm edge, 0.19 toe contacts/month', measured_height_m: 0.015 })),
    { title: 'Rug, 1.5 cm', why: 'A walker wheel or a toe can catch on it' });
  assert.equal(plainSpot(spot({ detail: 'cable: thin cord, height is a typical value', measured_height_m: 0.006 })).title, 'Cable: a cord on the floor');
  assert.equal(plainSpot(spot({ detail: 'tight gap: 7 cm each side of the walker' })).title, 'Tight squeeze, 7 cm each side');
  const r = plainSpot(spot({ kind: 'reason-ot', detail: 'loose mat · proposed by Cosmos Reason, not measurable from the splat' }));
  assert.equal(r.title, 'Something to check (not measured)');
  assert.ok(!/\d/.test(r.title + r.why));
});

test('tourStand: back along the route, facing the hazard; around it when that spot is not standable; null if nothing is', () => {
  const route: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0]];
  const s = spot({ xy: [2, 0] });
  const a = tourStand(s, route, () => true)!;
  assert.ok(Math.abs(a.x - 0.8) < 1e-9 && Math.abs(a.y) < 1e-9 && Math.abs(a.yaw) < 1e-9, JSON.stringify(a));   // 1.2 m back, looking +x
  const b = tourStand(s, route, (x, y) => y > 0.5)!;   // only the far side of the route is floor
  assert.ok(b.y > 0.5 && Math.abs(Math.atan2(s.xy[1] - b.y, s.xy[0] - b.x) - b.yaw) < 1e-9, JSON.stringify(b));
  assert.equal(tourStand(s, route, () => false), null);
});

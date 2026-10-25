// Move effort v1 (solid, one-piece objects): monotone in mass, distance and turn, never NaN, on the optimizer's scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveEffort, estimateMass, objectEffort, DEFAULT_MASS_KG, KIND_MASS, NEVER_MOVE, TWO_PERSON_KG, NOT_CARRIED, ACTION_EFFORT, interventionEffort, effortKind, type MoveInput } from '../src/effort.ts';
import { existsSync, readFileSync } from 'node:fs';

const ns = (o: Partial<MoveInput> = {}) => moveEffort({ kind: 'nightstand', distance_m: 1, turn_deg: 0, ...o });

test('more mass, distance or turn never makes a move easier', () => {
  for (let d = 0; d < 5; d += 0.5) assert.ok(ns({ distance_m: d + 0.5 }).effort >= ns({ distance_m: d }).effort);
  for (let kg = 0; kg < 100; kg += 5) assert.ok(ns({ mass_kg: kg + 5 }).effort > ns({ mass_kg: kg }).effort);
  assert.ok(ns({ turn_deg: 90 }).effort > ns().effort && ns({ turn_deg: 180 }).effort > ns({ turn_deg: 90 }).effort);
  assert.equal(ns({ turn_deg: 270 }).effort, ns({ turn_deg: 90 }).effort);
});

test('a bed is always more effort than a nightstand over the same move', () => {
  for (const d of [0, 0.5, 1.5, 3]) for (const turn_deg of [0, 90, 180])
    assert.ok(moveEffort({ kind: 'bed', distance_m: d, turn_deg }).effort > moveEffort({ kind: 'nightstand', distance_m: d, turn_deg }).effort);
});

test('two people above the mass threshold, with the minutes floor', () => {
  const bed = moveEffort({ kind: 'bed', distance_m: 1, turn_deg: 0 });
  assert.equal(bed.people, 2);
  assert.ok(bed.explain.includes('needs two people: heavy'));
  assert.equal(moveEffort({ kind: 'x', mass_kg: TWO_PERSON_KG, distance_m: 0, turn_deg: 0 }).people, 1);
  const heavyLight = moveEffort({ kind: 'x', mass_kg: TWO_PERSON_KG + 1, distance_m: 0, turn_deg: 0 });
  assert.ok(heavyLight.people === 2 && heavyLight.minutes >= 30);
});

test('zero distance and turn is the base cost; bad input never gives NaN or negatives', () => {
  for (const [kind, kg] of Object.entries(DEFAULT_MASS_KG)) if (!NOT_CARRIED.has(kind) && kind !== 'trash_can') assert.equal(moveEffort({ kind, distance_m: 0, turn_deg: 0 }).effort, 1 + kg / 20);
  for (const m of [{ distance_m: -2, turn_deg: -90 }, { distance_m: NaN, turn_deg: NaN }, { distance_m: 0, turn_deg: 720, mass_kg: -5 }]) {
    const r = moveEffort({ kind: 'bed', ...m });
    assert.ok(Number.isFinite(r.effort) && r.effort > 0 && Number.isFinite(r.minutes) && r.minutes > 0, JSON.stringify(m));
  }
  assert.equal(moveEffort({ kind: 'unknown', distance_m: 0, turn_deg: 0 }).effort, 1 + DEFAULT_MASS_KG.other / 20);
});

test('calibration: on the scale the optimizer lambdas expect', () => {
  const n = ns().effort, b = moveEffort({ kind: 'bed', distance_m: 1.5, turn_deg: 90 }).effort;
  assert.ok(n >= 1.5 && n <= 4, `nightstand 1 m: ${n}`);
  assert.ok(b >= 5 && b <= 12, `bed 1.5 m turned 90°: ${b}`);
});

test('mass from measured size: bigger box more mass, out of range is clamped and flagged, no size falls back', () => {
  const sq = (s: number) => [[0, 0], [s, 0], [s, s], [0, s]];
  const small = estimateMass({ kind: 'nightstand', footprint: sq(0.4), height_m: 0.5 });
  const big = estimateMass({ kind: 'nightstand', footprint: sq(0.5), height_m: 0.6 });
  assert.ok(big.mass_kg > small.mass_kg && small.from_size && !small.flagged);
  const huge = estimateMass({ kind: 'table', footprint: sq(3), height_m: 1 });
  assert.ok(huge.flagged && huge.mass_kg === KIND_MASS.table.max);
  assert.deepEqual(estimateMass({ kind: 'bed' }), { mass_kg: DEFAULT_MASS_KG.bed, from_size: false, flagged: false, explain: `about ${DEFAULT_MASS_KG.bed} kg (guess by kind)` });
  assert.ok(NEVER_MOVE.has('bed') && !NEVER_MOVE.has('chair'));
});

test('object tags: chair Easy, nightstand Moderate, bed stays put, rug mass only, config wins', () => {
  assert.equal(objectEffort({ kind: 'chair' }).difficulty, 'Easy');
  assert.equal(objectEffort({ kind: 'nightstand' }).difficulty, 'Moderate');
  const bed = objectEffort({ kind: 'bed' });
  assert.ok(!bed.movable && bed.tag.endsWith('stays put') && bed.difficulty === undefined);
  assert.equal(objectEffort({ kind: 'bed', movable: true }).difficulty, 'Hard');
  assert.equal(objectEffort({ kind: 'rug' }).tag, `≈ ${DEFAULT_MASS_KG.rug} kg (guess)`);
  assert.equal(objectEffort({ kind: 'table', mass_kg: 30 }).people, 2);
  assert.ok(objectEffort({ kind: 'table', footprint: [[0, 0], [3, 0], [3, 3], [0, 3]], height_m: 1 }).tag.endsWith('check in person'));
});

// review: mat/cord fixes are actions, hollow things are light, and the order is mat/cord < chair < trash can < table
const carry = (o: { kind: string; name?: string; mass_kg?: number }) => moveEffort({ ...o, distance_m: 1, turn_deg: 0 }).effort;
test('effort order by default mass: mat/cord < chair < trash can < table', () => {
  const mat = carry({ kind: 'rug', name: 'mat' }), cord = interventionEffort({ kind: 'flatten', effort: 1 });
  assert.equal(mat, ACTION_EFFORT); assert.equal(cord, ACTION_EFFORT);
  assert.ok(Math.max(mat, cord) < carry({ kind: 'chair' }) && carry({ kind: 'chair' }) < carry({ kind: 'other', name: 'trash_can' })
    && carry({ kind: 'other', name: 'trash_can' }) < carry({ kind: 'other', name: 'table' }));
});
test("an 'other' label takes its kind from the name only when the name is a known kind", () => {
  assert.equal(effortKind({ kind: 'other', name: 'chair2' }), 'chair'); assert.equal(effortKind({ kind: 'other', name: 'box3' }), 'other');
  assert.equal(effortKind({ kind: 'nightstand', name: 'table' }), 'nightstand');
});
test('hollow things stay light whatever their box', () => {
  const big = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.ok(estimateMass({ kind: 'other', name: 'basket', footprint: big, height_m: 1.3 }).mass_kg <= 3);
  assert.ok(estimateMass({ kind: 'chair', footprint: big, height_m: 1 }).mass_kg <= 7);
});
const K4 = 'public/scene/kitchen4_lighter/scene.json';
test('kitchen4_lighter: mat < chair < trash can < table from the measured boxes', { skip: !existsSync(K4) }, () => {
  const objs: any[] = JSON.parse(readFileSync(K4, 'utf8')).objects, by = (n: string) => objs.find(o => o.name === n);
  const e = (n: string) => carry({ ...by(n), mass_kg: objectEffort(by(n)).mass_kg });
  const chairs = objs.filter(o => effortKind(o) === 'chair').map(o => e(o.name));
  assert.ok(e('mat') < Math.min(...chairs) && Math.max(...chairs) < e('trash_can') && e('trash_can') < e('table'));
});

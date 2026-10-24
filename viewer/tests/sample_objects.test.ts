// SYNTHETIC sample-object scene (tests/make_sample_objects.py -> public/scene/sample_objects, git-ignored): every object
// kind gets the footprint, height, layer and bump class that stage 12 and stage 6 should give it. Nothing here is measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { stamp, bumpComponents, toCell, polyCells, worldFootprint } from '../src/grid.ts';
import { loadScene } from './scene.ts';

const HAVE_SAMPLE =existsSync(new URL('../public/scene/sample_objects/scene.json', import.meta.url));
const skip = HAVE_SAMPLE ? false : 'scene not generated: .venv/Scripts/python.exe tests/make_sample_objects.py';

const S = () => loadScene('sample_objects');
const at = (g: { origin_xy: number[]; shape: number[]; cell_m: number }, x: number, y: number) => { const [i, j] = toCell(g as any, [x, y]); return i * g.shape[1] + j; };

test('each object kind: layer, height and footprint area (SYNTHETIC boxes)', { skip }, () => {
  const { sc } = S();
  const o = Object.fromEntries(sc.objects.map((x: any) => [x.name, x]));
  const area = (x: any) => { const p = x.footprint; let a = 0; for (let k = 0; k < p.length; k++) a += p[k][0] * p[(k + 1) % p.length][1] - p[(k + 1) % p.length][0] * p[k][1]; return Math.abs(a) / 2; };
  // [name, kind, layer, true height (m), true footprint (m^2)]: the footprint comes from the Gaussians that were cut, so a
  // few cm of blur on each side is expected; the sides of a chair and a table also sit past their boxes by the cut margin
  for (const [name, kind, layer, h, a] of [['chair', 'chair', 'obstacle', 0.95, 0.45 * 0.45], ['table', 'other', 'obstacle', 0.45, 0.9 * 0.5],
    ['bed', 'bed', 'obstacle', 0.55, 1.6 * 2.05], ['rug', 'rug', 'bump', 0.015, 1.1 * 1.4], ['rug_curl', 'rug', 'bump', 0.023, 0.15 * 0.15],
    ['nightlight', 'nightlight', 'none', 0.2, 0.1 * 0.1], ['door', 'door', 'obstacle', 2.05, 0.74 * 0.06]] as const) {
    assert.equal(o[name].kind, kind, name); assert.equal(o[name].layer, layer, name);
    assert.ok(Math.abs(o[name].height_m - h) < 0.01, `${name} height ${o[name].height_m} vs ${h}`);
    assert.ok(area(o[name]) > 0.6 * a && area(o[name]) < 1.8 * a + 0.02, `${name} footprint ${area(o[name]).toFixed(3)} m2 vs ${a.toFixed(3)}`);
  }
  assert.ok(o.rug_curl.height_m > o.rug.height_m + 0.005, 'the curled corner is taller than the rug');
});

test('thin things are ESTIMATED, wide ones are MEASURED: cable and 5 cm strip vs the 12 cm threshold', { skip }, () => {
  const { init } = S(), { g, base, est } = init;
  const cable = at(g, 3.64, 1.5), strip = at(g, 0.925, 0.9), sill = at(g, 4.0, 1.5);
  assert.equal(est[cable], 1); assert.ok(Math.abs(base.bump[cable] - 0.006) < 1e-4, 'cable: the config typical height, not 5 mm');
  assert.equal(est[strip], 1); assert.ok(Math.abs(base.bump[strip] - 0.006) < 1e-4, '5 cm strip: thin, so ESTIMATED too');
  assert.equal(est[sill], 0); assert.ok(Math.abs(base.bump[sill] - 0.012) < 0.002, `12 cm threshold: measured ${base.bump[sill]}`);
});

test('bump patches: the curl joins the rug, the cable, the strip and the sill are their own', { skip }, () => {
  const { init, poses } = S(), { g } = init;
  const L = stamp(g, init.base, init.objects, poses);
  const c = bumpComponents(g, L.bump, init.rules.bump_min_m, init.rules.bump_link_cells);
  const id = (x: number, y: number) => c[at(g, x, y)];
  assert.ok(id(3.0, 1.5) > 0 && id(3.0, 1.5) === id(3.43, 2.22), 'rug and its curled corner are one patch');
  const ids = [id(3.0, 1.5), id(3.64, 1.5), id(0.925, 0.9), id(4.0, 1.5)];
  assert.ok(ids.every(Boolean) && new Set(ids).size === 4, `rug / cable / strip / sill are four patches: ${ids}`);
  assert.ok(Math.abs(L.bump[at(g, 3.43, 2.22)] - 0.023) < 0.003, 'the curl stamps at its own, taller height');
});

test('the movable objects are cut out of the base layers (nothing left behind to trap a moved object)', { skip }, () => {
  const { init, poses } = S(), { g, base } = init;
  init.objects.forEach((o, k) => {
    if (o.layer === 'none') return;
    for (const cell of polyCells(g, worldFootprint(o, poses[k])))
      if (o.layer === 'obstacle') assert.equal(base.obst[cell], 0, `${o.name}: obstacle left in the base layer`);
  });
});

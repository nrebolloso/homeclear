import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edt, plan, stamp, routeHazards, bumpComponents, placementOk, type Layers, type GridMeta } from '../src/grid.ts';
import { rollouts, contactProb } from '../src/sim.ts';

const load = (run: string) => {
  const d = new URL(`../public/scene/${run}/`, import.meta.url);
  const sc = JSON.parse(readFileSync(new URL('scene.json', d), 'utf8'));
  const buf = (f: string) => readFileSync(new URL(f, d));
  const u8 = (f: string) => new Uint8Array(buf(f));
  const b = buf(sc.grid.bump_height_m);
  const base: Layers = { floor: u8(sc.grid.floor), obst: u8(sc.grid.obstacles), bump: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  const route = JSON.parse(buf('route.json').toString());
  const poses = sc.objects.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 }));
  return { sc, g: sc.grid as GridMeta, base, route, poses };
};
const pp = (sc: any) => ({ walker_width_m: 0.66, ...sc.plan });

test('edt matches brute force', () => {
  const nx = 7, ny = 5, b = new Uint8Array(nx * ny); b[8] = 1; b[30] = 1;
  const d = edt(b, nx, ny);
  for (let k = 0; k < nx * ny; k++) {
    const want = Math.min(...[8, 30].map(o => Math.hypot(Math.floor(k / ny) - Math.floor(o / ny), (k % ny) - (o % ny))));
    assert.ok(Math.abs(d[k] - want) < 1e-6, `cell ${k}: ${d[k]} vs ${want}`);
  }
});

test('contact table interpolates and clamps', () => {
  const t = { height_m: [0, 0.01, 0.02], p_per_stride: [0, 0.1, 0.3] };
  assert.equal(contactProb(t, -1), 0); assert.ok(Math.abs(contactProb(t, 0.015) - 0.2) < 1e-12); assert.equal(contactProb(t, 1), 0.3);
});

test('synthetic scene: route found, same length as stage 7, rug + cable flagged at measured height', () => {
  const { sc, g, base, route, poses } = load('game_synth');
  const L = stamp(g, base, sc.objects, poses);
  const P = plan(g, L, route.start, route.goal, pp(sc));
  assert.equal(P.error, undefined);
  assert.ok(Math.abs(P.length_m - 3.66) < 0.15, `length ${P.length_m}`);
  const comps = bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m);
  const hz = routeHazards(g, L, P, 0.66, sc.hazard_rules.clearance_margin_m, sc.hazard_rules.bump_min_m, comps);
  const bumps = hz.filter(h => h.type === 'floor_bump');
  assert.ok(bumps.length >= 2, JSON.stringify(hz));
  // scene truth (tests/make_game_scene.py): 1.5 cm rug, measured; 5 mm cable, classified thin -> config typical 6 mm, estimated
  const hs = bumps.map(h => h.height_m!).sort();
  assert.ok(Math.abs(hs[0] - 0.006) < 1e-4 && Math.abs(hs[hs.length - 1] - 0.015) < 0.003, `bumps ${hs}`);
  assert.ok(hz.some(h => h.type === 'tight_clearance'), 'the 0.80 m doorway is tight for a 0.66 m walker');
});

test('doorway narrower than the walker blocks the route', () => {
  const { sc, g, base, route, poses } = load('game_synth_narrow');
  const P = plan(g, stamp(g, base, sc.objects, poses), route.start, route.goal, pp(sc));
  assert.match(P.error ?? '', /no path/);
});

test('moving the bed next to the route reroutes it (still passable); walls reject placement', () => {
  const { sc, g, base, route, poses } = load('game_synth');
  const k = sc.objects.findIndex((o: any) => o.name === 'bed');
  const P0 = plan(g, stamp(g, base, sc.objects, poses), route.start, route.goal, pp(sc));
  const moved = poses.map((p: any, n: number) => (n === k ? { x: 2.0, y: 1.0, yaw: Math.PI / 2 } : p));
  assert.ok(placementOk(g, base, sc.objects, moved, k));
  const t = performance.now();
  const P1 = plan(g, stamp(g, base, sc.objects, moved), route.start, route.goal, pp(sc));
  assert.ok(performance.now() - t < 1000);
  assert.equal(P1.error, undefined);   // a blocked route also has different (empty) cells
  assert.ok(Math.abs(P1.length_m - P0.length_m) > 0.15, `${P0.length_m} -> ${P1.length_m}`);
  const intoWall = poses.map((p: any, n: number) => (n === k ? { x: 4.0, y: 2.6, yaw: 0 } : p));
  assert.ok(!placementOk(g, base, sc.objects, intoWall, k));
});

test('rollouts: removing the rug and taping the cable cut toe contacts; no bumps -> none', () => {
  const { sc, g, base, route, poses } = load('game_synth');
  const persona = JSON.parse(readFileSync(new URL('../public/scene/game_synth/persona.json', import.meta.url), 'utf8'));
  const run = (ps: any[], flat: any[] = []) => {
    const L = stamp(g, base, sc.objects, ps, flat);
    const P = plan(g, L, route.start, route.goal, pp(sc));
    return rollouts(g, L.bump, bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m), P.xy, persona, sc.risk, []);
  };
  const before = run(poses);
  const rug = sc.objects.findIndex((o: any) => o.name === 'rug');
  const noRug = run(poses.map((p: any, n: number) => (n === rug ? { ...p, removed: true } : p)));
  const cable = sc.interventions.find((i: any) => i.id === 'tape_cable').box_xy;
  const neither = run(poses.map((p: any, n: number) => (n === rug ? { ...p, removed: true } : p)), [cable]);
  assert.ok(before.per_month > noRug.per_month && noRug.per_month > 0, `${before.per_month} ${noRug.per_month}`);
  assert.equal(neither.per_month, 0);
  assert.equal(Object.keys(before.per_comp).length, 2);
  assert.equal(before.ghosts.length, sc.risk.ghosts);
});

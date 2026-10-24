import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { edt, plan, stamp, routeHazards, bumpComponents, placementOk, polyCells, worldFootprint, type Layers, type GridMeta } from '../src/grid.ts';
import { evaluate, routeStart } from '../src/evaluate.ts';
import { loadScene } from './scene.ts';
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
  assert.ok(Math.abs(P.length_m - 3.87) < 0.15, `length ${P.length_m}`);   // stage 7 on the scene with the bathroom door open
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

// ---------- dragging objects around the SYNTHETIC sample scene (tests/make_sample_objects.py) ----------
// Move, rotate and remove each kind: the grid, the placement rule, the route, the checks and the imagined fill. The scene is
// git-ignored and generated on demand, so these skip (with the command) until it exists.
const haveSample = existsSync(new URL('../public/scene/sample_objects/scene.json', import.meta.url));
const skipSample = haveSample ? false : 'scene not generated: .venv/Scripts/python.exe tests/make_sample_objects.py';
type P = { x: number; y: number; yaw: number; removed?: boolean };
const cellsOf = (S: ReturnType<typeof loadScene>, k: number, p: P) => new Set(polyCells(S.g, worldFootprint(S.init.objects[k], p)));
const withPose = (poses: P[], k: number, p: Partial<P>) => poses.map((q, n) => (n === k ? { ...q, ...p } : q));
const idx = (S: ReturnType<typeof loadScene>, name: string) => S.init.objects.findIndex(o => o.name === name);
// where each kind is dragged to (all free floor in the sample room: placementOk is asserted below)
const MOVE_TO: Record<string, [number, number, number]> = { chair: [3.6, 3.6, 0], table: [1.0, 0.45, 0], bed: [1.0, 2.0, 0], nightstand: [2.0, 0.45, 0],
  rug: [2.9, 1.6, 0], rug_curl: [3.0, 3.6, 0], nightlight: [3.88, 0.95, 0], door: [4.48, 1.93, 0] };

test('drag: every kind can be removed, moved and rotated, and the grid follows exactly', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), { g, base, init, poses } = S, ny = g.shape[1];
  for (const [k, o] of init.objects.entries()) {
    const layerOf = (L: { obst: Uint8Array; bump: Float32Array }, c: number) => (o.layer === 'obstacle' ? L.obst[c] : L.bump[c]);
    const none = stamp(g, base, init.objects, withPose(poses, k, { removed: true }));
    const home = stamp(g, base, init.objects, poses);
    const here = cellsOf(S, k, poses[k]);
    if (o.layer === 'none') { assert.deepEqual(home.obst, none.obst, `${o.name}: a nightlight has no footprint`); continue; }
    // removed: the only cells that change are its own, and they go back to what the room has without it
    for (let c = 0; c < g.shape[0] * ny; c++) if (!here.has(c)) assert.equal(layerOf(home, c), layerOf(none, c), `${o.name}: removing it changed cell ${c} outside its footprint`);
    for (const c of here) assert.ok(layerOf(home, c) > 0 && !layerOf(none, c) || o.name === 'rug' || o.name === 'rug_curl', `${o.name}: footprint cell ${c} not cleared on removal`);
    // moved: the old cells are free again (unless the new footprint covers them), the new ones are taken
    const [mx, my, myaw] = MOVE_TO[o.name], moved = withPose(poses, k, { x: mx, y: my, yaw: myaw }), there = cellsOf(S, k, moved[k]);
    assert.ok(placementOk(g, base, init.objects, moved, k), `${o.name}: the drop spot ${mx},${my} should be free floor`);
    const Lm = stamp(g, base, init.objects, moved);
    for (const c of here) if (!there.has(c) && o.name !== 'rug_curl') assert.equal(layerOf(Lm, c), layerOf(none, c), `${o.name}: old cell ${c} still taken`);
    for (const c of there) assert.ok(layerOf(Lm, c) > 0, `${o.name}: new cell ${c} not taken`);
    if (o.layer === 'bump') for (const c of there) assert.ok(Math.abs(Lm.bump[c] - Math.max(o.height_m, none.bump[c])) < 1e-6, `${o.name}: a rug stamps its own height`);
    // rotated a quarter turn about its pivot: the same area, a different set of cells (unless it is square)
    const turned = withPose(poses, k, { yaw: Math.PI / 2 }), tc = cellsOf(S, k, turned[k]);
    assert.ok(Math.abs(tc.size - here.size) <= 0.08 * here.size + 4, `${o.name}: area ${here.size} -> ${tc.size} cells`);
  }
  // a table 0.9 x 0.5 m swaps its sides when turned
  const t = idx(S, 'table'), ext = (cs: Set<number>) => { const i = [...cs].map(c => Math.floor(c / ny)), j = [...cs].map(c => c % ny); return [Math.max(...i) - Math.min(...i) + 1, Math.max(...j) - Math.min(...j) + 1]; };
  const [a0, b0] = ext(cellsOf(S, t, poses[t])), [a1, b1] = ext(cellsOf(S, t, withPose(poses, t, { yaw: Math.PI / 2 })[t]));
  assert.ok(Math.abs(a0 - b1) <= 3 && Math.abs(b0 - a1) <= 3 && Math.abs(a0 - b0) > 10, `table extent ${a0}x${b0} -> ${a1}x${b1}`);
});

test('drag: placement rejects walls, other furniture and the void, accepts free floor', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), { g, base, init, poses } = S, ok = (name: string, x: number, y: number, yaw = 0) => {
    const k = idx(S, name);
    return placementOk(g, base, init.objects, withPose(poses, k, { x, y, yaw }), k);
  };
  assert.ok(ok('chair', 3.6, 3.6), 'free floor');
  assert.ok(!ok('chair', 4.05, 2.6), 'into the wall between the rooms');
  assert.ok(!ok('chair', 1.0, 3.0), 'onto the bed');
  assert.ok(!ok('chair', -1, -1), 'outside the room');
  const t = idx(S, 'table'), c = poses[idx(S, 'chair')];
  assert.ok(!placementOk(g, base, init.objects, withPose(poses, t, { x: c.x, y: c.y }), t), 'table onto the chair');
  assert.ok(!ok('rug', 1.0, 3.0), 'a rug does not go on the bed');
  assert.ok(ok('table', 1.0, 0.45, Math.PI / 2), 'rotated in place still fits');
});

test('drag: a table dropped on the route reroutes it; dropped across the doorway corridor it seals it', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), { g, base, init, poses } = S, t = idx(S, 'table');
  const rd = init.routes[0], p0 = plan(g, stamp(g, base, init.objects, poses), rd.start, rd.goal, init.plan);
  assert.equal(p0.error, undefined);
  const drop = (f: number) => {   // the table, centred on the route f of the way along
    const mid = p0.xy[Math.floor(p0.xy.length * f)], moved = withPose(poses, t, { x: mid[0], y: mid[1] });
    assert.ok(placementOk(g, base, init.objects, moved, t), 'a table can be dropped on the walker route (floor, no other furniture)');
    return { moved, p: plan(g, stamp(g, base, init.objects, moved), rd.start, rd.goal, init.plan) };
  };
  const { moved, p } = drop(0.3);
  assert.equal(p.error, undefined, 'there is still a way round');
  const table = cellsOf(S, t, moved[t]);
  assert.ok(p.cells.every(c => !table.has(c)), 'the new route does not go through the table');
  assert.ok(p.length_m > p0.length_m + 0.5, `longer: ${p0.length_m.toFixed(2)} -> ${p.length_m.toFixed(2)}`);
  // 0.9 m of table in the 1.4 m corridor to the doorway leaves less than the 0.66 m walker: no route at all. The viewer
  // lets you drop it there (placementOk is about furniture, not routes) and shows the route error.
  assert.match(drop(0.5).p.error ?? '', /no path/);
});

test('drag: the curled rug corner dropped on the route shows up as a taller bump hazard', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), { init, poses } = S, k = idx(S, 'rug_curl'), lay = { poses, flattened: [] as [number[], number[]][] };
  const before = evaluate(init, lay as any, { ghosts: false }), mid = before.xy[Math.floor(before.xy.length * 0.2)];
  const after = evaluate(init, { poses: withPose(poses, k, { x: mid[0], y: mid[1] }), flattened: [] }, { ghosts: false });
  const tallest = (e: typeof before) => Math.max(0, ...e.hazards.filter(h => h.type === 'floor_bump').map(h => h.height_m!));
  assert.ok(tallest(after) > 0.02 && tallest(before) < 0.02, `tallest bump on the route ${tallest(before)} -> ${tallest(after)}`);
  assert.ok(after.per_month >= before.per_month, 'a taller bump on the route is never safer');
});

test('drag: the route starts beside the bed wherever the bed goes (start_with), and checks follow the nightstand', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), { init, poses } = S, bed = idx(S, 'bed'), rd = init.routes[0], [ox, oy] = init.objects[bed].pivot;
  assert.deepEqual(routeStart(rd, init.objects, poses), rd.start, 'bed at home: the original start');
  const turned = withPose(poses, bed, { x: 1.1, y: 1.05, yaw: Math.PI / 2 }), [sx, sy] = routeStart(rd, init.objects, turned);
  const u = rd.start[0] - ox, v = rd.start[1] - oy;
  assert.ok(Math.hypot(sx - (1.1 - v), sy - (1.05 + u)) < 1e-9, 'rotated about the bed pivot, carried with it');
  assert.deepEqual(routeStart(rd, init.objects, withPose(poses, bed, { removed: true })), rd.start, 'no bed: the original start');
  const e1 = evaluate(init, { poses: turned, flattened: [] }, { ghosts: false });
  assert.ok(Math.hypot(e1.xy[0][0] - sx, e1.xy[0][1] - sy) < 0.1, 'the planned route begins at the carried start');
  // the phone sits on the nightstand: move the nightstand away from the bed and the reach check gets worse
  const n = idx(S, 'nightstand'), reach = (ps: P[]) => evaluate(init, { poses: ps, flattened: [] }, { ghosts: false }).checks.find(c => c.id === 'reach:phone')!;
  const near = reach(poses), far = reach(withPose(poses, n, { x: 2.0, y: 0.45 }));
  assert.ok(far.value_m! > near.value_m!, `phone reach ${near.value_m} -> ${far.value_m} m`);
});

test('imagined fills stay separate from the measured layers: files exist, sit below bump height, and removal uses only the base', { skip: skipSample }, () => {
  const S = loadScene('sample_objects'), dir = new URL('../public/scene/sample_objects/', import.meta.url);
  const fills = S.js('fills.json');
  for (const o of S.sc.objects) {
    assert.ok(existsSync(new URL(o.fill, dir)), `${o.name}: fill ${o.fill} missing`);
    assert.ok(o.name in fills && fills[o.name].backends.length > 0, `${o.name}: no fill backends listed`);
    // the fill is a flat set of Gaussians at z = 2 mm: under the 4 mm bump threshold, it can never register as a bump or obstacle
    // a fill with a wall patch (a door or bed against a wall) also paints the wall it hid, standing up to wall height: that
    // patch is imagined too, so only the floor-only fill stage 12 writes (fill_<name>.ply) is held to the floor rule
    const file = fills[o.name].wall_patch ? `objects/fill_${o.name}.ply` : o.fill;
    const b = readFileSync(new URL(file, dir)), end = b.indexOf('end_header\n') + 11, head = b.subarray(0, end).toString();
    const n = +/element vertex (\d+)/.exec(head)![1], props = [...head.matchAll(/property (\w+) (\w+)/g)];
    assert.ok(props.every(p => p[1] === 'float'), 'fills are float32 columns');
    const ix = props.findIndex(p => p[2] === 'z'), zs = Array.from({ length: Math.min(n, 2000) }, (_, r) => b.readFloatLE(end + (r * props.length + ix) * 4));
    assert.ok(Math.max(...zs) < S.init.rules.bump_min_m, `${o.name}: fill z up to ${Math.max(...zs)} m reaches the bump threshold`);
  }
  // removing an object gives the same layers as a room that never had it: the fill is a picture, not a measurement
  const bed = idx(S, 'bed'), Lr = stamp(S.g, S.base, S.init.objects, withPose(S.poses, bed, { removed: true }));
  for (const c of cellsOf(S, bed, S.poses[bed])) assert.equal(Lr.bump[c] === 0 || S.base.bump[c] === Lr.bump[c], true);
});

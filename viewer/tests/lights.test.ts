import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathLights, wallSpot, PATH_LIGHT } from '../src/lights.ts';
import { bathroomFixes, toiletSides } from '../src/bathroom.ts';
import { strokePersona } from '../src/stroke.ts';
import { stairChecks, type Stair } from '../src/stairs.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyIntervention, type GridMeta, type Layers, type XY } from '../src/grid.ts';
import { loadScene } from './scene.ts';

// a 6 m x 3 m room on 5 cm cells, walls one cell thick all round
const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.05, shape: [120, 60] };
function room(): Layers {
  const [nx, ny] = g.shape, n = nx * ny, L = { floor: new Uint8Array(n).fill(1), obst: new Uint8Array(n), bump: new Float32Array(n) };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) L.obst[i * ny + j] = 1;
  return L;
}
const corridor: XY[] = [[0.5, 0.6], [5.5, 0.6]];   // along the room, 55 cm from the bottom wall

test('path lights: a dark 5 m route gets lights on the wall until every stretch is lit', () => {
  const ivs = pathLights(g, room(), corridor, []);
  assert.ok(ivs.length >= 2 && ivs.length <= PATH_LIGHT.max, `${ivs.length} lights`);
  for (const iv of ivs) {
    assert.equal(iv.kind, 'add'); assert.equal(iv.fixture!.kind, 'nightlight'); assert.equal(iv.fixture!.light_r, PATH_LIGHT.r_m);
    const [x, y] = iv.fixture!.xyz!;
    assert.ok(y < 0.1 || x > 5.9, `on the nearest wall (bottom, or the end wall near the route's end): ${x}, ${y}`);
  }
  // every point of the route is now within a light (inside the 90% rim the placement uses)
  const lit = ivs.map(iv => ({ x: iv.fixture!.xyz![0], y: iv.fixture!.xyz![1] }));
  for (let x = 0.5; x <= 5.5; x += 0.25) assert.ok(lit.some(l => Math.hypot(l.x - x, l.y - 0.6) <= PATH_LIGHT.r_m), `x=${x} dark`);
  assert.deepEqual(ivs.map(iv => iv.id), ivs.map((_, k) => `path_light:${k + 1}`));
});

test('path lights: a route already lit gets none; numbering continues after earlier ones', () => {
  assert.equal(pathLights(g, room(), corridor, [{ x: 3, y: 0.6, r: 4 }]).length, 0);
  assert.equal(pathLights(g, room(), corridor, [], 'route', 0.75, 3)[0].id, 'path_light:3');
});

test('wallSpot: the floor-side face of the nearest wall, or null with none in reach', () => {
  const w = wallSpot(g, room(), [3, 0.6])!;
  assert.ok(Math.abs(w[1] - 0.05) < 1e-9 && Math.abs(w[0] - 3) < 0.05);
  assert.equal(wallSpot(g, room(), [3, 1.5], 0.5), null);
});

test('through evaluate(): applied path lights make the night route darker-free, so contacts drop', () => {
  const { init, poses } = loadScene('game_synth');
  const lay0 = { poses: poses.map((p, k) => (init.objects[k].kind === 'nightlight' ? { ...p, removed: true } : p)), flattened: [] as [XY, XY][] };
  const r0 = evaluate(init, lay0, { ghosts: false });
  const S = { ...init, interventions: [...init.interventions, ...pathLights(init.g, init.base, r0.xy, [])] };
  let lay = lay0;
  for (const iv of S.interventions.filter(i => i.id.startsWith('path_light:'))) lay = applyIntervention(init.objects, lay, iv);
  const r1 = evaluate(S, lay, { ghosts: false });
  assert.ok(r1.per_month < r0.per_month, `${r1.per_month} vs ${r0.per_month}`);
});

test('bathroom: the toilet grab bar goes on its side wall at ADA height, and the check turns ok', () => {
  const { init, poses } = loadScene('game_synth');
  const fx = bathroomFixes(init.fixtures!, init.g, init.base, null);
  assert.equal(fx.length, 1);
  const bar = fx[0].fixture!;
  assert.equal(bar.kind, 'grab_bar'); assert.equal(bar.attach, 'toilet'); assert.ok(bar.xyz![2] >= 0.84 && bar.xyz![2] <= 0.915);
  const S = { ...init, interventions: [...init.interventions, ...fx] };
  const check = (lay: any) => evaluate(S, lay, { ghosts: false }).checks.find(c => c.id === 'grab_bar:toilet')!;
  const lay0 = { poses, flattened: [] as [XY, XY][] };
  assert.equal(check(lay0).verdict, 'OT to verify');
  assert.equal(check(applyIntervention(init.objects, lay0, fx[0])).verdict, 'ok');
  // the stronger side opposite the wall: the fix says so
  const other = bar.side === 'left' ? 'right' : 'left';
  assert.match(bathroomFixes(init.fixtures!, init.g, init.base, other)[0].label, /weak side/);
});

test('toiletSides: the back is the end against a wall; the bar wall is the nearer side wall', () => {
  // toilet 40 cm wide, 60 cm deep, back against the top wall (y = 2.95), 20 cm from the right wall (x = 5.95)
  const s = toiletSides(g, room(), [[5.35, 2.35], [5.75, 2.35], [5.75, 2.95], [5.35, 2.95]]);
  assert.ok(s.front[1] < -0.99, 'faces down, away from the back wall');
  assert.equal(s.wall, 'left');   // facing -y, the person's left is +x: the right-hand wall of the room
});

test('stroke persona: the stronger hand flips, steps shorten, the weak side view goes', () => {
  const p = strokePersona({ walker: { width_m: 0.66 }, gait: { stride_m: 0.35, strong_side: 'left' } });
  assert.equal(p.gait.strong_side, 'right'); assert.ok(p.gait.stride_m < 0.35); assert.equal(p.vision, 'hemianopia_left');
  assert.equal(strokePersona({ walker: {}, gait: {} }, 'right').gait.strong_side, 'left');
});

test('stairs: a flight the scan only partly saw sends its riser numbers to the tape, not to fail', () => {
  const st: Stair = { name: 'stairs', bottom: [[0.9, 0], [0, 0]], top: [0.45, 2.7], treads_z: [0.15, 0.34, 0.56], tread_fronts_m: [0, 0.2, 0.4],
    tread_depth_m: 0.2, width_m: 0.9, measured: 'splat', top_z: 2.3, rails: { left: 'seen', right: 'seen' } };
  const ctx = { g, L: room(), fixtures: [], margin: { width: 0.02, height: 0.01 }, device: 'walker' };
  const v = (s: Stair, w: string) => stairChecks(s, ctx).find(c => c.id === `stairs:stairs:${w}`)!;
  for (const w of ['risers', 'riser_var', 'tread']) { assert.equal(v(st, w).verdict, 'OT to verify', w); assert.match(v(st, w).note, /MEASURING\.md/); }
  // the same numbers tape-measured, or a scan that saw up to the landing, still fail
  assert.equal(v({ ...st, measured: 'tape' }, 'riser_var').verdict, 'fail');
  assert.equal(v({ ...st, top_z: 0.6 }, 'riser_var').verdict, 'fail');
});

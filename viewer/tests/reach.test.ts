import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reachField, analyze, paintClasses, thresholds, costToReach, causeText, CLS, type ReachInit, type ReachOpts } from '../src/reach.ts';
import { routeStart } from '../src/evaluate.ts';
import { doorFixes, needWidth, type Door } from '../src/doors.ts';
import { applyIntervention, toCell, type GridMeta, type Layout, type XY } from '../src/grid.ts';
import { WHEELCHAIR } from '../src/wheelchair.ts';
import { loadScene } from './scene.ts';

// the synthetic bathroom doorway (tests/make_game_scene.py): wall x 4.0-4.1, opening y 1.5 +- door_w / 2
const door = (w: number): Door => ({ name: 'bathroom door', a: [4.05, 1.5 - w / 2], b: [4.05, 1.5 + w / 2], measured: 'tape' });
const BATH: XY = [5.4, 1.5];
function scene(run: string, extra: Partial<ReachInit> = {}) {
  const { init, poses, sc } = loadScene(run);
  const coverage = new Uint8Array(readFileSync(new URL(`../public/scene/${run}/${sc.grid.coverage}`, import.meta.url)));
  const S: ReachInit & typeof init = { ...init, coverage, coverage_good: sc.grid.coverage_good, ...extra } as any;
  const lay: Layout = { poses: [...poses], flattened: [] };
  const opts = (width_m = init.plan.walker_width_m, wheelchair = false): ReachOpts => ({ width_m, clearance_m: init.rules.clearance_margin_m, margin_m: init.rules.margin_m.width, wheelchair });
  const start = (l = lay) => routeStart(init.routes[0], init.objects, l.poses);
  const goals = init.routes.map(rd => ({ name: rd.name, at: rd.goal, kind: 'goal' as const }));
  const run_ = (l = lay, o = opts(), targets = goals) => { const f = reachField(S, l, start(l), init.plan.walker_width_m / 2); return { f, r: analyze(S, f, l, o, targets) }; };
  return { S, init, lay, opts, start, goals, run: run_ };
}

test('reach: through the 80 cm doorway the walker gets into the bathroom, nothing is cut off', () => {
  const { run } = scene('game_synth');
  const { r } = run();
  assert.equal(r.areas.cut, 0);
  assert.ok(r.areas.ok > 5, `reachable ${r.areas.ok.toFixed(1)} m²`);
  const toBath = r.targets.find(t => t.name === 'bed to bathroom')!;
  assert.notEqual(toBath.status, 'cut', JSON.stringify(toBath.status));
  assert.equal(r.targets.find(t => t.name === 'bed to wardrobe (day)')!.status, 'ok');
  // every ghost leaves from the start
  for (const t of r.targets.filter(x => x.path.length)) assert.ok(Math.hypot(t.path[0][0] - r.start[0], t.path[0][1] - r.start[1]) < 0.8, `${t.name} starts at ${t.path[0]}`);
});

test('reach: the 55 cm doorway cuts the bathroom off; marked, the doorway is named; widened, it opens', () => {
  const plain = scene('game_synth_narrow');
  const { r: r0 } = plain.run();
  assert.ok(r0.areas.cut > 2.5, `cut ${r0.areas.cut.toFixed(1)} m²`);
  assert.equal(r0.regions[0].cause.kind, 'structure', 'unmarked: a gap in a wall');
  const goal0 = r0.targets.find(t => t.name === 'bed to bathroom')!;
  assert.equal(goal0.status, 'cut');
  assert.ok(goal0.path.length > 5 && goal0.path[goal0.path.length - 1][0] < 4.0, `the ghost stops before the doorway: ${goal0.path.at(-1)}`);

  const d = door(0.55), marked = scene('game_synth_narrow', { doors: [d] });
  const { r: r1 } = marked.run();
  assert.equal(r1.regions[0].cause.kind, 'door');
  assert.equal(r1.regions[0].cause.name, 'bathroom door');
  assert.ok(Math.abs(r1.regions[0].cause.clear_m! - 0.55) < 0.01);
  assert.ok(r1.regions[0].pinch!.width_m <= 0.56, `pinch ${r1.regions[0].pinch!.width_m}`);
  assert.match(causeText(r1.regions[0].cause), /bathroom door \(55 cm clear\)/);

  const widen = doorFixes(d, needWidth(marked.init.plan.walker_width_m, marked.init.rules.clearance_margin_m)).find(i => i.id.startsWith('door_widen:'))!;
  const { r: r2 } = marked.run(applyIntervention(marked.init.objects, marked.lay, widen));
  assert.equal(r2.areas.cut, 0, `cut after widening ${r2.areas.cut}`);
  assert.notEqual(r2.targets.find(t => t.name === 'bed to bathroom')!.status, 'cut');
});

test('reach: a 61 cm doorway marked over the 80 cm gap counts at 61 cm (the reported case); hinges no, widening yes', () => {
  const d = door(0.61), s = scene('game_synth', { doors: [d] }), chair = s.opts(WHEELCHAIR.width_m, true);
  const { r } = s.run(s.lay, chair);
  assert.equal(r.targets.find(t => t.name === 'bed to bathroom')!.status, 'cut', 'the scan is 80 cm wide here, the marked door is not');
  assert.equal(r.regions[0].cause.name, 'bathroom door');
  const fx = doorFixes(d, needWidth(WHEELCHAIR.width_m, s.init.rules.clearance_margin_m));
  const hinges = s.run(applyIntervention(s.init.objects, s.lay, fx.find(i => i.id.startsWith('door_offset:'))!), chair).r;
  assert.equal(hinges.targets.find(t => t.name === 'bed to bathroom')!.status, 'cut', 'swing-clear hinges: +4.5 cm is not enough for a chair');
  const wide = s.run(applyIntervention(s.init.objects, s.lay, fx.find(i => i.id.startsWith('door_widen:'))!), chair).r;
  assert.notEqual(wide.targets.find(t => t.name === 'bed to bathroom')!.status, 'cut');
  assert.equal(wide.areas.cut, 0);
});

test('reach: a chair in front of the doorway cuts the bathroom off, named as movable; moved, it opens', () => {
  const base = scene('game_synth'), k = base.init.objects.length;
  const chair = { name: 'chair', kind: 'chair', footprint: [[-0.225, -0.225], [0.225, -0.225], [0.225, 0.225], [-0.225, 0.225]] as XY[], pivot: [3.7, 1.5, 0],
    layer: 'obstacle' as const, height_m: 0.9, light_radius_m: null };
  const s = scene('game_synth', { objects: [...base.init.objects, chair] as any });
  const lay: Layout = { poses: [...s.lay.poses, { x: 3.7, y: 1.5, yaw: 0 }], flattened: [] };
  const { r } = s.run(lay);
  const region = r.regions.find(x => Math.hypot(x.at[0] - BATH[0], x.at[1] - BATH[1]) < 1.5)!;
  assert.ok(region, `regions ${JSON.stringify(r.regions.map(x => x.at))}`);
  assert.deepEqual([region.cause.kind, region.cause.name, region.cause.movable], ['object', 'chair', true]);
  assert.equal(region.opens_if_moved, true);
  const goal = r.targets.find(t => t.name === 'bed to bathroom')!;
  assert.equal(goal.status, 'cut'); assert.equal(goal.opens_if_moved, true);
  const moved: Layout = { ...lay, poses: lay.poses.map((p, n) => (n === k ? { x: 2.0, y: 0.5, yaw: 0 } : p)) };
  assert.equal(s.run(moved).r.areas.cut, 0);
});

test('reach: one field answers every width; wider devices reach less', () => {
  const s = scene('game_synth_narrow', { doors: [door(0.55)] });
  const f = reachField(s.S, s.lay, s.start(), 0.3);
  const reach = (w: number) => { const c = paintClasses(f, thresholds(s.opts(w))); let n = 0; for (const x of c) if (x === CLS.ok || x === CLS.tight) n++; return n; };
  const [a, b, c] = [0.5, 0.66, 0.9].map(reach);
  assert.ok(a >= b && b >= c && a > c, `${a} >= ${b} >= ${c}`);
  // a 50 cm device fits through the 55 cm doorway: the bathroom isn't cut off
  assert.equal(analyze(s.S, f, s.lay, s.opts(0.5), s.goals).targets.find(t => t.name === 'bed to bathroom')!.status === 'cut', false);
});

test('reach: a hole in the scan is grey, never red; slivers and the outside of the walls are not holes', () => {
  const s = scene('game_synth');
  assert.equal(s.run().r.areas.grey, 0, 'unscanned space past the walls is outside the home');
  const floor = s.S.base.floor.slice(), obst = s.S.base.obst.slice(), ny = s.init.g.shape[1];
  const hole = (x0: number, y0: number, w: number) => {
    const [i0, j0] = toCell(s.init.g, [x0, y0]), [i1, j1] = toCell(s.init.g, [x0 + w, y0 + w]);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { floor[i * ny + j] = 0; obst[i * ny + j] = 0; }
  };
  hole(2.4, 2.9, 0.6); hole(0.4, 0.4, 0.2);
  const holed = scene('game_synth', { base: { ...s.S.base, floor, obst }, coverage: undefined });
  const { f, r } = holed.run();
  assert.ok(r.areas.grey > 0.3 && r.areas.grey < 0.45, `grey ${r.areas.grey.toFixed(2)} m² (the 0.04 m² sliver isn't a hole)`);
  const cls = paintClasses(f, thresholds(holed.opts()));
  const [hi, hj] = toCell(s.init.g, [2.7, 3.2]);
  assert.equal(cls[hi * ny + hj], CLS.grey);
});

// a hand-made floor: room A (3 x 3 m), a 0.9 m corridor 2 m long, and room B past it (or a wall)
function corridor(roomB: boolean, chairAt?: XY) {
  const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.02, shape: [430, 170] }, [nx, ny] = g.shape;
  const floor = new Uint8Array(nx * ny), obst = new Uint8Array(nx * ny).fill(1);
  const open = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = Math.round(x0 / 0.02); i < Math.round(x1 / 0.02); i++) for (let j = Math.round(y0 / 0.02); j < Math.round(y1 / 0.02); j++) { floor[i * ny + j] = 1; obst[i * ny + j] = 0; }
  };
  open(0.1, 0.1, 3.1, 3.1); open(3.1, 1.1, 5.1, 2.0);
  if (roomB) open(5.1, 0.1, 8.1, 3.1);
  const objects = chairAt ? [{ name: 'chair', kind: 'chair', footprint: [[-0.225, -0.225], [0.225, -0.225], [0.225, 0.225], [-0.225, 0.225]] as XY[], pivot: [...chairAt, 0], layer: 'obstacle' as const, height_m: 0.9 }] : [];
  const S: ReachInit = { g, base: { floor, obst, bump: new Float32Array(nx * ny) }, objects };
  const lay: Layout = { poses: objects.map(o => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })), flattened: [] };
  const f = reachField(S, lay, [1.6, 1.6], WHEELCHAIR.width_m / 2);
  return analyze(S, f, lay, { width_m: WHEELCHAIR.width_m, clearance_m: 0.1, margin_m: 0, wheelchair: true }, []);
}

test('reach: a wheelchair dead end (no ADA turning circle, one way in) is flagged; a hallway between rooms is not', () => {
  const dead = corridor(false);
  assert.equal(dead.pockets!.length, 1);
  assert.ok(dead.pockets![0].reverse_m > 1.5, `reverse ${dead.pockets![0].reverse_m.toFixed(2)} m`);
  assert.equal(dead.pockets![0].closed_by, undefined, 'a plain wall at the end');
  assert.deepEqual(corridor(true).pockets, [], 'room B at the far end: a through-way');
  const closed = corridor(true, [4.8, 1.55]);
  assert.equal(closed.pockets!.length >= 1, true, 'the chair closes the far end');
  assert.deepEqual([closed.pockets![0].closed_by?.kind, closed.pockets![0].closed_by?.name], ['object', 'chair']);
  // a walker gets no dead-end verdict: ADA gives a wheelchair's turning space, a walker's would be a guess
  const g = scene('game_synth');
  assert.equal(g.run().r.pockets, null);
});

test('reach: what it costs to get through a 75 cm doorway at each width: nothing, hinges, door off, a new opening', () => {
  const d = door(0.75), widths = [0.45, 0.5, 0.53, 0.55, 0.57, 0.59, 0.6, 0.7, 0.9];
  const steps = costToReach(d, widths, { clearance_m: 0.1, margin_m: 0, wheelchair: false });
  const at = (w: number) => steps.find(s => s.width_m === w)!;
  assert.equal(at(0.45).usd, 0);
  assert.equal(at(0.55).usd, 25); assert.match(at(0.55).label, /Swing-clear/);
  assert.equal(at(0.59).usd, 30); assert.match(at(0.59).label, /off its hinges/);
  assert.equal(at(0.7).usd, 1500); assert.match(at(0.7).label, /Widen/);
  assert.equal(at(0.7).source, 'placeholder');
  // a wheelchair needs ADA's 815 mm at least: no cheap tier through 75 cm
  assert.equal(costToReach(d, [0.5], { clearance_m: 0.1, margin_m: 0, wheelchair: true })[0].usd, 1500);
  // the door leaf is an object (it brings its own fixes): only a new opening is a doorway fix
  assert.equal(costToReach(d, [0.55], { clearance_m: 0.1, margin_m: 0, wheelchair: false, leafObject: true })[0].usd, 1500);
});

test('reach: the field and the report fit the replan budget on the synthetic home', () => {
  const s = scene('game_synth_narrow', { doors: [door(0.55)] });
  const t = performance.now();
  s.run();
  const ms = performance.now() - t;
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
});

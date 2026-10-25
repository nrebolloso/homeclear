// Writes tests/fixtures/effort_parity.json: what viewer/src/effort.ts, movecost.ts and planner.ts cost() say for kitchen4's
// objects, fixes and planner layouts, so tests/test_effort_parity.py can check planner/effort.py and engine.py against it.
// Re-run after effort.ts changes:  node tests/make_effort_parity.ts   (from the repo root; needs viewer/node_modules)
import { readFileSync, writeFileSync } from 'node:fs';
import { estimateMass, interventionEffort, moveEffort, effortKind, objectEffort } from '../viewer/src/effort.ts';
import { moveCost } from '../viewer/src/movecost.ts';
import { cost, type PlanLayout } from '../viewer/src/planner.ts';

const rd = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const sc = rd('viewer/public/scene/kitchen4_lighter/scene.json'), cfg = rd('configs/planner/kitchen4_lighter.json');
const search = rd('viewer/public/planner/kitchen4_lighter/search.json');
// main.ts: a mass from the measured box is set on the object before anything is priced; a guess stays unset
const objs = sc.objects.map((o: any) => { const e = objectEffort(o); return e.from_size ? { ...o, mass_kg: o.mass_kg ?? e.mass_kg } : { ...o }; });

const mass = sc.objects.map((o: any) => ({ name: o.name, kind: o.kind, footprint: o.footprint, height_m: o.height_m, ...estimateMass(o) }));
const moves: any[] = [];
for (const o of objs) for (const distance_m of [0, 1, 2.5]) for (const turn_deg of [0, 90, 180, 270, -90]) {
  for (const mass_kg of [undefined, o.mass_kg]) {
    const m = moveEffort({ kind: o.kind, name: o.name, mass_kg, distance_m, turn_deg });
    moves.push({ kind: o.kind, name: o.name, mass_kg: mass_kg ?? null, distance_m, turn_deg, effort: m.effort, minutes: m.minutes, people: m.people });
  }
}
// a few kinds kitchen4 has no object for (bed, heavy table, dresser), with and without a mass
for (const kind of ['bed', 'dresser', 'sofa', 'door', 'cord', 'other']) for (const mass_kg of [undefined, 10, 40]) {
  const m = moveEffort({ kind, mass_kg, distance_m: 1.5, turn_deg: 45 });
  moves.push({ kind, name: null, mass_kg: mass_kg ?? null, distance_m: 1.5, turn_deg: 45, effort: m.effort, minutes: m.minutes, people: m.people });
}
// movecost.ts moveCost from poses (yaw in degrees here, radians in the viewer), as planner.ts cost() calls it
const rad = (d: number) => (d * Math.PI) / 180;
const poseMoves: any[] = [];
for (const n of [...cfg.chairs, 'table', 'trash_can', 'basket', 'mat', 'bedside_table'])
  for (const [a, b] of [[[0, 0, 0], [1, 0, 90]], [[0.3, -1.1, 90], [0.3, -1.1, 0]], [[1.9, -0.83, 0], [1.2, 0.4, 180]], [[0, 0, 270], [2.5, 0, 0]], [[0, 0, 0], [0, 0, 0]]]) {
    const o = objs.find((q: any) => q.name === n), c = moveCost(o, { x: a[0], y: a[1], yaw: rad(a[2]) }, { x: b[0], y: b[1], yaw: rad(b[2]) });
    poseMoves.push({ name: n, a, b, effort: c.effort, minutes: c.minutes });
  }
const fixes = sc.interventions.map((iv: any) => {
  const on = objs.find((o: any) => o.name === iv.object), kind = on && effortKind(on);
  return { id: iv.id, kind: iv.kind, object: iv.object ?? null, effort_cfg: iv.effort ?? null, target_kind: kind ?? null, effort: interventionEffort(iv, kind) };
});
// planner.ts cost() from the scanned room to every stored layout, plus hand-made ones that turn chairs and use each option
const S: any = { ...sc, objects: objs };
const from: PlanLayout = search.scanned.layout, ch = from.chairs;
const extra: PlanLayout[] = [
  { ...from, chairs: { ...ch, chair3: [ch.chair3[0], ch.chair3[1], 90], chair8: [1.2, 0.4, 180] }, mat: 'taped', cord: 'rerouted', nightlight: 'kitchen' },
  { ...from, chairs: { ...ch, chair4: [ch.chair4[0] + 1, ch.chair4[1], 270] }, mat: 'moved', mat_at: [0.5, -0.3, 90], nightlight: 'off', caps: true },
  { ...from, mat: 'removed', cord: 'taped' },
];
const layouts = [...search.pareto.map((p: any) => p.layout), ...extra].map(pl => ({ layout: pl, cost: cost(S, cfg, from, pl) }));

writeFileSync(new URL('./fixtures/effort_parity.json', import.meta.url),
  JSON.stringify({ note: 'made by tests/make_effort_parity.ts from viewer/src/effort.ts; do not edit', mass, moves, pose_moves: poseMoves, fixes, from, layouts }, null, 1) + '\n');
console.log(`${mass.length} masses, ${moves.length} moves, ${poseMoves.length} pose moves, ${fixes.length} fixes, ${layouts.length} layouts`);

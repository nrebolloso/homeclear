// One layout -> every route planned, rolled out and checked. Pure (no Worker globals): the worker, the optimizer and the
// tests all call it.
import { stamp, carvedPolys, placedFixtures, plan, routeHazards, bumpComponents, polyCells, worldFootprint, applyIntervention,
  type GridMeta, type Layers, type Footprinted, type Layout, type Intervention, type XY, type RouteHazard } from './grid.ts';
import { rollouts, type Persona, type Risk, type Heat, type Ghost } from './sim.ts';
import type { StepModel } from './stepmodel.ts';
import type { WorldModel } from './worldmodel.ts';
import { runChecks, type Fixture, type TransferRules, type EmsRules, type BodyFacts, type CheckOut } from './checks.ts';
import { objectRisk, type BatchResults, type ObjEvent } from './objrisk.ts';
// shortcut: one batch, run on kitchen4_lighter's chairs and mat, serves every scene; rerun the batch per scene when it matters
import batch from '../../physics/batch_results.json' with { type: 'json' };
import { stairChecks, type Stair, type Side, type WalkerDims } from './stairs.ts';
import { doorChecks, doorFixes, doorGain, doorOnRoute, needWidth, type Door } from './doors.ts';
import { wheelchairChecks, ADA } from './wheelchair.ts';

/** One walk the patient makes: night trips get the darkness multiplier, daytime ones don't. start_with: the start
 *  rides on that object (the bed): move the bed and the patient gets up from the same spot beside it. */
export interface RouteDef { name: string; start: XY; goal: XY; trips_per_night: number; night: boolean; start_with?: string }

/** Tightest side clearance along a route away from its ends (more than 0.5 m from start and goal): getting up beside
 *  the bed or arriving at the toilet is close quarters by design, not a squeeze to fix. */
export function midClearance(xy: XY[], side: number[]): number | undefined {
  if (!xy.length) return undefined;
  const a = xy[0], b = xy[xy.length - 1];
  const mid = side.filter((_, k) => Math.hypot(xy[k][0] - a[0], xy[k][1] - a[1]) > 0.5 && Math.hypot(xy[k][0] - b[0], xy[k][1] - b[1]) > 0.5);
  return mid.length ? Math.min(...mid) : Math.min(...side);
}

/** A route's start in this layout: carried rigidly with its start_with object from that object's original pose. */
export function routeStart(rd: RouteDef, objects: { name: string; pivot: number[] }[], poses: { x: number; y: number; yaw: number; removed?: boolean }[]): XY {
  const k = rd.start_with ? objects.findIndex(o => o.name === rd.start_with) : -1;
  if (k < 0 || poses[k].removed) return rd.start;
  const [ox, oy] = objects[k].pivot, p = poses[k], u = rd.start[0] - ox, v = rd.start[1] - oy, c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [p.x + c * u - s * v, p.y + s * u + c * v];
}
export interface Init {
  g: GridMeta; base: Layers; est: Uint8Array;
  objects: (Footprinted & { name: string; kind: string; light_radius_m: number | null; surface_m?: number | null })[];
  routes: RouteDef[]; persona: Persona & BodyFacts; risk: Risk;
  fixtures?: Fixture[]; transfer?: TransferRules; ems?: EmsRules; interventions: Intervention[]; stepModel?: StepModel; worldModel?: WorldModel;
  plan: { walker_width_m: number; preferred_clearance_m: number; clearance_weight: number };
  rules: { clearance_margin_m: number; bump_min_m: number; bump_link_cells?: number; bump_limit_m: number; margin_m: { width: number; height: number } };
  /** stairs (stairs.ts): marked in the viewer or config game.stairs; the stronger hand (viewer override, else persona) and the device */
  stairs?: Stair[]; strong_side?: Side | null; device?: string;
  /** the walking aid's frame, for where the second one is parked at the top of a stair */
  walker?: WalkerDims;
  /** doorways (doors.ts): marked in the viewer or config game.doors */
  doors?: Door[];
}
export interface HazardOut extends RouteHazard { name: string; per_month: number; ot_check: boolean; estimated: boolean }
export interface RouteSummary {
  name: string; night: boolean; trips_per_night: number; per_month: number; lo: number; hi: number; length_m: number; error?: string;
  /** tightest side clearance along this route (m) */
  min_side_m?: number;
}
export interface Eval {
  error?: string; xy: XY[]; side: number[]; length_m: number; hazards: HazardOut[];
  /** all routes together (contacts / month), with the 10-90% range; `routes` has each one */
  per_month: number; per_month_lo: number; per_month_hi: number; routes: RouteSummary[]; sel: number;
  ghosts: Ghost[]; dist_m: Float32Array; ms: number;
  heat?: Heat; steps: { xy: XY; side: number; hit: boolean }[];
  /** transfers, reach, grab bars, stretcher access, phone after a fall (checks.ts) */
  checks: CheckOut[];
  /** simulated object events per route: mat slides, chair tips (objrisk.ts, from the offline physics batch) */
  objects: ObjEvent[];
  /** the same trips stepped by the hand rule, when a learned / world model drives the main ones (worker.ts) */
  hand?: { per_month: number; ghosts: Ghost[] };
}


export function evaluate(S: Init, lay: Layout, opts: { ghosts: boolean; sel?: number; heat?: boolean }): Eval {
  const t = performance.now(), { g, objects: O } = S, sel = Math.min(opts.sel ?? 0, S.routes.length - 1);
  const L = stamp(g, S.base, O, lay.poses, lay.flattened, carvedPolys(lay));
  const comps = bumpComponents(g, L.bump, S.rules.bump_min_m, S.rules.bump_link_cells);
  const names: Record<number, string> = {}, estComp = new Set<number>();
  S.est.forEach((e, c) => { if (e && comps[c]) estComp.add(comps[c]); });
  O.forEach((o, k) => {
    if (o.layer === 'bump' && !lay.poses[k].removed)
      for (const c of polyCells(g, worldFootprint(o, lay.poses[k]))) if (comps[c]) names[comps[c]] = o.name;
  });
  const lights = O.flatMap((o, k) => (o.kind === 'nightlight' && !lay.poses[k].removed ? [{ x: lay.poses[k].x, y: lay.poses[k].y, r: o.light_radius_m ?? 1.5 }] : []));
  const out = { per_month: 0, per_month_lo: 0, per_month_hi: 0, routes: [], sel, hazards: [], ghosts: [], steps: [], objects: [] } as unknown as Eval;
  const paths: XY[][] = [];
  S.routes.forEach((rd, k) => {
    const P = plan(g, L, routeStart(rd, O, lay.poses), rd.goal, S.plan);
    paths.push(P.xy);
    const summary: RouteSummary = { name: rd.name, night: rd.night, trips_per_night: rd.trips_per_night, per_month: 0, lo: 0, hi: 0,
      length_m: P.length_m, error: P.error, min_side_m: midClearance(P.xy, P.side) };
    out.routes.push(summary);
    if (k === sel) Object.assign(out, { xy: P.xy, side: P.side, length_m: P.length_m, dist_m: P.dist_m, error: P.error });
    if (P.error) return;
    const risk = { ...S.risk, trips_per_night: rd.trips_per_night, dark_contact_multiplier: rd.night ? S.risk.dark_contact_multiplier : 1,
      ghosts: opts.ghosts && k === sel ? S.risk.ghosts : 0 };
    const R = rollouts(g, L.bump, comps, P.xy, S.persona, risk, rd.night ? lights : [], 1, S.stepModel,
      { height_err_m: S.rules.margin_m.height, heat: opts.heat && k === sel, world: S.worldModel });
    Object.assign(summary, { per_month: R.per_month, lo: R.per_month_lo, hi: R.per_month_hi });
    out.per_month += R.per_month; out.per_month_lo += R.per_month_lo; out.per_month_hi += R.per_month_hi;
    out.objects.push(...objectRisk(batch as unknown as BatchResults, rd.name, P.xy, O.flatMap((o, j) => (lay.poses[j].removed ? [] : [{ name: o.name, kind: o.kind, poly: worldFootprint(o, lay.poses[j]) }])),
      S.persona.speed_mps ?? 0.5, rd.trips_per_night * S.risk.days_per_month, S.plan.walker_width_m / 2, S.risk.path_offset_sd_m));
    if (k !== sel) return;
    out.ghosts = R.ghosts; out.heat = R.heat; out.steps = R.steps;
    out.hazards = routeHazards(g, L, P, S.plan.walker_width_m, S.rules.clearance_margin_m, S.rules.bump_min_m, comps).map(h => ({
      ...h, name: h.type === 'floor_bump' ? names[h.comp!] ?? (estComp.has(h.comp!) ? 'cable' : 'floor bump') : 'tight passage',
      estimated: h.type === 'floor_bump' && estComp.has(h.comp!),
      per_month: h.type === 'floor_bump' ? R.per_comp[h.comp!] ?? 0 : 0,
      // within the measured map error (stage 6b) of a limit counts as a check too: borderline, OT to verify
      ot_check: h.type === 'floor_bump' ? h.height_m! >= S.rules.bump_limit_m - S.rules.margin_m.height || estComp.has(h.comp!)
        : h.min_side_clearance_m! < S.rules.clearance_margin_m + S.rules.margin_m.width,
    }));
  });
  // fixtures added by fixes in place (a touch lamp on the nightstand) count like marked ones
  const added = placedFixtures(S.interventions, lay).map(f => ({ ...f, measured: false }));
  out.checks = S.transfer && S.ems ? runChecks({ g, L, objects: O, poses: lay.poses, fixtures: [...(S.fixtures ?? []), ...added], raised: lay.raised ?? {}, body: S.persona,
    transfer: S.transfer, ems: S.ems, routeStart: routeStart(S.routes[0], O, lay.poses), plan: S.plan, margin: S.rules.margin_m,
    hazards: out.hazards.map(h => ({ position: h.position, name: h.name })) }) : [];
  for (const st of S.stairs ?? []) out.checks.push(...stairChecks(st, { g, L, fixtures: [...(S.fixtures ?? []), ...added], margin: S.rules.margin_m,
    strong_side: S.strong_side !== undefined ? S.strong_side : (S.persona as { strong_side?: Side }).strong_side ?? null, device: S.device ?? 'walker', walker: S.walker }));
  for (const d of S.doors ?? []) {
    // a wheelchair needs ADA's 815 mm clear opening even where its own width plus margins would be less
    const need = Math.max(needWidth(S.plan.walker_width_m, S.rules.clearance_margin_m), S.device === 'wheelchair' ? ADA.door_clear_m : 0), gain = doorGain(lay, d.name);
    let on = doorOnRoute(d, paths, false, gain);
    // A failed plan has no path. Open just this door and retry the blocked routes: an unrelated closet stays off-route.
    if (!on && out.routes.some(r => r.error)) {
      const iv = doorFixes(d, need).find(i => i.id.startsWith('door_widen:'));
      if (iv) {
        const test = applyIntervention(O, lay, iv), opened = stamp(g, S.base, O, test.poses, test.flattened, carvedPolys(test));
        on = S.routes.some((rd, k) => {
          if (!out.routes[k].error) return false;
          const P = plan(g, opened, routeStart(rd, O, test.poses), rd.goal, S.plan);
          return !P.error && doorOnRoute(d, [P.xy], false, iv.by_m);
        });
      }
    }
    out.checks.push(...doorChecks(d, { gain, need_m: need, margin: S.rules.margin_m, on_route: S.routes.length ? on : null }));
  }
  if (S.device === 'wheelchair' && out.dist_m) out.checks.push(...wheelchairChecks(g, out.dist_m,
    S.routes.flatMap(rd => [{ name: `${rd.name} start`, at: routeStart(rd, O, lay.poses) }, { name: `${rd.name} end`, at: rd.goal }]), out.hazards, S.rules.margin_m.width));
  // a route this walker can't make at all is the error to show, whichever route is selected
  const blocked = out.routes.find(r => r.error);
  if (blocked && !out.error) out.error = `${blocked.name}: ${blocked.error}`;
  if (!out.dist_m) out.dist_m = new Float32Array(g.shape[0] * g.shape[1]);
  return { ...out, ms: performance.now() - t };
}

/** The same route filter for the fix list and optimizer; keep unmarked configured interventions available. */
export function availableInterventions(S: Init, result: Eval): Intervention[] {
  const off = new Set(result.checks.filter(c => c.kind === 'door' && c.on_route === false).map(c => c.id.slice('door:'.length)));
  return S.interventions.filter(iv => iv.kind !== 'carve' || !off.has(iv.target!));
}


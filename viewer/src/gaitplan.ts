// Walking gait ghosts, the planning half (gaitghosts.ts draws it, fanworker.ts runs it): one whole trip per gait along the planned
// route, from the fan's own machinery (futures.ts fan(): the learned world model, the contact table, the rug fold).
// - Each gait is a foot-lift persona (futures.ts LIFTS). Gait changes how likely a toe is to catch an edge and, through that, which
//   way round a hazard the ghost walks (ASSUMPTION: ROUTE_RISK_M); it does not change the cloth: the rug folds with the same measured
//   chance for every gait, the shuffler just meets the folded corner with a lower toe.
// - Route choice: routeOptions() gives the planned route and its alternatives (around the mat, wide of the chair); each gait draws one
//   with odds from path length plus its own catch chance on that route (routeOdds). Both gaits share the draw (common random numbers).
// Imagined, never measured: nothing here feeds the planner, the OT report or the critic (they use sim.ts rollouts).
import { fan, prepare, routeOptions, routeOdds, LIFTS, ROUTE_RISK_M, type Fan, type FanScene, type Future, type Lift, type RouteOption } from './futures.ts';
import type { Fold, Layout, XY } from './grid.ts';
import { rng } from './sim.ts';
import { smoothRoute, type Pose, type WorldModel } from './worldmodel.ts';
import { P_FOLD } from './rugcascade.ts';

export type GaitId = 'average' | 'shuffler';
export interface Gait { id: GaitId; label: string; lift: Lift; color: number; css: string }
export const GAITS: Gait[] = [
  { id: 'average', label: 'Average foot lift', lift: 'average', color: 0x4dc9f0, css: '#4dc9f0' },
  { id: 'shuffler', label: 'Low-clearance shuffler', lift: 'shuffler', color: 0xffb347, css: '#ffb347' },
];
export interface GhostRoute { label: string; length_m: number; /** mean catch chance of this gait's futures on it */ risk: number; /** this gait's odds of taking it */ odds: number; catches_month: number }
export interface GhostRun {
  gait: GaitId; lift: Lift; routes: GhostRoute[]; pick: number;
  /** the typical future on the chosen route: its walker poses (frame centre, yaw), heels (heel k lands with poses[k + 1]) and what each swing risked */
  trip: Future; poses: Pose[]; swings: number[];
  /** catches/month if every trip took the chosen route, and weighted over the route odds (what this gait expects in this room) */
  catches_month: number; expected_month: number; n: number; folds: number;
  /** the way back over the same route when the typical trip folded a corner on the way out (the rug cascade, rugcascade.ts: a fold is a taller
   *  bump for the next pass): catches/month back with that corner folded against flat; null when nothing folded */
  back: { flat_month: number; folded_month: number } | null;
}
export interface GhostOpts { seed: number; n?: number; riskM?: number; foldP?: number | null; night?: boolean; gaits?: Gait[] }

/** the person (body centre, heading) with the walker frame on the route's first point, facing along it */
export function startState(xy: XY[], off0: number): { x: number; y: number; yaw: number } {
  const rt = smoothRoute(xy), q = rt[Math.min(rt.length - 1, 30)], yaw = Math.atan2(q[1] - rt[0][1], q[0] - rt[0][0]);
  return { x: rt[0][0] - off0 * Math.cos(yaw), y: rt[0][1] - off0 * Math.sin(yaw), yaw };
}
/** yaw along a walker path (the frame's heading is its direction of travel); the first pose keeps the person's heading */
export function posesOf(f: Future, yaw0: number): Pose[] {
  const w = f.walker, out: Pose[] = [];
  for (let k = 0; k < w.length; k++) {
    const a = w[Math.max(0, k - 1)], b = w[Math.min(w.length - 1, k + 1)];
    out.push([w[k][0], w[k][1], k === 0 || (a === b) ? yaw0 : Math.atan2(b[1] - a[1], b[0] - a[0])]);
  }
  return out;
}

/** One typical trip per gait along the planned route, with the routes each could take and how likely it is to take each. */
export function planGhosts(S: FanScene, lay: Layout, wm: WorldModel | null, route: XY[], fold: Fold | null, opts: GhostOpts): GhostRun[] {
  const n = opts.n ?? 40, riskM = opts.riskM ?? ROUTE_RISK_M, gaits = opts.gaits ?? GAITS, foldP = opts.foldP === undefined ? P_FOLD : opts.foldP;
  const off0 = S.walker.user_gap_m + S.walker.depth_m / 2, st = prepare(S, lay, fold);
  const len = route.reduce((d, p, i) => d + (i ? Math.hypot(p[0] - route[i - 1][0], p[1] - route[i - 1][1]) : 0), 0);
  const first = startState(route, off0);
  let options: RouteOption[] = routeOptions(S, st, lay, first, route, len + 1);
  if (options.length < 1) options = [{ label: 'as planned', xy: route, length_m: len, p: 1, fork: null }];
  const u = rng(opts.seed + 101).u();   // one draw for every gait: they diverge because their odds differ, not their luck
  return gaits.map((gt, gi) => {
    const F: Fan[] = options.map((o, oi) => fan(S, st, wm, startState(o.xy, off0), o.xy, n, opts.seed + 7 * oi + 1,
      { full_route: true, max_steps: 80, lift: gt.lift, night: opts.night, fold: foldP == null ? null : { p: foldP } }));
    const risks = F.map(f => f.futures.reduce((a, x) => a + x.p, 0) / Math.max(1, f.futures.length)), odds = routeOdds(options.map(o => o.length_m), risks, riskM);
    let pick = 0;
    for (let acc = odds[0]; pick < odds.length - 1 && u > acc; acc += odds[++pick]);
    const all = F[pick].futures.filter(f => f.walker.length > 3), mean = risks[pick], crossing = all.filter(f => f.crossed);
    // the typical future: closest to this route's mean catch chance, among the ones that cross something when most do (so the ghost
    // shows the edge it is typically walking over), else among all (a clean walk when most are clean)
    const pool = crossing.length >= all.length / 2 ? crossing : all, trip = (pool.length ? pool : F[pick].futures).reduce((b, f) => (Math.abs(f.p - mean) < Math.abs(b.p - mean) ? f : b));
    const per = F.map(f => f.catches_month);
    let back: GhostRun['back'] = null;
    if (trip.fold) {
      const rev = [...options[pick].xy].reverse(), sb = startState(rev, off0), o = { full_route: true, max_steps: 80, lift: gt.lift, night: opts.night };
      back = { flat_month: fan(S, st, wm, sb, rev, n, opts.seed + 500 + gi, o).catches_month, folded_month: fan(S, prepare(S, lay, trip.fold), wm, sb, rev, n, opts.seed + 500 + gi, o).catches_month };
    }
    return { gait: gt.id, back, lift: gt.lift, pick, n, trip, poses: posesOf(trip, first.yaw), swings: trip.steps.map(x => x.p), catches_month: per[pick],
      expected_month: per.reduce((a, c, i) => a + c * odds[i], 0), folds: F[pick].futures.filter(f => f.fold).length,
      routes: options.map((o, i) => ({ label: o.label, length_m: o.length_m, risk: risks[i], odds: odds[i], catches_month: per[i] })) };
  });
}
export const liftLabel = (l: Lift) => LIFTS[l].label;

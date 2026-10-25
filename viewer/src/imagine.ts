// What the world model imagines in the kitchen, for the life-size ghosts (wmghosts.ts). Whole trips come from the real
// planner evaluator (planner.ts score(), fixed seed, so every gait style and layout walks the same random numbers), with
// what each step caught: a toe contact drawn by the rollout, a walker-frame brush (planner.ts brushes(), the same test the
// score counts). Short futures are fanned out ahead of the lead trip at each heel strike. Pure: planworker.ts runs it.
import { stamp, carvedPolys, placedFixtures, toCell, type XY, type Layout, type Pose as ObjPose } from './grid.ts';
import type { Eval, Init } from './evaluate.ts';
import { brushes, score, toLayout, type PlanLayout, type PlannerCfg } from './planner.ts';
import { contactProb, rng } from './sim.ts';
import { predict, sampleHeel, smoothRoute, type Pose, type WorldModel } from './worldmodel.ts';

type Walker = { width_m: number; depth_m: number; leg_radius_m: number };
/** p = the chance this step's swing catches the toe (sim.ts, 0 off a bump); toe = whether the drawn trip did */
export interface ImaginedStep { heel: XY; side: number; walker: Pose; toe: boolean; p: number; brush: string | null }
export interface Future { walker: XY[]; heels: XY[]; hazard: string | null }
export interface Imagined {
  trips: ImaginedStep[][];
  /** per heel strike of trip 0 (from its 3rd step): futures fanned out from that state */
  futures: Future[][];
  /** the batch tables' snag rates for this layout, where each object is (the viewer draws them per trip) */
  snags: { object: string; event: string; per_month: number; at: XY }[];
  score: { risk: number; contacts: number; snags: number; brushes: number; brush_by: Record<string, number> };
  trips_per_month: number;
}

/** what a walker pose at one step brushes (the nearest thing), or null: brushes() on a one-pose trip */
function brushAt(S: Init, cfg: PlannerCfg, lay: Layout, ev: Eval, walker: Walker, p: Pose): string | null {
  return Object.keys(brushes(S, cfg, lay, { ...ev, ghosts: [{ pts: [], hit: [], walker: [p] }] }, walker).by)[0] ?? null;
}

/** n trips of this layout walked by world model wm; futures (nf of them, `ahead` steps each) at each heel strike of trip 0.
 *  lift = this walker's toe clearance vs. the scene persona's (futures.ts LIFTS: 1 average, < 1 the shuffler); the seed is
 *  the same, so two lifts walk the same steps and differ only in what catches */
export function imagine(S0: Init, cfg: PlannerCfg, base: ObjPose[],
                        pl: PlanLayout, walker: Walker, wm: WorldModel, n: number, nf = 0, ahead = 4, lift = 1): Imagined {
  const S = { ...S0, worldModel: wm, persona: { ...S0.persona, step_model: 'world' as const, clearance_scale: (S0.persona.clearance_scale ?? 1) * lift } }, lay = toLayout(S, cfg, base, pl);
  const sc = score(S, cfg, base, pl, walker), ev = sc.ev, rd = S.routes[ev.sel] ?? S.routes[0];
  const trips = ev.ghosts.slice(0, n).map((gh, t) => gh.pts.map((heel, k) => ({ heel, side: t === 0 ? (ev.steps[k]?.side ? 1 : -1) : 0, walker: gh.walker![k],
    toe: gh.hit[k], p: gh.p?.[k] ?? 0, brush: brushAt(S, cfg, lay, ev, walker, gh.walker![k]) })));
  const snags = sc.snag_by.map(o => { const k = S.objects.findIndex(b => b.name === o.object), p = lay.poses[k]; return { ...o, at: [p.x, p.y] as XY }; });
  const out: Imagined = { trips, futures: [], snags, trips_per_month: rd.trips_per_night * S.risk.days_per_month,
    score: { risk: sc.risk, contacts: sc.contacts, snags: sc.snags, brushes: sc.brushes, brush_by: sc.brush_by } };
  if (!nf || ev.error || !trips[0]?.length) return out;
  // futures: the rollout loop of sim.ts worldRollouts, started from trip 0's state at each heel strike
  const L = stamp(S.g, S.base, S.objects, lay.poses, lay.flattened, carvedPolys(lay)), ny = S.g.shape[1], table = S.risk.contact_table[S.persona.gait_profile];
  const lights = [...S.objects.flatMap((o, k) => (o.kind === 'nightlight' && !lay.poses[k].removed ? [{ x: lay.poses[k].x, y: lay.poses[k].y, r: o.light_radius_m ?? 1.5 }] : [])),
    ...placedFixtures(S.interventions, lay).flatMap(f => (f.light_r && f.xyz ? [{ x: f.xyz[0], y: f.xyz[1], r: f.light_r }] : []))];
  const rt = smoothRoute(ev.xy), n0 = rt.length, e = rt[n0 - 1], b = rt[Math.max(0, n0 - 20)], du = Math.hypot(e[0] - b[0], e[1] - b[1]) || 1;
  const ext: XY[] = [...rt, ...[...Array(150)].map((_, i) => [e[0] + (i + 1) * 0.01 * (e[0] - b[0]) / du, e[1] + (i + 1) * 0.01 * (e[1] - b[1]) / du] as XY)];
  const T = trips[0];
  for (let k = 0; k < T.length; k++) {
    if (k < 2) { out.futures.push([]); continue; }
    const fan: Future[] = [], R = rng(1000 + k);
    for (let f = 0; f < nf; f++) {
      const heels: XY[] = [T[k].heel, T[k - 1].heel, T[k - 2].heel], sides = [T[k].side, T[k - 1].side, T[k - 2].side];
      const fu: Future = { walker: [[T[k].walker[0], T[k].walker[1]]], heels: [], hazard: null };
      const clearance = Math.exp(R.n() * S.persona.toe_clearance_cv) * (S.persona.clearance_scale ?? 1);
      let j = 0;
      for (let s = 0; s < ahead; s++) {
        const mid: XY = [(heels[0][0] + heels[1][0]) / 2, (heels[0][1] + heels[1][1]) / 2];
        let best = Infinity;
        for (let q = j; q < Math.min(j + 400, ext.length); q++) { const d = Math.hypot(ext[q][0] - mid[0], ext[q][1] - mid[1]); if (d < best) { best = d; j = q; } }
        if (j >= n0 - 16) break;
        const p = predict(wm, heels, sides, [25, 50, 100].map(o => ext[Math.min(j + o, ext.length - 1)])), foot = sampleHeel(p, R.u, R.n), from = heels[1];
        // toe: the highest bump the swing passes over, drawn as the rollout draws it; then the frame's brush test
        const ns = Math.max(2, Math.ceil(Math.hypot(foot[0] - from[0], foot[1] - from[1]) / (S.g.cell_m / 2)));
        let h = 0;
        for (let q = 0; q <= ns; q++) { const [ci, cj] = toCell(S.g, [from[0] + (foot[0] - from[0]) * q / ns, from[1] + (foot[1] - from[1]) * q / ns]); h = Math.max(h, L.bump[ci * ny + cj]); }
        const lit = lights.some(l => Math.hypot(foot[0] - l.x, foot[1] - l.y) <= l.r), dark = rd.night && !lit ? S.risk.dark_contact_multiplier : 1;
        if (!fu.hazard && h > 0 && R.u() < Math.min(1, contactProb(table, h / clearance) * dark)) fu.hazard = 'toe catch';
        fu.hazard ??= brushAt(S, cfg, lay, ev, walker, p.walker);
        fu.heels.push(foot); fu.walker.push([p.walker[0], p.walker[1]]);
        heels.unshift(foot); heels.length = 3; sides.unshift(-sides[0]); sides.length = 3;
      }
      fan.push(fu);
    }
    out.futures.push(fan);
  }
  return out;
}

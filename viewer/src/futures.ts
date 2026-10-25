// The world model's futures fan, from the walker's CURRENT state (live, every ~0.5 s; futuresfan.ts draws it, fanworker.ts
// runs it). ~30 rollouts 4-5 s ahead, with the rollout loop and checks of sim.ts (world model: worldRollouts; hand rule:
// rollouts()), split over 2-4 candidate routes where the way ahead forks (over / around the mat, past / wide of a chair:
// routeOptions). Checks: each swing's rise over an edge against that swing's toe clearance, drawn from the published curve
// (LIFTS), and the walker frame against the furniture (the planner's brush test, planner.ts brushes()). A future is red if a
// toe passes lower than an edge of >= hazard_rules.bump_min_m it rises over, or its frame comes within brush_m of a piece of
// furniture; p is the chance the toe actually catches (contact table), kept apart. Imagined, never measured. Pure: node
// tests run it on the exported scene.
import { stamp, edt, plan, toCell, cellXY, carvedPolys, worldFootprint, polyCells, type GridMeta, type Layers, type Layout, type PlanParams, type XY } from './grid.ts';
import { contactProb, rng, type Persona, type Risk } from './sim.ts';
import { predict, sampleHeel, smoothRoute, type Pose, type WorldModel } from './worldmodel.ts';

export interface FanScene {
  g: GridMeta; base: Layers; est: Uint8Array; persona: Persona; risk: Risk; rules: { bump_min_m: number };
  objects: { name: string; kind: string; layer: string; footprint: XY[]; pivot: number[]; height_m: number; light_radius_m?: number }[];
  walker: { width_m: number; depth_m: number; leg_radius_m: number; user_gap_m: number };
  brush_m?: number; speed_mps?: number; plan?: PlanParams;
}
/** a folded corner (livephys flapInfo while folded): the doubled-over cloth stands up near that corner */
export interface Fold { corner: XY; lift_m: number; size_m: number }
/** crossed = the edge (mat, cord, folded corner) a swing rose over, hit or not; route = index into Fan.routes */
export interface Future { walker: XY[]; heels: XY[]; end: Pose; hazard: string | null; at: XY | null; p: number; crossed: string | null; route: number }
export interface RouteOption { label: string; xy: XY[]; length_m: number; p: number; fork: XY | null }
export interface Fan {
  futures: Future[]; counts: Record<string, number>; crossed: Record<string, number>; spread_m: number; path: 'route' | 'heading';
  routes: { label: string; p: number; n: number; fork: XY | null; tip: XY | null }[]; ahead_s: number; lift: Lift;
}

/** Foot lift: each swing's minimum toe clearance (MTC) is drawn from the published older-adult curve, lognormal 14.1 +- 8.3 mm
 *  (Frontiers 2014, the curve tools/contact_table.py fits the trip-odds table to). A swing "hits the edge" when its toe passes
 *  lower than the edge it rises over. People lift their feet higher over edges they see, so most of these never become trips:
 *  the trip odds (p, the contact table) stay apart. */
const MTC_MEAN_M = 0.0141, MTC_SD_M = 0.0083, MTC_S = Math.sqrt(Math.log(1 + (MTC_SD_M / MTC_MEAN_M) ** 2)), MTC_MED_M = MTC_MEAN_M / Math.sqrt(1 + (MTC_SD_M / MTC_MEAN_M) ** 2);
/** The fan's personas until shuffle recordings exist. "Shuffler" = a person whose foot lift sits at the published curve's
 *  16th percentile (its median x e^-s, ~7 mm typical MTC instead of ~12); it scales both the MTC draw and the trip-odds
 *  lookup (clearance_scale). ASSUMPTION: a percentile of the published curve, not a measured shuffling group (Alcock 2018
 *  measured Parkinson's MTC no lower than controls'). */
export const LIFTS = {
  average: { label: 'average foot lift', scale: 1 },
  shuffler: { label: 'low-clearance shuffler', scale: Math.exp(-MTC_S) },
};
export type Lift = keyof typeof LIFTS;
/** route odds: ASSUMPTION, a softmax on planned path length, each extra ROUTE_TAU_M of walking e times less likely (not fitted to people's choices) */
export const ROUTE_TAU_M = 0.5;
const AHEAD_S: [number, number] = [4, 5];
export interface Stamped { L: Layers; owner: Int16Array; dist: Float32Array; lights: { x: number; y: number; r: number }[] }

const FOLD = -2, CORD = -1;
/** the layout's floor map plus who owns each bump / obstacle cell, and the distance (m) to the nearest furniture
 *  (movable obstacles: walls and counters are the route's business, not a hazard the fan names) */
export function prepare(S: FanScene, lay: Layout, fold: Fold | null): Stamped {
  const { g } = S, [nx, ny] = g.shape, L = stamp(g, S.base, S.objects as any, lay.poses, lay.flattened, carvedPolys(lay));
  const owner = new Int16Array(nx * ny), furn = new Uint8Array(nx * ny);
  for (let c = 0; c < owner.length; c++) if (S.est[c] && L.bump[c] > 0) owner[c] = CORD;
  S.objects.forEach((o, k) => {
    if (lay.poses[k].removed || o.layer === 'none') return;
    for (const c of polyCells(g, worldFootprint(o as any, lay.poses[k]))) {
      if (o.layer === 'obstacle') { owner[c] = k + 1; furn[c] = 1; }
      else if (L.bump[c] > 0) owner[c] = k + 1;   // a taped strip zeroed it: nothing to own
    }
  });
  if (fold) {
    // shortcut: the fold is a disc of the curl's measured lift around the corner, not the flap's shape; upgrade with flapInfo.tri
    const r = Math.ceil(fold.size_m / 2 / g.cell_m), [ci, cj] = toCell(g, fold.corner);
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny || di * di + dj * dj > r * r) continue;
      L.bump[i * ny + j] = Math.max(L.bump[i * ny + j], fold.lift_m); owner[i * ny + j] = FOLD;
    }
  }
  const d = edt(furn, nx, ny);
  for (let c = 0; c < d.length; c++) d[c] *= g.cell_m;
  // shortcut: nightlight objects only (evaluate.ts also counts added light fixtures); upgrade if the fan is used on a lit-path layout
  const lights = S.objects.flatMap((o, k) => (o.kind === 'nightlight' && !lay.poses[k].removed ? [{ x: lay.poses[k].x, y: lay.poses[k].y, r: o.light_radius_m ?? 1.5 }] : []));
  return { L, owner, dist: d, lights };
}

/** what a swing crossed, by the cell that set its highest point: "mat edge" when the swing came from off the mat */
function bumpName(S: FanScene, st: Stamped, c: number, fromOff: boolean): string {
  const o = st.owner[c];
  if (o === FOLD) return 'folded corner';
  if (o === CORD) return 'cord';
  if (o > 0) { const ob = S.objects[o - 1]; return ob.kind === 'rug' ? `${ob.name}${fromOff ? ' edge' : ''}` : ob.name; }
  return 'floor bump';
}
/** the nearest furniture within brush_m of the frame's two sides and front (brushes()' 3 x 12 sample points), or null */
function brushName(S: FanScene, st: Stamped, [x, y, yaw]: Pose): { name: string; at: XY } | null {
  const { g } = S, ny = g.shape[1], w = S.walker, a = w.depth_m / 2, b = w.width_m / 2 - w.leg_radius_m, bm = S.brush_m ?? 0.03;
  const d: XY = [Math.cos(yaw), Math.sin(yaw)], l: XY = [-d[1], d[0]];
  const leg = (s: number, t: number): XY => [x + s * a * d[0] + t * b * l[0], y + s * a * d[1] + t * b * l[1]];
  const P = [leg(1, 1), leg(1, -1), leg(-1, 1), leg(-1, -1)];
  let best: { c: number; d: number; at: XY } | null = null;
  for (const [p, q] of [[P[0], P[2]], [P[1], P[3]], [P[0], P[1]]]) for (let s = 0; s < 12; s++) {
    const u = s / 11, pt: XY = [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1])], [i, j] = toCell(g, pt), dd = st.dist[i * ny + j] - g.cell_m / 2;
    if (dd < bm && (!best || dd < best.d)) best = { c: i * ny + j, d: dd, at: pt };
  }
  if (!best) return null;
  // the owner: nearest furniture cell around the point
  const r = Math.ceil((bm + g.cell_m) / g.cell_m) + 1, ci = Math.floor(best.c / ny), cj = best.c % ny;
  let bd = Infinity, who = 0;
  for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
    const i = ci + di, j = cj + dj, c = i * ny + j;
    if (i < 0 || j < 0 || i >= g.shape[0] || j >= ny || st.owner[c] <= 0 || S.objects[st.owner[c] - 1].layer !== 'obstacle' || di * di + dj * dj >= bd) continue;
    bd = di * di + dj * dj; who = st.owner[c];
  }
  if (!who) return null;
  const o = S.objects[who - 1];
  return { name: o.kind === 'chair' ? 'chair' : o.name.replace(/_/g, ' '), at: best.at };
}

/** the path the futures follow: the planned route ahead (resampled every 1 cm) if the walker is on it and facing along it,
 *  else straight ahead along its heading (free walk off the route); extended 1.5 m past the end like worldRollouts */
function pathAhead(state: { x: number; y: number; yaw: number }, route: XY[] | null): { P: XY[]; kind: Fan['path'] } {
  const h: XY = [Math.cos(state.yaw), Math.sin(state.yaw)];
  let P: XY[] | null = null;
  if (route && route.length > 1) {
    const rt = smoothRoute(route);
    let k = 0, bd = Infinity;
    rt.forEach((p, i) => { const d = Math.hypot(p[0] - state.x, p[1] - state.y); if (d < bd) { bd = d; k = i; } });
    const q = rt[Math.min(rt.length - 1, k + 30)], t = Math.hypot(q[0] - rt[k][0], q[1] - rt[k][1]);
    if (bd < 0.6 && t > 0.1 && ((q[0] - rt[k][0]) * h[0] + (q[1] - rt[k][1]) * h[1]) / t > 0.5) P = rt.slice(k);
  }
  const kind: Fan['path'] = P && P.length > 20 ? 'route' : 'heading';
  if (kind === 'heading') P = [...Array(300)].map((_, i) => [state.x + i * 0.01 * h[0], state.y + i * 0.01 * h[1]] as XY);
  const e = P![P!.length - 1], b = P![Math.max(0, P!.length - 20)], du = Math.hypot(e[0] - b[0], e[1] - b[1]) || 1;
  return { P: [...P!, ...[...Array(150)].map((_, i) => [e[0] + (i + 1) * 0.01 * (e[0] - b[0]) / du, e[1] + (i + 1) * 0.01 * (e[1] - b[1]) / du] as XY)], kind };
}

/** "wide of the chair": keep-out band around the footprint (the planner's own walker inflation comes on top) */
const WIDE_M = 0.25;
const segD = (p: XY, a: XY, b: XY) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const polyD = (p: XY, poly: XY[]) => Math.min(...poly.map((a, i) => segD(p, a, poly[(i + 1) % poly.length])));
const lineD = (p: XY, P: XY[]) => { let d = Infinity; for (let i = 1; i < P.length; i++) d = Math.min(d, segD(p, P[i - 1], P[i])); return d; };
const firstM = (P: XY[], m: number) => { const out: XY[] = [P[0]]; for (let i = 1, d = 0; i < P.length && d < m; i++) { d += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); out.push(P[i]); } return out; };

/** The candidate routes from the walker frame (in front of `state`, the body) to the planned route's goal: the plan from
 *  here, plus one alternative per decision point within horizon_m, nearest first, at most 3: a mat / cord edge the plan
 *  crosses -> the plan that keeps off it ("around the mat"); furniture the plan passes within 15 cm of the frame's side ->
 *  the plan that keeps its footprint WIDE_M clear ("wide of the chair"). Kept only if it really differs ahead (> 15 cm from every route so
 *  far). Odds: softmax on path length (ROUTE_TAU_M, ASSUMPTION). */
export function routeOptions(S: FanScene, st: Stamped, lay: Layout, state: { x: number; y: number; yaw: number }, route: XY[], horizon_m: number): RouteOption[] {
  const { g } = S, ny = g.shape[1], pp = S.plan ?? { walker_width_m: S.walker.width_m, preferred_clearance_m: 0.1, clearance_weight: 1 };
  const off0 = S.walker.user_gap_m + S.walker.depth_m / 2, start: XY = [state.x + off0 * Math.cos(state.yaw), state.y + off0 * Math.sin(state.yaw)], goal = route[route.length - 1];
  const main = plan(g, st.L, start, goal, pp);
  if (main.error || main.xy.length < 2) return [];
  const ahead = firstM(main.xy, horizon_m), half = pp.walker_width_m / 2;
  const name = (o: FanScene['objects'][number]) => (o.kind === 'chair' ? 'chair' : o.name.replace(/_/g, ' '));
  const cand: { i: number; k: number; bump: boolean; fp: XY[] }[] = [];
  S.objects.forEach((o, k) => {
    if (lay.poses[k].removed || o.layer === 'none') return;
    const fp = worldFootprint(o as any, lay.poses[k]);
    let i = -1;
    if (o.layer === 'obstacle') i = ahead.findIndex(p => polyD(p, fp) < half + 0.15);
    else {
      const cells = new Set(polyCells(g, fp).filter(c => st.L.bump[c] >= S.rules.bump_min_m));   // taped: below the threshold, no decision
      i = ahead.findIndex(p => { const [a, b] = toCell(g, p); return cells.has(a * ny + b); });
    }
    // a decision still ahead: the frame already at it (< 25 cm) can't choose any more
    if (i >= 0 && firstM(ahead, 0.25).length <= i) cand.push({ i, k, bump: o.layer !== 'obstacle', fp });
  });
  const out: RouteOption[] = [{ label: '', xy: main.xy, length_m: main.length_m, p: 1, fork: null }], mainLabel: string[] = [];
  for (const c of cand.sort((a, b) => a.i - b.i)) {
    if (out.length >= 4) break;
    const obst = st.L.obst.slice(), nm = name(S.objects[c.k]);
    if (c.bump) for (const q of polyCells(g, c.fp)) obst[q] = 1;
    else {
      const xs = c.fp.map(p => p[0]), ys = c.fp.map(p => p[1]);
      const [i0, j0] = toCell(g, [Math.min(...xs) - WIDE_M, Math.min(...ys) - WIDE_M]), [i1, j1] = toCell(g, [Math.max(...xs) + WIDE_M, Math.max(...ys) + WIDE_M]);
      for (let i = Math.max(0, i0); i <= Math.min(g.shape[0] - 1, i1); i++) for (let j = Math.max(0, j0); j <= Math.min(ny - 1, j1); j++) if (polyD(cellXY(g, i * ny + j), c.fp) < WIDE_M) obst[i * ny + j] = 1;
    }
    const alt = plan(g, { ...st.L, obst }, start, goal, pp);
    if (alt.error || alt.xy.length < 2) continue;
    const altAhead = firstM(alt.xy, horizon_m);
    if (out.some(r => Math.max(...altAhead.map(p => lineD(p, r.xy))) < 0.15)) continue;
    out.push({ label: c.bump ? `around the ${nm}` : `wide of the ${nm}`, xy: alt.xy, length_m: alt.length_m, p: 1, fork: altAhead.find(p => lineD(p, main.xy) > 0.05) ?? null });
    mainLabel.push(c.bump ? `over the ${nm}` : `past the ${nm}`);
  }
  out[0].label = mainLabel.join(', ') || 'as planned';
  const m = Math.min(...out.map(r => r.length_m)), e = out.map(r => Math.exp(-(r.length_m - m) / ROUTE_TAU_M)), z = e.reduce((a, b) => a + b);
  out.forEach((r, i) => (r.p = e[i] / z));
  return out;
}
/** the horizon: 4 s, stretched up to 5 s so it reaches 1 m past the nearest fork */
export function horizonS(S: FanScene, routes: RouteOption[], state: { x: number; y: number }): number {
  const v = S.speed_mps ?? S.persona.speed_mps ?? 0.45, forks = routes.flatMap(r => (r.fork ? [Math.hypot(r.fork[0] - state.x, r.fork[1] - state.y)] : []));
  return forks.length ? Math.min(AHEAD_S[1], Math.max(AHEAD_S[0], (Math.min(...forks) + 1) / v)) : AHEAD_S[0];
}

/** n futures from `state` (the person: body centre + heading). wm = the learned world model, null = the hand rule.
 *  routes (routeOptions): each future follows one, drawn by its odds; none = the planned route (or straight ahead). */
export function fan(S: FanScene, st: Stamped, wm: WorldModel | null, state: { x: number; y: number; yaw: number }, route: XY[] | null,
                    n: number, seed: number, opts: { ahead_s?: number; night?: boolean; routes?: RouteOption[]; lift?: Lift } = {}): Fan {
  const { g, persona: pe, risk } = S, ny = g.shape[1], table = risk.contact_table[pe.gait_profile];
  if (!table) throw new Error(`no contact_table for gait profile ${pe.gait_profile}`);
  const ahead_s = opts.ahead_s ?? AHEAD_S[0], ahead = ahead_s * (S.speed_mps ?? pe.speed_mps ?? 0.45), off0 = S.walker.user_gap_m + S.walker.depth_m / 2;
  const main = pathAhead(state, route), kind = main.kind, R = rng(seed), counts: Record<string, number> = {}, crossed: Record<string, number> = {}, futures: Future[] = [];
  const opt = kind === 'route' && opts.routes && opts.routes.length > 1 ? opts.routes : null;
  const paths = opt ? opt.map(r => pathAhead(state, r.xy).P) : [main.P], lift = opts.lift ?? 'average', ls = LIFTS[lift].scale;
  const routes: Fan['routes'] = (opt ?? [{ label: 'as planned', p: 1, fork: null }]).map((r, i) => ({ label: r.label, p: r.p, n: 0, fork: r.fork, tip: paths[i][Math.min(paths[i].length - 1, Math.round(ahead * 0.8 / 0.01))] }));
  let P = paths[0];
  const lights = st.lights, night = opts.night ?? true;
  // the swing check of the main rollouts, plus its name and where
  const swing = (from: XY, foot: XY, clearance: number, fu: Future) => {
    const ns = Math.max(2, Math.ceil(Math.hypot(foot[0] - from[0], foot[1] - from[1]) / (g.cell_m / 2)));
    let h = 0, hc = -1;
    for (let q = 0; q <= ns; q++) { const [i, j] = toCell(g, [from[0] + (foot[0] - from[0]) * q / ns, from[1] + (foot[1] - from[1]) * q / ns]), c = i * ny + j; if (st.L.bump[c] > h) { h = st.L.bump[c]; hc = c; } }
    if (h <= 0) return;
    const lit = lights.some(l => Math.hypot(foot[0] - l.x, foot[1] - l.y) <= l.r), dark = night && !lit ? risk.dark_contact_multiplier : 1;
    fu.p = 1 - (1 - fu.p) * (1 - Math.min(1, contactProb(table, h / clearance) * dark));
    // an edge the swing rises over (stepping along the top of a mat or down off it is not)
    const [fi, fj] = toCell(g, from), rise = h - st.L.bump[fi * ny + fj];
    if (rise < S.rules.bump_min_m) return;
    const nm = bumpName(S, st, hc, true);
    fu.crossed ??= nm.replace(/ edge$/, '');
    if (!fu.hazard && MTC_MED_M * ls * Math.exp(MTC_S * R.n()) < rise) { fu.hazard = nm; fu.at = cellXY(g, hc); }
  };
  const frame = (p: Pose, fu: Future) => { if (fu.hazard) return; const b = brushName(S, st, p); if (b) { fu.hazard = b.name; fu.at = b.at; } };
  const travel = (fu: Future) => { let d = 0; for (let k = 1; k < fu.walker.length; k++) d += Math.hypot(fu.walker[k][0] - fu.walker[k - 1][0], fu.walker[k][1] - fu.walker[k - 1][1]); return d; };
  const nearest = (p: XY, j: number, w: number) => { let best = Infinity, bj = j; for (let q = j; q < Math.min(j + w, P.length); q++) { const d = Math.hypot(P[q][0] - p[0], P[q][1] - p[1]); if (d < best) { best = d; bj = q; } } return bj; };
  const c0: XY = [state.x + off0 * Math.cos(state.yaw), state.y + off0 * Math.sin(state.yaw)];
  for (let f = 0; f < n; f++) {
    let r = 0;
    for (let u = R.u(); r < routes.length - 1 && (u -= routes[r].p) > 0; r++);
    P = paths[r]; routes[r].n++;
    const clearance = Math.exp(R.n() * pe.toe_clearance_cv) * (pe.clearance_scale ?? 1) * ls;
    const fu: Future = { walker: [c0], heels: [], end: [c0[0], c0[1], state.yaw], hazard: null, at: null, p: 0, crossed: null, route: r };
    if (wm) {
      // worldRollouts: heels seeded around the person, mid-heels at the body; actions = path points 25/50/100 cm ahead
      const L0 = pe.stride_m, Wd = pe.foot_sep_m, s0 = R.u() < 0.5 ? -1 : 1, ux = Math.cos(state.yaw), uy = Math.sin(state.yaw);
      const at = (a: number, l: number): XY => [state.x + a * ux - l * uy, state.y + a * uy + l * ux];
      const heels: XY[] = [at(L0 / 2, s0 * Wd / 2), at(-L0 / 2, -s0 * Wd / 2), at(-1.5 * L0, s0 * Wd / 2)], sides = [s0, -s0, s0];
      const last: XY[] = s0 > 0 ? [heels[1], heels[0]] : [heels[0], heels[1]];
      for (let k = 0, s = 0; s < 30 && travel(fu) < ahead; s++) {
        k = nearest([(heels[0][0] + heels[1][0]) / 2, (heels[0][1] + heels[1][1]) / 2], k, 120);
        const p = predict(wm, heels, sides, [25, 50, 100].map(o => P[Math.min(k + o, P.length - 1)])), foot = sampleHeel(p, R.u, R.n), side = -sides[0], fi = side > 0 ? 1 : 0;
        swing(last[fi], foot, clearance, fu); frame(p.walker, fu);
        last[fi] = foot; heels.unshift(foot); heels.length = 3; sides.unshift(side); sides.length = 3;
        fu.heels.push(foot); fu.walker.push([p.walker[0], p.walker[1]]); fu.end = p.walker;
      }
    } else {
      // rollouts() hand rule: feet on the path +- foot_sep/2, the trip's offset and step jitter; the frame on the path ahead
      const off = R.n() * risk.path_offset_sd_m, step = Math.max(0.15, pe.stride_m * (1 + R.n() * pe.stride_cv));
      let j = nearest([state.x, state.y], 0, 200), u = j, side = R.u() < 0.5 ? 1 : 0;
      const last: (XY | null)[] = [null, null];
      for (let s = 0; s < 30 && travel(fu) < ahead; s++, side ^= 1) {
        u += step / 0.01; j = Math.min(P.length - 2, Math.round(u));
        const t: XY = [P[j + 1][0] - P[j][0], P[j + 1][1] - P[j][1]], tl = Math.hypot(t[0], t[1]) || 1, nx = -t[1] / tl, nyv = t[0] / tl;
        const lat = off + (side ? 1 : -1) * pe.foot_sep_m / 2 + R.n() * risk.step_jitter_m, foot: XY = [P[j][0] + nx * lat, P[j][1] + nyv * lat];
        if (last[side]) swing(last[side]!, foot, clearance, fu);
        last[side] = foot;
        const cj = Math.min(P.length - 2, j + Math.round(off0 / 0.01)), w: Pose = [P[cj][0] + nx * off, P[cj][1] + nyv * off, Math.atan2(P[cj + 1][1] - P[cj][1], P[cj + 1][0] - P[cj][0])];
        frame(w, fu);
        fu.heels.push(foot); fu.walker.push([w[0], w[1]]); fu.end = w;
      }
    }
    if (fu.hazard) counts[fu.hazard] = (counts[fu.hazard] ?? 0) + 1;
    if (fu.crossed) crossed[fu.crossed] = (crossed[fu.crossed] ?? 0) + 1;
    futures.push(fu);
  }
  return { futures, counts, crossed, spread_m: spread(futures), path: kind, routes, ahead_s, lift };
}

/** sd of the futures' end points across their mean heading (m): how wide the fan opens */
export function spread(fs: Future[]): number {
  if (fs.length < 2) return 0;
  const m = fs.reduce((a, f) => [a[0] + f.end[0] / fs.length, a[1] + f.end[1] / fs.length], [0, 0]);
  const yaw = Math.atan2(fs.reduce((a, f) => a + Math.sin(f.end[2]), 0), fs.reduce((a, f) => a + Math.cos(f.end[2]), 0)), l: XY = [-Math.sin(yaw), Math.cos(yaw)];
  const v = fs.map(f => (f.end[0] - m[0]) * l[0] + (f.end[1] - m[1]) * l[1]);
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
}
/** the label: "World model: 12/30 cross the mat · 5 hit the edge" (the most crossed edge), then the other hazards;
 *  nothing crossed: "World model: 30 imagined futures · 4 hit the chair" (the most common hazard) or "all clear" */
export function fanLabel(F: Fan, model: string): string {
  const n = F.futures.length, edge = Object.entries(F.crossed).sort((a, b) => b[1] - a[1])[0];
  const hit = edge ? F.futures.filter(f => f.crossed === edge[0] && f.hazard?.replace(/ edge$/, '') === edge[0]).length : 0;
  const rest = Object.entries(F.counts).filter(([k]) => !edge || k.replace(/ edge$/, '') !== edge[0]).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c} hit the ${k}`);
  const lead = edge ? `${edge[1]}/${n} cross the ${edge[0]} · ${hit} hit the edge` : `${n} imagined futures${rest.length ? '' : ' · all clear'}`;
  return [`${model}: ${lead}`, ...rest].join(' · ');
}
/** "18 over the mat · 12 around the mat" (only when the way ahead forks) */
export function routeLabel(F: Fan): string {
  return F.routes.length > 1 ? F.routes.map(r => `${r.n} ${r.label}`).join(' · ') : '';
}

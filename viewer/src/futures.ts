// The world model's futures fan, from the walker's CURRENT state (live, every ~0.5 s; futuresfan.ts draws it, fanworker.ts
// runs it). ~30 short rollouts 2-3 s ahead, with the rollout loop and checks of sim.ts (world model: worldRollouts; hand
// rule: rollouts()): each swing's highest bump (the toe check), and the walker frame against the furniture (the planner's
// brush test, planner.ts brushes()). A future is red if any of its swings crosses a bump >= hazard_rules.bump_min_m or its
// frame comes within brush_m of a piece of furniture; p is the chance the toe actually catches (contact table), kept apart.
// Imagined, never measured. Pure: node tests run it on the exported scene.
import { stamp, edt, toCell, cellXY, carvedPolys, worldFootprint, polyCells, type GridMeta, type Layers, type Layout, type XY } from './grid.ts';
import { contactProb, rng, type Persona, type Risk } from './sim.ts';
import { predict, sampleHeel, smoothRoute, type Pose, type WorldModel } from './worldmodel.ts';

export interface FanScene {
  g: GridMeta; base: Layers; est: Uint8Array; persona: Persona; risk: Risk; rules: { bump_min_m: number };
  objects: { name: string; kind: string; layer: string; footprint: XY[]; pivot: number[]; height_m: number; light_radius_m?: number }[];
  walker: { width_m: number; depth_m: number; leg_radius_m: number; user_gap_m: number };
  brush_m?: number; speed_mps?: number;
}
/** a folded corner (livephys flapInfo while folded): the doubled-over cloth stands up near that corner */
export interface Fold { corner: XY; lift_m: number; size_m: number }
export interface Future { walker: XY[]; heels: XY[]; end: Pose; hazard: string | null; at: XY | null; p: number }
export interface Fan { futures: Future[]; counts: Record<string, number>; spread_m: number; path: 'route' | 'heading' }
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

/** n futures from `state` (the person: body centre + heading). wm = the learned world model, null = the hand rule. */
export function fan(S: FanScene, st: Stamped, wm: WorldModel | null, state: { x: number; y: number; yaw: number }, route: XY[] | null,
                    n: number, seed: number, opts: { ahead_s?: number; night?: boolean } = {}): Fan {
  const { g, persona: pe, risk } = S, ny = g.shape[1], table = risk.contact_table[pe.gait_profile];
  if (!table) throw new Error(`no contact_table for gait profile ${pe.gait_profile}`);
  const ahead = (opts.ahead_s ?? 2.5) * (S.speed_mps ?? pe.speed_mps ?? 0.45), off0 = S.walker.user_gap_m + S.walker.depth_m / 2;
  const { P, kind } = pathAhead(state, route), R = rng(seed), counts: Record<string, number> = {}, futures: Future[] = [];
  const lights = st.lights, night = opts.night ?? true;
  // the swing check of the main rollouts, plus its name and where
  const swing = (from: XY, foot: XY, clearance: number, fu: Future) => {
    const ns = Math.max(2, Math.ceil(Math.hypot(foot[0] - from[0], foot[1] - from[1]) / (g.cell_m / 2)));
    let h = 0, hc = -1;
    for (let q = 0; q <= ns; q++) { const [i, j] = toCell(g, [from[0] + (foot[0] - from[0]) * q / ns, from[1] + (foot[1] - from[1]) * q / ns]), c = i * ny + j; if (st.L.bump[c] > h) { h = st.L.bump[c]; hc = c; } }
    if (h <= 0) return;
    const lit = lights.some(l => Math.hypot(foot[0] - l.x, foot[1] - l.y) <= l.r), dark = night && !lit ? risk.dark_contact_multiplier : 1;
    fu.p = 1 - (1 - fu.p) * (1 - Math.min(1, contactProb(table, h / clearance) * dark));
    if (!fu.hazard && h >= S.rules.bump_min_m) {
      const [fi, fj] = toCell(g, from);
      fu.hazard = bumpName(S, st, hc, st.L.bump[fi * ny + fj] < h); fu.at = cellXY(g, hc);
    }
  };
  const frame = (p: Pose, fu: Future) => { if (fu.hazard) return; const b = brushName(S, st, p); if (b) { fu.hazard = b.name; fu.at = b.at; } };
  const travel = (fu: Future) => { let d = 0; for (let k = 1; k < fu.walker.length; k++) d += Math.hypot(fu.walker[k][0] - fu.walker[k - 1][0], fu.walker[k][1] - fu.walker[k - 1][1]); return d; };
  const nearest = (p: XY, j: number, w: number) => { let best = Infinity, bj = j; for (let q = j; q < Math.min(j + w, P.length); q++) { const d = Math.hypot(P[q][0] - p[0], P[q][1] - p[1]); if (d < best) { best = d; bj = q; } } return bj; };
  const c0: XY = [state.x + off0 * Math.cos(state.yaw), state.y + off0 * Math.sin(state.yaw)];
  for (let f = 0; f < n; f++) {
    const clearance = Math.exp(R.n() * pe.toe_clearance_cv) * (pe.clearance_scale ?? 1);
    const fu: Future = { walker: [c0], heels: [], end: [c0[0], c0[1], state.yaw], hazard: null, at: null, p: 0 };
    if (wm) {
      // worldRollouts: heels seeded around the person, mid-heels at the body; actions = path points 25/50/100 cm ahead
      const L0 = pe.stride_m, Wd = pe.foot_sep_m, s0 = R.u() < 0.5 ? -1 : 1, ux = Math.cos(state.yaw), uy = Math.sin(state.yaw);
      const at = (a: number, l: number): XY => [state.x + a * ux - l * uy, state.y + a * uy + l * ux];
      const heels: XY[] = [at(L0 / 2, s0 * Wd / 2), at(-L0 / 2, -s0 * Wd / 2), at(-1.5 * L0, s0 * Wd / 2)], sides = [s0, -s0, s0];
      const last: XY[] = s0 > 0 ? [heels[1], heels[0]] : [heels[0], heels[1]];
      for (let k = 0, s = 0; s < 12 && travel(fu) < ahead; s++) {
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
      for (let s = 0; s < 12 && travel(fu) < ahead; s++, side ^= 1) {
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
    futures.push(fu);
  }
  return { futures, counts, spread_m: spread(futures), path: kind };
}

/** sd of the futures' end points across their mean heading (m): how wide the fan opens */
export function spread(fs: Future[]): number {
  if (fs.length < 2) return 0;
  const m = fs.reduce((a, f) => [a[0] + f.end[0] / fs.length, a[1] + f.end[1] / fs.length], [0, 0]);
  const yaw = Math.atan2(fs.reduce((a, f) => a + Math.sin(f.end[2]), 0), fs.reduce((a, f) => a + Math.cos(f.end[2]), 0)), l: XY = [-Math.sin(yaw), Math.cos(yaw)];
  const v = fs.map(f => (f.end[0] - m[0]) * l[0] + (f.end[1] - m[1]) * l[1]);
  return Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
}
/** the label: "World model: 30 imagined futures · 12 hit the mat edge" (the most common hazard) */
export function fanLabel(F: Fan, model: string): string {
  const top = Object.entries(F.counts).sort((a, b) => b[1] - a[1])[0];
  return `${model}: ${F.futures.length} imagined futures · ${top ? `${top[1]} hit the ${top[0]}` : 'all clear'}`;
}

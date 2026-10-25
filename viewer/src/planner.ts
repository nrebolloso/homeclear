// Kitchen planner (configs/planner/<scene>.json): a layout is where the table chairs stand (5 cm grid, 90 deg turns), the
// mat's state, the cord's state and which outlet has the nightlight. Score = expected toe contacts + simulated object
// snags (the MuJoCo batch tables) + walker-frame brushes per month, every term from evaluate() with its fixed seed, so
// two layouts see the same trips (common random numbers) and their difference is the layout's, not the dice's.
// The GPU search (planner/) mirrors this file; planner/rescore.ts re-scores its answers here so the viewer shows these numbers.
import { polyCells, worldFootprint, toCell, type Layout, type Pose, type XY } from './grid.ts';
import { evaluate, type Init, type Eval } from './evaluate.ts';
import { moveCost, fixCost } from './movecost.ts';
import { effortKind } from './effort.ts';

type Opt = { label: string; cost_usd: number; minutes: number; effort: number; product?: string; assumption?: string } | { from_fix: string };
export interface PlannerCfg {
  scene: string; grid_m: number; yaw_step_deg: number; table: string; chairs: string[]; chair_reach_m: number; chair_overlap_frac: number; under_table_frac: number;
  mat: string; cord_box_xy: [XY, XY]; nightlight: string;
  zones: Record<string, { box_xy: [XY, XY]; source: string }>;
  outlets: Record<string, { xy: XY; source: string }>;
  options: { mat: Record<string, Opt>; cord: Record<string, Opt>; nightlight: Record<string, Opt>; walker?: Record<string, Opt> };
  brush_m: number;
}
export type MatState = 'present' | 'taped' | 'moved' | 'removed';
export type CordState = 'present' | 'taped' | 'rerouted';
/** chairs: [x, y, yaw_deg]; nightlight: an outlet name or 'off' (nightlight_at: dragged somewhere else, flagged) */
export interface PlanLayout {
  chairs: Record<string, [number, number, number]>; mat: MatState; mat_at?: [number, number, number];
  cord: CordState; nightlight: string; nightlight_at?: XY;
  /** glide caps / tennis balls on the walker's rear legs (options.walker.caps) */
  caps?: boolean;
}
export interface Item { key: string; label: string; usd: number; minutes: number; effort: number; product?: string; assumption?: string }
export interface Cost { usd: number; minutes: number; effort: number; items: Item[] }
export interface PlanScore {
  /** contacts + snags + brushes per month, and its range: the contacts' and brushes' 10-90% over batches of trips
   *  plus the snag tables' 95% bin intervals */
  risk: number; lo: number; hi: number; contacts: number; snags: number; brushes: number;
  snag_by: { object: string; event: string; per_month: number }[]; brush_by: Record<string, number>;
  error?: string; ev: Eval;
}

const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => Math.round(((r * 180) / Math.PI) % 360 + 360) % 360;
const idx = (S: Init, name: string) => { const k = S.objects.findIndex(o => o.name === name); if (k < 0) throw new Error(`planner: no object ${name}`); return k; };
const box = ([[x0, y0], [x1, y1]]: [XY, XY]): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The planner's view of an engine layout (the scanned room, or a judge's edits in the viewer). */
export function fromLayout(S: Init, cfg: PlannerCfg, base: Pose[], lay: Layout): PlanLayout {
  const p = (n: string) => lay.poses[idx(S, n)], m = p(cfg.mat), m0 = base[idx(S, cfg.mat)], nl = p(cfg.nightlight);
  const [[cx0, cy0], [cx1, cy1]] = cfg.cord_box_xy;
  const cordFlat = lay.flattened.some(([[x0, y0], [x1, y1]]) => x0 <= cx0 + 0.05 && y0 <= cy0 + 0.05 && x1 >= cx1 - 0.05 && y1 >= cy1 - 0.05);
  const outlet = Object.entries(cfg.outlets).find(([, o]) => Math.hypot(o.xy[0] - nl.x, o.xy[1] - nl.y) < 0.15)?.[0];
  const moved = Math.hypot(m.x - m0.x, m.y - m0.y) > 0.01 || Math.abs(m.yaw - m0.yaw) > 0.01;
  return {
    chairs: Object.fromEntries(cfg.chairs.map(n => [n, [p(n).x, p(n).y, deg(p(n).yaw)]])),
    mat: m.removed ? 'removed' : m.taped ? 'taped' : moved ? 'moved' : 'present', ...(moved && !m.removed ? { mat_at: [m.x, m.y, deg(m.yaw)] as [number, number, number] } : {}),
    cord: cordFlat ? 'taped' : 'present',
    nightlight: nl.removed ? 'off' : outlet ?? 'elsewhere', ...(!nl.removed && !outlet ? { nightlight_at: [nl.x, nl.y] as XY } : {}),
    ...(lay.walker_caps ? { caps: true } : {}),
  };
}

/** The engine layout evaluate() runs: base poses with the planner's chairs, mat, cord and nightlight applied. */
export function toLayout(S: Init, cfg: PlannerCfg, base: Pose[], pl: PlanLayout): Layout {
  const poses = base.map(p => ({ ...p }));
  for (const [n, [x, y, a]] of Object.entries(pl.chairs)) poses[idx(S, n)] = { x, y, yaw: rad(a) };
  const m = idx(S, cfg.mat), nl = idx(S, cfg.nightlight);
  if (pl.mat === 'removed') poses[m] = { ...poses[m], removed: true };
  else if (pl.mat === 'moved' && pl.mat_at) poses[m] = { x: pl.mat_at[0], y: pl.mat_at[1], yaw: rad(pl.mat_at[2]) };
  else if (pl.mat === 'taped') poses[m] = { ...poses[m], taped: true };
  if (pl.nightlight === 'off') poses[nl] = { ...poses[nl], removed: true };
  else { const at = cfg.outlets[pl.nightlight]?.xy ?? pl.nightlight_at; if (at) poses[nl] = { x: at[0], y: at[1], yaw: 0 }; }
  return { poses, flattened: pl.cord === 'present' ? [] : [cfg.cord_box_xy], ...(pl.caps ? { walker_caps: true } : {}) };
}

/** Cells an object may stand on: static floor without walls; every object's scanned spot counts as floor (nobody
 *  filmed under it), as optimize.ts freeMask and main.ts placeBase. */
function floorMask(S: Init): Uint8Array {
  const m = new Uint8Array(S.base.floor.length);
  for (let c = 0; c < m.length; c++) m[c] = S.base.floor[c] && !S.base.obst[c] ? 1 : 0;
  S.objects.forEach(o => { for (const c of polyCells(S.g, worldFootprint(o, { x: o.pivot[0], y: o.pivot[1], yaw: 0 }))) m[c] = 1; });
  return m;
}
const masks = new WeakMap<Init, Uint8Array>();

/** Why this layout can't be a proposal ([] = valid): overlaps, off the floor, chairs out of the table's reach, things
 *  in the kept-clear zones, a nightlight away from an outlet. Route feasibility is score()'s error. */
export function check(S: Init, cfg: PlannerCfg, base: Pose[], pl: PlanLayout): string[] {
  const out: string[] = [], { g } = S, lay = toLayout(S, cfg, base, pl);
  if (!masks.has(S)) masks.set(S, floorMask(S));
  const floor = masks.get(S)!, t = idx(S, cfg.table), tablePoly = worldFootprint(S.objects[t], lay.poses[t]);
  const cellsOf = (k: number) => polyCells(g, worldFootprint(S.objects[k], lay.poses[k]));
  const zoneCells = Object.entries(cfg.zones).map(([n, z]) => [n, new Set(polyCells(g, box(z.box_xy)))] as const);
  // obstacles other than the table chairs and the table stay where they are; chairs may tuck under the table
  const fixed = new Set<number>();
  S.objects.forEach((o, k) => { if (o.layer === 'obstacle' && !lay.poses[k].removed && !cfg.chairs.includes(o.name) && k !== t) for (const c of cellsOf(k)) fixed.add(c); });
  // scanned footprints are loose (the scan's own chairs overlap each other up to 15%, chair3 is 84% under the table)
  const tableCells = new Set(cellsOf(t)), seen: [string, Set<number>][] = [];
  for (const n of cfg.chairs) {
    const k = idx(S, n), cells = cellsOf(k), mine = new Set(cells);
    if (cells.some(c => !floor[c])) out.push(`${n} is off the floor (wall or unscanned)`);
    else if (cells.some(c => fixed.has(c))) out.push(`${n} overlaps furniture`);
    for (const [m, sc] of seen) if (cells.filter(c => sc.has(c)).length > cfg.chair_overlap_frac * Math.min(sc.size, mine.size)) out.push(`${n} overlaps ${m}`);
    if (cells.filter(c => tableCells.has(c)).length > cfg.under_table_frac * cells.length) out.push(`${n} is pushed too far under the table`);
    seen.push([n, mine]);
    const p = lay.poses[k], d = polyDist([p.x, p.y], tablePoly);
    if (d > cfg.chair_reach_m) out.push(`${n} is ${d.toFixed(2)} m from the table (limit ${cfg.chair_reach_m} m)`);
    for (const [z, zc] of zoneCells) if (cells.some(c => zc.has(c))) out.push(`${n} is in the ${z.replace('_', ' ')} zone`);
  }
  if (pl.mat !== 'removed') {
    const cells = cellsOf(idx(S, cfg.mat));
    if (pl.mat === 'moved' && cells.some(c => !floor[c] || fixed.has(c))) out.push('the mat is off the floor or under furniture');
    for (const [z, zc] of zoneCells) if (cells.some(c => zc.has(c))) out.push(`the mat is in the ${z.replace('_', ' ')} zone`);
  }
  if (pl.nightlight !== 'off' && !cfg.outlets[pl.nightlight]) out.push('the nightlight is not at an outlet');
  return out;
}

/** Distance from a point to a polygon (0 inside). */
function polyDist(p: XY, poly: XY[]): number {
  let inside = false, best = Infinity;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > p[1]) !== (yb > p[1]) && p[0] < ((xb - xa) * (p[1] - ya)) / (yb - ya) + xa) inside = !inside;
    const dx = xb - xa, dy = yb - ya, t = Math.max(0, Math.min(1, ((p[0] - xa) * dx + (p[1] - ya) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - xa - t * dx, p[1] - ya - t * dy));
  }
  return inside ? 0 : best;
}

/** What it takes to get from `from` to `pl`: chair and mat moves by movecost.ts, the rest by the config's options/fixes. */
export function cost(S: Init, cfg: PlannerCfg, from: PlanLayout, pl: PlanLayout): Cost {
  const items: Item[] = [], O = (n: string) => S.objects[idx(S, n)];
  const opt = (key: string, o: Opt | undefined, fallback: string): Item => {
    if (!o) throw new Error(`planner: no cost for ${key}`);
    if ('from_fix' in o) {
      const iv = S.interventions.find(i => i.id === o.from_fix);
      if (!iv) throw new Error(`planner: no fix ${o.from_fix}`);
      const on = S.objects.find(o => o.name === iv.object), c = fixCost(iv, on && effortKind(on));
      return { key, label: iv.label ?? fallback, usd: c.usd, minutes: c.minutes, effort: c.effort, product: iv.product };
    }
    return { key, label: o.label, usd: o.cost_usd, minutes: o.minutes, effort: o.effort, product: o.product, assumption: o.assumption };
  };
  const mv = (key: string, label: string, n: string, a: number[], b: number[]) => {
    const c = moveCost(O(n), { x: a[0], y: a[1], yaw: rad(a[2]) }, { x: b[0], y: b[1], yaw: rad(b[2]) });
    items.push({ key, label, usd: c.usd, minutes: c.minutes, effort: c.effort });
  };
  for (const n of cfg.chairs) {
    const a = from.chairs[n], b = pl.chairs[n];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01 || a[2] !== b[2]) mv(n, `Move ${n} to (${b[0].toFixed(2)}, ${b[1].toFixed(2)})${a[2] !== b[2] ? `, turned ${b[2]} deg` : ''}`, n, a, b);
  }
  if (pl.mat !== from.mat || (pl.mat === 'moved' && String(pl.mat_at) !== String(from.mat_at))) {
    if (pl.mat === 'moved') { const m = S.objects[idx(S, cfg.mat)]; mv('mat', 'Move the mat', cfg.mat, from.mat_at ?? [m.pivot[0], m.pivot[1], 0], pl.mat_at!); }
    else if (pl.mat !== 'present') items.push(opt('mat', cfg.options.mat[pl.mat], pl.mat));
  }
  if (pl.cord !== from.cord && pl.cord !== 'present') items.push(opt('cord', cfg.options.cord[pl.cord], pl.cord));
  if (pl.nightlight !== from.nightlight) items.push(opt('nightlight', cfg.options.nightlight[pl.nightlight], pl.nightlight));
  if (pl.caps && !from.caps) items.push(opt('caps', cfg.options.walker?.caps, 'caps'));
  return { usd: items.reduce((s, i) => s + i.usd, 0), minutes: items.reduce((s, i) => s + i.minutes, 0), effort: items.reduce((s, i) => s + i.effort, 0), items };
}

/** The changes from `a` to `b`, one key each (chair name, mat, cord, nightlight): what a judge changed, what the AI kept. */
export function changed(cfg: PlannerCfg, a: PlanLayout, b: PlanLayout): string[] {
  const out = cfg.chairs.filter(n => Math.hypot(a.chairs[n][0] - b.chairs[n][0], a.chairs[n][1] - b.chairs[n][1]) > 0.01 || a.chairs[n][2] !== b.chairs[n][2]);
  if (a.mat !== b.mat || String(a.mat_at) !== String(b.mat_at)) out.push('mat');
  if (a.cord !== b.cord) out.push('cord');
  if (a.nightlight !== b.nightlight || String(a.nightlight_at) !== String(b.nightlight_at)) out.push('nightlight');
  if (!!a.caps !== !!b.caps) out.push('caps');
  return out;
}

/** Walker-frame brushes: the frame's sides and front bar (rollout.py frame_outline, 12 points each) within brush_m of
 *  a wall or furniture at a step, once per thing per trip; per month like contacts, 10-90% over 10 batches of trips. */
export function brushes(S: Init, cfg: PlannerCfg, lay: Layout, ev: Eval, walker: { width_m: number; depth_m: number; leg_radius_m: number }) {
  const { g } = S, ny = g.shape[1], ids = new Map<number, string>(), trips = ev.ghosts.filter(gh => gh.walker);
  S.objects.forEach((o, k) => { if (o.layer === 'obstacle' && !lay.poses[k].removed) for (const c of polyCells(g, worldFootprint(o, lay.poses[k]))) ids.set(c, o.name); });
  const r = Math.ceil((cfg.brush_m + g.cell_m) / g.cell_m) + 1, a = walker.depth_m / 2, b = walker.width_m / 2 - walker.leg_radius_m;
  const by: Record<string, number> = {}, B = Math.min(10, Math.max(1, trips.length)), batch = new Array(B).fill(0), nb = new Array(B).fill(0);
  trips.forEach((gh, trip) => {
    const touched = new Set<string>(), bi = Math.floor((trip * B) / trips.length);
    nb[bi]++;
    for (const [x, y, yaw] of gh.walker!) {
      const d: XY = [Math.cos(yaw), Math.sin(yaw)], l: XY = [-d[1], d[0]];
      const leg = (s: number, t: number): XY => [x + s * a * d[0] + t * b * l[0], y + s * a * d[1] + t * b * l[1]];
      const L = [leg(1, 1), leg(1, -1), leg(-1, 1), leg(-1, -1)];
      for (const [p, q] of [[L[0], L[2]], [L[1], L[3]], [L[0], L[1]]]) for (let s = 0; s < 12; s++) {
        const u = s / 11, pt: XY = [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1])], [i, j] = toCell(g, pt);
        if (ev.dist_m[i * ny + j] - g.cell_m / 2 >= cfg.brush_m) continue;
        // what it brushed: the nearest blocked cell around the point; a movable's footprint names it, else the room
        let best = Infinity, who = 'wall/counter';
        for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
          const ii = i + di, jj = j + dj, c = ii * ny + jj;
          if (ii < 0 || jj < 0 || ii >= g.shape[0] || jj >= ny || ev.dist_m[c] > 0 || di * di + dj * dj >= best) continue;
          best = di * di + dj * dj; who = ids.get(c) ?? 'wall/counter';
        }
        touched.add(who);
      }
    }
    for (const w of touched) by[w] = (by[w] ?? 0) + 1;
    batch[bi] += touched.size;
  });
  const rd = S.routes[ev.sel] ?? S.routes[0], month = rd.trips_per_night * S.risk.days_per_month, n = Math.max(1, trips.length);
  for (const w in by) by[w] *= month / n;
  const per = batch.map((h, k) => (h * month) / Math.max(1, nb[k])).sort((x, y) => x - y);
  const q = (f: number) => { const x = f * (B - 1), i = Math.floor(x), t = x - i; return per[i] + (per[Math.min(B - 1, i + 1)] - per[i]) * t; };
  return { per_month: Object.values(by).reduce((s, v) => s + v, 0), lo: q(0.1), hi: q(0.9), by };
}

/** the objective is toe catches / month (sim.ts contacts); simulated snags + brushes only break ties. planner/engine.py TIE_BREAK */
export const TIE_BREAK = 1e-5;

/** Score one layout. shortcut: brushes only on the selected route (evaluate keeps walker poses for that one); score
 *  each route in turn when a scene has several that matter. */
export function score(S: Init, cfg: PlannerCfg, base: Pose[], pl: PlanLayout, walker: { width_m: number; depth_m: number; leg_radius_m: number }): PlanScore {
  const lay = toLayout(S, cfg, base, pl), ev = evaluate({ ...S, risk: { ...S.risk, ghosts: S.risk.rollouts } }, lay, { ghosts: true });
  // a taped mat keeps its edge (toe contacts) but stops the simulated slide / fold: config ASSUMPTION
  const snag_by = ev.objects.filter(o => !(pl.mat === 'taped' && o.object === cfg.mat)).map(o => ({ object: o.object, event: o.event, per_month: o.per_month,
    lo: o.per_month * (o.ci95[0] ?? o.p) / (o.p || 1), hi: o.per_month * (o.ci95[1] ?? o.p) / (o.p || 1) }));
  const br = ev.error ? { per_month: 0, lo: 0, hi: 0, by: {} } : brushes(S, cfg, lay, ev, walker);
  const snags = snag_by.reduce((s, o) => s + o.per_month, 0);
  return {
    risk: ev.per_month + TIE_BREAK * (snags + br.per_month), contacts: ev.per_month, snags, brushes: br.per_month,
    lo: ev.per_month_lo + TIE_BREAK * (br.lo + snag_by.reduce((s, o) => s + o.lo, 0)), hi: ev.per_month_hi + TIE_BREAK * (br.hi + snag_by.reduce((s, o) => s + o.hi, 0)),
    snag_by: snag_by.map(({ object, event, per_month }) => ({ object, event, per_month })), brush_by: br.by, error: ev.error, ev,
  };
}

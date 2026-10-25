// "Suggest layouts": search rearrangements of the movable furniture plus the configured fixes, score each with the same
// evaluate() as the live view (all routes, checks), and return three options from quick to full. Pure: runs in the
// worker, tested in node. Every number in an option comes from a full re-evaluation of that exact layout.
import { applyIntervention, polyCells, worldFootprint, toCell, type GridMeta, type Layout, type Pose, type XY, type Intervention } from './grid.ts';
import { evaluate, availableInterventions, routeStart, type Init, type Eval } from './evaluate.ts';
import { bedExit } from './checks.ts';
import { rng } from './sim.ts';
import { moveEffort } from './effort.ts';

export interface OptimizerCfg {
  /** contacts/month-equivalents: how much each thing costs next to one expected toe contact per month */
  length_per_m: number; squeeze: number; check_fail: number; check_borderline: number;
  /** effort weights for the three options: quick (effort expensive) .. full (effort free) */
  lambdas: [number, number, number];
  /** moving an object: effort.ts moveEffort (mass, distance, turn); a configured intervention carries its own effort */
  slots_per_object: number; anneal_steps: number;
}
export const DEFAULTS: OptimizerCfg = {
  length_per_m: 0.02, squeeze: 3.0, check_fail: 0.6, check_borderline: 0.2, lambdas: [0.3, 0.1, 0.02],
  slots_per_object: 24, anneal_steps: 60,
};

/** key: what the action changes; two actions with one key can't both be in an option (offset hinges vs door off) */
export interface Action { id: string; key: string; label: string; effort: number; cost_usd: number; minutes: number; product?: string; apply: (l: Layout) => Layout }
export interface OptionOut { name: string; lambda: number; actions: { id: string; label: string; cost_usd: number; minutes: number; product?: string }[];
  layout: Layout; per_month: number; per_month_lo: number; per_month_hi: number; effort: number; cost_usd: number; minutes: number; score: number;
  checks_failed: number; min_side_m: number }

type Obj = Init['objects'][number] & { movable?: boolean; mass_kg?: number };

/** Cells an object may stand on: static floor, no wall, and not under another (unmoved) obstacle. Its own original
 *  spot counts as floor (nobody filmed under it, but it stands there now), as in main.ts placeBase. */
function freeMask(S: Init, poses: Pose[], k: number): Uint8Array {
  const N = S.g.shape[0] * S.g.shape[1], m = new Uint8Array(N);
  for (let c = 0; c < N; c++) m[c] = S.base.floor[c] && !S.base.obst[c] ? 1 : 0;
  S.objects.forEach(o => { for (const c of polyCells(S.g, worldFootprint(o, { x: o.pivot[0], y: o.pivot[1], yaw: 0 }))) m[c] = 1; });
  S.objects.forEach((o, n) => {
    if (n === k || poses[n].removed || o.layer !== 'obstacle') return;
    for (const c of polyCells(S.g, worldFootprint(o, poses[n]))) m[c] = 0;
  });
  return m;
}

/** Does the footprint fit (5 cm lattice inside it, early out)? */
function fits(g: GridMeta, mask: Uint8Array, poly: XY[]): boolean {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]), ny = g.shape[1];
  const inside = (x: number, y: number) => {
    let r = false;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++)
      if ((poly[a][1] > y) !== (poly[b][1] > y) && x < ((poly[b][0] - poly[a][0]) * (y - poly[a][1])) / (poly[b][1] - poly[a][1]) + poly[a][0]) r = !r;
    return r;
  };
  for (let x = Math.min(...xs) + 0.02; x < Math.max(...xs); x += 0.05)
    for (let y = Math.min(...ys) + 0.02; y < Math.max(...ys); y += 0.05) {
      if (!inside(x, y)) continue;
      const i = Math.floor((x - g.origin_xy[0]) / g.cell_m), j = Math.floor((y - g.origin_xy[1]) / g.cell_m);
      if (i < 0 || j < 0 || i >= g.shape[0] || j >= ny || !mask[i * ny + j]) return false;
    }
  return true;
}

/** How far a footprint side is from a wall (or `also`) straight out: the first offset (1 cm steps, up to `max`) at
 *  which most of the side's sample points are wall. Infinity = no wall that close. */
function wallGap(S: Init, a: XY, b: XY, out: XY, max: number, also?: Set<number>): number {
  const ny = S.g.shape[1];
  for (let d = 0.01; d <= max; d += 0.01) {
    let hit = 0, n = 0;
    for (let t = 0.1; t <= 0.9; t += 0.1) {
      const [i, j] = toCell(S.g, [a[0] + (b[0] - a[0]) * t + out[0] * d, a[1] + (b[1] - a[1]) * t + out[1] * d]), c = i * ny + j;
      n++; if (S.base.obst[c] || !S.base.floor[c] || also?.has(c)) hit++;
    }
    if (hit >= 0.7 * n) return d;
  }
  return Infinity;
}

/** Wall slots for object k: right-angle poses that fit, slid flush (1 cm gap) against a wall within 12 cm of a
 *  10 cm lattice point; a bed puts a SHORT side (its head) there. A nightstand or chair may stand against the bed's
 *  side instead. Evenly thinned to `limit`, nearest-first from where it is now. */
export function wallSlots(S: Init, poses: Pose[], k: number, limit: number): (Pose & { beside_bed: boolean })[] {
  const o = S.objects[k], mask = freeMask(S, poses, k), g = S.g, out: { p: Pose; d: number; bed: boolean }[] = [], seen = new Set<string>();
  const bed = S.objects.findIndex(b => b.kind === 'bed');
  const beside = (o.kind === 'nightstand' || o.kind === 'chair') && bed >= 0 && bed !== k && !poses[bed].removed
    ? new Set(polyCells(g, worldFootprint(S.objects[bed], poses[bed]))) : undefined;
  const x0 = g.origin_xy[0], y0 = g.origin_xy[1], x1 = x0 + g.shape[0] * g.cell_m, y1 = y0 + g.shape[1] * g.cell_m;
  for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2])
    for (let x = x0 + 0.2; x < x1 - 0.2; x += 0.1) for (let y = y0 + 0.2; y < y1 - 0.2; y += 0.1) {
      const fp = worldFootprint(o, { x, y, yaw });
      const cx = fp.reduce((a, q) => a + q[0], 0) / fp.length, cy = fp.reduce((a, q) => a + q[1], 0) / fp.length;
      const sides = fp.map((a, n) => {
        const b = fp[(n + 1) % fp.length], m: XY = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy], l = Math.hypot(...m) || 1;
        return { a, b, out: [m[0] / l, m[1] / l] as XY, len: Math.hypot(b[0] - a[0], b[1] - a[1]) };
      });
      const shortest = Math.min(...sides.map(q => q.len));
      for (const sd of sides) {
        if (o.kind === 'bed' && sd.len > shortest * 1.2) continue;
        const gw = wallGap(S, sd.a, sd.b, sd.out, 0.12), gb = beside ? wallGap(S, sd.a, sd.b, sd.out, 0.12, beside) : Infinity;
        const gap = Math.min(gw, gb);
        if (!Number.isFinite(gap)) continue;
        const p = { x: x + sd.out[0] * (gap - 0.02), y: y + sd.out[1] * (gap - 0.02), yaw };
        const key = `${p.x.toFixed(2)},${p.y.toFixed(2)},${yaw.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (fits(g, mask, worldFootprint(o, p))) out.push({ p, d: Math.hypot(p.x - poses[k].x, p.y - poses[k].y), bed: Number.isFinite(gb) && gb <= gw });   // ties: the bed's cut edge leaves a sliver of obstacle
      }
    }
  out.sort((a, b) => a.d - b.d);
  // up to half the slots beside the bed (where a nightstand belongs), the rest spread over the walls
  const thin = (xs: typeof out, n: number) => { const st = Math.max(1, Math.floor(xs.length / Math.max(1, n))); return xs.filter((_, i) => i % st === 0).slice(0, n); };
  const near = thin(out.filter(s => s.bed), Math.floor(limit / 2));
  return [...near, ...thin(out.filter(s => !s.bed), limit - near.length)].map(s => ({ ...s.p, beside_bed: s.bed }));
}

/** Bed exit needs a ~0.9 m square to turn the walker in (OT rule of thumb): share of it that is free floor. */
function exitRoom(S: Init, lay: Layout): number {
  const k = S.objects.findIndex(o => o.kind === 'bed');
  if (k < 0 || lay.poses[k].removed) return 1;
  const e = bedExit(S.objects[k], lay.poses[k], routeStart(S.routes[0], S.objects, lay.poses)), ny = S.g.shape[1];
  const occupied = new Set<number>();
  S.objects.forEach((o, n) => { if (!lay.poses[n].removed && o.layer === 'obstacle') for (const c of polyCells(S.g, worldFootprint(o, lay.poses[n]))) occupied.add(c); });
  let free = 0, n = 0;
  for (let dx = -0.4; dx <= 0.4; dx += 0.1) for (let dy = -0.4; dy <= 0.4; dy += 0.1) {
    const [i, j] = toCell(S.g, [e[0] + dx, e[1] + dy]), c = i * ny + j;
    n++; if (S.base.floor[c] && !S.base.obst[c] && !occupied.has(c)) free++;
  }
  return free / n;
}

export function score(S: Init, cfg: OptimizerCfg, r: Eval, lay: Layout, effort: number, lambda: number): number {
  if (r.error) return Infinity;
  const margin = S.rules.clearance_margin_m;
  let J = r.per_month + lambda * effort;
  for (const q of r.routes) {
    J += cfg.length_per_m * q.length_m * q.trips_per_night;
    J += cfg.squeeze * q.trips_per_night / 2 * Math.max(0, margin - (q.min_side_m ?? margin)) / margin;
  }
  for (const c of r.checks) J += c.verdict === 'fail' ? cfg.check_fail : c.verdict === 'borderline, OT to verify' ? cfg.check_borderline : 0;
  J += 2 * Math.max(0, 0.8 - exitRoom(S, lay));
  return J;
}

/** Every single change on the table: the configured fixes, plus moving each movable object to a wall slot. */
export function actions(S: Init, cfg: OptimizerCfg, start: Layout): Action[] {
  const A: Action[] = availableInterventions(S, evaluate(S, start, { ghosts: false })).map((iv: Intervention) => ({
    id: iv.id, key: iv.kind === 'raise' ? `raise:${iv.target}` : iv.kind === 'carve' ? `carve:${iv.target}` : iv.kind === 'add' ? `add:${iv.id}` : iv.kind === 'flatten' ? `flat:${iv.id}` : `obj:${iv.object}`,
    label: iv.label, effort: iv.effort ?? 1, cost_usd: iv.cost_usd ?? 0, minutes: iv.minutes ?? 10, product: iv.product,
    apply: (l: Layout) => applyIntervention(S.objects, l, iv),
  }));
  (S.objects as Obj[]).forEach((o, k) => {
    if (o.movable === false || o.layer === 'none' || o.kind === 'door' || o.kind === 'rug' || start.poses[k].removed) return;
    for (const p of wallSlots(S, start.poses, k, cfg.slots_per_object)) {
      const d = Math.hypot(p.x - start.poses[k].x, p.y - start.poses[k].y);
      if (d < 0.15 && Math.abs(p.yaw - start.poses[k].yaw) < 0.01) continue;
      const turn = Math.round(((((p.yaw - start.poses[k].yaw) * 180) / Math.PI) % 360 + 360) % 360);
      A.push({ id: `move:${o.name}:${p.x.toFixed(1)},${p.y.toFixed(1)},${turn}`, key: `obj:${o.name}`,
        label: `Move the ${o.name} ${d.toFixed(1)} m${turn ? `, turned ${turn}°` : ''} (${p.beside_bed ? 'beside the bed' : 'against a wall'})`,
        ...(({ effort, minutes }) => ({ effort, minutes }))(moveEffort({ kind: o.kind, mass_kg: o.mass_kg, distance_m: d, turn_deg: turn })), cost_usd: 0,
        apply: (l: Layout) => ({ ...l, poses: l.poses.map((q, n) => (n === k ? { x: p.x, y: p.y, yaw: p.yaw } : q)) }) });
    }
  });
  return A;
}

/** Scores of action sets without the effort term, shared by the three options (only lambda * effort differs). */
function scorer(F: Init, cfg: OptimizerCfg, start: Layout, A: Action[]) {
  const byId = new Map(A.map(a => [a.id, a]));
  const memo = new Map<string, number>();
  const raw = (ids: string[]) => {
    const key = [...ids].sort().join('|');
    if (!memo.has(key)) {
      const l = ids.reduce((x, id) => byId.get(id)!.apply(x), start);
      memo.set(key, score(F, cfg, evaluate(F, l, { ghosts: false }), l, 0, 0));
    }
    return memo.get(key)!;
  };
  const effort = (ids: string[]) => ids.reduce((e, id) => e + byId.get(id)!.effort, 0);
  return { raw, effort, memo, byId };
}

/** Forward selection (each step re-scores the candidates in the context of what is already chosen, so a fix that
 *  only helps after another, like a touch lamp once the nightstand is beside the bed, can win), then a short anneal. */
function searchOne(sc: ReturnType<typeof scorer>, cfg: OptimizerCfg, A: Action[], cands: string[], lambda: number, seed: number) {
  const J = (ids: string[]) => sc.raw(ids) + lambda * sc.effort(ids);
  const clash = (ids: string[], id: string) => ids.some(x => sc.byId.get(x)!.key === sc.byId.get(id)!.key);
  const MIN_GAIN = 0.01;   // an action has to earn its place: no free-riding moves that change nothing
  let cur: string[] = [], best = J(cur);
  for (;;) {
    let pick = '', pj = best - MIN_GAIN;
    for (const id of cands) {
      if (clash(cur, id)) continue;
      const j = J([...cur, id]);
      if (j < pj) { pj = j; pick = id; }
    }
    if (!pick) break;
    cur = [...cur, pick]; best = pj;
  }
  const R = rng(seed);
  let T = 0.3, now = cur, nowJ = best;
  for (let it = 0; it < cfg.anneal_steps; it++, T *= 0.94) {
    const u = R.u(), a = A[Math.floor(R.u() * A.length)];
    let next = now;
    if (u < 0.4 && !clash(now, a.id)) next = [...now, a.id];
    else if (u < 0.7 && now.length) next = now.filter((_, n) => n !== Math.floor(R.u() * now.length));
    else if (now.length) { const drop = Math.floor(R.u() * now.length), rest = now.filter((_, n) => n !== drop); if (!clash(rest, a.id)) next = [...rest, a.id]; }
    if (next === now) continue;
    const j = J(next);
    if (j < nowJ || R.u() < Math.exp(-(j - nowJ) / T)) { now = next; nowJ = j; }
    if (j < best - MIN_GAIN) { best = j; cur = next; }
  }
  // drop anything that stopped earning its place once the rest was chosen
  for (const id of [...cur]) { const rest = cur.filter(x => x !== id), j = J(rest); if (j <= best + MIN_GAIN / 2) { cur = rest; best = Math.min(best, j); } }
  return { ids: cur, score: best };
}

/** The three options. `onProgress(done, total)` lets the worker report while it searches. */
export function optimize(S: Init, start: Layout, cfgIn: Partial<OptimizerCfg> = {}, onProgress?: (msg: string) => void): { options: OptionOut[]; evals: number; ms: number } {
  const t = performance.now(), cfg = { ...DEFAULTS, ...cfgIn };
  // search on fewer trips per route (expected-contact totals are low-noise), re-check winners with the full count
  const F: Init = { ...S, risk: { ...S.risk, rollouts: Math.min(S.risk.rollouts, 120), ghosts: 0 } };
  const A = actions(S, cfg, start), sc = scorer(F, cfg, start, A);
  const base = sc.raw([]);
  const single = new Map<string, number>();
  A.forEach((a, n) => {
    single.set(a.id, base - sc.raw([a.id]));
    if (n % 10 === 0) onProgress?.(`trying single changes ${n + 1}/${A.length}`);
  });
  // candidates for forward selection: every configured fix, and each object's best few wall slots
  const perObj = new Map<string, string[]>();
  for (const a of A.filter(x => x.id.startsWith('move:')).sort((x, y) => single.get(y.id)! - single.get(x.id)!))
    perObj.set(a.key, [...(perObj.get(a.key) ?? []), a.id].slice(0, 6));
  const cands = [...A.filter(x => !x.id.startsWith('move:')).map(x => x.id), ...[...perObj.values()].flat()];
  const names = ['Quick fixes', 'Moderate', 'Full re-layout'];
  const options = cfg.lambdas.map((lambda, n) => {
    onProgress?.(`searching: ${names[n]}`);
    const s = searchOne(sc, cfg, A, cands, lambda, 11 + n);
    const acts = s.ids.map(id => A.find(a => a.id === id)!);
    const layout = acts.reduce((l, a) => a.apply(l), start);
    const r = evaluate(S, layout, { ghosts: false });
    return { name: names[n], lambda, layout, actions: acts.map(a => ({ id: a.id, label: a.label, cost_usd: a.cost_usd, minutes: a.minutes, product: a.product })),
      per_month: r.per_month, per_month_lo: r.per_month_lo, per_month_hi: r.per_month_hi, effort: acts.reduce((e, a) => e + a.effort, 0),
      cost_usd: acts.reduce((e, a) => e + a.cost_usd, 0), minutes: acts.reduce((e, a) => e + a.minutes, 0),
      score: score(S, cfg, r, layout, 0, 0), checks_failed: r.checks.filter(c => c.verdict === 'fail').length,
      min_side_m: Math.min(...r.routes.map(q => q.min_side_m ?? Infinity)) };
  });
  // the same set twice (two lambdas agreeing) is shown once
  const seen = new Set<string>();
  const evals = sc.memo.size;
  return { options: options.filter(o => { const k = o.actions.map(a => a.id).sort().join('|'); if (seen.has(k)) return false; seen.add(k); return true; }),
    evals, ms: performance.now() - t };
}

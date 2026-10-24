// Kitchen planner off the main thread (planfix.ts): real planner scores (planner.ts score(), the same evaluator the GPU
// search mirrors) and the live judge mode: the critic (planner/critic.py, a small MLP) searches thousands of layouts
// seeded with the judge's own, then the top 5 and the judge's layout are scored for real and the best is kept, so the
// answer can never be worse than what the judge built.
import { check, cost, score, type PlanLayout, type PlannerCfg } from './planner.ts';
import { rng } from './sim.ts';
import type { Init } from './evaluate.ts';
import { worldFootprint, type Pose } from './grid.ts';

export interface Critic { spec: { chairs: string[]; mat: string[]; cord: string[]; nightlight: string[] }; x_mean: number[]; x_std: number[]; x_min: number[]; x_max: number[]; y_mean: number; y_std: number; y_range: [number, number];
  layers: { w: number[][]; b: number[] }[] }
type Walker = { width_m: number; depth_m: number; leg_radius_m: number };
let S: Init, cfg: PlannerCfg & { search?: any }, base: Pose[], walker: Walker, critic: Critic | null;

/** planner/critic.py features(): change both together */
export function criticFeatures(sp: Critic['spec'], pl: PlanLayout): number[] {
  const f: number[] = [];
  for (const n of sp.chairs) { const [x, y, a] = pl.chairs[n]; f.push(x, y, Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)); }
  for (const m of sp.mat) f.push(+(pl.mat === m));
  const at = pl.mat_at ?? [0, 0, 0];
  f.push(at[0], at[1], +(at[2] === 90));
  for (const c of sp.cord) f.push(+(pl.cord === c));
  for (const o of sp.nightlight) f.push(+(pl.nightlight === o));
  return f;
}
export function predict(c: Critic, pl: PlanLayout): number {
  // clamped to the training range in and out (critic.py): unclamped, the annealer finds layouts it extrapolates to negative risk
  let h = criticFeatures(c.spec, pl).map((v, i) => (Math.min(c.x_max[i], Math.max(c.x_min[i], v)) - c.x_mean[i]) / c.x_std[i]);
  c.layers.forEach((L, k) => {
    h = L.w.map((row, i) => row.reduce((s, w, j) => s + w * h[j], L.b[i]));
    if (k < c.layers.length - 1) h = h.map(v => v / (1 + Math.exp(-v)));   // SiLU
  });
  return Math.min(c.y_range[1], Math.max(c.y_range[0], h[0] * c.y_std + c.y_mean));
}

const snap = (v: number, g: number) => Math.round(Math.round(v / g) * g * 1000) / 1000;
/** planner/search.py propose(): a neighbour that passes check() */
export function propose(pl: PlanLayout, scan: PlanLayout, u: () => number): PlanLayout {
  const g = cfg.grid_m, pick = <T>(a: T[]) => a[Math.floor(u() * a.length)];
  const ti = S.objects.findIndex(o => o.name === cfg.table), pts = worldFootprint(S.objects[ti], base[ti]);
  const lo = [Math.min(...pts.map(p => p[0])) - cfg.chair_reach_m, Math.min(...pts.map(p => p[1])) - cfg.chair_reach_m];
  const hi = [Math.max(...pts.map(p => p[0])) + cfg.chair_reach_m, Math.max(...pts.map(p => p[1])) + cfg.chair_reach_m];
  for (let n = 0; n < 200; n++) {
    const q: PlanLayout = structuredClone(pl), r = u();
    if (r < 0.6) {
      const k = pick(cfg.chairs);
      let [x, y, a] = q.chairs[k];
      const m = u();
      if (m < 0.5) { const d = pick([0.05, 0.1, 0.2, 0.4]) * pick([-1, 1]); if (u() < 0.5) { x = snap(x + d, g); y = snap(y, g); } else { x = snap(x, g); y = snap(y + d, g); } }
      else if (m < 0.7) a = (a + pick([90, 270])) % 360;
      else if (m < 0.9) { x = snap(lo[0] + u() * (hi[0] - lo[0]), g); y = snap(lo[1] + u() * (hi[1] - lo[1]), g); a = pick([0, 90, 180, 270]); }
      else [x, y, a] = scan.chairs[k];
      q.chairs[k] = [x, y, a];
    } else if (r < 0.75) {
      q.mat = pick(['present', 'taped', 'removed', 'moved'] as const); delete q.mat_at;
      if (q.mat === 'moved') { const m = S.objects.find(o => o.name === cfg.mat)!.pivot; q.mat_at = [snap(m[0] + (u() - 0.5) * 1.2, g), snap(m[1] + (u() - 0.5) * 1.2, g), pick([0, 90])]; }
    } else if (r < 0.87) q.cord = pick(['present', 'taped', 'rerouted'] as const);
    else { q.nightlight = pick([...Object.keys(cfg.outlets), 'off']); delete q.nightlight_at; }
    if (JSON.stringify(q) !== JSON.stringify(pl) && !check(S, cfg, base, q).length) return q;
  }
  return pl;
}

const slim = (pl: PlanLayout) => { const r = score(S, cfg, base, pl, walker); const { ev, ...rest } = r; return rest; };   // the trip polylines stay in the worker

/** critic-guided annealing from the judge's layout, then real scores for the judge's and the critic's top 5 */
function live(judge: PlanLayout, scan: PlanLayout, n: number, lam: number) {
  const t0 = performance.now(), R = rng(7), bad = check(S, cfg, base, judge);
  const start = bad.length ? scan : judge;   // an invalid judge layout can't be the incumbent: start from the scan, say why
  const J = (pl: PlanLayout) => predict(critic!, pl) + lam * cost(S, cfg, start, pl).effort;
  const seen = new Map<string, { pl: PlanLayout; j: number }>();
  const chains = 8, steps = Math.ceil(n / chains);
  let cur = Array.from({ length: chains }, () => ({ pl: start, j: J(start) }));
  for (let st = 0; st < steps; st++) {
    const T = 20 * (0.3 / 20) ** (st / Math.max(1, steps - 1));
    cur = cur.map(c => {
      const q = propose(c.pl, scan, R.u), k = JSON.stringify(q);
      const e = seen.get(k) ?? { pl: q, j: J(q) };
      seen.set(k, e);
      return e.j <= c.j || R.u() < Math.exp(-(e.j - c.j) / T) ? e : c;
    });
  }
  const top = [...seen.values()].sort((a, b) => a.j - b.j).slice(0, 5);
  const cands = [start, ...top.map(t => t.pl)].map(pl => { const s = slim(pl); return { pl, s, effort: cost(S, cfg, start, pl).effort, critic: predict(critic!, pl), j: s.error ? Infinity : s.risk + lam * cost(S, cfg, start, pl).effort }; });
  const best = cands.reduce((b, c) => (c.j < b.j - 1e-9 ? c : b), cands[0]);   // the incumbent wins ties: never worse
  return { invalid: bad, start: bad.length ? 'scanned' : 'judge', judge: cands[0], best, candidates: cands, searched: seen.size, ms: performance.now() - t0 };
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') ({ init: S, cfg, base, walker, critic } = m);
  else if (m.type === 'score') postMessage({ id: m.id, scores: m.pls.map((pl: PlanLayout) => ({ check: check(S, cfg, base, pl), ...slim(pl) })) });
  else if (m.type === 'live') postMessage({ id: m.id, ...live(m.judge, m.scan, m.n ?? 4000, m.lam ?? cfg.search?.live_effort_weight ?? 2) });
};

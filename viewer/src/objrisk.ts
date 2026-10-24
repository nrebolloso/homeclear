// Object physics in the rollouts: the offline MuJoCo batch (physics/batch_mujoco.py) gave P(mat slides / corner folds /
// chair moves / chair tips) per approach speed and angle; here each route's crossings of the mat and near passes of
// chairs look those up at the persona's speed and the route's angle. SIMULATED: shapes from the splat, masses and
// frictions sampled from assumed ranges, not measured; the real-walker check is still open (BLOCKERS.md).
import type { XY } from './grid.ts';

interface Bin { speed_mps: [number, number]; angle_deg: [number, number]; n: number; [k: string]: unknown }
interface Scenario { trials: number; given_contact: Record<string, { p: number | null; ci95: (number | null)[] }>; bins: Bin[] }
export interface BatchResults { label: string; scenarios: Record<string, Scenario> }
export interface ObjEvent {
  object: string; route: string; event: string; speed_mps: number; angle_deg: number;
  /** P(event) per crossing (mat) or per touch (chair), from the batch bin; ci95 is that bin's Wilson interval */
  p: number; ci95: [number, number]; n: number;
  /** chance a trip touches it: 1 for a mat the route crosses; for a chair, the rollouts' sideways sway reaching it */
  p_contact: number; per_month: number;
}

const ang = (d: XY, n: XY) => (Math.acos(Math.min(1, Math.abs(d[0] * n[0] + d[1] * n[1]) / Math.hypot(...d) / Math.hypot(...n))) * 180) / Math.PI;
const cross = (a: XY, b: XY, c: XY, d: XY) => {   // does segment ab cross cd?
  const s = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0;
};
const segDist = (p: XY, a: XY, b: XY) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
// 1 - normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7)
const tail = (z: number) => {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? (1 - erf) / 2 : (1 + erf) / 2;
};

function lookup(sc: Scenario, event: string, speed: number, angle: number) {
  const b = sc.bins.find(b => speed >= b.speed_mps[0] && speed <= b.speed_mps[1] && angle >= b.angle_deg[0] && angle <= b.angle_deg[1] && b.n > 0);
  if (b) return { p: b[event] as number, ci95: b[event + '_ci95'] as [number, number], n: b.n };
  const g = sc.given_contact[event];   // empty bin: the scenario as a whole
  return { p: g.p ?? 0, ci95: g.ci95 as [number, number], n: sc.trials };
}

export function objectRisk(R: BatchResults, route: string, xy: XY[], objs: { name: string; kind: string; poly: XY[] }[],
  speed_mps: number, trips_per_month: number, walker_half_m: number, sway_sd_m: number): ObjEvent[] {
  const out: ObjEvent[] = [], speed = Math.min(0.6, Math.max(0.1, speed_mps));
  for (const o of objs) {
    const n = o.poly.length, edges = o.poly.map((a, i) => [a, o.poly[(i + 1) % n]] as [XY, XY]);
    if (o.kind === 'rug' && R.scenarios.mat_edge) {
      // each time the route steps onto the mat (the batch pushes the walker 0.9 m on after the edge)
      for (let i = 1; i < xy.length; i++) for (const [a, b] of edges) {
        if (!cross(xy[i - 1], xy[i], a, b)) continue;
        const d: XY = [xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]], nrm: XY = [b[1] - a[1], a[0] - b[0]];
        const mid: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], c = o.poly.reduce((s, q) => [s[0] + q[0] / n, s[1] + q[1] / n], [0, 0]);
        if (d[0] * (c[0] - mid[0]) + d[1] * (c[1] - mid[1]) <= 0) continue;   // stepping off, not on
        const angle = ang(d, nrm);
        for (const ev of ['slid', 'folded']) { const L = lookup(R.scenarios.mat_edge, ev, speed, angle);
          out.push({ object: o.name, route, event: ev, speed_mps: speed, angle_deg: angle, ...L, p_contact: 1, per_month: trips_per_month * L.p }); }
      }
    } else if (o.kind === 'chair' && R.scenarios.chair) {
      // nearest approach of the route to the chair; the walker frame reaches walker_half_m to each side, sway is normal
      let best = { d: Infinity, i: 1, e: 0 };
      for (let i = 1; i < xy.length; i++) edges.forEach(([a, b], e) => {
        const d = Math.min(segDist(a, xy[i - 1], xy[i]), segDist(b, xy[i - 1], xy[i]), segDist(xy[i], a, b));
        if (d < best.d) best = { d, i, e };
      });
      const p_contact = tail((best.d - walker_half_m) / Math.max(sway_sd_m, 1e-3));
      if (p_contact < 1e-3) continue;
      const [a, b] = edges[best.e], d: XY = [xy[best.i][0] - xy[best.i - 1][0], xy[best.i][1] - xy[best.i - 1][1]];
      const angle = ang(d, [b[1] - a[1], a[0] - b[0]]);
      for (const ev of ['moved', 'tipped']) { const L = lookup(R.scenarios.chair, ev, speed, angle);
        out.push({ object: o.name, route, event: ev, speed_mps: speed, angle_deg: angle, ...L, p_contact, per_month: trips_per_month * p_contact * L.p }); }
    }
  }
  return out;
}

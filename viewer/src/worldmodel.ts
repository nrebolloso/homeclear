// Learned world model (worldmodel/learned.py): MLP -> mixture of K Gaussians over the next heel + a Gaussian walker pose
// when that heel lands. Frame: origin = stance heel, x = from the mid-heels toward the 0.25 m route point, y left,
// mirrored when the swing foot is the right one. Weights + check exported by worldmodel/export_web.py.
import type { XY } from './grid.ts';
import type { Mixture } from './stepmodel.ts';

export interface WorldModel {
  K: number; min_w: number; mean_gap_m: number; x_mean: number[]; x_std: number[]; x_min: number[]; x_max: number[];
  layers: { W: number[][]; b: number[] }[];
  shift?: number;   // set by the viewer from walker.json: user_gap + depth/2 - mean_gap_m (learned.py Learned.shift)
}
export type Pose = [number, number, number];

const unit = (v: XY): XY => { const n = Math.hypot(v[0], v[1]) || 1; return [v[0] / n, v[1] / n]; };

/** Frame of one state: heels newest first, sides[0] = side of the stance heel (+1 left), action = route points ahead. */
export function frame(heels: XY[], sides: number[], action: XY[]) {
  const o = heels[0], t = unit([action[0][0] - (heels[0][0] + heels[1][0]) / 2, action[0][1] - (heels[0][1] + heels[1][1]) / 2]);
  return { o, t, mir: -sides[0] };
}
type F = ReturnType<typeof frame>;
export const toLocal = ({ o, t, mir }: F, p: XY): XY => {
  const q = [p[0] - o[0], p[1] - o[1]];
  return [q[0] * t[0] + q[1] * t[1], mir * (-q[0] * t[1] + q[1] * t[0])];
};
export const toWorld = ({ o, t, mir }: F, p: XY): XY => [o[0] + p[0] * t[0] - mir * p[1] * t[1], o[1] + p[0] * t[1] + mir * p[1] * t[0]];

/** Heel mixture (world frame, glitch components under min_w dropped) and the mean walker pose (frame centre, yaw). */
export function predict(m: WorldModel, heels: XY[], sides: number[], action: XY[]): { mix: Mixture; walker: Pose; f: F } {
  const f = frame(heels, sides, action);
  const x = [heels[1], heels[2], ...action].flatMap(p => toLocal(f, p)).map((v, i) => Math.min(m.x_max[i], Math.max(m.x_min[i], v)));
  let h = x.map((v, i) => (v - m.x_mean[i]) / m.x_std[i]);
  m.layers.forEach((l, li) => {
    h = l.W.map((row, o) => row.reduce((a, w, i) => a + w * h[i], l.b[o]));
    if (li < m.layers.length - 1) h = h.map(v => v / (1 + Math.exp(-v)));   // SiLU
  });
  const lg = [...Array(m.K)].map((_, k) => h[5 * k]), mx = Math.max(...lg), e = lg.map(v => Math.exp(v - mx)), z = e.reduce((a, b) => a + b);
  const w = e.map(v => v / z), keep = w.map(v => v >= Math.min(m.min_w, Math.max(...w)));
  const ks = [...Array(m.K).keys()].filter(k => keep[k]), zk = ks.reduce((a, k) => a + w[k], 0);
  const c = (v: number) => Math.exp(Math.min(2, Math.max(-7, v)));
  const mix: Mixture = { w: ks.map(k => w[k] / zk), mu: ks.map(k => toWorld(f, [h[5 * k + 1], h[5 * k + 2]])), sd: ks.map(k => [c(h[5 * k + 3]), c(h[5 * k + 4])]) };
  const wm = h.slice(5 * m.K, 5 * m.K + 3), a = Math.atan2(f.t[1], f.t[0]) + f.mir * wm[2], cen = toWorld(f, [wm[0], wm[1]]);
  const s = m.shift ?? 0;
  return { mix, walker: [cen[0] + s * Math.cos(a), cen[1] + s * Math.sin(a), a], f };
}

/** One heel draw: component by weight, Gaussian in the local (along, across) frame of the state. */
export function sampleHeel(p: ReturnType<typeof predict>, u: () => number, n: () => number): XY {
  let r = u(), k = 0;
  while (k < p.mix.w.length - 1 && (r -= p.mix.w[k]) > 0) k++;
  const { t, mir } = p.f, a = p.mix.sd[k][0] * n(), b = p.mix.sd[k][1] * n();
  return [p.mix.mu[k][0] + a * t[0] - mir * b * t[1], p.mix.mu[k][1] + a * t[1] + mir * b * t[0]];
}

/** Route resampled every 1 cm and smoothed at sigma_m (rollout.py plan_route SMOOTH_M): the model was trained on smooth
 *  walked routes; a grid path's kinks put it out of distribution (WORLD_MODEL.md "Closed-loop stability"). */
export function smoothRoute(xy: XY[], sigma_m = 0.3): XY[] {
  const resample = (p: XY[]) => {
    const s = [0];
    for (let k = 1; k < p.length; k++) s.push(s[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]));
    const out: XY[] = [];
    for (let u = 0, j = 0; u < s[s.length - 1]; u += 0.01) {
      while (s[j + 1] < u) j++;
      const f = (u - s[j]) / (s[j + 1] - s[j] || 1);
      out.push([p[j][0] + f * (p[j + 1][0] - p[j][0]), p[j][1] + f * (p[j + 1][1] - p[j][1])]);
    }
    return out;
  };
  const p = resample(xy), sg = sigma_m / 0.01, R = Math.ceil(4 * sg);
  const ker = [...Array(2 * R + 1)].map((_, i) => Math.exp(-0.5 * ((i - R) / sg) ** 2)), kz = ker.reduce((a, b) => a + b);
  const sm = p.map((_, i) => [0, 1].map(d => ker.reduce((a, kv, j) => a + kv * p[Math.min(p.length - 1, Math.max(0, i + j - R))][d], 0) / kz) as XY);
  return resample(sm);
}

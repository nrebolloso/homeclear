// Learned next-footstep model (motion/train_eval.py): MLP -> mixture of K 2D Gaussians over the next heel, in the
// mirrored route frame of motion/gait_data.py (origin = route point at the current heel, x along the route, y left,
// y flipped when the next foot is the right one). Weights exported to step_model.json by train_eval.py.
export interface StepModel {
  K: number; x_mean: number[]; x_std: number[]; toe_offset: number[][]; com_mean: number[];
  layers: { W: number[][]; b: number[] }[]; hand_rule_fit?: { stride_m: number; foot_sep_m: number };
  x_min: number[]; x_max: number[]; y_min: number[]; y_max: number[];   // training ranges
}
export interface Mixture { w: number[]; mu: [number, number][]; sd: [number, number][] }

/** Forward pass on one raw (un-normalised) 21-feature input. */
export function mdn(m: StepModel, x: number[]): Mixture {
  let h = x.map((v, i) => (v - m.x_mean[i]) / m.x_std[i]);
  m.layers.forEach((l, li) => {
    h = l.W.map((row, o) => row.reduce((a, w, i) => a + w * h[i], l.b[o]));
    if (li < m.layers.length - 1) h = h.map(v => v / (1 + Math.exp(-v)));   // SiLU
  });
  const lg = [], mu: [number, number][] = [], sd: [number, number][] = [];
  for (let k = 0; k < m.K; k++) {
    const o = h.slice(5 * k, 5 * k + 5), c = (v: number) => Math.exp(Math.min(2, Math.max(-7, v)));
    lg.push(o[0]); mu.push([o[1], o[2]]); sd.push([c(o[3]), c(o[4])]);
  }
  const mx = Math.max(...lg), e = lg.map(v => Math.exp(v - mx)), z = e.reduce((a, b) => a + b);
  return { w: e.map(v => v / z), mu, sd };
}

/** Input vector, same order as gait_data.features(): heel+toe of the last 3 steps (newest first, local), CoM position,
 *  CoM velocity, speed, heading vs route, route turn at 0.25/0.5/1.0 m ahead (rad, mirrored). The simulator has no body:
 *  toes sit at the training mean heel->toe offset and the CoM at its training mean position, moving along the route. */
export function features(m: StepModel, heels: [number, number][], speed: number, turns: number[]): number[] {
  const hist = heels.flatMap((p, j) => [p[0], p[1], p[0] + m.toe_offset[j][0], p[1] + m.toe_offset[j][1]]);
  const x = [...hist, m.com_mean[0], m.com_mean[1], speed, 0, speed, 0, ...turns];
  return x.map((v, i) => Math.min(m.x_max[i], Math.max(m.x_min[i], v)));   // an MLP extrapolates wildly outside its training range
}

/** A draw inside the training target range (rejection, then the clamped mixture mean). */
export function draw(m: StepModel, mx: Mixture, u: () => number, n: () => number): [number, number] {
  const ok = (p: number[]) => p.every((v, d) => v >= m.y_min[d] && v <= m.y_max[d]);
  for (let t = 0; t < 20; t++) { const p = sample(mx, u, n); if (ok(p)) return p; }
  const mean = [0, 1].map(d => mx.w.reduce((a, w, k) => a + w * mx.mu[k][d], 0));
  return [0, 1].map(d => Math.min(m.y_max[d], Math.max(m.y_min[d], mean[d]))) as [number, number];
}

export function sample(mx: Mixture, u: () => number, n: () => number): [number, number] {
  let r = u(), k = 0;
  while (k < mx.w.length - 1 && (r -= mx.w[k]) > 0) k++;
  return [mx.mu[k][0] + mx.sd[k][0] * n(), mx.mu[k][1] + mx.sd[k][1] * n()];
}

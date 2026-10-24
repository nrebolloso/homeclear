// Monte Carlo night trips along a planned route: where the feet land, which swings cross a measured bump, and how
// often that becomes a toe contact. Heights come from the splat grid; the height->probability table is config.
import type { GridMeta, XY } from './grid.ts';
import { toCell } from './grid.ts';
import { mdn, features, draw, type StepModel } from './stepmodel.ts';
import { predict, sampleHeel, smoothRoute, type WorldModel, type Pose } from './worldmodel.ts';

export interface Persona {
  gait_profile: string; stride_m: number; stride_cv: number; foot_sep_m: number; toe_clearance_cv: number;
  step_model?: 'hand' | 'learned' | 'world'; speed_mps?: number;   // learned = stepmodel.ts; world = worldmodel.ts (heels + walker)
}
export interface Risk {
  rollouts: number; trips_per_night: number; days_per_month: number; path_offset_sd_m: number; step_jitter_m: number;
  dark_contact_multiplier: number; ghosts: number; contact_table: Record<string, { height_m: number[]; p_per_stride: number[] }>;
}
export interface Light { x: number; y: number; r: number }
export interface Ghost { pts: XY[]; hit: boolean[]; walker?: Pose[] }   // walker: world model only, one pose per step
export interface RolloutResult { per_month: number; per_comp: Record<number, number>; trips: number; ghosts: Ghost[] }

/** Linear interpolation in the calibration table, clamped at both ends. */
export function contactProb(t: { height_m: number[]; p_per_stride: number[] }, h: number): number {
  const H = t.height_m, P = t.p_per_stride;
  if (h <= H[0]) return P[0];
  for (let k = 1; k < H.length; k++) if (h <= H[k]) return P[k - 1] + ((P[k] - P[k - 1]) * (h - H[k - 1])) / (H[k] - H[k - 1]);
  return P[P.length - 1];
}

/** Seeded PRNG (mulberry32): the same seed for every layout gives common random numbers, so before/after is a fair compare. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

export function rollouts(g: GridMeta, bump: Float32Array, comps: Int32Array, route: XY[], persona: Persona, risk: Risk,
                         lights: Light[], seed = 1, model?: StepModel, world?: WorldModel): RolloutResult {
  if (persona.step_model === 'world') return worldRollouts(g, bump, comps, route, persona, risk, lights, seed, world);
  const learned = persona.step_model === 'learned';
  if (learned && !model) throw new Error('persona.step_model = learned but no step model loaded');
  const table = risk.contact_table[persona.gait_profile];
  if (!table) throw new Error(`no contact_table for gait profile ${persona.gait_profile}`);
  const s = [0];
  for (let k = 1; k < route.length; k++) s.push(s[k - 1] + Math.hypot(route[k][0] - route[k - 1][0], route[k][1] - route[k - 1][1]));
  const L = s[s.length - 1], ny = g.shape[1];
  // position + unit normal (left of travel) at arc length u
  let seg = 0;
  const at = (u: number): [number, number, number, number] => {
    if (u < s[seg]) seg = 0;
    while (seg < s.length - 2 && s[seg + 1] < u) seg++;
    const a = route[seg], b = route[Math.min(seg + 1, route.length - 1)], d = s[seg + 1] - s[seg] || 1;
    const f = Math.min(1, Math.max(0, (u - s[seg]) / d)), tx = (b[0] - a[0]) / d, ty = (b[1] - a[1]) / d;
    return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), -ty, tx];
  };
  // before the start: straight back along the first segment (the learned model needs 3 steps of history)
  const atx = (u: number): [number, number, number, number] => {
    const p = at(Math.max(0, Math.min(u, L))), e = u < 0 ? u : 0;
    return [p[0] + e * p[3], p[1] - e * p[2], p[2], p[3]];
  };
  // learned: route resampled every 1 cm with its direction from a +-15 cm chord (a grid path's own segments zigzag
  // 0/45 deg; the training routes are smooth), so frames and the heel -> route projection are index lookups
  const N = learned ? Math.floor(L / 0.01) + 1 : 0, rp: XY[] = [], rd: XY[] = [];
  for (let i = 0; i < N; i++) { const p = at(i * 0.01); rp.push([p[0], p[1]]); }
  for (let i = 0; i < N; i++) {
    const p = atx((i - 15) * 0.01), q = i + 15 < N ? rp[i + 15] : atx((i + 15) * 0.01), d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    rd.push([(q[0] - p[0]) / d, (q[1] - p[1]) / d]);
  }
  const R = rng(seed), perComp: Record<number, number> = {}, ghosts: Ghost[] = [];
  let total = 0;
  for (let trip = 0; trip < risk.rollouts; trip++) {
    const off = R.n() * risk.path_offset_sd_m;
    const clearance = Math.exp(R.n() * persona.toe_clearance_cv);   // this trip's toe clearance vs. typical
    const step = learned ? model!.hand_rule_fit!.stride_m : Math.max(0.15, persona.stride_m * (1 + R.n() * persona.stride_cv));
    const last: (XY | null)[] = [null, null];
    const ghost: Ghost = { pts: [], hit: [] };
    // learned: the 3 latest heels (newest first), seeded with hand-rule steps behind the start
    const heels: XY[] = [];
    let u = R.u() * step, ci = Math.round(u / 0.01);
    if (learned) for (let j = 0; j < 3; j++) {
      const [x, y, nx, nyv] = atx(u - j * step), lat = off + ((j % 2) ? -1 : 1) * model!.hand_rule_fit!.foot_sep_m / 2;
      heels.push([x + nx * lat, y + nyv * lat]);
    }
    // learned: stop once a heel projects onto the goal (its frame is pinned there, so further steps walk off the route)
    for (let k = 0; learned ? ci < N - 1 : u <= L + step; k++) {
      const side = k % 2;
      let foot: XY, body: XY;
      if (!learned) {
        const [x, y, nx, nyv] = at(Math.min(u, L));
        const lat = off + (side ? 1 : -1) * persona.foot_sep_m / 2 + R.n() * risk.step_jitter_m;
        foot = [x + nx * lat, y + nyv * lat]; body = [x + nx * off, y + nyv * off];
        u += step;
      } else {
        // frame at the current heel's route point; mirror so the next foot is always "left" (side 1 = left)
        const i0 = Math.min(ci, N - 1), [ox, oy] = rp[i0], [tx, ty] = rd[i0], nx = -ty, nyv = tx, mir = side ? 1 : -1;
        const loc = (p: XY): [number, number] => [(p[0] - ox) * tx + (p[1] - oy) * ty, mir * ((p[0] - ox) * nx + (p[1] - oy) * nyv)];
        const turns = [25, 50, 100].map(m => { const q = rd[Math.min(i0 + m, N - 1)]; return Math.atan2(mir * (q[0] * nx + q[1] * nyv), q[0] * tx + q[1] * ty); });
        const [a, b] = draw(model!, mdn(model!, features(model!, heels.map(loc), persona.speed_mps ?? 0.5, turns)), R.u, R.n);
        foot = [ox + a * tx + b * mir * nx, oy + a * ty + b * mir * nyv];
        body = [(foot[0] + heels[0][0]) / 2, (foot[1] + heels[0][1]) / 2];
        heels.unshift(foot); heels.length = 3;
        // next frame: the route point nearest the new heel (as gait_data.py), searched ahead
        let best = Infinity, bi = ci + Math.max(5, Math.round(a * 100));
        for (let j = ci; j <= Math.min(ci + 120, N - 1); j++) { const d = Math.hypot(rp[j][0] - foot[0], rp[j][1] - foot[1]); if (d < best) { best = d; bi = j; } }
        if (bi <= ci) bi = ci + Math.max(5, Math.round(a * 100));
        ci = bi; u = ci * 0.01;
      }
      let hit = false;
      const from = last[side];
      if (from) {   // the swing from this foot's last placement: highest bump it passes over
        const n = Math.max(2, Math.ceil(Math.hypot(foot[0] - from[0], foot[1] - from[1]) / (g.cell_m / 2)));
        let h = 0, comp = 0;
        for (let q = 0; q <= n; q++) {
          const [i, j] = toCell(g, [from[0] + (foot[0] - from[0]) * q / n, from[1] + (foot[1] - from[1]) * q / n]);
          if (bump[i * ny + j] > h) { h = bump[i * ny + j]; comp = comps[i * ny + j]; }
        }
        if (h > 0) {
          const lit = lights.some(l => Math.hypot(foot[0] - l.x, foot[1] - l.y) <= l.r);
          const p = Math.min(1, contactProb(table, h / clearance) * (lit ? 1 : risk.dark_contact_multiplier));
          if (R.u() < p) { hit = true; total++; perComp[comp] = (perComp[comp] || 0) + 1; }
        }
      }
      last[side] = foot;
      if (trip < risk.ghosts) { ghost.pts.push(body); ghost.hit.push(hit); }
    }
    if (trip < risk.ghosts) ghosts.push(ghost);
  }
  const month = risk.trips_per_night * risk.days_per_month / risk.rollouts;
  const per_comp: Record<number, number> = {};
  for (const c in perComp) per_comp[c] = perComp[c] * month;
  return { per_month: total * month, per_comp, trips: risk.rollouts, ghosts };
}

/** World model trips (worldmodel/rollout.py Engine.trip): heels drawn from the learned mixture, the walker pose from its
 *  walker head. Ghost dots are the heels. shortcut: no per-trip path offset and no walker pull-back at counters (the
 *  Python engine has both); the live frame check still turns the walker red where it gets too close. */
function worldRollouts(g: GridMeta, bump: Float32Array, comps: Int32Array, route: XY[], persona: Persona, risk: Risk,
                       lights: Light[], seed: number, m?: WorldModel): RolloutResult {
  if (!m) throw new Error('persona.step_model = world but no world model loaded');
  const table = risk.contact_table[persona.gait_profile];
  if (!table) throw new Error(`no contact_table for gait profile ${persona.gait_profile}`);
  const rt = smoothRoute(route), n0 = rt.length, ny = g.shape[1];
  const e = rt[n0 - 1], b = rt[Math.max(0, n0 - 20)], du = Math.hypot(e[0] - b[0], e[1] - b[1]) || 1;
  const ext: XY[] = [...rt, ...[...Array(150)].map((_, i) => [e[0] + (i + 1) * 0.01 * (e[0] - b[0]) / du, e[1] + (i + 1) * 0.01 * (e[1] - b[1]) / du] as XY)];
  const R = rng(seed), perComp: Record<number, number> = {}, ghosts: Ghost[] = [];
  let total = 0;
  const L0 = persona.stride_m, Wd = persona.foot_sep_m, d0 = Math.hypot(rt[20][0] - rt[0][0], rt[20][1] - rt[0][1]) || 1;
  const ux = (rt[20][0] - rt[0][0]) / d0, uy = (rt[20][1] - rt[0][1]) / d0;
  for (let trip = 0; trip < risk.rollouts; trip++) {
    const clearance = Math.exp(R.n() * persona.toe_clearance_cv), s0 = R.u() < 0.5 ? -1 : 1;
    // mid-heels on route[0], as in the training data
    const at = (a: number, l: number): XY => [rt[0][0] + a * ux - l * uy, rt[0][1] + a * uy + l * ux];
    const heels: XY[] = [at(L0 / 2, s0 * Wd / 2), at(-L0 / 2, -s0 * Wd / 2), at(-1.5 * L0, s0 * Wd / 2)], sides = [s0, -s0, s0];
    const last: XY[] = s0 > 0 ? [heels[1], heels[0]] : [heels[0], heels[1]];   // index 0 = right foot, 1 = left foot
    const ghost: Ghost = { pts: [], hit: [], walker: [] };
    for (let k = 0, step = 0; step < 400; step++) {
      const mid: XY = [(heels[0][0] + heels[1][0]) / 2, (heels[0][1] + heels[1][1]) / 2];
      let best = Infinity, bk = k;
      for (let j = k; j < Math.min(k + 120, ext.length); j++) { const d = Math.hypot(ext[j][0] - mid[0], ext[j][1] - mid[1]); if (d < best) { best = d; bk = j; } }
      k = bk;
      if (k >= n0 - 16) break;
      const action = [25, 50, 100].map(o => ext[Math.min(k + o, ext.length - 1)]);
      const p = predict(m, heels, sides, action), foot = sampleHeel(p, R.u, R.n), side = -sides[0], fi = side > 0 ? 1 : 0;
      let hit = false;
      const from = last[fi];
      const ns = Math.max(2, Math.ceil(Math.hypot(foot[0] - from[0], foot[1] - from[1]) / (g.cell_m / 2)));
      let h = 0, comp = 0;
      for (let q = 0; q <= ns; q++) {
        const [i, j] = toCell(g, [from[0] + (foot[0] - from[0]) * q / ns, from[1] + (foot[1] - from[1]) * q / ns]);
        if (bump[i * ny + j] > h) { h = bump[i * ny + j]; comp = comps[i * ny + j]; }
      }
      if (h > 0) {
        const lit = lights.some(l => Math.hypot(foot[0] - l.x, foot[1] - l.y) <= l.r);
        const pc = Math.min(1, contactProb(table, h / clearance) * (lit ? 1 : risk.dark_contact_multiplier));
        if (R.u() < pc) { hit = true; total++; perComp[comp] = (perComp[comp] || 0) + 1; }
      }
      last[fi] = foot;
      heels.unshift(foot); heels.length = 3; sides.unshift(side); sides.length = 3;
      if (trip < risk.ghosts) { ghost.pts.push(foot); ghost.hit.push(hit); ghost.walker!.push(p.walker); }
    }
    if (trip < risk.ghosts) ghosts.push(ghost);
  }
  const month = risk.trips_per_night * risk.days_per_month / risk.rollouts;
  const per_comp: Record<number, number> = {};
  for (const c in perComp) per_comp[c] = perComp[c] * month;
  return { per_month: total * month, per_comp, trips: risk.rollouts, ghosts };
}

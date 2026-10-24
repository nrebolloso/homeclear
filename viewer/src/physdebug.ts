// Debug views of the physics pass (physics.ts): what the pushed walker did, as numbers, a chart and a replayable pose.
// Pure functions first (tested in tests/physdebug.test.ts); drawPushChart is the only one that touches a canvas.
import type { PhysicsResult, TracePoint } from './physics.ts';

export interface PhysSummary {
  /** hardest push given after the first 0.5 m run-up (N; getting the walker moving from rest is not counted) and the limit it was capped at */
  peak_push_n: number; limit_n: number;
  /** seconds spent at the limit (the person has nothing more to give) */
  at_limit_s: number;
  /** largest frame tilt (deg) and the tallest floor edge any leg stood on (m) */
  max_tilt_deg: number; max_leg_height_m: number;
  /** distance along the route where the push peaked (m) */
  peak_at_s: number;
  /** average speed over the run (m/s), the walker reaching the goal or not */
  mean_speed_mps: number;
  snags: number; tipped: number; done: boolean; stuck_at_s: number | null;
}

const RUN_UP_M = 0.5, EDGE_M = 0.003;
export function summarize(r: PhysicsResult): PhysSummary {
  const tr = r.trace, dt = tr.length > 1 ? (tr[tr.length - 1].t - tr[0].t) / (tr.length - 1) : 0;
  let peak = 0, peakAt = 0, atLimit = 0, tilt = 0, leg = 0;
  // the push to get the walker from rest up to walking speed is the person starting, not an obstacle: the first RUN_UP_M
  // of the route does not count, unless a leg is already standing on an edge there
  const counted = (p: TracePoint) => p.s >= RUN_UP_M || p.legs.some(h => h >= EDGE_M);
  for (const p of tr) {
    if (counted(p) && p.push > peak) { peak = p.push; peakAt = p.s; }
    if (counted(p) && p.push >= r.limit_n - 1e-6) atLimit += dt;
    tilt = Math.max(tilt, p.tilt_deg);
    leg = Math.max(leg, ...p.legs);
  }
  const last = tr[tr.length - 1];
  return { peak_push_n: peak, limit_n: r.limit_n, at_limit_s: +atLimit.toFixed(2), max_tilt_deg: tilt, max_leg_height_m: leg, peak_at_s: peakAt,
    mean_speed_mps: last && last.t > 0 ? +(last.s / last.t).toFixed(3) : 0,
    snags: r.snags.length, tipped: r.snags.filter(s => s.tipped).length, done: r.done, stuck_at_s: r.stuck ? r.stuck.s_m : null };
}

/** One-line readout of a sample, for the replay caption. */
export const sampleText = (p: TracePoint, limit: number) =>
  `${p.t.toFixed(1)} s · ${p.s.toFixed(2)} m · ${(p.v * 100).toFixed(0)} cm/s · push ${p.push.toFixed(0)}/${limit.toFixed(0)} N · tilt ${p.tilt_deg.toFixed(1)}°`;

/** The pose at time t, interpolated between samples (yaw the short way round); clamps at both ends. */
export function poseAt(tr: TracePoint[], t: number): TracePoint | null {
  if (!tr.length) return null;
  if (t <= tr[0].t) return tr[0];
  const last = tr[tr.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = tr.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid].t <= t) lo = mid; else hi = mid; }
  const a = tr[lo], b = tr[hi], f = (t - a.t) / Math.max(b.t - a.t, 1e-9), mix = (x: number, y: number) => x + f * (y - x);
  let dy = b.yaw - a.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  return { t, x: mix(a.x, b.x), y: mix(a.y, b.y), yaw: a.yaw + f * dy, s: mix(a.s, b.s), v: mix(a.v, b.v), push: mix(a.push, b.push),
    tilt_deg: mix(a.tilt_deg, b.tilt_deg), legs: a.legs.map((h, k) => mix(h, b.legs[k])) };
}

/** Push as a fraction of the limit, 0..1: blue (easy) to red (all the person has). */
export const pushColor = (push: number, limit: number): [number, number, number] => {
  const f = Math.min(1, Math.max(0, push / Math.max(limit, 1e-9)));
  return [0.25 + 0.75 * f, 0.55 - 0.4 * f, 1 - 0.85 * f];
};

/** Push against distance along the route, with the limit, the edges the legs stood on and the snags. */
export function drawPushChart(cv: HTMLCanvasElement, r: PhysicsResult, playhead?: number) {
  const ctx = cv.getContext('2d')!, W = cv.width, H = cv.height, m = { l: 30, r: 6, t: 8, b: 16 };
  ctx.clearRect(0, 0, W, H);
  const tr = r.trace;
  if (!tr.length) { ctx.fillStyle = '#9aa'; ctx.font = '11px system-ui'; ctx.fillText('no trace recorded', 8, H / 2); return; }
  const L = tr[tr.length - 1].s || 1, X = (s: number) => m.l + (s / L) * (W - m.l - m.r), Y = (n: number) => H - m.b - (n / (r.limit_n * 1.1)) * (H - m.t - m.b);
  const edge = Math.max(0.02, ...tr.flatMap(p => p.legs)), E = (h: number) => H - m.b - (h / edge) * 0.45 * (H - m.t - m.b);
  // the floor edges under the legs (tallest leg), as a grey profile at the bottom
  ctx.fillStyle = 'rgba(160,170,180,.35)';
  ctx.beginPath(); ctx.moveTo(X(0), H - m.b);
  for (const p of tr) ctx.lineTo(X(p.s), E(Math.max(...p.legs)));
  ctx.lineTo(X(L), H - m.b); ctx.closePath(); ctx.fill();
  // the limit and the push
  ctx.strokeStyle = '#ff5a5a'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(m.l, Y(r.limit_n)); ctx.lineTo(W - m.r, Y(r.limit_n)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#66ccff'; ctx.lineWidth = 1.5; ctx.beginPath();
  tr.forEach((p, k) => (k ? ctx.lineTo(X(p.s), Y(p.push)) : ctx.moveTo(X(p.s), Y(p.push))));
  ctx.stroke(); ctx.lineWidth = 1;
  for (const s of r.snags) {
    ctx.strokeStyle = s.tipped ? '#ff2fd0' : '#ffb347'; ctx.beginPath(); ctx.moveTo(X(s.s_m), m.t); ctx.lineTo(X(s.s_m), H - m.b); ctx.stroke();
  }
  if (r.stuck) { ctx.fillStyle = '#ff2fd0'; ctx.fillRect(X(r.stuck.s_m) - 3, m.t, 6, H - m.t - m.b); }
  if (playhead !== undefined) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(X(playhead), m.t); ctx.lineTo(X(playhead), H - m.b); ctx.stroke(); }
  ctx.fillStyle = '#9aa'; ctx.font = '10px system-ui';
  ctx.fillText(`${r.limit_n.toFixed(0)} N`, 2, Y(r.limit_n) + 3); ctx.fillText('0', 18, H - m.b + 3);
  ctx.fillText('0 m', m.l, H - 3); ctx.fillText(`${L.toFixed(1)} m`, W - m.r - 28, H - 3);
}

// Cascading rug hazard in autoplay: each autoplay pass that crosses the rug's edge (onto or off) may fold a corner; the
// fold stays in the layout (Layout.folds) as a taller bump, so the next pass's rollouts and the futures fan see it.
// P(fold per crossing) is MEASURED: the real walker passes over a loose rug (data/recording_notes.csv). The fold height
// is SIMULATED: the cloth-rug sim's folded passes (physics/rug_calib.py check, all arms pooled).
import type { XY, Fold, Layout, Pose } from './grid.ts';
import calib from '../../physics/rug_calib.json' with { type: 'json' };

const real = calib.real as Record<string, { n: number; folded: number }>;
/** folded flat-rug passes / all of them, both directions pooled */
export const P_FOLD = Object.values(real).reduce((s, r) => s + r.folded * r.n, 0) / Object.values(real).reduce((s, r) => s + r.n, 0);
/** median height of the sim's folded passes, every arm pooled (the fitted arm drags rather than folds) */
export const FOLD_LIFT_M = calib.fold_h_m.p50;
const pooled = (a: Record<string, { n: number; disturbed: number }>) => Object.values(a).reduce((s, r) => s + r.disturbed * r.n, 0) / Object.values(a).reduce((s, r) => s + r.n, 0);
/** glide caps / tennis balls on the rear legs (glide-rug friction CAPS_MU, ASSUMED): P(fold or drag) with caps over
 *  without, both directions, same draws of everything else (paired sim arms) */
export const CAPS_FACTOR = pooled(calib.arms.glide_caps) / pooled(calib.arms.fitted);
/** tape the mat edge (edge rows pinned in the sim), the same ratio */
export const TAPE_FACTOR = pooled(calib.arms.taped) / pooled(calib.arms.fitted);
export const FOLD_SIZE_M = 0.15;   // ASSUMPTION: the folded flap reaches ~15 cm from the corner, read off the real clips by eye

const cross = (a: XY, b: XY, c: XY, d: XY): XY | null => {   // where segment ab crosses cd, if it does
  const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]], den = r[0] * q[1] - r[1] * q[0];
  if (!den) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
};

/** Where the route crosses the polygon's edges, in route order. */
export function edgeCrossings(poly: XY[], xy: XY[]): XY[] {
  const out: XY[] = [];
  for (let i = 1; i < xy.length; i++)
    for (let e = 0; e < poly.length; e++) {
      const x = cross(xy[i - 1], xy[i], poly[e], poly[(e + 1) % poly.length]);
      if (x) out.push(x);
    }
  return out;
}

/** Pass n over the rug: each edge crossing folds the corner nearest it with P_FOLD (seeded by n, so a replay repeats).
 *  Returns the fold of the first crossing that folds, or null. */
export function foldOnPass(poly: XY[], xy: XY[], n: number, p = P_FOLD): Fold | null {
  let s = (n * 2654435761 + 1) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (const x of edgeCrossings(poly, xy)) {
    if (rnd() >= p) continue;
    const corner = poly.reduce((b, q) => (Math.hypot(q[0] - x[0], q[1] - x[1]) < Math.hypot(b[0] - x[0], b[1] - x[1]) ? q : b));
    return { corner: [corner[0], corner[1]], lift_m: FOLD_LIFT_M, size_m: FOLD_SIZE_M };
  }
  return null;
}

/** Autoplay's lap counter: call lap() each time autoplay wraps to the start. A fold already there stays (one per rug);
 *  moving, removing or taping the rug clears it. Returns the new layout when it changed, else null. */
export function createRugCascade(rug: { index: number; poly: (p: Pose) => XY[] } | null) {
  let n = 0, at = '';
  // a taped rug can't fold (Pose.taped comes with the futures-fan branch; read without depending on it)
  const taped = (p: Pose) => 'taped' in p && !!p.taped;
  const key = (p: Pose) => `${p.x},${p.y},${p.yaw},${!!p.removed},${taped(p)}`;
  return {
    get passes() { return n; },
    lap(xy: XY[], lay: Layout): Layout | null {
      if (!rug) return null;
      const p = lay.poses[rug.index];
      if (lay.folds?.length && key(p) !== at) return { ...lay, folds: [] };
      if (p.removed || taped(p) || lay.folds?.length) return null;
      const f = foldOnPass(rug.poly(p), xy, ++n);
      if (!f) return null;
      at = key(p);
      return { ...lay, folds: [f] };
    },
    reset() { n = 0; at = ''; },
  };
}

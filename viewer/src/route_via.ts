// Routes through waypoints (route.via, stage 7's plan.via): plan() leg by leg, joined. A loop is start == goal with via points round it.
import { plan, type GridMeta, type Layers, type Plan, type PlanParams, type XY } from './grid.ts';

export function planVia(g: GridMeta, L: Layers, start: XY, via: XY[] | undefined, goal: XY, pp: PlanParams): Plan {
  if (!via?.length) return plan(g, L, start, goal, pp);
  const pts = [start, ...via, goal];
  let out: Plan | null = null;
  for (let k = 1; k < pts.length; k++) {
    const P = plan(g, L, pts[k - 1], pts[k], pp);
    if (P.error) return { ...P, error: `${P.error} (leg ${k} of ${pts.length - 1})` };
    // legs meet on the same snapped cell: drop the repeat
    out = !out ? P : { ...P, cells: [...out.cells, ...P.cells.slice(1)], xy: [...out.xy, ...P.xy.slice(1)], side: [...out.side, ...P.side.slice(1)],
      length_m: out.length_m + P.length_m, min_side_clearance_m: Math.min(out.min_side_clearance_m ?? Infinity, P.min_side_clearance_m ?? Infinity) };
  }
  return out!;
}

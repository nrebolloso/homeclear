// Re-planning + Monte Carlo off the main thread, so dragging furniture never stalls rendering.
import { stamp, plan, routeHazards, bumpComponents, polyCells, worldFootprint, applyIntervention,
  type GridMeta, type Layers, type Footprinted, type Layout, type Intervention, type XY, type RouteHazard } from './grid.ts';
import { rollouts, type Persona, type Risk } from './sim.ts';
import type { StepModel } from './stepmodel.ts';

export interface Init {
  g: GridMeta; base: Layers; est: Uint8Array; objects: (Footprinted & { name: string; kind: string; light_radius_m: number | null })[];
  route: { start: XY; goal: XY }; persona: Persona; risk: Risk; interventions: Intervention[]; stepModel?: StepModel;
  plan: { walker_width_m: number; preferred_clearance_m: number; clearance_weight: number };
  rules: { clearance_margin_m: number; bump_min_m: number; bump_link_cells?: number; bump_limit_m: number; margin_m: { width: number; height: number } };
}
export interface HazardOut extends RouteHazard { name: string; per_month: number; ot_check: boolean; estimated: boolean }
export interface Eval {
  error?: string; xy: XY[]; side: number[]; length_m: number; hazards: HazardOut[]; per_month: number;
  ghosts: { pts: XY[]; hit: boolean[] }[]; dist_m: Float32Array; ms: number;
}

let S: Init;

function evaluate(lay: Layout, ghosts: boolean): Eval {
  const t = performance.now(), { g, objects: O } = S;
  const L = stamp(g, S.base, O, lay.poses, lay.flattened);
  const P = plan(g, L, S.route.start, S.route.goal, S.plan);
  const out = { xy: P.xy, side: P.side, length_m: P.length_m, dist_m: P.dist_m, hazards: [], per_month: 0, ghosts: [] } as unknown as Eval;
  if (P.error) return { ...out, error: P.error, ms: performance.now() - t };
  const comps = bumpComponents(g, L.bump, S.rules.bump_min_m, S.rules.bump_link_cells);
  const names: Record<number, string> = {}, estComp = new Set<number>();
  S.est.forEach((e, c) => { if (e && comps[c]) estComp.add(comps[c]); });
  O.forEach((o, k) => {
    if (o.layer === 'bump' && !lay.poses[k].removed)
      for (const c of polyCells(g, worldFootprint(o, lay.poses[k]))) if (comps[c]) names[comps[c]] = o.name;
  });
  const lights = O.flatMap((o, k) => (o.kind === 'nightlight' && !lay.poses[k].removed ? [{ x: lay.poses[k].x, y: lay.poses[k].y, r: o.light_radius_m ?? 1.5 }] : []));
  const R = rollouts(g, L.bump, comps, P.xy, S.persona, { ...S.risk, ghosts: ghosts ? S.risk.ghosts : 0 }, lights, 1, S.stepModel);
  out.hazards = routeHazards(g, L, P, S.plan.walker_width_m, S.rules.clearance_margin_m, S.rules.bump_min_m, comps).map(h => ({
    ...h, name: h.type === 'floor_bump' ? names[h.comp!] ?? (estComp.has(h.comp!) ? 'cable' : 'floor bump') : 'tight passage',
    estimated: h.type === 'floor_bump' && estComp.has(h.comp!),
    per_month: h.type === 'floor_bump' ? R.per_comp[h.comp!] ?? 0 : 0,
    // within the measured map error (stage 6b) of a limit counts as a check too: borderline, OT to verify
    ot_check: h.type === 'floor_bump' ? h.height_m! >= S.rules.bump_limit_m - S.rules.margin_m.height || estComp.has(h.comp!)
      : h.min_side_clearance_m! < S.rules.clearance_margin_m + S.rules.margin_m.width,
  }));
  out.per_month = R.per_month; out.ghosts = R.ghosts;
  return { ...out, ms: performance.now() - t };
}

onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') { S = m.init; return; }
  if (m.type === 'eval') {
    const r = evaluate(m.layout, true);
    postMessage({ type: 'eval', id: m.id, r }, { transfer: [r.dist_m.buffer] });
  } else if (m.type === 'fixes') {
    const before = evaluate(m.layout, false).per_month;
    const fixes = S.interventions.map(iv => {
      const r = evaluate(applyIntervention(S.objects, m.layout, iv), false);
      return { id: iv.id, label: iv.label, per_month: r.per_month, reduction: r.error ? -Infinity : before - r.per_month, error: r.error };
    }).sort((a, b) => b.reduction - a.reduction);
    postMessage({ type: 'fixes', id: m.id, before, fixes });
  }
};

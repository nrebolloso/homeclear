// Re-planning + Monte Carlo off the main thread, so dragging furniture never stalls rendering.
import { applyIntervention, stamp, bumpComponents, carvedPolys } from './grid.ts';
import { evaluate, type Init, type Eval } from './evaluate.ts';
import { optimize } from './optimize.ts';
export type { Init, Eval, RouteDef, HazardOut, RouteSummary } from './evaluate.ts';

let S: Init;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') { S = m.init; return; }
  if (m.type === 'eval') {
    const r = evaluate(S, m.layout, { ghosts: true, sel: m.sel, heat: m.heat });
    const transfer: ArrayBuffer[] = [r.dist_m.buffer as ArrayBuffer];
    if (r.heat) transfer.push(r.heat.steps.buffer as ArrayBuffer, r.heat.hits.buffer as ArrayBuffer);
    postMessage({ type: 'eval', id: m.id, r }, { transfer });
  } else if (m.type === 'fixes') {
    // tightest squeeze on the selected route: a fix can matter by widening it even with no toe contacts saved
    const squeeze = (r: Eval) => r.hazards.filter(h => h.type === 'tight_clearance').reduce((v, h) => Math.min(v, h.min_side_clearance_m!), Infinity);
    const b = evaluate(S, m.layout, { ghosts: false, sel: m.sel }), before = b.per_month;
    const fixes = S.interventions.map(iv => {
      const r = evaluate(S, applyIntervention(S.objects, m.layout, iv), { ghosts: false, sel: m.sel });
      const gain = Math.min(squeeze(r), 0.5) - Math.min(squeeze(b), 0.5);
      return { id: iv.id, label: iv.label, per_month: r.per_month, reduction: r.error ? -Infinity : before - r.per_month,
        clearance_gain_m: r.error ? 0 : gain, error: r.error };
    }).sort((a, b) => b.reduction - a.reduction || b.clearance_gain_m - a.clearance_gain_m);
    postMessage({ type: 'fixes', id: m.id, before, fixes });
  } else if (m.type === 'physics') {
    // the walker pushed along every route over this layout's floor (Rapier); separate from the toe-contact numbers
    const { initPhysics, pushAlong } = await import('./physics.ts');   // Rapier's wasm (~4 MB) only when asked
    await initPhysics();
    const L = stamp(S.g, S.base, S.objects, m.layout.poses, m.layout.flattened, carvedPolys(m.layout));
    const comps = bumpComponents(S.g, L.bump, S.rules.bump_min_m, S.rules.bump_link_cells);
    const routes = S.routes.map((rd, k) => {
      const e = evaluate(S, m.layout, { ghosts: false, sel: k });
      if (e.error) return { name: rd.name, error: e.error };
      const names: Record<number, string> = {};
      for (const h of e.hazards) if (h.comp) names[h.comp] = h.name;
      return { name: rd.name, names, ...pushAlong(S.g, L.bump, comps, e.xy, m.walker, m.cfg) };
    });
    postMessage({ type: 'physics', id: m.id, routes });
  } else if (m.type === 'optimize') {
    const res = optimize(S, m.layout, m.cfg ?? {}, msg => postMessage({ type: 'progress', id: m.id, msg }));
    postMessage({ type: 'optimize', id: m.id, ...res });
  }
};

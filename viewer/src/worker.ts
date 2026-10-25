// Re-planning + Monte Carlo off the main thread, so dragging furniture never stalls rendering.
import { applyIntervention, stamp, bumpComponents, carvedPolys } from './grid.ts';
import { evaluate, availableInterventions, type Init, type Eval } from './evaluate.ts';
import { optimize } from './optimize.ts';
import { reachField, analyze, type ReachField } from './reach.ts';
export type { Init, Eval, RouteDef, HazardOut, RouteSummary } from './evaluate.ts';

let S: Init;
let reach: { key: string; f: ReachField; id: number } | null = null, reachIds = 0;   // the widest-way field, per layout and start

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') { S = m.init; reach = null; return; }
  if (m.type === 'eval') {
    const r = evaluate(S, m.layout, { ghosts: true, sel: m.sel, heat: m.heat });
    if (S.persona.step_model !== 'hand' && !r.error) {   // hand-rule baseline over the same route: ~50 ms, drawn as a second ghost set
      const h = evaluate({ ...S, persona: { ...S.persona, step_model: 'hand' }, stepModel: undefined, worldModel: undefined }, m.layout, { ghosts: true, sel: m.sel });
      r.hand = { per_month: h.per_month, ghosts: h.ghosts };
    }
    const transfer: ArrayBuffer[] = [r.dist_m.buffer as ArrayBuffer];
    if (r.heat) transfer.push(r.heat.steps.buffer as ArrayBuffer, r.heat.hits.buffer as ArrayBuffer);
    postMessage({ type: 'eval', id: m.id, r }, { transfer });
  } else if (m.type === 'fixes') {
    // tightest squeeze on the selected route: a fix can matter by widening it even with no toe contacts saved
    const squeeze = (r: Eval) => r.hazards.filter(h => h.type === 'tight_clearance').reduce((v, h) => Math.min(v, h.min_side_clearance_m!), Infinity);
    const b = evaluate(S, m.layout, { ghosts: false, sel: m.sel }), before = b.per_month;
    const fixes = availableInterventions(S, b).map(iv => {
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
  } else if (m.type === 'reach') {
    // where this device can go (reach.ts): the field once per layout, the report per width; the field's arrays go to the
    // main thread only when they changed (the width slider repaints from them there)
    const key = JSON.stringify([m.layout, m.start]);
    if (reach?.key !== key) reach = { key, f: reachField(S, m.layout, m.start, S.plan.walker_width_m / 2), id: ++reachIds };
    const f = reach.f, report = analyze(S, f, m.layout, m.opts, m.targets);
    const out: Record<string, unknown> = { type: 'reach', id: m.id, report, fieldId: reach.id }, transfer: ArrayBuffer[] = [];
    if (m.have !== reach.id) {
      const field = { dist: f.dist.slice(), need: f.need.slice(), len: f.len.slice(), grey: f.grey.slice(), hatch: f.hatch.slice() };
      out.field = field; transfer.push(...Object.values(field).map(a => a.buffer as ArrayBuffer));
    }
    postMessage(out, { transfer });
  } else if (m.type === 'optimize') {
    const res = optimize(S, m.layout, m.cfg ?? {}, msg => postMessage({ type: 'progress', id: m.id, msg }));
    postMessage({ type: 'optimize', id: m.id, ...res });
  }
};

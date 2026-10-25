// A few named plans for the room, side by side: cycle through them, reset one change inside a plan, see what each costs and
// does. A plan is a Layout (plain data) plus the ids of the configured fixes behind it, so diffLayouts (reimagine.ts) can cost
// and label every change and undoChange can take one back. Pure: no DOM, no worker; main.ts holds a PlanSet and renders cards.
import type { Intervention, Layout, Pose } from './grid.ts';
import { diffLayouts, undoChange, type Change } from './reimagine.ts';
import { sumCosts } from './movecost.ts';
import { evaluate, type Eval, type Init } from './evaluate.ts';
import { compare, headline, type Analytics } from './analytics.ts';

export interface Plan { id: string; name: string; layout: Layout; applied: string[] }
/** plans[0] is always the room as scanned: it can't be removed or renamed, and every card compares against it */
export interface PlanSet { plans: Plan[]; index: number }

const copy = (l: Layout): Layout => ({ ...l, poses: l.poses.map(p => ({ ...p })), flattened: [...l.flattened],
  ...(l.raised ? { raised: { ...l.raised } } : {}), ...(l.added ? { added: [...l.added] } : {}),
  ...(l.carved ? { carved: [...l.carved] } : {}), ...(l.placed ? { placed: { ...l.placed } } : {}) });

export const START_ID = 'as-scanned';
export function createPlans(original: Layout): PlanSet {
  return { plans: [{ id: START_ID, name: 'As scanned', layout: copy(original), applied: [] }], index: 0 };
}
export const current = (s: PlanSet): Plan => s.plans[s.index];
export const start = (s: PlanSet): Plan => s.plans[0];

const uniqueId = (s: PlanSet, name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
  let id = slug, n = 2;
  while (s.plans.some(p => p.id === id)) id = `${slug}-${n++}`;
  return id;
};

/** A new plan (selected). `name` defaults to "Plan B", "Plan C", … */
export function addPlan(s: PlanSet, layout: Layout, applied: string[] = [], name?: string): PlanSet {
  const nm = name?.trim() || `Plan ${String.fromCharCode(65 + Math.min(s.plans.length, 25))}`;
  const plans = [...s.plans, { id: uniqueId(s, nm), name: nm, layout: copy(layout), applied: [...applied] }];
  return { plans, index: plans.length - 1 };
}
/** The selected plan copied under a new name, to try a variation without losing it. */
export const forkPlan = (s: PlanSet, name?: string): PlanSet => addPlan(s, current(s).layout, current(s).applied, name);

export function removePlan(s: PlanSet, id: string): PlanSet {
  if (id === START_ID) return s;
  const was = current(s).id, plans = s.plans.filter(p => p.id !== id);
  return { plans, index: Math.max(0, plans.findIndex(p => p.id === was)) };   // removing the selected one falls back to the scan
}
export const renamePlan = (s: PlanSet, id: string, name: string): PlanSet =>
  id === START_ID || !name.trim() ? s : { ...s, plans: s.plans.map(p => (p.id === id ? { ...p, name: name.trim() } : p)) };

/** The arrows: +1 / -1 wrap around, so a quick tap cycles through every plan. */
export const step = (s: PlanSet, by: 1 | -1): PlanSet => ({ ...s, index: (s.index + by + s.plans.length) % s.plans.length });
export const select = (s: PlanSet, id: string): PlanSet => { const k = s.plans.findIndex(p => p.id === id); return k < 0 ? s : { ...s, index: k }; };

/** The selected plan after the user changed the room (a drag, a fix applied): same plan, new layout. */
export const updateCurrent = (s: PlanSet, layout: Layout, applied: string[]): PlanSet =>
  s.index === 0 ? s : { ...s, plans: s.plans.map((p, k) => (k === s.index ? { ...p, layout: copy(layout), applied: [...applied] } : p)) };

/** Every change in a plan, against the room as scanned, each costed (movecost.ts). */
export const changesOf = (objs: { name: string; kind: string; pivot: number[]; height_m?: number }[], s: PlanSet, plan: Plan, ivs: Intervention[]): Change[] =>
  diffLayouts(objs, start(s).layout, plan.layout, ivs, plan.applied);

/** One change taken back inside a plan; the others stay. Returns the set unchanged for an unknown plan or the scan. */
export function resetChange(s: PlanSet, id: string, c: Change, originalPoses: Pose[], ivs: Intervention[]): PlanSet {
  if (id === START_ID) return s;
  return { ...s, plans: s.plans.map(p => (p.id !== id ? p : { ...p, layout: undoChange(p.layout, originalPoses, c, ivs), applied: p.applied.filter(a => a !== c.iv) })) };
}
/** The whole plan back to the scan. */
export const resetPlan = (s: PlanSet, id: string): PlanSet =>
  id === START_ID ? s : { ...s, plans: s.plans.map(p => (p.id === id ? { ...p, layout: copy(start(s).layout), applied: [] } : p)) };

export interface PlanCard { plan: Plan; changes: Change[]; cost: { usd: number; minutes: number; helpers: number }; eval: Eval; analytics: Analytics; headline: string }
/** What a plan costs and does. `base` is the scan's Eval (run once, reused for every card); the plan's own Eval is the slow part. */
export function planCard(init: Init, s: PlanSet, plan: Plan, base: Eval, sel = 0): PlanCard {
  const changes = changesOf(init.objects, s, plan, init.interventions);
  const ev = plan.id === START_ID ? base : evaluate(init, plan.layout, { ghosts: false, sel });
  const analytics = compare(base, ev);
  return { plan, changes, cost: sumCosts(changes.map(c => c.cost)), eval: ev, analytics, headline: changes.length ? headline(analytics) : 'No changes yet' };
}

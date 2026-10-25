import type { Change } from './reimagine.ts';

// Frontend seams: a missing estimate stays unknown, never becomes a zero-dollar promise.
export interface Installation {
  setupTimeRange?: [number, number]; helpersNeeded?: number; professionalRequired?: boolean;
  tools?: string[]; powerSource?: string; maintenance?: string; disruption?: string;
  verificationStatus: 'pending' | 'estimated' | 'verified';
}
export interface LightingIdea extends Installation { id: string; title: string; why: string; placement: string }
export const LIGHTING_IDEAS: LightingIdea[] = [
  { id: 'path', title: 'Motion-activated path light', why: 'Consider illumination before entering a dark route.', placement: 'Review route transitions and available outlets.', powerSource: 'Battery or outlet · verify on site', maintenance: 'Battery replacement or charging may be needed.', verificationStatus: 'pending' },
  { id: 'bedside', title: 'Reachable bedside light', why: 'Consider a light that can be switched on before standing.', placement: 'Verify reach from the bed and switch position.', powerSource: 'Verify on site', verificationStatus: 'pending' },
  { id: 'threshold', title: 'Doorway or threshold light', why: 'Review shadows, glare, and changes in floor level.', placement: 'Inspect the actual doorway; keep cables off the walking route.', professionalRequired: true, verificationStatus: 'pending' },
];
export function summarizeChanges(changes: Change[]) {
  const priced = changes.filter(c => c.cost.source !== 'placeholder' && Number.isFinite(c.cost.usd));
  return {
    count: changes.length, knownSubtotal: priced.reduce((s, c) => s + c.cost.usd, 0),
    unpriced: changes.length - priced.length,
    // effort.ts prices every change, placeholder dollars or not; it adds up (movecost.ts sumCosts)
    effort: changes.reduce((s, c) => s + (Number.isFinite(c.cost.effort) ? c.cost.effort : 0), 0),
    helpers: changes.length && changes.every(c => c.cost.source !== 'placeholder') ? Math.max(...changes.map(c => c.cost.helpers)) : null,
  };
}
// Compare final states, not option names or action order. Retain backend indices for Apply.
const firstOfEachLayout = <T extends { option: { layout: unknown } }>(list: T[]) => {
  const seen = new Set<string>();
  return list.filter(({ option }) => { const key = JSON.stringify(option.layout); if (seen.has(key)) return false; seen.add(key); return true; });
};
export function distinctOptions<T extends { layout: unknown; score: number; actions: unknown[] }>(options: T[]) {
  return firstOfEachLayout(options.map((option, index) => ({ option, index })).sort((a, b) => a.option.score - b.option.score || a.option.actions.length - b.option.actions.length));
}
/** The proposals in the order they are stepped through: the precomputed planner's own order (Easiest first), else the best-scored first */
export function orderedProposals<T extends { layout: unknown; score: number; actions: unknown[]; planned?: boolean }>(options: T[]) {
  return options.length && options.every(o => o.planned) ? firstOfEachLayout(options.map((option, index) => ({ option, index }))) : distinctOptions(options);
}
export const escapeHTML = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

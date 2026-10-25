import type { Change } from './reimagine.ts';
import { effortScore } from './effort.ts';

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
  const timed = changes.filter(c => c.cost.source !== 'placeholder' && Number.isFinite(c.cost.minutes));
  return {
    count: changes.length, knownSubtotal: priced.reduce((s, c) => s + c.cost.usd, 0),
    unpriced: changes.length - priced.length, setupMinutes: timed.reduce((s, c) => s + c.cost.minutes, 0),
    untimed: changes.length - timed.length,
    // effort cost (effort.ts): every change has an effort, placeholder or not; minutes stay above in case we switch back
    effortTotal: changes.reduce((s, c) => s + c.cost.effort, 0), effortScore: effortScore(changes.reduce((s, c) => s + c.cost.effort, 0)),
    helpers: changes.length && changes.every(c => c.cost.source !== 'placeholder') ? Math.max(...changes.map(c => c.cost.helpers)) : null,
  };
}
// Compare final states, not option names or action order. Retain backend indices for Apply.
export function distinctOptions<T extends { layout: unknown; score: number; actions: unknown[] }>(options: T[]) {
  const seen = new Set<string>();
  return options.map((option, index) => ({ option, index })).sort((a, b) => a.option.score - b.option.score || a.option.actions.length - b.option.actions.length)
    .filter(({ option }) => { const key = JSON.stringify(option.layout); if (seen.has(key)) return false; seen.add(key); return true; });
}
export const escapeHTML = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

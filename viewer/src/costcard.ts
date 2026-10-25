import { onWindow, every } from './lifetime.ts';
// The cost card: what one proposed change takes, in plain words, when its object is picked. The in-room tags stay (they
// are scene sprites, so they show in the headset); this is the larger desktop card with the detail they have no room for.
// The model is pure (tests/costcard.test.ts) and never turns a missing number into a zero: a placeholder or absent field
// reads "pending", and funding is a classification to verify, not a coverage promise (frontend-model.ts, AGENTS.md).
import type { Change } from './reimagine.ts';
import type { Funding } from './movecost.ts';

export type Status = 'known' | 'placeholder' | 'pending';
export interface CostRow { label: string; value: string; status: Status; note?: string }
export interface HazardRef { type: string; position: [number, number]; name?: string; height_m?: number; min_side_clearance_m?: number }
export interface CostCardModel {
  title: string; kind: Change['kind']; rows: CostRow[]; funding: { label: string; note: string };
  /** hazards of the room as it is that this change clears (within `NEAR_M` of it) */
  clears: string[]; placeholder: boolean;
}

export const NEAR_M = 0.8;
export const FUNDING_LABEL: Record<Funding, string> = {
  self_pay: 'Self-pay', part_b_dme: 'Medicare Part B (durable equipment)', ma_ssbci: 'Medicare Advantage supplemental benefit',
  medicaid_hcbs: 'Medicaid home- and community-based services', va_hisa: 'VA home improvement (HISA)', unclassified: 'Not classified yet',
};
const money = (x: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(x);
const hazardText = (h: HazardRef) => h.type === 'floor_bump'
  ? `${h.name ?? 'bump'}${h.height_m !== undefined ? ` ${(h.height_m * 100).toFixed(1)} cm` : ''}`
  : `tight gap${h.min_side_clearance_m !== undefined ? ` ${(h.min_side_clearance_m * 100).toFixed(0)} cm/side` : ''}`;

/** Resolved hazards within NEAR_M of where the change is made. */
export function nearbyCleared(c: Pick<Change, 'at'>, resolved: HazardRef[], near = NEAR_M): string[] {
  return resolved.filter(h => Math.hypot(h.position[0] - c.at[0], h.position[1] - c.at[1]) <= near).map(hazardText);
}

export function costCardModel(c: Change, resolved: HazardRef[] = []): CostCardModel {
  const ph = c.cost.source === 'placeholder', st: Status = ph ? 'placeholder' : 'known', cost = c.cost;
  const usdKnown = Number.isFinite(cost.usd);
  const rows: CostRow[] = [
    { label: 'Price', status: usdKnown ? st : 'pending', value: !usdKnown ? 'Pending' : cost.usd ? money(cost.usd) : c.kind === 'fix' ? 'Pending' : 'No purchase',
      note: ph ? 'placeholder estimate: not a quote' : undefined },
    { label: 'Time', status: Number.isFinite(cost.minutes) ? st : 'pending', value: Number.isFinite(cost.minutes) ? `${cost.minutes} min` : 'Pending', note: ph ? 'placeholder estimate' : undefined },
    { label: 'People', status: Number.isFinite(cost.helpers) ? st : 'pending', value: Number.isFinite(cost.helpers) ? (cost.helpers > 1 ? `${cost.helpers} people` : '1 person') : 'Pending' },
    { label: 'Effort', status: Number.isFinite(cost.effort) ? st : 'pending', value: Number.isFinite(cost.effort) ? `${cost.effort.toFixed(1)} (relative)` : 'Pending' },
    { label: 'Installation', status: 'pending', value: 'Pending', note: 'tools, power, maintenance and whether a professional is needed: verify on site' },
  ];
  if (c.kind === 'move') rows.splice(1, 0, { label: 'Move', status: 'known', value: `${c.dist_m.toFixed(1)} m${c.turn_deg ? `, turned ${c.turn_deg}°` : ''}` });
  return {
    title: c.label, kind: c.kind, rows, placeholder: ph, clears: nearbyCleared(c, resolved),
    funding: { label: FUNDING_LABEL[cost.funding] ?? FUNDING_LABEL.unclassified, note: 'a classification to verify, not a promise of coverage' },
  };
}

// ---------- DOM ----------

export interface CostCardDeps {
  changes: () => Change[];
  resolved: () => HazardRef[];
  /** the object index picked on the desktop, or -1 */
  onPick: (cb: (k: number) => void) => void;
}
export function mountCostCard(D: CostCardDeps) {
  const el = document.createElement('aside');
  el.id = 'costcard'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'What this change takes'); el.hidden = true;
  document.body.append(el);
  let shown: { k: number; fix?: string } | null = null, last = '';
  const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const find = () => { const w = shown; return w ? D.changes().find(c => (w.fix ? c.iv === w.fix : c.k === w.k)) : undefined; };
  function render() {
    const c = find();
    if (!c) { el.hidden = true; last = ''; return; }
    const m = costCardModel(c, D.resolved());
    el.hidden = false;
    const html = `<div class="cc-head"><span class="cc-eyebrow">${m.kind === 'remove' ? 'REMOVE' : m.kind === 'move' ? 'MOVE' : 'FIX'}</span><button type="button" class="cc-close" aria-label="Close cost card">×</button></div>
      <h2>${esc(m.title)}</h2>
      <dl>${m.rows.map(r => `<div class="cc-row" data-status="${r.status}"><dt>${esc(r.label)}</dt><dd>${esc(r.value)}${r.status === 'placeholder' ? ' <span class="cc-badge">placeholder</span>' : r.status === 'pending' ? ' <span class="cc-badge">verify</span>' : ''}${r.note ? `<small>${esc(r.note)}</small>` : ''}</dd></div>`).join('')}
        <div class="cc-row" data-status="pending"><dt>Who might pay</dt><dd>${esc(m.funding.label)}<small>${esc(m.funding.note)}</small></dd></div></dl>
      ${m.clears.length ? `<div class="cc-clears"><b>Clears</b> ${m.clears.map(esc).join(' · ')}</div>` : '<div class="cc-clears muted">No hazard on the route is cleared by this change alone.</div>'}
      <p class="cc-foot">Estimates for an OT to verify. The numbers are simulated, not a measurement.</p>`;
    if (html === last) return;   // the 1 s refresh must not replace a button under the pointer
    last = html; el.innerHTML = html;
    el.querySelector<HTMLButtonElement>('.cc-close')!.onclick = () => { shown = null; el.hidden = true; };
  }
  D.onPick(k => { shown = k >= 0 ? { k } : null; render(); });
  onWindow('keydown', e => { if (e.code === 'Escape' && !el.hidden && el.contains(document.activeElement)) { shown = null; el.hidden = true; } });
  every(() => { if (shown) render(); }, 1000);   // the numbers change after a re-plan, with no event
  return {
    show(k: number, fix?: string) { shown = { k, fix }; render(); },
    hide() { shown = null; el.hidden = true; },
    visible: () => !el.hidden, element: el,
  };
}

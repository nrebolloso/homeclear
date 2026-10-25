// The $$$ budget window: a slider sets how much the family will spend, a checklist of the configured fixes shows what
// that buys. Suggested fixes (already applied or in the optimizer's best option) stay checked; the rest are filled in
// best-first (toe contacts saved per dollar) while they fit. Unpriced fixes are never auto-checked: a missing price is
// unknown, not free. What is checked goes to the OT report as the plan of action.
import { difficulty, effortScore } from './effort.ts';

export interface BudgetItem { id: string; label: string; usd?: number; effort: number; product?: string; suggested: boolean;
  /** toe contacts per month saved, rolled out on its own (worker 'fixes'); undefined: not simulated, OT to verify */
  benefit?: number; error?: string }
export interface BudgetPlan { usd: number; spent: number; effort_score: number;
  items: { label: string; cost_usd?: number; effort: number; product?: string; suggested: boolean; checked: boolean; benefit?: number }[] }
export interface BudgetAdapter {
  /** configured fixes with their rollout savings and whether they are suggested */
  items(): Promise<BudgetItem[]>;
  /** make the room match: apply the checked fixes, undo the unchecked ones */
  commit(checked: string[]): Promise<unknown>;
}

const value = (i: BudgetItem) => (i.benefit ?? 0) / Math.max(1, i.usd ?? 0);
/** Suggested first (always), then extras by value per dollar while the budget lasts. */
export function pickPlan(items: BudgetItem[], budgetUsd: number): string[] {
  const out = items.filter(i => i.suggested && !i.error).map(i => i.id);
  let left = budgetUsd - items.filter(i => out.includes(i.id)).reduce((t, i) => t + (i.usd ?? 0), 0);
  for (const i of items.filter(i => !i.suggested && !i.error && i.usd !== undefined && (i.benefit ?? 0) > 0).sort((a, b) => value(b) - value(a)))
    if (i.usd! <= left) { out.push(i.id); left -= i.usd!; }
  return out;
}
export function planOf(items: BudgetItem[], checked: string[], budgetUsd: number): BudgetPlan {
  const on = items.filter(i => checked.includes(i.id)), effort = on.reduce((t, i) => t + i.effort, 0);
  return { usd: budgetUsd, spent: on.reduce((t, i) => t + (i.usd ?? 0), 0), effort_score: effortScore(effort),
    items: items.map(i => ({ label: i.label, cost_usd: i.usd, effort: i.effort, product: i.product, suggested: i.suggested, checked: checked.includes(i.id), benefit: i.benefit })) };
}

let last: BudgetPlan | undefined;
/** the plan as last seen in the window, for the OT report (undefined: the window was never opened) */
export const currentBudget = () => last;

const STYLE = `
#budget-tile { position: fixed; left: 20px; bottom: 84px; z-index: 5; width: 48px; height: 32px; padding: 0; background: #c0c0c0; color: #000;
  font: bold 13px/1 monospace; border: 3px outset #eee; border-radius: 0; cursor: pointer; box-shadow: none; }
#budget-tile:active, #budget-tile[aria-expanded="true"] { border-style: inset; }
#budget-dialog { width: min(440px, calc(100vw - 32px)); max-height: 80vh; padding: 16px; border: 1px solid #888; border-radius: 12px; background: #1b1d22; color: #eee; font: 14px system-ui, sans-serif; }
#budget-dialog::backdrop { background: rgba(0, 0, 0, .35); }
#budget-dialog h2 { margin: 0 0 8px; font-size: 16px; }
#budget-dialog .bud-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
#budget-slider { width: 100%; margin: 8px 0 4px; accent-color: #6bb3ff; }
#budget-bar { height: 10px; border-radius: 5px; background: #333; overflow: hidden; }
#budget-bar > div { height: 100%; background: #4fb477; transition: width .2s; }
#budget-bar.over > div { background: #e0a030; }
#budget-list { list-style: none; margin: 12px 0; padding: 0; display: grid; gap: 6px; }
#budget-list label { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: start; padding: 8px; border-radius: 8px; background: #25282f; cursor: pointer; }
#budget-list small { display: block; color: #aaa; }
#budget-list .sug { font-size: 11px; padding: 1px 6px; border-radius: 6px; background: #2f4a6b; margin-left: 6px; }
#budget-dialog footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; align-items: center; }
`;
const money = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function mountBudget(api: BudgetAdapter, onCommit: () => void) {
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
  const tile = document.createElement('button'); tile.id = 'budget-tile'; tile.textContent = '$$$';
  tile.title = 'Budget: what to buy and do'; tile.setAttribute('aria-expanded', 'false'); tile.setAttribute('aria-controls', 'budget-dialog');
  const dlg = document.createElement('dialog'); dlg.id = 'budget-dialog'; dlg.setAttribute('aria-label', 'Budget');
  dlg.innerHTML = `<div class="bud-top"><h2>Budget</h2><strong id="budget-value"></strong></div>
    <input type="range" id="budget-slider" min="0" max="5000" step="25" value="500" aria-label="Budget in dollars">
    <div id="budget-bar"><div></div></div><small id="budget-left"></small>
    <ul id="budget-list"><li>rolling out each fix…</li></ul>
    <footer><span id="budget-total"></span><span><button id="budget-close">Close</button> <button id="budget-apply" class="primary">Apply plan</button></span></footer>`;
  (document.getElementById('frontend') ?? document.body).append(tile, dlg);
  const $ = (id: string) => dlg.querySelector<HTMLElement>('#' + id)!;
  const slider = $('budget-slider') as HTMLInputElement;
  let items: BudgetItem[] = [], checked: string[] = [];

  function render() {
    const usd = +slider.value, plan = (last = planOf(items, checked, usd)), over = plan.spent > usd, unpriced = items.filter(i => checked.includes(i.id) && i.usd === undefined).length;
    $('budget-value').textContent = money(usd);
    ($('budget-bar').firstElementChild as HTMLElement).style.width = `${usd ? Math.min(100, (100 * plan.spent) / usd) : plan.spent ? 100 : 0}%`;
    $('budget-bar').classList.toggle('over', over);
    $('budget-left').textContent = over ? `${money(plan.spent - usd)} over budget` : `${money(usd - plan.spent)} left`;
    $('budget-total').textContent = `${money(plan.spent)}${unpriced ? ` + ${unpriced} unpriced` : ''} · effort ${plan.effort_score}/100`;
    $('budget-list').innerHTML = items.length ? items.map(i => `<li><label><input type="checkbox" data-id="${esc(i.id)}" ${checked.includes(i.id) ? 'checked' : ''} ${i.error ? 'disabled' : ''}>
      <span>${esc(i.label)}${i.suggested ? '<span class="sug">suggested</span>' : ''}<small>${esc(i.product ?? '')}${i.error ? ' blocks the route' : i.benefit !== undefined ? ` −${i.benefit.toFixed(1)} toe contacts/month` : ' OT to verify'} · ${difficulty(i.effort)}</small></span>
      <strong>${i.usd === undefined ? 'price needed' : i.usd ? money(i.usd) : 'free'}</strong></label></li>`).join('') : '<li>No fixes configured for this scene.</li>';
    $('budget-list').querySelectorAll<HTMLInputElement>('input[data-id]').forEach(b => b.onchange = () => {
      checked = b.checked ? [...checked, b.dataset.id!] : checked.filter(x => x !== b.dataset.id); render(); });
  }
  slider.oninput = () => { checked = pickPlan(items, +slider.value); render(); };
  tile.onclick = async () => {
    if (dlg.open) return dlg.close();
    dlg.show(); tile.setAttribute('aria-expanded', 'true');
    items = await api.items(); checked = pickPlan(items, +slider.value); render();
  };
  dlg.addEventListener('close', () => tile.setAttribute('aria-expanded', 'false'));
  $('budget-close').onclick = () => dlg.close();
  $('budget-apply').onclick = async () => {
    const b = $('budget-apply') as HTMLButtonElement; b.disabled = true;
    try { await api.commit(checked); onCommit(); items = await api.items(); render(); } finally { b.disabled = false; }
  };
}

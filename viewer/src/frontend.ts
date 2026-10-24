import './frontend.css';
import { distinctOptions, escapeHTML as h, LIGHTING_IDEAS, summarizeChanges } from './frontend-model.ts';
import type { Change } from './reimagine.ts';
import type { Eval } from './evaluate.ts';
import type { Spot } from './spotlight.ts';
import type { OptionOut } from './optimize.ts';

export type NavigationMode = 'explore' | 'route' | 'inspect';
export interface FrontendSnapshot {
  room: string; patient: string; route: string; current: Eval | null; baseline: Eval | null;
  changes: Change[]; spots: Spot[]; options: OptionOut[]; selected: number; selectedName?: string;
  mode: 'auto' | 'free' | 'fly'; paused: boolean; speed: number; comparison: number; planKey: string;
}
export interface InspectItem { id: string; title: string; detail: string; at: [number, number]; object: number; change?: Change }
export interface FrontendAdapter {
  snapshot(): FrontendSnapshot;
  navigate(mode: NavigationMode): void; focus(item: InspectItem): void; leaveInspect(): void;
  pause(): void; restart(): void; speed(value: number): void;
  compare(t: number): void; animate(): void; suggest(): Promise<OptionOut[]>; apply(index: number): Promise<unknown>;
  undo(change: Change): Promise<unknown>; select(k: number): void;
  path(on: boolean): void; highlights(on: boolean): void; improvements(on: boolean): void;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (x: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(x);
const number = (x?: number) => x === undefined || !Number.isFinite(x) ? 'Pending' : x.toFixed(x > 0 && x < .05 ? 2 : 1);

export function mountFrontend(api: FrontendAdapter) {
  document.body.classList.add('frontend');
  const root = document.createElement('div'); root.id = 'frontend';
  root.innerHTML = `
    <button id="workspace-toggle" class="floating brand" aria-expanded="false" aria-controls="workspace-menu"><span class="brand-mark">C</span><span>Cleared<small id="room-name"></small></span><span class="chevron">⌄</span></button>
    <section id="workspace-menu" class="floating popover" aria-label="Room and patient settings" hidden>
      <div class="eyebrow">WORKSPACE</div><h2>Room & patient</h2><div id="context-controls"></div>
      <details><summary>Scan setup & advanced tools</summary><div id="advanced-controls"></div></details>
      <details><summary>Help & keyboard controls</summary><div id="help-controls"></div><p>In VR, click the left thumbstick to open the spatial menu. Point and trigger to choose.</p></details>
      <div id="share-controls" class="button-row"></div>
    </section>
    <div id="comparison" class="floating" aria-label="Layout comparison" hidden><div class="segmented"><button id="show-original" aria-pressed="false">Original</button><button id="show-proposed" aria-pressed="true">Proposed</button></div><button id="animate-changes">▷ Animate changes</button></div>
    <div id="active-filters" class="floating status-pill" role="status" hidden></div>
    <aside id="planning-panel" class="floating" aria-label="Room planning">
      <div class="panel-top"><span class="eyebrow">ROOM PLANNING</span><button id="panel-close" aria-label="Collapse planning panel">›</button></div>
      <div class="panel-tabs" role="tablist" aria-label="Planning view"><button id="tab-assessment" role="tab" aria-controls="pane-assessment" aria-selected="true" tabindex="0">Assessment</button><button id="tab-reimagine" role="tab" aria-controls="pane-reimagine" aria-selected="false" tabindex="-1">Reimagine</button><button id="tab-changes" role="tab" aria-controls="pane-changes" aria-selected="false" tabindex="-1">Changes <span id="change-count"></span></button></div>
      <section id="pane-assessment" class="pane" role="tabpanel" aria-labelledby="tab-assessment"><div class="eyebrow" id="route-scope"></div><h1>Understand the room</h1><p class="muted">Review the route before making changes.</p><div id="assessment-summary"></div><div id="assessment-findings"></div><details><summary>Simulation & additional checks</summary><div id="assessment-details"></div></details><button class="primary full" id="assessment-reimagine">Explore improvements <span>→</span></button></section>
      <section id="pane-reimagine" class="pane" role="tabpanel" aria-labelledby="tab-reimagine" hidden><div class="eyebrow">PLAN A CHANGE</div><h1>Reimagine room</h1><p class="muted">Compare proposals, then choose what to change.</p><button id="generate-proposals" class="primary full">✧ Reimagine room</button><p id="proposal-progress" class="muted" role="status" aria-live="polite"></p><div id="proposal-cards"></div><details><summary>Explore individual fixes</summary><div id="individual-fixes"></div></details><details><summary>Improve nighttime visibility <span class="badge">Concepts</span></summary><p class="muted">Ideas for review, not scene-specific recommendations. Placement, illumination, and installation estimates need verification.</p><div id="lighting-ideas"></div></details></section>
      <section id="pane-changes" class="pane" role="tabpanel" aria-labelledby="tab-changes" hidden><div class="eyebrow">YOUR CURRENT PLAN</div><h1>Changes & effort</h1><p class="muted">One list for moves, removals, and additions.</p><div id="change-summary"></div><div class="segmented"><button id="cost-summary" aria-pressed="true">Summary</button><button id="cost-breakdown" aria-pressed="false">Cost breakdown</button></div><div id="change-list"></div><div id="comparison-metrics"></div><div id="selected-controls"><h2>Selected object</h2><p id="selection-name" class="muted"></p><div id="object-actions" class="button-row"></div></div><details><summary>Restore removed objects</summary><div id="removed-controls"></div></details><div id="reset-controls" class="button-row"></div></section>
      <footer class="panel-footer">Geometry measured · outcomes simulated<br><span class="imagined">Imagined content is never used for measurements</span></footer>
    </aside>
    <button id="panel-open" class="floating" aria-expanded="false" aria-controls="planning-panel" hidden>Planning ‹</button>
    <section id="inspect-card" class="floating" aria-label="Inspection details" hidden><div class="button-row"><span class="eyebrow">INSPECT</span><select id="inspect-filter" aria-label="Inspect items"><option value="all">All items</option><option value="hazards">Hazards</option><option value="changes">Changes</option></select><button id="inspect-exit" aria-label="Exit inspection">×</button></div><div id="inspect-content"></div><div class="button-row"><button id="inspect-prev">← Previous</button><span id="inspect-position" class="muted"></span><button id="inspect-next">Next →</button></div></section>
    <div id="viewer-toolbar" class="floating"><nav class="segmented" aria-label="Navigation mode"><button id="mode-explore" aria-pressed="false"><span>◎</span> Explore</button><button id="mode-route" aria-pressed="true"><span>⠿</span> Follow route</button><button id="mode-inspect" aria-pressed="false"><span>⌖</span> Inspect</button></nav><div id="route-playback" class="button-row"><button id="route-pause">Pause</button><button id="route-restart" aria-label="Restart route">↺</button><select id="route-speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option></select></div></div>
    <button id="filter-toggle" class="floating" aria-expanded="false" aria-controls="filter-menu">☷ View filters <span id="filter-count"></span></button>
    <section id="filter-menu" class="floating popover" aria-label="View filters" hidden><div class="button-row"><h2>View filters</h2><button id="filter-reset">Reset view</button></div><div id="filter-experience"><h3>Experience</h3></div><div id="filter-navigation"><h3>Navigation</h3><label><input id="particle-path" type="checkbox" checked> Particle path</label></div><div id="filter-findings"><h3>Findings</h3></div><div id="filter-changes"><h3>Changes</h3><label><input id="improvement-highlights" type="checkbox" checked> Evaluated improvements</label></div><details><summary>Advanced display</summary><div id="filter-advanced"></div></details></section>
    <div id="view-caption" class="floating status-pill">Original scan · simulation estimates</div>
    <div id="frontend-message" class="floating" role="status" aria-live="polite" hidden></div>`;
  document.body.append(root);

  // Reparent the existing controls so event handlers, IDs, and teammate integrations continue to work.
  function move(id: string, target: string, label?: string) {
    const el = $(id); if (!el) return;
    let node: HTMLElement = el.closest('label') ?? el;
    if (label && node.tagName === 'LABEL') { for (const n of [...node.childNodes]) if (n.nodeType === Node.TEXT_NODE) n.textContent = ` ${label} `; }
    $(target).append(node);
  }
  function heading(text: string, target: string, ids: string[]) {
    const title = document.createElement('h2'); title.textContent = text; $(target).append(title);
    ids.forEach(id => move(id, target));
  }
  move('persona', 'context-controls', 'Patient'); move('routesel', 'context-controls', 'Route'); move('personanote', 'context-controls');
  move('vision', 'filter-experience', 'Vision simulation'); move('night', 'filter-experience', 'Night view');
  $<HTMLSelectElement>('reimtags').options[0].textContent = 'Selected item';
  $<HTMLSelectElement>('reimtags').options[1].textContent = 'All changed items';
  $<HTMLSelectElement>('reimtags').options[2].textContent = 'Off';
  move('ghosts', 'filter-navigation', 'Simulated footsteps'); move('third', 'filter-navigation', 'Third-person view');
  move('spot', 'filter-findings', 'Hazard highlights'); move('heights', 'filter-findings', 'Measured bump heights');
  move('reimghosts', 'filter-changes', 'Original object positions'); move('reimtags', 'filter-changes', 'Cost labels');
  ['imagfill', 'fillsel', 'imagceil', 'heat', 'shell', 'verify', 'perf'].forEach(id => move(id, 'filter-advanced'));
  heading('Findings on this route', 'assessment-findings', ['hazards', 'checks']);
  heading('Estimated toe contacts / month · all routes', 'assessment-details', ['risk']);
  heading('A month of nights', 'assessment-details', ['timeline', 'nightscrub', 'nightinfo']);
  heading('Walker physics', 'assessment-details', ['physics', 'snags', 'physinfo', 'pushchart', 'replay', 'replaycap']);
  move('status', 'assessment-details'); move('verifyinfo', 'assessment-details');
  move('planfixes', 'individual-fixes'); $('planfixes').textContent = 'Evaluate individual fixes'; move('fixes', 'individual-fixes');
  ['remove', 'resetobj'].forEach(id => move(id, 'object-actions')); move('reset', 'reset-controls'); move('inventory', 'removed-controls');
  ['report', 'fixcard'].forEach(id => move(id, 'share-controls'));
  const help = document.querySelector('#left > p.hint'); if (help) $('help-controls').append(help);
  move('fly', 'help-controls'); move('autoplay', 'help-controls'); move('free', 'help-controls'); move('tour', 'help-controls');
  for (const title of [...document.querySelectorAll<HTMLElement>('#right > h2')]) {
    if (!/Stairs|Doorways|Cosmos/.test(title.textContent ?? '')) continue;
    const group = document.createElement('div'); group.append(title.cloneNode(true));
    for (let n = title.nextElementSibling; n && n.tagName !== 'H2' && n.id !== 'physpanel';) { const next = n.nextElementSibling; group.append(n); n = next; }
    $('advanced-controls').append(group);
  }
  move('physpanel', 'advanced-controls');
  $('left').hidden = true; $('right').hidden = true;
  // Hidden legacy overlays stay addressable, with a quiet default rather than duplicate receipts/arrows.
  for (const id of ['reimarrows', 'reimreceipt']) { const box = $<HTMLInputElement>(id); box.checked = false; box.dispatchEvent(new Event('change')); }

  let tab = 'assessment', nav: NavigationMode = 'route', inspectIndex = 0, inspectKind = 'all', costDetail = false, busy = false;
  let signature = '', inspectedId = ''; let generatedFor = '', generatedPlan = '', previewedPlan = ''; let chosenOption: number | null = null;
  const defaults = new Map<HTMLInputElement | HTMLSelectElement, string | boolean>();
  $('filter-menu').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(el => defaults.set(el, el instanceof HTMLInputElement ? el.checked : el.value));
  let messageTimer = 0;
  function notify(message: string) { window.clearTimeout(messageTimer); $('frontend-message').textContent = message; $('frontend-message').hidden = false; messageTimer = window.setTimeout(() => { $('frontend-message').hidden = true; }, 5500); }
  function setTab(next: string) {
    tab = next;
    for (const name of ['assessment', 'reimagine', 'changes']) { $(`pane-${name}`).hidden = name !== tab; $(`tab-${name}`).setAttribute('aria-selected', String(name === tab)); $(`tab-${name}`).tabIndex = name === tab ? 0 : -1; }
    setPanel(true);
  }
  function setPanel(open: boolean) { $('planning-panel').hidden = !open; $('panel-open').hidden = open; document.body.classList.toggle('panel-collapsed', !open); $('panel-open').setAttribute('aria-expanded', String(open)); }
  for (const name of ['assessment', 'reimagine', 'changes']) $(`tab-${name}`).onclick = () => setTab(name);
  root.querySelector('[role="tablist"]')!.addEventListener('keydown', event => {
    const e = event as KeyboardEvent, names = ['assessment', 'reimagine', 'changes']; let k = names.indexOf(tab);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); k = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (k + (e.key === 'ArrowRight' ? 1 : 2)) % 3; setTab(names[k]); $(`tab-${names[k]}`).focus();
  });
  $('panel-close').onclick = () => setPanel(false); $('panel-open').onclick = () => setPanel(true);
  $('assessment-reimagine').onclick = () => setTab('reimagine');
  for (const [button, menu] of [['workspace-toggle', 'workspace-menu'], ['filter-toggle', 'filter-menu']]) $(button).onclick = () => {
    const open = $(menu).hidden;
    for (const [b, m] of [['workspace-toggle', 'workspace-menu'], ['filter-toggle', 'filter-menu']]) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
    $(menu).hidden = !open; $(button).setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('pointerdown', e => { for (const [b, m] of [['workspace-toggle', 'workspace-menu'], ['filter-toggle', 'filter-menu']]) if (!$(m).hidden && !$(m).contains(e.target as Node) && !$(b).contains(e.target as Node)) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } });
  function dismiss() { for (const [b, m] of [['workspace-toggle', 'workspace-menu'], ['filter-toggle', 'filter-menu']]) if (!$(m).hidden) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); $(b).focus(); } $('frontend-message').hidden = true; }
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (!$('workspace-menu').hidden || !$('filter-menu').hidden)) { dismiss(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.defaultPrevented || (e.target as HTMLElement).closest('input,select,textarea,[contenteditable]')) e.stopPropagation();
  });
  root.addEventListener('keyup', e => { if ((e.target as HTMLElement).closest('input,select,textarea,[contenteditable]')) e.stopPropagation(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
  function setNavigation(next: NavigationMode) {
    if (nav === 'inspect' && next !== 'inspect') api.leaveInspect();
    nav = next; api.navigate(next);
    if (next === 'inspect') { inspectIndex = 0; inspectedId = ''; showInspection(true); }
    updateChrome();
  }
  for (const mode of ['explore', 'route', 'inspect'] as const) $(`mode-${mode}`).onclick = () => setNavigation(mode);
  $('inspect-exit').onclick = () => setNavigation('explore');
  $('route-pause').onclick = () => { api.pause(); updateChrome(); }; $('route-restart').onclick = () => api.restart();
  $<HTMLSelectElement>('route-speed').onchange = e => api.speed(Number((e.target as HTMLSelectElement).value));
  $('show-original').onclick = () => { api.compare(0); updateChrome(); }; $('show-proposed').onclick = () => { api.compare(1); updateChrome(); };
  $('animate-changes').onclick = () => api.animate();
  $<HTMLInputElement>('particle-path').onchange = e => api.path((e.target as HTMLInputElement).checked);
  $<HTMLInputElement>('improvement-highlights').onchange = e => api.improvements((e.target as HTMLInputElement).checked);
  $('spot').addEventListener('change', () => api.highlights($<HTMLInputElement>('spot').checked));
  $('filter-reset').onclick = () => { for (const [el, value] of defaults) { if (el instanceof HTMLInputElement) el.checked = value as boolean; else el.value = value as string; el.dispatchEvent(new Event('change', { bubbles: true })); } updateChrome(); };
  $('filter-menu').addEventListener('change', updateChrome);
  function inspectionItems(): InspectItem[] {
    const s = api.snapshot();
    return [...(inspectKind === 'changes' ? [] : s.spots.map(p => ({ id: p.id, title: p.label, detail: p.detail, at: p.xy, object: p.object }))),
      ...(inspectKind === 'hazards' ? [] : s.changes.map(c => ({ id: `change:${c.name}:${c.iv ?? c.kind}`, title: c.label, detail: 'Proposed change · compare with the original scan.', at: c.at, object: c.k, change: c })))];
  }
  function showInspection(focus = false) {
    if (nav !== 'inspect') return;
    const list = inspectionItems(); inspectIndex = Math.max(0, Math.min(inspectIndex, list.length - 1)); const item = list[inspectIndex];
    $('inspect-content').innerHTML = item ? `<h2>${h(item.title)}</h2><p class="muted">${h(item.detail)}</p>${item.change ? installationHTML(item.change, true) : '<span class="badge amber">Finding for review</span>'}` : '<h2>Nothing to inspect yet</h2><p class="muted">Choose another filter, or add a change to the plan.</p>';
    $('inspect-position').textContent = list.length ? `${inspectIndex + 1} / ${list.length}` : '0 items';
    $<HTMLButtonElement>('inspect-prev').disabled = inspectIndex <= 0; $<HTMLButtonElement>('inspect-next').disabled = inspectIndex >= list.length - 1;
    if (item && (focus || inspectedId !== item.id)) { inspectedId = item.id; api.focus(item); }
  }
  $<HTMLSelectElement>('inspect-filter').onchange = e => { inspectKind = (e.target as HTMLSelectElement).value; inspectIndex = 0; showInspection(true); };
  $('inspect-prev').onclick = () => { inspectIndex--; showInspection(true); }; $('inspect-next').onclick = () => { inspectIndex++; showInspection(true); };

  function installationHTML(c: Change, expanded: boolean) {
    const placeholder = c.cost.source === 'placeholder';
    return `<div class="change-estimate"><span>${placeholder ? 'Estimate pending' : `${money(c.cost.usd)} · ${c.cost.minutes} min · ${c.cost.helpers} helper${c.cost.helpers === 1 ? '' : 's'}`}</span>${placeholder ? '<span class="badge">Placeholder model</span>' : ''}</div>${expanded ? `<dl class="details-grid"><dt>Setup time</dt><dd>${placeholder ? 'Pending estimate' : `${c.cost.minutes} min · hands-on estimate`}</dd><dt>Helpers</dt><dd>${placeholder ? 'Pending estimate' : c.cost.helpers}</dd><dt>Tools / installation</dt><dd>Verify requirements</dd><dt>Room disruption</dt><dd>Pending assessment</dd><dt>Funding</dt><dd>${c.cost.funding === 'unclassified' ? 'Unclassified' : h(c.cost.funding.replaceAll('_', ' '))} · verify eligibility</dd></dl>${placeholder ? `<p class="muted">Model placeholder: ${money(c.cost.usd)}, ${c.cost.minutes} min, ${c.cost.helpers} helper(s). Excluded from known totals.</p>` : ''}` : ''}`;
  }
  function renderChanges(s: FrontendSnapshot) {
    const total = summarizeChanges(s.changes);
    $('change-count').textContent = total.count ? String(total.count) : '';
    $('change-summary').innerHTML = `<div class="metric-grid"><div><small>Known subtotal</small><strong>${total.count && !total.unpriced ? money(total.knownSubtotal) : total.knownSubtotal ? money(total.knownSubtotal) : 'Pending'}</strong></div><div><small>Setup time</small><strong>${total.count && !total.untimed ? `${total.setupMinutes} min` : 'Pending'}</strong></div><div><small>Helpers needed</small><strong>${total.helpers ?? 'Pending'}</strong></div><div><small>Unpriced items</small><strong>${total.unpriced} / ${total.count}</strong></div></div><p class="muted">${total.count ? `${total.count - total.unpriced} of ${total.count} changes have non-placeholder cost estimates. Setup time is summed hands-on work, not a delivery or completion schedule.` : 'Add a change to see cost and installation estimates.'}</p>`;
    $('change-list').innerHTML = total.count ? s.changes.map((c, i) => `<article class="change-card"><div class="eyebrow">${h(c.kind === 'fix' ? 'Addition / fix' : c.kind)}</div><h3>${h(c.label)}</h3>${installationHTML(c, costDetail)}<div class="button-row"><button data-inspect-change="${i}">Inspect</button><button data-undo-change="${i}">Undo</button></div></article>`).join('') : '<div class="empty-state"><span>✧</span><h3>Your plan starts here</h3><p>Move an object or preview a proposal. Every change will appear in this list.</p></div>';
    $('change-list').querySelectorAll<HTMLButtonElement>('[data-undo-change]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api.undo(s.changes[Number(b.dataset.undoChange)]); refresh(); } catch { notify('Could not undo this change. Try again.'); b.disabled = false; } });
    $('change-list').querySelectorAll<HTMLButtonElement>('[data-inspect-change]').forEach(b => b.onclick = () => { inspectKind = 'changes'; $<HTMLSelectElement>('inspect-filter').value = 'changes'; setNavigation('inspect'); inspectIndex = Number(b.dataset.inspectChange); showInspection(true); });
    $('selected-controls').hidden = s.selected < 0;
    $('selection-name').textContent = s.selected >= 0 ? `${s.selectedName ?? 'Selected object'} · Move with the gizmo, or use the actions below.` : '';
  }
  $('cost-summary').onclick = () => { costDetail = false; refresh(); }; $('cost-breakdown').onclick = () => { costDetail = true; refresh(); };
  function renderAssessment(s: FrontendSnapshot) {
    const e = s.current, route = e?.routes[e.sel], concerns = (e?.hazards.length ?? 0) + (e?.checks.filter(c => c.verdict !== 'ok').length ?? 0);
    $('assessment-summary').innerHTML = `<div class="finding-banner"><span class="badge amber">For review</span><h2>${e ? e.error ? 'Route unavailable' : `${concerns} finding${concerns === 1 ? '' : 's'} to review` : 'Evaluating the route…'}</h2><p class="muted">Geometry and simulation support occupational therapist review.</p></div><div class="metric-grid"><div><small>Min. clearance / side</small><strong>${route?.min_side_m === undefined ? 'Pending' : `${(route.min_side_m * 100).toFixed(0)} cm`}</strong></div><div><small>Selected route</small><strong>${e?.error ? 'Blocked' : route ? 'Available' : 'Pending'}</strong></div></div>`;
    const b = s.baseline;
    $('comparison-metrics').innerHTML = s.changes.length ? `<h2>Evaluated comparison</h2><p class="muted">All routes · selected patient. Results describe the proposed endpoint, including while the visual preview shows Original.</p><table><thead><tr><th>Metric</th><th>Original</th><th>Proposed</th></tr></thead><tbody><tr><td>Toe contacts / month</td><td>${number(b?.per_month)}</td><td>${number(e?.per_month)}</td></tr><tr><td>Likely range</td><td>${number(b?.per_month_lo)}–${number(b?.per_month_hi)}</td><td>${number(e?.per_month_lo)}–${number(e?.per_month_hi)}</td></tr><tr><td>Clearance / side<small>Selected route</small></td><td>${b?.routes[b.sel]?.min_side_m === undefined ? 'Pending' : `${(b.routes[b.sel].min_side_m! * 100).toFixed(0)} cm`}</td><td>${route?.min_side_m === undefined ? 'Pending' : `${(route.min_side_m * 100).toFixed(0)} cm`}</td></tr></tbody></table>` : '';
  }
  function renderProposals(s: FrontendSnapshot) {
    const options = distinctOptions(s.options);
    const currentContext = `${s.patient}:${s.route}`;
    if (generatedFor && (generatedFor !== currentContext || (generatedPlan && s.planKey !== generatedPlan && s.planKey !== previewedPlan))) { $('proposal-cards').innerHTML = '<p class="muted">Patient, route, or working layout changed. Generate proposals again for this context.</p>'; return; }
    const card = ({ option: o, index }: typeof options[number], recommended: boolean) => `<article class="proposal-card ${recommended ? 'recommended' : ''}"><span class="badge">${recommended ? 'Recommended by model' : 'Alternative'}</span><h2>${h(o.name)}</h2><p>${o.actions.length} change${o.actions.length === 1 ? '' : 's'} · ${o.checks_failed} checks flagged</p><ol>${o.actions.map(a => `<li>${h(a.label)}</li>`).join('')}</ol><div class="proposal-metrics"><span>${number(o.per_month)}/month<small>Simulated contacts · all routes</small></span><span>${number(o.per_month_lo)}–${number(o.per_month_hi)}<small>Likely range</small></span></div><p class="muted">Cost & installation estimates are reviewed in Changes after applying.</p><button class="${recommended ? 'primary' : ''} full" data-preview="${index}">Preview proposal</button><button class="full" data-use="${index}" ${chosenOption === index ? '' : 'disabled'}>Use this layout</button></article>`;
    $('proposal-cards').innerHTML = options.length ? card(options[0], true) + (options.length > 1 ? `<details><summary>Other options · ${options.length - 1}</summary>${options.slice(1).map(o => card(o, false)).join('')}</details>` : '<p class="muted">One distinct outcome found.</p>') : '<div class="empty-state"><span>✧</span><h3>Make room for a better route</h3><p>Explore rearrangements and configured fixes. Each proposal is evaluated by the existing model.</p></div>';
    $('proposal-cards').querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(b => b.onclick = async () => { if (busy) return; busy = true; b.disabled = true; try { await api.apply(Number(b.dataset.preview)); chosenOption = Number(b.dataset.preview); previewedPlan = api.snapshot().planKey; api.navigate('explore'); nav = 'explore'; notify('Proposal loaded in the viewer. This is a simulation; the room has not physically changed.'); refresh(); } catch { notify('Proposal could not be loaded. Try generating again.'); } finally { busy = false; b.disabled = false; } });
    $('proposal-cards').querySelectorAll<HTMLButtonElement>('[data-use]').forEach(b => b.onclick = () => { setTab('changes'); notify('This proposal is your current working plan. Review individual changes and estimates here.'); });
  }
  $('generate-proposals').onclick = async () => {
    if (busy) return; busy = true; const b = $<HTMLButtonElement>('generate-proposals'); b.disabled = true; b.textContent = 'Searching layouts…'; chosenOption = null;
    const request = api.snapshot(); generatedFor = `${request.patient}:${request.route}`; generatedPlan = request.planKey; previewedPlan = '';
    try { await api.suggest(); refresh(); } catch { notify('Layout search failed. You can still move objects or explore individual fixes.'); }
    finally { busy = false; b.disabled = false; b.textContent = '✧ Generate proposals again'; }
  };
  $('lighting-ideas').innerHTML = LIGHTING_IDEAS.map(idea => `<article class="change-card"><span class="badge">Concept · verify on site</span><h3>${h(idea.title)}</h3><p>${h(idea.why)}</p><p class="muted">${h(idea.placement)}</p><dl class="details-grid"><dt>Power</dt><dd>${h(idea.powerSource ?? 'Pending')}</dd><dt>Cost / setup</dt><dd>Pending estimate</dd><dt>Installation</dt><dd>${idea.professionalRequired ? 'Professional assessment suggested' : 'Verify requirements'}</dd>${idea.maintenance ? `<dt>Maintenance</dt><dd>${h(idea.maintenance)}</dd>` : ''}</dl></article>`).join('') + '<p class="muted">Rendered brightness does not establish real illumination. No lux or vision-improvement claims are inferred from this preview.</p>';

  function updateChrome() {
    const s = api.snapshot();
    if (nav !== 'inspect') nav = s.mode === 'auto' ? 'route' : 'explore';
    for (const mode of ['explore', 'route', 'inspect']) $(`mode-${mode}`).setAttribute('aria-pressed', String(mode === nav));
    $('route-playback').hidden = nav !== 'route'; $('inspect-card').hidden = nav !== 'inspect';
    $('route-pause').textContent = s.paused ? 'Play' : 'Pause';
    $('comparison').hidden = !s.changes.length;
    $('show-original').setAttribute('aria-pressed', String(s.comparison === 0)); $('show-proposed').setAttribute('aria-pressed', String(s.comparison > 0));
    const night = $<HTMLInputElement>('night').checked, vision = $<HTMLSelectElement>('vision');
    const active = [night ? 'Night view' : '', vision.selectedIndex > 0 ? vision.selectedOptions[0]?.textContent : ''].filter(Boolean);
    $('active-filters').hidden = !active.length; $('active-filters').textContent = active.join(' · ');
    const changed = [...defaults].filter(([el, value]) => (el instanceof HTMLInputElement ? el.checked : el.value) !== value).length;
    $('filter-count').textContent = changed ? String(changed) : '';
    $('room-name').textContent = s.room.replaceAll('_', ' '); $('route-scope').textContent = s.route;
    $('view-caption').textContent = s.changes.length ? `${s.comparison === 0 ? 'Original visual preview' : 'Proposed layout · imagined, not measured'} · metrics describe proposed endpoint` : 'Original scan · simulation estimates';
    $('cost-summary').setAttribute('aria-pressed', String(!costDetail)); $('cost-breakdown').setAttribute('aria-pressed', String(costDetail));
    $('proposal-progress').textContent = $('optstatus').textContent;
  }
  function refresh() { const s = api.snapshot(); renderAssessment(s); renderChanges(s); renderProposals(s); showInspection(); updateChrome(); }
  // Small scalar signature keeps the viewer frame loop free of DOM work; changes are polled only four times/sec.
  let lastSelected = -1;
  const timer = window.setInterval(() => {
    const s = api.snapshot(); const next = JSON.stringify([s.current?.ms, s.current?.per_month, s.patient, s.route, s.changes.map(c => [c.name, c.kind, c.at, c.turn_deg]), s.options.map(o => o.layout), s.selected]);
    if (s.selected >= 0 && s.selected !== lastSelected) setTab('changes'); lastSelected = s.selected;
    if (next !== signature) { signature = next; refresh(); } else updateChrome();
  }, 250);
  refresh();
  return { refresh, setTab, setNavigation, inspection: () => nav === 'inspect' ? inspectionItems()[inspectIndex] ?? null : null, inspectNext: () => { inspectIndex = Math.min(inspectIndex + 1, inspectionItems().length - 1); showInspection(true); }, inspectPrevious: () => { inspectIndex = Math.max(0, inspectIndex - 1); showInspection(true); }, dispose: () => window.clearInterval(timer) };
}

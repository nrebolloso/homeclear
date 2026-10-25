import { onDocument, every, later } from './lifetime.ts';
import './frontend.css';
import { createAnnouncer, mountDisplaySettings, nameUnlabeled, watchDialog } from './a11y.ts';
import { navOf } from './navmode.ts';
import { distinctOptions, escapeHTML as h, LIGHTING_IDEAS, summarizeChanges } from './frontend-model.ts';
import type { Change } from './reimagine.ts';
import type { Eval } from './evaluate.ts';
import type { Spot } from './spotlight.ts';
import type { OptionOut } from './optimize.ts';
import { controlHints, statusPills, type HintCtx } from './hints.ts';
import { clampPanel, snapPanel, stepPanel, panelSnaps } from './panel-size.ts';

export type NavigationMode = 'explore' | 'route' | 'walk' | 'fly' | 'inspect';
export interface FrontendSnapshot {
  room: string; patient: string; route: string; current: Eval | null; baseline: Eval | null;
  changes: Change[]; spots: Spot[]; options: OptionOut[]; selected: number; selectedName?: string;
  mode: 'auto' | 'free' | 'fly'; explore: boolean; paused: boolean; speed: number; comparison: number; planKey: string;
}
export interface InspectItem { id: string; title: string; detail: string; at: [number, number]; object: number; change?: Change }
export interface FrontendAdapter {
  snapshot(): FrontendSnapshot;
  navigate(mode: NavigationMode): void; focus(item: InspectItem): void; leaveInspect(): void;
  pause(): void; restart(): void; speed(value: number): void;
  compare(t: number): void; animate(): void; suggest(): Promise<OptionOut[]>; apply(index: number): Promise<unknown>;
  undo(change: Change): Promise<unknown>; select(k: number): void;
  /** the previewed proposal is accepted ("Use this layout"): its additions stop being an x-ray and become part of the scan */
  commit?(): void;
  path(on: boolean): void; highlights(on: boolean): void; improvements(on: boolean): void;
  /** "Light the path": nightlights where the route is dark (lights.ts); resolves to how many were added and the note to show */
  lightPath?(): Promise<{ added: number; note: string }>;
  /** what the viewer is doing now, for the controls strip and the status pills (hints.ts); `inspect` is the frontend's own */
  hintContext?(): Omit<HintCtx, 'inspect'> & { thirdPerson: boolean; personaLabel: string };
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const money = (x: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(x);
const number = (x?: number) => x === undefined || !Number.isFinite(x) ? 'Pending' : x.toFixed(x > 0 && x < .05 ? 2 : 1);

export function mountFrontend(api: FrontendAdapter) {
  document.body.classList.add('frontend');
  const root = document.createElement('div'); root.id = 'frontend';
  root.innerHTML = `
    <a class="skip-link" id="skip-panel" href="#planning-panel">Skip to planning panel</a><a class="skip-link" id="skip-toolbar" href="#viewer-toolbar">Skip to viewer controls</a>
    <div id="brand-bar" class="floating"><button id="workspace-toggle" class="brand" aria-expanded="false" aria-controls="workspace-menu"><span class="brand-mark" aria-hidden="true">C</span><span>Cleared<small id="room-name"></small></span><span class="chevron" aria-hidden="true">⌄</span></button><span id="scan-slot"></span></div>
    <div id="status-pills" role="group" aria-label="Current view"><span id="pills"></span><div id="active-filters" class="status-pill" role="status" hidden></div></div>
    <section id="workspace-menu" class="floating popover" aria-label="Room and patient settings" hidden>
      <div class="eyebrow">WORKSPACE</div><h2>Room & patient</h2><div id="context-controls"></div>
      <details id="a11y-settings"><summary>Accessibility & display</summary>
        <div role="group" aria-labelledby="a11y-text-label"><span id="a11y-text-label">Text size</span><div class="segmented"><button data-text="default" aria-pressed="true">Default</button><button data-text="large" aria-pressed="false">Large</button><button data-text="larger" aria-pressed="false">Largest</button></div></div>
        <label>Color theme <select id="a11y-theme"><option value="system">Match device (dark)</option><option value="dark">Dark</option><option value="light">Light</option><option value="contrast">High contrast</option></select></label>
        <label class="a11y-check"><input type="checkbox" id="a11y-motion"> Reduce motion <small id="a11y-motion-note"></small></label>
        <button id="a11y-reset">Reset display settings</button>
      </details>
      <details><summary>Scan setup & advanced tools</summary><div id="advanced-controls"></div></details>
      <details><summary>Help & keyboard controls</summary><div id="help-controls"></div><p>In VR, hold the left thumbstick click to open the spatial menu (click again to close). Click the wand thumbstick to undo the last object edit; hold the off-hand grip as well to redo. Point and trigger to choose.</p></details>
      <div id="share-controls" class="button-row"></div>
    </section>
    <div id="comparison" class="floating" role="group" aria-label="Layout comparison" hidden><div class="segmented"><button id="show-original" aria-pressed="false">Original</button><button id="show-proposed" aria-pressed="true">Proposed</button></div><button id="animate-changes"><span aria-hidden="true">▷</span> Animate changes</button></div>
    <aside id="planning-panel" class="floating" aria-label="Room planning" tabindex="-1">
      <div id="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize planning panel. Arrow left widens, arrow right narrows, Home resets" tabindex="0"></div>
      <div class="panel-top"><span class="eyebrow">ROOM PLANNING</span><button id="panel-pin" aria-pressed="false" title="Keep the panel wide while you move around" hidden>Pin wide</button><button id="panel-close" aria-label="Collapse planning panel"><span aria-hidden="true">›</span></button></div>
      <div class="panel-tabs" role="tablist" aria-label="Planning view"><button id="tab-assessment" role="tab" aria-controls="pane-assessment" aria-selected="true" tabindex="0">Assessment</button><button id="tab-reimagine" role="tab" aria-controls="pane-reimagine" aria-selected="false" tabindex="-1">Reimagine</button><button id="tab-changes" role="tab" aria-controls="pane-changes" aria-selected="false" tabindex="-1">Changes <span id="change-count"></span></button><button id="tab-view" role="tab" aria-controls="pane-view" aria-selected="false" tabindex="-1">View <span id="filter-count"></span></button></div>
      <section id="pane-assessment" class="pane" role="tabpanel" aria-labelledby="tab-assessment"><div class="eyebrow" id="route-scope"></div><h1>Understand the room</h1><p class="muted">Review the route before making changes.</p><div id="assessment-summary"></div><div id="assessment-findings"></div><details><summary>Simulation & additional checks</summary><div id="assessment-details"></div></details><button class="primary full" id="assessment-reimagine">Explore improvements <span aria-hidden="true">→</span></button></section>
      <section id="pane-reimagine" class="pane" role="tabpanel" aria-labelledby="tab-reimagine" hidden><div class="eyebrow">PLAN A CHANGE</div><h1>Reimagine room</h1><p class="muted">Compare proposals, then choose what to change.</p><button id="generate-proposals" class="primary full"><span aria-hidden="true">✧</span> Reimagine room</button><p id="proposal-progress" class="muted" role="status" aria-live="polite"></p><div id="proposal-cards"></div><details><summary>Explore individual fixes</summary><div id="individual-fixes"></div></details><button id="light-path" class="full"><span aria-hidden="true">☾</span> Light the path at night</button><p id="light-path-note" class="muted" role="status" aria-live="polite"></p><details><summary>Improve nighttime visibility <span class="badge">Concepts</span></summary><p class="muted">Ideas for review, not scene-specific recommendations. Placement, illumination, and installation estimates need verification.</p><div id="lighting-ideas"></div></details></section>
      <section id="pane-changes" class="pane" role="tabpanel" aria-labelledby="tab-changes" hidden><div class="eyebrow">YOUR CURRENT PLAN</div><h1>Changes & effort</h1><p class="muted">One list for moves, removals, and additions.</p><div id="mark-controls"><h2>Marks</h2><p class="muted">Tell the planner where stairs and doorways are. Keys: <kbd>M</kbd> then <kbd>1</kbd> stairs or <kbd>2</kbd> doorway.</p><div id="mark-buttons" class="button-row"></div><div id="mark-status"></div><details><summary>How marking works</summary><div id="mark-help"></div></details></div><div id="change-summary"></div><div class="segmented"><button id="cost-summary" aria-pressed="true">Summary</button><button id="cost-breakdown" aria-pressed="false">Cost breakdown</button></div><div id="change-list"></div><div id="comparison-metrics"></div><div id="selected-controls"><h2>Selected object</h2><p id="selection-name" class="muted"></p><div id="object-actions" class="button-row"></div></div><details><summary>Restore removed objects</summary><div id="removed-controls"></div></details><div id="reset-controls" class="button-row"></div></section>
      <section id="pane-view" class="pane" role="tabpanel" aria-labelledby="tab-view" hidden><div class="eyebrow">WHAT YOU SEE</div><h1>View</h1><h2>Who is moving</h2><div id="persona-cards" role="radiogroup" aria-label="Who is moving through the room"></div><div id="persona-note"></div><h2>Camera</h2><div id="view-camera"><p class="muted">In Walk the mouse turns your head and the walker keeps its heading (<kbd>W</kbd>/<kbd>S</kbd> push, <kbd>A</kbd>/<kbd>D</kbd> turn it); an amber arrow shows when they differ and <kbd>C</kbd> turns the walker to face your view. Look around parks the walker; Fly leaves it too. Keys <kbd>1</kbd>–<kbd>4</kbd> switch modes.</p></div><div id="filter-menu" role="group" aria-label="View filters"><div class="button-row"><h2>Filters</h2><button id="filter-reset">Reset view</button></div><div id="filter-experience"><h3>Experience</h3></div><div id="filter-navigation"><h3>Navigation</h3><label><input id="particle-path" type="checkbox" checked> Particle path</label></div><div id="filter-findings"><h3>Findings</h3></div><div id="filter-changes"><h3>Changes</h3><label><input id="improvement-highlights" type="checkbox" checked> Evaluated improvements</label></div><details><summary>Advanced display</summary><div id="filter-advanced"></div></details></div></section>
      <footer class="panel-footer">Geometry measured · outcomes simulated<br><span class="imagined">Imagined content is never used for measurements</span></footer>
    </aside>
    <button id="panel-open" class="floating" aria-expanded="false" aria-controls="planning-panel" hidden>Planning <span aria-hidden="true">‹</span></button>
    <section id="inspect-card" class="floating" aria-label="Inspection details" tabindex="-1" hidden><div class="button-row"><span class="eyebrow">INSPECT</span><select id="inspect-filter" aria-label="Inspect items"><option value="all">All items</option><option value="hazards">Hazards</option><option value="changes">Changes</option></select><button id="inspect-exit" aria-label="Exit inspection"><span aria-hidden="true">×</span></button></div><div id="inspect-content"></div><div class="button-row"><button id="inspect-prev"><span aria-hidden="true">←</span> Previous</button><span id="inspect-position" class="muted"></span><button id="inspect-next">Next <span aria-hidden="true">→</span></button></div></section>
    <div id="viewer-toolbar" class="floating" role="group" aria-label="Viewer controls" tabindex="-1"><nav class="segmented" aria-label="Navigation mode"><button id="mode-route" aria-pressed="true" title="Follow route (1): the walker walks the planned route"><span aria-hidden="true">⠿</span> Follow route</button><button id="mode-walk" aria-pressed="false" title="Walk (2): push with W/S, turn the walker with A/D, the mouse turns your head only. Fenced by walls and furniture"><span aria-hidden="true">↟</span> Walk</button><button id="mode-explore" aria-pressed="false" title="Look around (3): the walker stays parked and nothing collides with you"><span aria-hidden="true">◎</span> Look around</button><button id="mode-fly" aria-pressed="false" title="Fly (4): a free camera that passes through everything; the walker stays put"><span aria-hidden="true">☁</span> Fly</button><button id="mode-inspect" aria-pressed="false" title="Inspect: step through findings and changes"><span aria-hidden="true">⌖</span> Inspect</button></nav><div id="route-playback" class="button-row"><button id="route-pause">Pause</button><button id="route-restart" aria-label="Restart route"><span aria-hidden="true">↺</span></button><select id="route-speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option></select></div></div>
    <div id="controls-strip" class="floating" role="status" aria-label="Controls for the current mode"><span id="strip-mode"></span><span id="strip-chips"></span><button id="strip-keys" type="button" aria-label="Show keyboard shortcuts (F1)">F1 · keys</button></div>
    <div id="view-caption" class="floating status-pill">Original scan · simulation estimates</div>
    <div id="frontend-message" class="floating" role="status" aria-live="polite" hidden></div>`;
  document.body.prepend(root);
  const picker = document.getElementById('scan-picker'); if (picker) $('scan-slot').append(picker);   // the scan library's button lives inside the brand pill (app.ts puts it back before a scene swap)   // first in tab order, so the skip links are the first stop

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
  move('routesel', 'context-controls', 'Route'); move('persona', 'persona-cards'); move('personanote', 'persona-note');   // the select stays as the cards' backing control
  move('markstairs', 'mark-buttons'); move('markdoor', 'mark-buttons'); move('editstairs', 'mark-buttons'); move('editdoors', 'mark-buttons');
  $('editstairs').textContent = 'Edit stair marks'; $('editdoors').textContent = 'Edit doorway marks'; move('stairstatus', 'mark-status'); move('doorstatus', 'mark-status');
  for (const hint of [...document.querySelectorAll<HTMLElement>('#right p.hint')]) if (/^(Click to mark|VR: )/.test(hint.textContent ?? '')) $('mark-help').append(hint);
  move('vision', 'filter-experience', 'Vision simulation'); move('night', 'filter-experience', 'Night view');
  $<HTMLSelectElement>('reimtags').options[0].textContent = 'Selected item';
  $<HTMLSelectElement>('reimtags').options[1].textContent = 'All changed items';
  $<HTMLSelectElement>('reimtags').options[2].textContent = 'Off';
  move('ghosts', 'filter-navigation', 'Simulated footsteps'); move('handghosts', 'filter-navigation', 'Hand-rule footsteps (baseline)'); move('third', 'view-camera', 'Third-person view');
  move('spot', 'filter-findings', 'Hazard highlights'); move('heights', 'filter-findings', 'Measured bump heights');
  move('reimghosts', 'filter-changes', 'Original object positions'); move('reimtags', 'filter-changes', 'Cost labels');
  ['imagfill', 'fillsel', 'imagceil', 'heat', 'shell', 'verify', 'perf'].forEach(id => move(id, 'filter-advanced'));
  heading('Findings on this route', 'assessment-findings', ['hazards', 'checks']);
  heading('Estimated toe catches / month · all routes', 'assessment-details', ['risk']);
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
  // ---------- reach map (main.ts, reach.ts): the toggles with the filters, the rest under the findings ----------
  move('reach', 'filter-findings', 'Reach map (where the device can go)'); move('coverage', 'filter-navigation', 'Coverage ghosts (widest way to each spot)');
  move('hitghosts', 'filter-navigation', 'Only simulated trips with a contact');
  heading('Where the device can go', 'assessment-findings', ['reachwidth', 'reachplay', 'markpoint', 'clearpoints', 'copypoints', 'reachstatus', 'reachfindings', 'reachtargets', 'reachcost', 'reachcostinfo']);
  $('reachcost').setAttribute('role', 'img');
  $('left').hidden = true; $('right').hidden = true;
  // Hidden legacy overlays stay addressable, with a quiet default rather than duplicate receipts/arrows.
  for (const id of ['reimarrows', 'reimreceipt']) { const box = $<HTMLInputElement>(id); box.checked = false; box.dispatchEvent(new Event('change')); }

  // ---------- accessibility (a11y.ts) ----------
  const announce = createAnnouncer(root);
  const display = mountDisplaySettings(root, () => { calmMotion(); updateChrome(); });
  const sceneView = document.getElementById('view'); sceneView?.setAttribute('role', 'main'); sceneView?.setAttribute('aria-label', '3D room view');
  watchDialog(document.getElementById('player'), 'Cosmos video preview (imagined, not measured)', '#closeplayer');
  watchDialog(document.getElementById('qr'), 'Family fix card QR code', '#closeqr');
  $('nightscrub').setAttribute('aria-label', 'Night of the month'); $('nightscrub').setAttribute('aria-describedby', 'nightinfo');
  $('timeline').setAttribute('role', 'img'); $('timeline').setAttribute('aria-label', 'Toe contacts across a month of nights'); $('timeline').setAttribute('aria-describedby', 'nightinfo');
  nameUnlabeled(root);

  const TABS = ['assessment', 'reimagine', 'changes', 'view'];
  let tab = 'assessment', nav: NavigationMode = 'route', inspectIndex = 0, inspectKind = 'all', costDetail = false, busy = false;
  let signature = '', inspectedId = ''; let generatedFor = '', generatedPlan = '', previewedPlan = ''; let chosenOption: number | null = null;
  const defaults = new Map<HTMLInputElement | HTMLSelectElement, string | boolean>();
  $('filter-menu').querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(el => defaults.set(el, el instanceof HTMLInputElement ? el.checked : el.value));
  let messageTimer = 0;
  function notify(message: string) { window.clearTimeout(messageTimer); $('frontend-message').textContent = message; $('frontend-message').hidden = false; messageTimer = later(() => { $('frontend-message').hidden = true; }, Math.max(5500, 4000 + message.length * 80)); }   // longer messages stay long enough to read
  function setTab(next: string) {
    tab = next;
    for (const name of TABS) { $(`pane-${name}`).hidden = name !== tab; $(`tab-${name}`).setAttribute('aria-selected', String(name === tab)); $(`tab-${name}`).tabIndex = name === tab ? 0 : -1; }
    setPanel(true);
  }
  function setPanel(open: boolean) { $('planning-panel').hidden = !open; $('panel-open').hidden = open; document.body.classList.toggle('panel-collapsed', !open); $('panel-open').setAttribute('aria-expanded', String(open)); }
  for (const name of TABS) $(`tab-${name}`).onclick = () => setTab(name);
  root.querySelector('[role="tablist"]')!.addEventListener('keydown', event => {
    const e = event as KeyboardEvent, names = TABS; let k = names.indexOf(tab);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); k = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1 : (k + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length; setTab(names[k]); $(`tab-${names[k]}`).focus();
  });
  $('panel-close').onclick = () => { setPanel(false); $('panel-open').focus(); }; $('panel-open').onclick = () => { setPanel(true); $(`tab-${tab}`).focus(); };
  for (const [link, target] of [['skip-panel', 'planning-panel'], ['skip-toolbar', 'viewer-toolbar']]) $(link).onclick = e => { e.preventDefault(); if (target === 'planning-panel') setPanel(true); $(target).focus(); };
  $('assessment-reimagine').onclick = () => setTab('reimagine');

  // ---------- drag-to-widen planning panel (panel-size.ts): overlaps the scene, snaps, and goes back when you move or look ----------
  const panelEl = $('planning-panel'), handle = $('panel-resize'); let pinned = false;
  function baseWidth() { const w = panelEl.style.width; panelEl.style.width = ''; const b = panelEl.getBoundingClientRect().width; if (w) panelEl.style.width = w; return b; }
  function setWidth(px: number | null) {
    if (px === null) panelEl.style.removeProperty('width'); else panelEl.style.width = `${Math.round(px)}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(px ?? baseWidth())));
    $('panel-pin').hidden = px === null; if (px === null) { pinned = false; $('panel-pin').setAttribute('aria-pressed', 'false'); }
  }
  const resetPanel = () => { if (!pinned && panelEl.style.width) setWidth(null); };
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId); panelEl.classList.add('resizing');
    const b = baseWidth(), move = (ev: PointerEvent) => setWidth(clampPanel(innerWidth - 16 - ev.clientX, b, innerWidth));
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); panelEl.classList.remove('resizing'); const w = snapPanel(panelEl.getBoundingClientRect().width, b, innerWidth); setWidth(w === b ? null : w); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', e => {
    const b = baseWidth(), cur = panelEl.getBoundingClientRect().width; let w: number | null = null;
    if (e.key === 'ArrowLeft') w = stepPanel(cur, b, innerWidth, 1); else if (e.key === 'ArrowRight') w = stepPanel(cur, b, innerWidth, -1);
    else if (e.key === 'Home') w = b; else if (e.key === 'End') w = panelSnaps(b, innerWidth).at(-1)!; else return;
    e.preventDefault(); setWidth(w === b ? null : w);
  });
  handle.addEventListener('dblclick', () => { pinned = false; setWidth(null); });
  $('panel-pin').onclick = () => { pinned = !pinned; $('panel-pin').setAttribute('aria-pressed', String(pinned)); announce(pinned ? 'Panel pinned wide.' : 'Panel will narrow when you move.'); };
  // moving, looking, scrolling the scene or pressing Esc puts it back (pinned: stays)
  onDocument('keydown', e => { if ((/^(Key[WASDQE]|Arrow(Up|Down|Left|Right))$/.test(e.code) && !panelEl.contains(e.target as Node) && !(e.target as HTMLElement).closest('input,select,textarea')) || e.code === 'Escape') resetPanel(); });
  onDocument('pointerdown', e => { if (!(e.target as HTMLElement).closest('#frontend, #keyhelp')) resetPanel(); }, true);
  onDocument('wheel', e => { if (!(e.target as HTMLElement).closest('#frontend')) resetPanel(); }, { passive: true });
  onDocument('pointerlockchange', resetPanel);
  for (const [button, menu] of [['workspace-toggle', 'workspace-menu']]) $(button).onclick = () => {
    const open = $(menu).hidden;
    for (const [b, m] of [['workspace-toggle', 'workspace-menu']]) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
    $(menu).hidden = !open; $(button).setAttribute('aria-expanded', String(open));
  };
  onDocument('pointerdown', e => { for (const [b, m] of [['workspace-toggle', 'workspace-menu']]) if (!$(m).hidden && !$(m).contains(e.target as Node) && !$(b).contains(e.target as Node)) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } });
  function dismiss() { for (const [b, m] of [['workspace-toggle', 'workspace-menu']]) if (!$(m).hidden) { $(m).hidden = true; $(b).setAttribute('aria-expanded', 'false'); $(b).focus(); } $('frontend-message').hidden = true; }
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('workspace-menu').hidden) { dismiss(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.defaultPrevented || (e.target as HTMLElement).closest('input,select,textarea,[contenteditable]')) e.stopPropagation();
  });
  root.addEventListener('keyup', e => { if ((e.target as HTMLElement).closest('input,select,textarea,[contenteditable]')) e.stopPropagation(); });
  onDocument('keydown', e => { if (e.key === 'Escape') dismiss(); });
  function setNavigation(next: NavigationMode) {
    if (nav === 'inspect' && next !== 'inspect') api.leaveInspect();
    const was = nav; nav = next; api.navigate(next); calmMotion();
    if (next === 'inspect') { inspectIndex = 0; inspectedId = ''; showInspection(true); }
    updateChrome();
    if (next === 'inspect' && was !== 'inspect') $('inspect-card').focus();   // keyboard users land on the card they just opened
    if (next !== was) announce({ explore: 'Look around. The walker stays parked; move through the room freely.', walk: 'Walk. W and S push the walker, A and D turn it, the mouse turns your head.', fly: 'Fly. A free camera; the walker stays where it was.', route: 'Following the route.', inspect: 'Inspect mode. Step through findings and changes with Previous and Next.' }[next]);
  }
  // With reduced motion the walkthrough waits for the person to press Play instead of moving on its own.
  function calmMotion() { if (display.reduceMotion() && nav === 'route' && !api.snapshot().paused) api.pause(); }
  for (const mode of ['route', 'walk', 'explore', 'fly', 'inspect'] as const) $(`mode-${mode}`).onclick = () => setNavigation(mode);
  $('inspect-exit').onclick = () => { setNavigation('explore'); $('mode-explore').focus(); };
  $('strip-keys').onclick = () => document.getElementById('keyhelp-chip')?.click();   // the floating F1 chip lives in the strip now (the chip stays in the DOM for controls.ts)
  $('route-pause').onclick = () => { api.pause(); updateChrome(); announce(api.snapshot().paused ? 'Route paused.' : 'Route playing.'); }; $('route-restart').onclick = () => { api.restart(); announce('Route restarted.'); };
  $<HTMLSelectElement>('route-speed').onchange = e => api.speed(Number((e.target as HTMLSelectElement).value));
  $('show-original').onclick = () => { api.compare(0); updateChrome(); announce('Showing the original layout.'); }; $('show-proposed').onclick = () => { api.compare(1); updateChrome(); announce('Showing the proposed layout.'); };
  $('animate-changes').onclick = () => { if (display.reduceMotion()) api.compare(api.snapshot().comparison > 0 ? 0 : 1); else api.animate(); };
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
    if (item && (focus || inspectedId !== item.id)) { inspectedId = item.id; api.focus(item); announce(`${inspectIndex + 1} of ${list.length}: ${item.title}. ${item.detail}`); }
    // A button that just became disabled (first or last item) would drop focus to the page; keep it in the card.
    const held = document.activeElement as HTMLButtonElement | null;
    if (held?.disabled && $('inspect-card').contains(held)) { const other = $<HTMLButtonElement>(held.id === 'inspect-next' ? 'inspect-prev' : 'inspect-next'); (other.disabled ? $('inspect-card') : other).focus(); }
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
    $('change-list').innerHTML = total.count ? s.changes.map((c, i) => `<article class="change-card"><div class="eyebrow">${h(c.kind === 'fix' ? 'Addition / fix' : c.kind)}</div><h3>${h(c.label)}</h3>${installationHTML(c, costDetail)}<div class="button-row"><button data-inspect-change="${i}">Inspect</button><button data-undo-change="${i}">Undo</button></div></article>`).join('') : '<div class="empty-state"><span aria-hidden="true">✧</span><h3>Your plan starts here</h3><p>Move an object or preview a proposal. Every change will appear in this list.</p></div>';
    $('change-list').querySelectorAll<HTMLButtonElement>('[data-undo-change]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api.undo(s.changes[Number(b.dataset.undoChange)]); refresh(); } catch { notify('Could not undo this change. Try again.'); b.disabled = false; } });
    $('change-list').querySelectorAll<HTMLButtonElement>('[data-inspect-change]').forEach(b => b.onclick = () => { inspectKind = 'changes'; $<HTMLSelectElement>('inspect-filter').value = 'changes'; setNavigation('inspect'); inspectIndex = Number(b.dataset.inspectChange); showInspection(true); });
    $('selected-controls').hidden = s.selected < 0;
    $('selection-name').textContent = s.selected >= 0 ? `${s.selectedName ?? 'Selected object'} · Move with the gizmo, or use the actions below.` : '';
  }
  $('cost-summary').onclick = () => { costDetail = false; refresh(); }; $('cost-breakdown').onclick = () => { costDetail = true; refresh(); };
  function renderAssessment(s: FrontendSnapshot) {
    const e = s.current, route = e?.routes[e.sel], concerns = (e?.hazards.length ?? 0) + (e?.checks.filter(c => c.verdict !== 'ok').length ?? 0);
    $('assessment-summary').innerHTML = `<div class="finding-banner"><span class="badge amber">For review</span><h2>${e ? e.error ? 'Route unavailable' : `${concerns} finding${concerns === 1 ? '' : 's'} to review` : 'Evaluating the route…'}</h2><p class="muted">Geometry and simulation support occupational therapist review.</p></div><div class="metric-grid"><div><small>Min. clearance / side</small><strong>${route?.min_side_m === undefined ? 'Pending' : `${(route.min_side_m * 100).toFixed(0)} cm`}</strong></div><div><small>Selected route</small><strong>${e?.error ? 'Blocked' : route ? 'Available' : 'Pending'}</strong></div><div class="wide"><small>Toe catches / month · ${e?.ghosts?.length ?? 0} simulated trips</small><strong>${number(e?.per_month)}</strong>${e?.hand ? `<small>hand-rule baseline ${number(e.hand.per_month)}</small>` : ''}</div></div>`;
    const b = s.baseline;
    $('comparison-metrics').innerHTML = s.changes.length ? `<h2>Evaluated comparison</h2><p class="muted">All routes · selected patient. Results describe the proposed endpoint, including while the visual preview shows Original.</p><table><thead><tr><th>Metric</th><th>Original</th><th>Proposed</th></tr></thead><tbody><tr><td>Toe catches / month</td><td>${number(b?.per_month)}</td><td>${number(e?.per_month)}</td></tr><tr><td>Likely range</td><td>${number(b?.per_month_lo)}–${number(b?.per_month_hi)}</td><td>${number(e?.per_month_lo)}–${number(e?.per_month_hi)}</td></tr><tr><td>Clearance / side<small>Selected route</small></td><td>${b?.routes[b.sel]?.min_side_m === undefined ? 'Pending' : `${(b.routes[b.sel].min_side_m! * 100).toFixed(0)} cm`}</td><td>${route?.min_side_m === undefined ? 'Pending' : `${(route.min_side_m * 100).toFixed(0)} cm`}</td></tr></tbody></table>` : '';
  }
  function renderProposals(s: FrontendSnapshot) {
    const options = distinctOptions(s.options);
    const currentContext = `${s.patient}:${s.route}`;
    if (generatedFor && (generatedFor !== currentContext || (generatedPlan && s.planKey !== generatedPlan && s.planKey !== previewedPlan))) { $('proposal-cards').innerHTML = '<p class="muted">Patient, route, or working layout changed. Generate proposals again for this context.</p>'; return; }
    const card = ({ option: o, index }: typeof options[number], recommended: boolean) => `<article class="proposal-card ${recommended ? 'recommended' : ''}"><span class="badge">${recommended ? 'Recommended by model' : 'Alternative'}</span><h2>${h(o.name)}</h2><p>${o.actions.length} change${o.actions.length === 1 ? '' : 's'} · ${o.checks_failed} checks flagged</p><ol>${o.actions.map(a => `<li>${h(a.label)}</li>`).join('')}</ol><div class="proposal-metrics"><span>${number(o.per_month)}/month<small>Simulated contacts · all routes</small></span><span>${number(o.per_month_lo)}–${number(o.per_month_hi)}<small>Likely range</small></span></div><p class="muted">Cost & installation estimates are reviewed in Changes after applying.</p><button class="${recommended ? 'primary' : ''} full" data-preview="${index}">Preview proposal</button><button class="full" data-use="${index}" ${chosenOption === index ? '' : 'disabled'}>Use this layout</button></article>`;
    $('proposal-cards').innerHTML = options.length ? card(options[0], true) + (options.length > 1 ? `<details><summary>Other options · ${options.length - 1}</summary>${options.slice(1).map(o => card(o, false)).join('')}</details>` : '<p class="muted">One distinct outcome found.</p>') : '<div class="empty-state"><span aria-hidden="true">✧</span><h3>Make room for a better route</h3><p>Explore rearrangements and configured fixes. Each proposal is evaluated by the existing model.</p></div>';
    $('proposal-cards').querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(b => b.onclick = async () => { if (busy) return; busy = true; b.disabled = true; try { await api.apply(Number(b.dataset.preview)); chosenOption = Number(b.dataset.preview); previewedPlan = api.snapshot().planKey; api.navigate('explore'); nav = 'explore'; notify('Proposal loaded in the viewer. This is a simulation; the room has not physically changed.'); refresh(); } catch { notify('Proposal could not be loaded. Try generating again.'); } finally { busy = false; b.disabled = false; } });
    $('proposal-cards').querySelectorAll<HTMLButtonElement>('[data-use]').forEach(b => b.onclick = () => { api.commit?.(); setTab('changes'); notify('This proposal is your current working plan. Review individual changes and estimates here.'); });
  }
  $('light-path').hidden = !api.lightPath;
  $('light-path').onclick = async () => {
    if (busy || !api.lightPath) return; busy = true; const b = $<HTMLButtonElement>('light-path'); b.disabled = true;
    try { const r = await api.lightPath(); $('light-path-note').textContent = r.note; refresh(); } catch { notify('Could not place nightlights on this route.'); }
    finally { busy = false; b.disabled = false; }
  };
  $('generate-proposals').onclick = async () => {
    if (busy) return; busy = true; const b = $<HTMLButtonElement>('generate-proposals'); b.disabled = true; b.textContent = 'Searching layouts…'; chosenOption = null;
    const request = api.snapshot(); generatedFor = `${request.patient}:${request.route}`; generatedPlan = request.planKey; previewedPlan = '';
    try { await api.suggest(); refresh(); } catch { notify('Layout search failed. You can still move objects or explore individual fixes.'); }
    finally { busy = false; b.disabled = false; b.innerHTML = '<span aria-hidden="true">✧</span> Generate proposals again'; }
  };
  $('lighting-ideas').innerHTML = LIGHTING_IDEAS.map(idea => `<article class="change-card"><span class="badge">Concept · verify on site</span><h3>${h(idea.title)}</h3><p>${h(idea.why)}</p><p class="muted">${h(idea.placement)}</p><dl class="details-grid"><dt>Power</dt><dd>${h(idea.powerSource ?? 'Pending')}</dd><dt>Cost / setup</dt><dd>Pending estimate</dd><dt>Installation</dt><dd>${idea.professionalRequired ? 'Professional assessment suggested' : 'Verify requirements'}</dd>${idea.maintenance ? `<dt>Maintenance</dt><dd>${h(idea.maintenance)}</dd>` : ''}</dl></article>`).join('') + '<p class="muted">Rendered brightness does not establish real illumination. No lux or vision-improvement claims are inferred from this preview.</p>';

  function updateChrome() {
    const s = api.snapshot();
    if (nav !== 'inspect') nav = navOf(s.mode, s.explore);
    for (const mode of ['route', 'walk', 'explore', 'fly', 'inspect']) $(`mode-${mode}`).setAttribute('aria-pressed', String(mode === nav));
    $('route-playback').hidden = nav !== 'route'; $('inspect-card').hidden = nav !== 'inspect';
    $('route-pause').textContent = s.paused ? 'Play' : 'Pause';
    $('comparison').hidden = !s.changes.length;
    const calm = display.reduceMotion(); $('animate-changes').hidden = calm;
    const tour = $<HTMLButtonElement>('tour'); tour.disabled = calm; tour.title = calm ? 'Off while reduce motion is on. Use Inspect to step through findings.' : 'fly to each hazard, worst first';
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
    renderHints(s); renderPersonaCards();
    const concerns = (s.current?.hazards.length ?? 0) + (s.current?.checks.filter(c => c.verdict !== 'ok').length ?? 0);
    const summary = `Interactive 3D scan of ${s.room.replaceAll('_', ' ')}. ${({ route: 'Following the route.', inspect: 'Inspecting.', walk: 'Walking.', fly: 'Flying.', explore: 'Looking around.' } as Record<NavigationMode, string>)[nav]} ${s.current ? `${concerns} finding${concerns === 1 ? '' : 's'} to review. ` : ''}${s.changes.length} planned change${s.changes.length === 1 ? '' : 's'}. The Room planning panel lists everything in text.`;
    const canvas = sceneView?.querySelector('canvas');
    if (canvas && canvas.getAttribute('aria-label') !== summary) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', summary); }
  }
  // ---------- controls strip, status pills, persona cards (hints.ts): what the keys do now, and who/what is on screen ----------
  let hintKey = '', cardsKey = '';
  function renderHints(s: FrontendSnapshot) {
    const hc = api.hintContext?.(); if (!hc) return;
    const x = { ...hc, inspect: nav === 'inspect' }, proposed = s.changes.length ? s.comparison > 0 : null;
    const key = JSON.stringify([x, proposed]); if (key === hintKey) return; hintKey = key;
    const hints = controlHints(x);
    $('controls-strip').dataset.tone = hints.tone; $('strip-mode').textContent = hints.label;
    $('strip-chips').innerHTML = hints.chips.map(c => `<span class="chip">${c.keys.map(k => `<kbd>${h(k)}</kbd>`).join('')}<span>${h(c.text)}</span></span>`).join('');
    $('pills').innerHTML = statusPills({ ...x, proposed }).map(p => p.go
      ? `<button class="pill" data-tone="${p.tone}" data-go="${p.go}">${h(p.text)}</button>` : `<span class="pill" data-tone="${p.tone}">${h(p.text)}</span>`).join('');
  }
  $('pills').addEventListener('click', e => {
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-go]')?.dataset.go;
    if (go === 'view') setTab('view'); else if (go === 'compare') { api.compare(api.snapshot().comparison === 0 ? 1 : 0); updateChrome(); }
  });
  function renderPersonaCards() {
    const sel = $<HTMLSelectElement>('persona'), key = [...sel.options].map(o => o.value + o.text).join('|') + sel.value + sel.disabled;
    if (key === cardsKey) return; cardsKey = key;
    $('persona-cards').querySelectorAll('.persona-card').forEach(n => n.remove());
    for (const o of sel.options) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'persona-card'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(o.value === sel.value));
      b.textContent = o.text; b.disabled = sel.disabled;
      b.onclick = () => { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); updateChrome(); };
      $('persona-cards').append(b);
    }
  }
  function refresh() { const s = api.snapshot(); renderAssessment(s); renderChanges(s); renderProposals(s); showInspection(); updateChrome(); }
  // Small scalar signature keeps the viewer frame loop free of DOM work; changes are polled only four times/sec.
  let lastSelected = -1;
  const timer = every(() => {
    const s = api.snapshot(); const next = JSON.stringify([s.current?.ms, s.current?.per_month, s.patient, s.route, s.changes.map(c => [c.name, c.kind, c.at, c.turn_deg]), s.options.map(o => o.layout), s.selected]);
    if (s.selected !== lastSelected) { if (s.selected >= 0) { setTab('changes'); announce(`${s.selectedName ?? 'Object'} selected. Arrow keys move it 5 cm; Delete removes it; Escape deselects.`); } else if (lastSelected >= 0) announce('Selection cleared.'); } lastSelected = s.selected;
    if (next !== signature) { signature = next; refresh(); } else updateChrome();
  }, 250);
  calmMotion(); refresh();
  return { refresh, setTab, setNavigation, inspection: () => nav === 'inspect' ? inspectionItems()[inspectIndex] ?? null : null, inspectNext: () => { inspectIndex = Math.min(inspectIndex + 1, inspectionItems().length - 1); showInspection(true); }, inspectPrevious: () => { inspectIndex = Math.max(0, inspectIndex - 1); showInspection(true); }, dispose: () => window.clearInterval(timer) };
}

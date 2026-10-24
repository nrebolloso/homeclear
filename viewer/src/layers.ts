// Layers: one always-visible control for what the room shows. Four presets (Clean, Hazards, Compare, Evidence), a grouped
// popover of every layer, and "Hide UI" (V) that removes the panels and HUD and leaves only the room.
// It adds no rendering: it drives the checkboxes and selects that already exist (spot, heights, heat, ...) by setting them
// and dispatching `change`, exactly like frontend.ts's "Reset view", so every handler in main.ts and reimagine.ts stays
// the only owner of what a layer does. The table and the preset logic are pure (tests/layers.test.ts); `mountLayers` is the DOM.
// (layers.css is imported by main.ts: node's test runner cannot load a .css import.)

export type LayerValue = boolean | string;
export type LayerGroup = 'Hazards' | 'Movement' | 'Changes' | 'Evidence';
export interface LayerDef { id: string; group: LayerGroup; label: string; options?: { value: string; label: string }[] }
/** Every layer is an existing control; `id` is its element id. */
export const LAYERS: LayerDef[] = [
  { id: 'spot', group: 'Hazards', label: 'Hazard highlights' },
  { id: 'heights', group: 'Hazards', label: 'Measured bump heights' },
  { id: 'particle-path', group: 'Movement', label: 'Particle path' },
  { id: 'ghosts', group: 'Movement', label: 'Simulated footsteps' },
  { id: 'handghosts', group: 'Movement', label: 'Hand-rule footsteps (baseline)' },
  { id: 'heat', group: 'Movement', label: 'Heatmap' },
  { id: 'reimghosts', group: 'Changes', label: 'Original object positions' },
  { id: 'reimarrows', group: 'Changes', label: 'Movement arrows' },
  { id: 'improvement-highlights', group: 'Changes', label: 'Evaluated improvements' },
  { id: 'reimtags', group: 'Changes', label: 'Cost labels', options: [{ value: 'off', label: 'Off' }, { value: 'selected', label: 'Selected item' }, { value: 'all', label: 'All changed items' }] },
  { id: 'imagfill', group: 'Evidence', label: 'Imagined floor' },
  { id: 'imagceil', group: 'Evidence', label: 'Imagined ceiling' },
  { id: 'verify', group: 'Evidence', label: 'Re-scan check' },
  { id: 'shell', group: 'Evidence', label: 'Room shell' },
];
export const GROUPS: LayerGroup[] = ['Hazards', 'Movement', 'Changes', 'Evidence'];

export type PresetName = 'clean' | 'hazards' | 'compare' | 'evidence';
export interface Preset { label: string; hint: string; set: Record<string, LayerValue> }
/** A preset lists only the layers it cares about; every other layer is left as it is. */
export const PRESETS: Record<PresetName, Preset> = {
  clean: { label: 'Clean', hint: 'The room only: no highlights, footsteps, labels or overlays',
    set: { spot: false, heights: false, 'particle-path': false, ghosts: false, handghosts: false, heat: false, reimghosts: false, reimarrows: false, 'improvement-highlights': false, reimtags: 'off' } },
  hazards: { label: 'Hazards', hint: 'What goes wrong: highlighted objects, bump heights and the simulated footsteps',
    set: { spot: true, heights: true, 'particle-path': true, ghosts: true, handghosts: false, heat: false, reimghosts: false, reimarrows: false, 'improvement-highlights': false, reimtags: 'off' } },
  compare: { label: 'Compare', hint: 'Current and proposed together: old positions, arrows, improvements and cost labels',
    set: { spot: false, heights: false, ghosts: false, handghosts: false, heat: false, reimghosts: true, reimarrows: true, 'improvement-highlights': true, reimtags: 'all' } },
  evidence: { label: 'Evidence', hint: 'What is measured and what is imagined: imagined floor and ceiling, estimated heights, proposals',
    set: { spot: true, heights: true, 'particle-path': false, ghosts: false, handghosts: false, heat: false, reimghosts: false, reimarrows: false, 'improvement-highlights': false, reimtags: 'off', imagfill: true, imagceil: true, verify: true } },
};
export const PRESET_ORDER: PresetName[] = ['clean', 'hazards', 'compare', 'evidence'];

/** The layers performance mode keeps off (heavy overlays), so a preset never undoes that choice. */
export function perfSkips(id: string, value: LayerValue): boolean { return id === 'heat' || id === 'imagceil' || (id === 'reimtags' && value === 'all'); }

export interface LayerIO { has(id: string): boolean; get(id: string): LayerValue; set(id: string, value: LayerValue): void }
export interface ApplyOpts { perf?: boolean }

/** Write a preset through `io`: only layers that exist and differ, so nothing redraws twice. Returns the ids it changed. */
export function applyPreset(name: PresetName, io: LayerIO, opts: ApplyOpts = {}): string[] {
  const changed: string[] = [];
  for (const [id, value] of Object.entries(PRESETS[name].set)) {
    if (!io.has(id) || (opts.perf && perfSkips(id, value)) || io.get(id) === value) continue;
    io.set(id, value); changed.push(id);
  }
  return changed;
}
/** Which preset the layers currently match (every layer it names that exists), else 'custom'. */
export function activePreset(io: LayerIO, opts: ApplyOpts = {}): PresetName | 'custom' {
  for (const name of PRESET_ORDER) {
    const entries = Object.entries(PRESETS[name].set).filter(([id, v]) => io.has(id) && !(opts.perf && perfSkips(id, v)));
    if (entries.length && entries.every(([id, v]) => io.get(id) === v)) return name;
  }
  return 'custom';
}

export interface KeyLike { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat?: boolean; target?: unknown }
/** V toggles the chrome, unless a modifier is held, the key is repeating, text is being typed, or a mark/edit/grab is under way. */
export function chromeKey(e: KeyLike, busy: boolean): boolean {
  if (e.code !== 'KeyV' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || busy) return false;
  const t = (e.target ?? {}) as { tagName?: string; isContentEditable?: boolean };
  return !/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName ?? '') && !t.isContentEditable;
}

// ---------- DOM ----------

export interface LayersOpts {
  /** a mark, edit or grab is under way: V is left to it */
  busy?: () => boolean;
  /** performance mode is on: presets leave the heavy layers off */
  perf?: () => boolean;
}
export interface LayersApi {
  apply(name: PresetName): string[]; active(): PresetName | 'custom'; state(): Record<string, LayerValue>;
  setChrome(hidden: boolean): void; chrome(): boolean;
}

export function mountLayers(opts: LayersOpts = {}): LayersApi {
  const el = (id: string) => document.getElementById(id) as (HTMLInputElement & HTMLSelectElement) | null;
  const io: LayerIO = {
    has: id => { const e = el(id); return !!e && !e.closest('label')?.hidden; },
    get: id => { const e = el(id)!; return e.tagName === 'SELECT' ? e.value : e.checked; },
    set: (id, v) => { const e = el(id)!; if (typeof v === 'boolean') e.checked = v; else e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); },
  };
  const perf = () => !!opts.perf?.();
  const dock = document.createElement('div');
  dock.id = 'layers'; dock.setAttribute('role', 'group'); dock.setAttribute('aria-label', 'Layers');
  dock.innerHTML = `
    <div class="lay-full">
      <div class="lay-presets" role="group" aria-label="Layer presets">${PRESET_ORDER.map(n => `<button type="button" data-preset="${n}" aria-pressed="false" title="${PRESETS[n].hint}">${PRESETS[n].label}</button>`).join('')}<span id="lay-custom" class="lay-custom" hidden>Custom</span></div>
      <button type="button" id="lay-more" aria-expanded="false" aria-controls="lay-pop" title="Every layer, grouped">Layers <span aria-hidden="true">▴</span></button>
      <button type="button" id="lay-hide" title="Hide the panels and HUD, leave only the room (V)">Hide UI <kbd>V</kbd></button>
    </div>
    <section id="lay-pop" aria-label="All layers" hidden></section>
    <button type="button" id="lay-show" class="lay-chip" title="Show the panels again (V)" hidden>Show UI <kbd>V</kbd></button>
    <div id="lay-live" class="lay-sr" role="status" aria-live="polite"></div>`;
  document.body.append(dock);
  const q = <T extends HTMLElement>(sel: string) => dock.querySelector<T>(sel)!;
  const pop = q('#lay-pop'), live = q('#lay-live');

  // the popover mirrors the real controls (the View-tab filters stay the same elements): each row reads and writes by id
  const rows = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const group of GROUPS) {
    const defs = LAYERS.filter(l => l.group === group);
    const sec = document.createElement('div'); sec.className = 'lay-group'; sec.dataset.group = group;
    sec.innerHTML = `<h3>${group}</h3>`;
    for (const d of defs) {
      const row = document.createElement('label'); row.dataset.layer = d.id;
      if (d.options) {
        row.append(`${d.label} `);
        const s = document.createElement('select');
        s.innerHTML = d.options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        s.onchange = () => { if (io.has(d.id)) io.set(d.id, s.value); };
        row.append(s); rows.set(d.id, s);
      } else {
        const c = document.createElement('input'); c.type = 'checkbox';
        c.onchange = () => { if (io.has(d.id)) io.set(d.id, c.checked); };
        row.append(c, ` ${d.label}`); rows.set(d.id, c);
      }
      sec.append(row);
    }
    pop.append(sec);
  }

  let hidden = false;
  const sync = () => {
    for (const [id, c] of rows) {
      const here = io.has(id), row = c.closest('label') as HTMLElement;
      row.hidden = !here;
      if (!here) continue;
      if (c instanceof HTMLInputElement) c.checked = io.get(id) as boolean; else c.value = io.get(id) as string;
    }
    for (const sec of pop.querySelectorAll<HTMLElement>('.lay-group')) sec.hidden = ![...sec.querySelectorAll('label')].some(l => !(l as HTMLElement).hidden);
    const a = activePreset(io, { perf: perf() });
    for (const b of dock.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === a));
    q('#lay-custom').hidden = a !== 'custom';
  };
  const say = (t: string) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };

  const api: LayersApi = {
    apply(name) { const ch = applyPreset(name, io, { perf: perf() }); sync(); say(`${PRESETS[name].label} layers.${perf() ? ' Performance mode keeps heavy overlays off.' : ''}`); return ch; },
    active: () => activePreset(io, { perf: perf() }),
    state: () => Object.fromEntries(LAYERS.filter(l => io.has(l.id)).map(l => [l.id, io.get(l.id)])),
    setChrome(h) {
      hidden = h; document.body.classList.toggle('clean', h);
      q('.lay-full').hidden = h; q('#lay-show').hidden = !h; if (h) { pop.hidden = true; q('#lay-more').setAttribute('aria-expanded', 'false'); }
      say(h ? 'Interface hidden. Press V to show it.' : 'Interface shown.');
      (h ? q('#lay-show') : q('#lay-hide')).focus({ preventScroll: true });
    },
    chrome: () => hidden,
  };

  for (const b of dock.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.onclick = () => api.apply(b.dataset.preset as PresetName);
  q('#lay-more').onclick = () => { pop.hidden = !pop.hidden; q('#lay-more').setAttribute('aria-expanded', String(!pop.hidden)); sync(); };
  q('#lay-hide').onclick = () => api.setChrome(true);
  q('#lay-show').onclick = () => api.setChrome(false);
  addEventListener('keydown', e => {
    if (chromeKey(e, !!opts.busy?.())) { e.preventDefault(); api.setChrome(!hidden); }
    else if (e.code === 'Escape' && !pop.hidden && dock.contains(document.activeElement)) { pop.hidden = true; q('#lay-more').setAttribute('aria-expanded', 'false'); q('#lay-more').focus(); }
  });
  document.addEventListener('change', e => { if (!dock.contains(e.target as Node)) sync(); });   // any layer changed elsewhere (View tab, classic panel, code)
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !dock.contains(e.target as Node)) { pop.hidden = true; q('#lay-more').setAttribute('aria-expanded', 'false'); } });
  sync();
  return api;
}

import { onWindow, later } from './lifetime.ts';
// In-viewer review of what the viewer flagged: an OT can confirm a highlighted hazard, dismiss it, or leave a note. This is
// a judgement ON the flagged items, kept apart from the measurements: dismissing hides the highlight, pin and tour stop but the
// measured number and the simulated toe contacts are unchanged. It is NOT the hand-labelled answer key (tools/label_hazards):
// that one is labelled blind, before looking at what the geometry or Cosmos Reason flagged, so these verdicts never feed it.
// The store is pure (tests/hazardreview.test.ts); `mountReview` is the panel.
import type { Spot } from './spotlight.ts';

export type Verdict = 'confirmed' | 'dismissed';
export interface ReviewItem { verdict?: Verdict; note?: string; at?: string }
export type ReviewState = Record<string, ReviewItem>
type SpotKey = Pick<Spot, 'kind' | 'xy' | 'label'>;

/** A spot's identity across re-plans, routes and personas: its kind, where it is (to 1 cm) and its headline. */
export const reviewKey = (s: SpotKey) => `${s.kind}|${s.xy[0].toFixed(2)},${s.xy[1].toFixed(2)}|${s.label}`;

const clean = (it: ReviewItem): ReviewItem | null => { const o: ReviewItem = {}; if (it.verdict) o.verdict = it.verdict; if (it.note?.trim()) o.note = it.note.trim().slice(0, 500); if (it.at && (o.verdict || o.note)) o.at = it.at; return o.verdict || o.note ? o : null; };
function put(state: ReviewState, key: string, item: ReviewItem): ReviewState {
  const next = { ...state }, c = clean(item);
  if (c) next[key] = c; else delete next[key];
  return next;
}
/** Set or clear (null) the verdict; setting the verdict it already has clears it (a second click undoes). */
export function setVerdict(state: ReviewState, key: string, verdict: Verdict | null, now = new Date().toISOString()): ReviewState {
  const cur = state[key] ?? {};
  return put(state, key, { ...cur, verdict: verdict && cur.verdict !== verdict ? verdict : undefined, at: now });
}
export function setNote(state: ReviewState, key: string, note: string, now = new Date().toISOString()): ReviewState { return put(state, key, { ...(state[key] ?? {}), note, at: now }); }

/** The spots still shown: everything but what was dismissed. */
export const visibleSpots = <T extends SpotKey>(spots: T[], state: ReviewState): T[] => spots.filter(s => state[reviewKey(s)]?.verdict !== 'dismissed');
export function reviewCounts(spots: SpotKey[], state: ReviewState) {
  const out = { total: spots.length, confirmed: 0, dismissed: 0, noted: 0, unreviewed: 0 };
  for (const s of spots) { const r = state[reviewKey(s)]; if (r?.verdict === 'confirmed') out.confirmed++; else if (r?.verdict === 'dismissed') out.dismissed++; else out.unreviewed++; if (r?.note) out.noted++; }
  return out;
}
/** Anything unreadable falls back to an empty review; unknown verdicts are dropped. */
export function parseReview(raw: string | null): ReviewState {
  let o: unknown = {};
  try { o = JSON.parse(raw ?? '{}'); } catch { /* start empty */ }
  const out: ReviewState = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>, c = clean({ verdict: r.verdict === 'confirmed' || r.verdict === 'dismissed' ? r.verdict : undefined, note: typeof r.note === 'string' ? r.note : undefined, at: typeof r.at === 'string' ? r.at : undefined });
    if (c) out[k] = c;
  }
  return out;
}
/** The review as a file: one row per reviewed spot, with what the viewer said it was. */
export function exportReview(scene: string, spots: (SpotKey & { detail?: string; severity?: number })[], state: ReviewState, now = new Date().toISOString()) {
  return {
    kind: 'viewer-hazard-review', scene, exported: now,
    note: 'An OT\'s verdicts on hazards the viewer flagged. Not a hand-labelled answer key (that is labelled blind, before looking at flags).',
    items: spots.filter(s => state[reviewKey(s)]).map(s => ({ key: reviewKey(s), source: s.kind, label: s.label, detail: s.detail, xy: s.xy, ...state[reviewKey(s)] })),
  };
}

// ---------- DOM ----------

export interface ReviewDeps {
  scene: string;
  /** every spot on the current route, dismissed or not */
  spots: () => (Spot)[];
  /** the shown set changed: redraw highlights, pins and the tour */
  onChange: (state: ReviewState) => void;
}
const STORE = (scene: string) => `homeclear.review.${scene}`;
export function mountReview(D: ReviewDeps) {
  let state: ReviewState = parseReview((() => { try { return localStorage.getItem(STORE(D.scene)); } catch { return null; } })());
  const save = () => { try { localStorage.setItem(STORE(D.scene), JSON.stringify(state)); } catch { /* private window: kept until reload */ } };
  const dock = document.getElementById('layers'), bar = dock?.querySelector('.lay-full'), hide = document.getElementById('lay-hide');
  const btn = document.createElement('button'); btn.type = 'button'; btn.id = 'rev-open'; btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'rev-panel');
  btn.title = 'Confirm, dismiss or note the hazards the viewer flagged';
  const panel = document.createElement('section'); panel.id = 'rev-panel'; panel.setAttribute('aria-label', 'Review flagged hazards'); panel.hidden = true;
  if (bar && hide) bar.insertBefore(btn, hide); else document.body.append(btn);
  (dock ?? document.body).append(panel);
  const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const set = (s: ReviewState) => { state = s; save(); render(); D.onChange(state); };
  let last = '';
  function render() {
    const spots = D.spots(), n = reviewCounts(spots, state);
    btn.innerHTML = `Review <span class="rev-count" aria-label="${n.unreviewed} not yet reviewed">${n.unreviewed}</span>`;
    if (panel.hidden) return;
    const html = `<div class="rev-head"><b>Review flagged hazards</b> <small>${n.confirmed} confirmed · ${n.dismissed} dismissed · ${n.unreviewed} to review</small>
        <button type="button" id="rev-export" ${n.total ? '' : 'disabled'} title="Download your verdicts as JSON">Export</button></div>
      <p class="rev-note">Dismissing hides the highlight; the measured number and the simulated risk are unchanged. This is not the blind answer key.</p>
      <ul>${spots.map(s => { const k = reviewKey(s), r = state[k] ?? {}; return `<li data-key="${esc(k)}" data-verdict="${r.verdict ?? ''}">
        <div class="rev-line"><span class="rev-kind" data-kind="${s.kind}">${s.kind === 'measured' ? 'measured' : s.kind === 'reason-confirmed' ? 'proposed · scan agrees' : 'proposed · OT to check'}</span> <b>${esc(s.label)}</b></div>
        <small>${esc(s.detail)}</small>
        <div class="rev-actions"><button type="button" data-act="confirmed" aria-pressed="${r.verdict === 'confirmed'}">Confirm</button><button type="button" data-act="dismissed" aria-pressed="${r.verdict === 'dismissed'}">Dismiss</button>
        <input type="text" maxlength="500" placeholder="Note" aria-label="Note for ${esc(s.label)}" value="${esc(r.note ?? '')}"></div></li>`; }).join('') || '<li class="muted">No hazards flagged on this route.</li>'}</ul>`;
    if (html === last && panel.firstChild) return;   // a re-plan that changed nothing must not eat what is being typed
    last = html; panel.innerHTML = html;
    panel.querySelectorAll<HTMLLIElement>('li[data-key]').forEach(li => {
      const key = li.dataset.key!;
      li.querySelectorAll<HTMLButtonElement>('[data-act]').forEach(b => { b.onclick = () => set(setVerdict(state, key, b.dataset.act as Verdict)); });
      const inp = li.querySelector('input')!; inp.onchange = () => set(setNote(state, key, inp.value));
    });
    const ex = panel.querySelector<HTMLButtonElement>('#rev-export');
    if (ex) ex.onclick = () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(exportReview(D.scene, spots, state), null, 2)], { type: 'application/json' }));
      a.download = `hazard_review_${D.scene}.json`; a.click(); later(() => URL.revokeObjectURL(a.href), 1000);
    };
  }
  btn.onclick = () => { last = ''; panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); render(); };
  onWindow('keydown', e => { if (e.code === 'Escape' && !panel.hidden && panel.contains(document.activeElement)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
  render();
  return {
    state: () => state, spots: () => visibleSpots(D.spots(), state), refresh: render,
    filter: (s: Spot) => state[reviewKey(s)]?.verdict !== 'dismissed',
    counts: () => reviewCounts(D.spots(), state),
  };
}

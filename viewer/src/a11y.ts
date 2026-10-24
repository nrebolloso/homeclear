// Accessibility helpers for the planning frontend: display preferences (text size, theme, reduced motion),
// a screen-reader announcer, dialog focus handling, and names for legacy controls that have none.
// frontend.ts wires these in; the preference logic is pure so tests/a11y.test.ts can check it without a DOM.

export type TextSize = 'default' | 'large' | 'larger';
export type Theme = 'dark' | 'light' | 'contrast';
export interface Prefs { text: TextSize; theme: Theme | 'system'; reduceMotion: boolean }

export const TEXT_SCALE: Record<TextSize, number> = { default: 1, large: 1.15, larger: 1.3 };
export const DEFAULT_PREFS: Prefs = { text: 'default', theme: 'system', reduceMotion: false };
const KEY = 'homeclear.a11y';

/** Anything unreadable or unknown falls back to the default, so a stale or hand-edited value can't break the page. */
export function parsePrefs(raw: string | null): Prefs {
  let o: Record<string, unknown> = {};
  try { const v = JSON.parse(raw ?? '{}'); if (v && typeof v === 'object') o = v; } catch { /* use defaults */ }
  return {
    text: o.text === 'large' || o.text === 'larger' ? o.text : 'default',
    theme: o.theme === 'dark' || o.theme === 'light' || o.theme === 'contrast' ? o.theme : 'system',
    reduceMotion: o.reduceMotion === true,
  };
}
export function loadPrefs(): Prefs { try { return parsePrefs(localStorage.getItem(KEY)); } catch { return { ...DEFAULT_PREFS }; } }
export function savePrefs(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window: kept for this visit only */ } }

/** A person's choice wins; otherwise the OS "more contrast" setting; otherwise the dark theme the viewer ships with. */
export function resolveTheme(p: Prefs, osContrastMore: boolean): Theme { return p.theme !== 'system' ? p.theme : osContrastMore ? 'contrast' : 'dark'; }
export function reducedMotion(p: Prefs, osReduce: boolean): boolean { return p.reduceMotion || osReduce; }

const $in = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)!;

/** The "Accessibility & display" controls in the workspace menu. Sets data-theme / data-motion / --fs on <body>. */
export function mountDisplaySettings(root: HTMLElement, onChange: () => void) {
  const motionQ = matchMedia('(prefers-reduced-motion: reduce)'), contrastQ = matchMedia('(prefers-contrast: more)');
  let prefs = loadPrefs();
  const reduce = () => reducedMotion(prefs, motionQ.matches);
  const sizes = [...root.querySelectorAll<HTMLButtonElement>('[data-text]')];
  const theme = $in<HTMLSelectElement>(root, '#a11y-theme'), motion = $in<HTMLInputElement>(root, '#a11y-motion');
  function apply() {
    const b = document.body;
    b.dataset.theme = resolveTheme(prefs, contrastQ.matches); b.dataset.motion = reduce() ? 'reduce' : 'full';
    b.style.setProperty('--fs', String(TEXT_SCALE[prefs.text]));
    for (const s of sizes) s.setAttribute('aria-pressed', String(s.dataset.text === prefs.text));
    theme.value = prefs.theme; motion.checked = reduce(); motion.disabled = motionQ.matches;
    $in(root, '#a11y-motion-note').textContent = motionQ.matches ? 'On because your device asks for it.' : '';
  }
  const change = (next: Partial<Prefs>) => { prefs = { ...prefs, ...next }; savePrefs(prefs); apply(); onChange(); };
  for (const s of sizes) s.onclick = () => change({ text: s.dataset.text as TextSize });
  theme.onchange = () => change({ theme: theme.value as Prefs['theme'] });
  motion.onchange = () => change({ reduceMotion: motion.checked });
  $in(root, '#a11y-reset').onclick = () => change({ ...DEFAULT_PREFS });
  motionQ.addEventListener('change', () => { apply(); onChange(); }); contrastQ.addEventListener('change', apply);
  apply();
  return { reduceMotion: reduce };
}

/** Polite live region for things that change on screen without moving focus (inspect step, mode, selection). */
export function createAnnouncer(parent: HTMLElement) {
  const el = document.createElement('div'); el.className = 'sr-only'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.setAttribute('aria-atomic', 'true');
  parent.append(el);
  let timer = 0;
  // Clear first so repeating the same message is announced again.
  return (message: string) => { window.clearTimeout(timer); el.textContent = ''; timer = window.setTimeout(() => { el.textContent = message; }, 60); };
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])';

/** Make a legacy overlay (shown/hidden with the `hidden` attribute) a real dialog: named, focus moves in, Tab stays inside, Esc closes, focus returns. */
export function watchDialog(el: HTMLElement | null, label: string, closeSelector: string) {
  if (!el) return;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', label); el.tabIndex = -1;
  let opener: HTMLElement | null = null, wasOpen = !el.hidden;
  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); el.querySelector<HTMLElement>(closeSelector)?.click(); return; }
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
  new MutationObserver(() => {
    const open = !el.hidden; if (open === wasOpen) return; wasOpen = open;
    if (open) { opener = document.activeElement as HTMLElement | null; el.focus(); }
    else if (opener && document.contains(opener)) { opener.focus(); opener = null; }
  }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
}

/** Legacy panels name some controls only with `title`; give those (and unlabeled canvases) a real accessible name. */
export function nameUnlabeled(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('select,input,textarea,canvas')) {
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) continue;
    if ((el as HTMLInputElement).labels?.length) continue;
    const title = el.getAttribute('title'); if (title) el.setAttribute('aria-label', title);
    if (el.tagName === 'CANVAS') el.setAttribute('role', 'img');
  }
}

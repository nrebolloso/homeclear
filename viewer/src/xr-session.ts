import { SparkXr } from '@sparkjsdev/spark';
import type { SparkXrOptions } from '@sparkjsdev/spark';
// Keep the entry button and XR manager across rooms; only the host callbacks change.
let session: SparkXr | undefined;
let enter: (() => void | Promise<void>) | undefined, exit: (() => void | Promise<void>) | undefined;
let available = false;
export function bindXR(options: SparkXrOptions) {
  enter = options.onEnterXr; exit = options.onExitXr;
  session ??= new SparkXr({ ...options, onEnterXr: () => enter?.(), onExitXr: () => exit?.(),
    onReady: ok => { available = ok; vrEntryChanged(); return options.onReady?.(ok); } });
  queueMicrotask(() => session?.element?.setAttribute('data-xr-persistent', 'true'));
}

// ---------- the Enter VR button: shown on a headset (or ?vr / the emulator), hidden on a desktop until K ----------
// A desktop with Link or SteamVR installed reports VR support, so Spark would show the button on every page. Hidden
// with a body class, not style.display: Spark rewrites that on every session start and end.
declare global { interface WindowEventMap { vrentry: CustomEvent<{ available: boolean; shown: boolean }> } }
const SHOWN_KEY = 'homeclear:vr-button', CLASS = 'vr-entry-hidden';
const q = new URLSearchParams(location.search);
const headset = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent) || q.has('emulate');
const stored = () => { try { return localStorage.getItem(SHOWN_KEY); } catch { return null; } };
let shown = q.has('vr') || (stored() ?? (headset ? '1' : '0')) === '1';
const style = document.createElement('style');
style.textContent = `body.${CLASS} [data-xr-persistent] { display: none !important; }`;
document.head.append(style);
function vrEntryChanged() {
  document.body.classList.toggle(CLASS, !shown);
  window.dispatchEvent(new CustomEvent('vrentry', { detail: { available, shown } }));
}
vrEntryChanged();
/** this browser can start a VR session (Spark found immersive-vr) */
export const vrAvailable = () => available;
export const vrButtonShown = () => shown;
/** K: show or hide the Enter VR button, remembered in this browser; null when VR isn't available here */
export function toggleVrButton(): boolean | null {
  if (!available) return null;
  shown = !shown;
  try { localStorage.setItem(SHOWN_KEY, shown ? '1' : '0'); } catch { /* private mode: this page only */ }
  vrEntryChanged();
  return shown;
}

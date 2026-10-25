// Explicit scene ownership; no patched browser prototypes. One room mounts at a time.
export class Lifetime {
  private cleanup: (() => void)[] = [];
  disposed = false;
  own(fn: () => void) { this.cleanup.push(fn); }
  dispose() { if (this.disposed) return; this.disposed = true; for (const fn of this.cleanup.reverse()) { try { fn(); } catch (e) { console.warn('Scene cleanup', e); } } this.cleanup = []; }
}
let active: Lifetime | undefined;
export function useLifetime(scope: Lifetime) { active = scope; }
export function own(fn: () => void) { active?.own(fn); }
export function onWindow<K extends keyof WindowEventMap>(type: K, fn: (event: WindowEventMap[K]) => void, options?: boolean | AddEventListenerOptions) {
  window.addEventListener(type, fn, options); own(() => window.removeEventListener(type, fn, options));
}
export function onDocument<K extends keyof DocumentEventMap>(type: K, fn: (event: DocumentEventMap[K]) => void, options?: boolean | AddEventListenerOptions) {
  document.addEventListener(type, fn, options); own(() => document.removeEventListener(type, fn, options));
}
export function onThree(target: any, type: string, fn: (event: any) => void) {
  target.addEventListener(type, fn); own(() => target.removeEventListener(type, fn));
}
export function every(fn: () => void, ms: number) { const id = window.setInterval(fn, ms); own(() => window.clearInterval(id)); return id; }
export function later(fn: () => void, ms: number) { const id = window.setTimeout(fn, ms); own(() => window.clearTimeout(id)); return id; }

export function onCanvas<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (event: HTMLElementEventMap[K]) => void, options?: boolean | AddEventListenerOptions) {
  target.addEventListener(type, fn, options); own(() => target.removeEventListener(type, fn, options));
}

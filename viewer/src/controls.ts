// Desktop controls that don't need the scene: what a key press means, the undo history for room edits, and the F1 key
// overlay with its toast. main.ts supplies the actions (grab, remove, mark...) and calls these from one hook block.
// The pure parts (keyIntent, createHistory) touch no DOM so tests/controls.test.ts can run them.

export type Intent = 'help' | 'undo' | 'redo' | 'mark' | 'mark-stairs' | 'mark-door' | 'choose-cancel' | 'remove' | 'grab'
  | 'grab-drop' | 'grab-cancel' | 'grab-turn' | 'lock' | 'recenter' | 'persona' | 'nav-route' | 'nav-walk' | 'nav-explore' | 'nav-fly' | null;
export interface KeyLike { code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
/** typing: focus is in a text field; grabbing: G is carrying an object; choosing: M was pressed and 1/2 is awaited */
export interface KeyCtx { typing: boolean; grabbing: boolean; choosing: boolean }

export function keyIntent(e: KeyLike, c: KeyCtx): Intent {
  if (e.code === 'F1') return 'help';
  if (c.typing) return null;
  if (e.key === '?') return 'help';
  if (e.ctrlKey || e.metaKey) {   // only undo/redo: every other Ctrl/Cmd chord belongs to the browser
    if (e.altKey) return null;
    if (e.code === 'KeyZ') return e.shiftKey ? 'redo' : 'undo';
    return e.code === 'KeyY' ? 'redo' : null;
  }
  if (e.altKey) return null;
  if (c.choosing) {   // M was pressed: 1 or 2 picks the tool, Esc or any other key drops the choice (the key still does its own job)
    if (e.code === 'Digit1' || e.code === 'Numpad1') return 'mark-stairs';
    if (e.code === 'Digit2' || e.code === 'Numpad2') return 'mark-door';
    return 'choose-cancel';
  }
  if (c.grabbing) return e.code === 'Escape' ? 'grab-cancel' : e.code === 'Enter' || e.code === 'KeyG' ? 'grab-drop' : e.code === 'KeyR' ? 'grab-turn' : null;
  if (e.shiftKey) return null;
  const digit = ({ Digit1: 'nav-route', Digit2: 'nav-walk', Digit3: 'nav-explore', Digit4: 'nav-fly' } as Record<string, Intent>)[e.code];   // 1-4: the toolbar modes (M then 1/2 is the mark chooser above)
  if (digit) return digit;
  return ({ KeyM: 'mark', KeyX: 'remove', KeyG: 'grab', KeyL: 'lock', KeyC: 'recenter', KeyP: 'persona' } as Record<string, Intent>)[e.code] ?? null;
}

/** Undo/redo over snapshots S. An entry only applies while the room is still exactly as that edit left it (same key): a fix
 *  applied or an object pushed by the walker in between changes it, and then the history is dropped instead of guessing. */
export function createHistory<S>(key: (s: S) => unknown, limit = 100) {
  type E = { label: string; before: S; after: S };
  let past: E[] = [], future: E[] = [];
  return {
    record(label: string, before: S, after: S) {
      if (key(before) === key(after)) return;
      past.push({ label, before, after }); if (past.length > limit) past.shift();
      future = [];
    },
    undo(now: S): { label: string; to: S } | 'stale' | null {
      const e = past.at(-1); if (!e) return null;
      if (key(e.after) !== key(now)) { past = []; future = []; return 'stale'; }
      past.pop(); future.push(e); return { label: e.label, to: e.before };
    },
    redo(now: S): { label: string; to: S } | 'stale' | null {
      const e = future.at(-1); if (!e) return null;
      if (key(e.before) !== key(now)) { past = []; future = []; return 'stale'; }
      future.pop(); past.push(e); return { label: e.label, to: e.after };
    },
    clear() { past = []; future = []; },
    size: () => ({ undo: past.length, redo: future.length }),
  };
}

/** A short buzz on a controller; hand tracking and the emulator have no actuator, so then nothing happens. */
export function pulse(pad: Gamepad | undefined, strength = 0.5, ms = 40) {
  try {
    const a = (pad as any)?.hapticActuators?.[0];
    if (a?.pulse) a.pulse(strength, ms);
    else (pad as any)?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
  } catch { /* haptics are a nicety */ }
}
/** VR: the planning menu opens on a left-stick click held this long (a tap is too easy to hit by accident, e.g. on a
 *  controller strapped to a walker); closing it is a plain click. */
export const MENU_HOLD_S = 0.4;

const GROUPS: [string, [string, string][]][] = [
  ['Move and look', [
    ['1 / 2 / 3 / 4', 'Follow route / Walk / Look around (walker parked, nothing collides) / Fly'],
    ['W / S, A / D', 'push the walker forward and back, turn it (arrows too)'],
    ['Drag, left or right button', 'look around'],
    ['Scroll / two-finger scroll / pinch', 'walk forward and back (sideways scroll turns)'],
    ['Mouse', 'looks around; the walker keeps its heading, W/S push it that way'],
    ['Wheelchair: W / S, A / D, Q / E', 'roll forward and back, steer while rolling (A / D only turn when moving), spin on the spot'],
    ['P', 'switch who is walking (cycles the Who list: patient, walker, wheelchair...)'],
    ['C', 'turn the walker (or chair) to face where you are looking'],
    ['L', 'lock the mouse to look freely; Esc lets go'],
    ['F', 'fly (spectator): Q / E down and up, Shift fast; the walker stays where it was'],
  ]],
  ['Edit furniture', [
    ['Click', 'select · T / R switch move and rotate · arrows nudge 5 cm'],
    ['G', 'grab: it follows the mouse; click or Enter drops, R turns, Esc cancels'],
    ['X or Delete', 'remove the selected object'],
    ['Z / Shift+Z', 'put the selected object back / reset the whole room'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'undo / redo any of the above (Ctrl+Y also redoes)'],
  ]],
  ['Mark stairs and doorways', [
    ['M, then 1 or 2', '1 stairs, 2 doorway (M again cancels)'],
    ['Click or Space', 'place a point (Space: at the screen centre)'],
    ['Shift', 'hold to skip snapping'],
    ['Right click, Backspace, Ctrl+Z', 'undo the last point'],
    ['Esc / Enter', 'cancel marking / finish editing marks'],
  ]],
  ['Anywhere', [['H', 'demo mode (hides the panels)'], ['F1 or ?', 'this list']]],
];

const CSS = `
#keyhelp-chip { position: fixed; right: 12px; bottom: 12px; z-index: 30; font: 12px system-ui, sans-serif; color: var(--dim, #9aa0a6); background: var(--panel, rgba(17,20,24,.86)); border: 1px solid #fff2; border-radius: 8px; padding: 4px 9px; cursor: pointer; }
#keyhelp-chip:hover, #keyhelp-chip:focus-visible { color: var(--fg, #e8e6e1); }
#keyhelp { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: #0008; font: 14px/1.4 system-ui, sans-serif; color: var(--fg, #e8e6e1); }
#keyhelp[hidden], #keyhelp-chip[hidden], #crosshair[hidden], #keytoast[hidden] { display: none; }
#keyhelp .box { background: var(--bg, #111418); border: 1px solid #fff3; border-radius: 14px; padding: 18px 22px; max-width: 760px; max-height: 88vh; overflow: auto; }
#keyhelp h2 { margin: 0 0 6px; font-size: 16px; } #keyhelp h3 { margin: 14px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim, #9aa0a6); }
#keyhelp dl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; margin: 0; } #keyhelp dt { font-weight: 600; white-space: nowrap; } #keyhelp dd { margin: 0; color: #cfd3d8; }
#keyhelp button { margin-top: 14px; }
#crosshair { position: fixed; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px #0008; pointer-events: none; z-index: 20; }
#keytoast { position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); z-index: 40; background: var(--panel, rgba(17,20,24,.9)); color: var(--fg, #e8e6e1); border: 1px solid #fff3; border-radius: 10px; padding: 7px 14px; font: 14px system-ui, sans-serif; pointer-events: none; }
body.xr-active #keyhelp-chip, .frontend.xr-active #keyhelp-chip { display: none; }
@media (prefers-reduced-motion: no-preference) { #keytoast { transition: opacity .2s; } }`;

/** The F1 overlay, a small "F1 keys" chip, a crosshair for the locked mouse and a one-line toast ("Undid: moved bed"). */
export function createKeyOverlay() {
  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const chip = document.createElement('button'); chip.id = 'keyhelp-chip'; chip.type = 'button'; chip.textContent = 'F1 · keys'; chip.setAttribute('aria-label', 'Show keyboard shortcuts (F1)');
  const dlg = document.createElement('div'); dlg.id = 'keyhelp'; dlg.hidden = true; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-label', 'Keyboard shortcuts');
  const box = document.createElement('div'); box.className = 'box';
  box.innerHTML = '<h2>Keyboard and mouse</h2>' + GROUPS.map(([t, rows]) =>
    `<h3>${t}</h3><dl>${rows.map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('')}</dl>`).join('');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close (Esc)';
  box.append(close); dlg.append(box);
  const cross = document.createElement('div'); cross.id = 'crosshair'; cross.hidden = true;
  const toastEl = document.createElement('div'); toastEl.id = 'keytoast'; toastEl.hidden = true; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
  document.body.append(chip, dlg, cross, toastEl);
  let from: HTMLElement | null = null, timer = 0;
  const isOpen = () => !dlg.hidden;
  function open() { from = document.activeElement as HTMLElement | null; dlg.hidden = false; close.focus(); }
  function hide() { dlg.hidden = true; from?.focus?.(); from = null; }
  chip.onclick = () => (isOpen() ? hide() : open());
  close.onclick = hide;
  dlg.addEventListener('pointerdown', e => { if (e.target === dlg) hide(); });
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); hide(); } });
  return {
    isOpen, open, close: hide, toggle: () => (isOpen() ? hide() : open()),
    toast(text: string, ms = 2200) {
      toastEl.textContent = text; toastEl.hidden = false; clearTimeout(timer);
      timer = window.setTimeout(() => { toastEl.hidden = true; }, ms);
    },
    setLocked(on: boolean) { cross.hidden = !on; },
  };
}

// What the keys and buttons do right now: one table behind the bottom-left strip (desktop), the strip card on the off-hand
// controller (VR) and the status pills. Pure (no DOM, no three) so tests/hints.test.ts can run it. The full lists stay on
// F1 (controls.ts); this is only the handful that apply in the current state, at most MAX_CHIPS.

export type Tone = 'move' | 'edit' | 'mark' | 'spectate' | 'view';
export type HintMode = 'marking' | 'editing' | 'grabbing' | 'selected' | 'inspect' | 'route' | 'fly' | 'free' | 'explore';
export interface HintCtx {
  device: 'desktop' | 'vr';
  persona: string;                       // 'patient' | 'wheelchair' | 'stroke' | ...
  nav: 'auto' | 'free' | 'fly';          // the viewer's walk mode: auto = following the route
  inspect: boolean;
  marking: { kind: 'stairs' | 'door' | 'point'; step: number; total: number } | null;
  editingMarks: boolean;
  grabbing: boolean;                     // G on the desktop; a held object under the wand in VR
  selected: boolean;                     // desktop: an object is picked; VR: the wand points at one
  locked: boolean;                       // desktop: mouse locked
  mounted: boolean;                      // VR: controller strapped to a walker
  parked?: boolean;                      // desktop: Look around (the walker stays where it was, nothing collides)
  mismatch?: boolean;                    // desktop: the head is turned away from the walker's heading
}
export interface Chip { keys: string[]; text: string }
export interface Hints { mode: HintMode; label: string; tone: Tone; chips: Chip[] }
export const MAX_CHIPS = 5;
export const VR_CHIPS = 3;   // the strip on the controller shows one row per chip: more than three stops reading at a glance

const c = (text: string, ...keys: string[]): Chip => ({ keys, text });
const TONE: Record<HintMode, Tone> = { marking: 'mark', editing: 'mark', grabbing: 'edit', selected: 'edit', inspect: 'view', route: 'move', fly: 'spectate', free: 'move', explore: 'view' };

export function hintMode(x: HintCtx): HintMode {
  return x.marking ? 'marking' : x.editingMarks ? 'editing' : x.grabbing ? 'grabbing' : x.selected ? 'selected' : x.inspect ? 'inspect' : x.nav === 'auto' ? 'route' : x.nav === 'fly' ? 'fly' : x.parked && x.device === 'desktop' ? 'explore' : 'free';
}

export function controlHints(x: HintCtx): Hints {
  const mode = hintMode(x), chair = x.persona === 'wheelchair', vr = x.device === 'vr';
  let label: string, chips: Chip[];
  const wasd = chair ? [c('roll', 'W', 'S'), c('steer', 'A', 'D'), c('spin', 'Q', 'E')] : [c('push', 'W', 'S'), c('turn', 'A', 'D')];   // the chair rolls, steers while rolling, spins on the spot
  switch (mode) {
    case 'marking':
      label = `Marking ${x.marking!.kind === 'stairs' ? 'stairs' : x.marking!.kind === 'door' ? 'doorway' : 'a point to check'} · ${x.marking!.step}/${x.marking!.total}`;
      chips = vr ? [c('place', 'Trigger'), c('undo', 'B'), c('cancel', 'Grip'), c('no snap', 'Off-hand grip')]
        : [c('place', 'Click'), c('centre', 'Space'), c('no snap', 'Shift'), c('undo', 'Ctrl', 'Z'), c('cancel', 'Esc')];
      break;
    case 'editing':
      label = 'Editing marks';
      chips = vr ? [c('drag a point', 'Trigger'), c('finish', 'A'), c('cancel', 'Grip')]
        : [c('drag a point', 'Drag'), c('rail side', 'Click'), c('done', 'Enter')];
      break;
    case 'grabbing':
      label = 'Moving object';
      chips = vr ? [c('drop', 'Release'), c('turn', 'Twist'), c('delete', 'Hold still')]
        : [c('drop', 'Click'), c('turn', 'R'), c('cancel', 'Esc')];
      break;
    case 'selected':
      label = vr ? 'Pointing at an object' : 'Object selected';
      chips = vr ? [c('move', 'Trigger'), c('delete', 'Hold A'), c('reset', 'Grip')]   // the three a headset needs on an object; undo stays on the stick click
        : [c('grab', 'G'), c('remove', 'X'), c('put back', 'Z'), c('undo', 'Ctrl', 'Z'), c('move / turn', 'T', 'R')];
      break;
    case 'inspect':
      label = 'Inspecting';
      chips = vr ? [c('menu', 'Click stick')] : [c('previous', '←'), c('next', '→'), c('leave', 'Esc')];
      break;
    case 'route':
      label = 'Following route';
      chips = vr ? [c('menu', 'Click stick'), c('doorway', 'X'), c('stairs', 'Y')]
        : [c('look', 'Mouse'), c('take over', 'W', 'A', 'S', 'D'), c('mark', 'M'), c('all keys', 'F1')];
      break;
    case 'fly':
      label = 'Fly · spectator · walker stays put';
      chips = [c('fly', 'W', 'A', 'S', 'D'), c('down / up', 'Q', 'E'), c('fast', 'Shift'), c('look', 'Mouse'), c('back', 'F')];
      break;
    case 'explore':
      label = 'Looking around · walker parked';
      chips = [c('move', 'W', 'A', 'S', 'D'), c('look', 'Mouse'), c('scroll', 'Wheel'), c('walk again', '2'), c('fly', 'F')];
      break;
    default:   // free walk
      label = chair ? 'Driving' : 'Walking';
      chips = vr ? (x.mounted ? [c('walk', 'Stick ↑↓'), c('turn', 'Stick ←→'), c('menu', 'Click stick')]
          : [c('walk', 'Left stick'), c('turn', 'Right stick'), c('menu', 'Click stick')])   // three rows read from the controller; X / Y still mark
        : x.locked ? [c('look', 'Mouse'), ...wasd, c('act at dot', 'Click'), c('unlock', 'Esc')].slice(0, MAX_CHIPS)
        : chair ? [...wasd, c('look', 'Mouse'), c('mark', 'M', '1/2')]
        : x.mismatch ? [c('walker ≠ view', 'C'), ...wasd, c('look', 'Mouse'), c('mark', 'M', '1/2')]   // the amber arrow is on: C turns the walker to face the view
        : [...wasd, c('look', 'Mouse'), c('recenter', 'C'), c('mark', 'M', '1/2')];
  }
  return { mode, label, tone: TONE[mode], chips: chips.slice(0, vr ? VR_CHIPS : MAX_CHIPS) };
}

/** The strip card on the controller: the label, then one row per chip (key, action) so each reads at arm's length. */
export function hintRows(h: Hints): { label: string; rows: { key: string; text: string }[] } {
  return { label: h.label, rows: h.chips.map(k => ({ key: k.keys.join('+'), text: k.text })) };
}

/** The same hint as plain lines, for the VR strip card: the label, then the chips on one line. */
export function hintLines(h: Hints): string[] {
  return [h.label, h.chips.map(k => `${k.keys.join('+')} ${k.text}`).join(' · ')];
}

/** Status pills: persona, view and mode, plus the marking step first; the same words on desktop and in the headset. */
export interface Pill { text: string; tone: Tone; go?: 'view' | 'compare' }   // go: what clicking the pill jumps to
export function statusPills(x: HintCtx & { thirdPerson: boolean; personaLabel: string; proposed: boolean | null }): Pill[] {
  const mode = hintMode(x);
  const pills: Pill[] = [{ text: x.personaLabel, tone: 'view', go: 'view' }, { text: x.thirdPerson ? 'Third person' : 'First person', tone: 'view', go: 'view' }];
  pills.push({ text: x.nav === 'auto' ? 'Route' : x.nav === 'fly' ? 'Fly · noclip' : x.parked && x.device === 'desktop' ? 'Look around' : 'Walk', tone: x.nav === 'fly' ? 'spectate' : x.parked && x.device === 'desktop' ? 'view' : 'move' });
  if (x.proposed !== null) pills.push({ text: x.proposed ? 'Proposed' : 'Original', tone: 'view', go: 'compare' });
  if (mode === 'marking' || mode === 'editing') pills.unshift({ text: controlHints(x).label, tone: 'mark' });
  return pills;
}

// VR: a menu as a ring around one controller. There are two (xr.ts): the view ring on the off hand (how the room looks)
// and the action ring on the wand hand (what you do to it). Hold that hand's stick click (MENU_HOLD_S) and the ring opens
// just above the controller, facing you; tilt the stick into a slice and let go to choose it; let go with the stick
// centred to close. A short click is that hand's undo or redo (xr.ts).
// A slice with a ▸ holds a second ring: rest on it for OPEN_DWELL_S (a bar fills along its edge) or let go on it, and the
// ring turns to its items, with "Back" at the bottom. After letting go on one the ring stays open on its own: tilt and
// click to choose, click in the middle to close, or B.
// Drawn as glass (glass() below, the arc cards in xr.ts too): a see-through tinted ground with a light sheen from the top
// and a hairline rim, slices told apart by a step in tone, one accent for the slice you are on (green; amber only for
// danger), a line icon over a short label, sentence case, two type sizes.
import * as THREE from 'three';
import { MENU_HOLD_S, pulse } from './controls.ts';
import type { XrButton } from './xr.ts';

/** a slice: a button, or (with items) a second ring. short(): the slice's own word or two; text() goes in the hub */
export interface RingItem extends XrButton { short?(): string; items?(): RingItem[]; icon?: string }

/** how far the stick must lean before a slice counts, and how long it rests on a ▸ slice (or Back) before the ring turns */
export const STICK_DEAD = 0.45, OPEN_DWELL_S = 0.7;

/** The slice the stick points at, of n round the ring, slice 0 straight up and the rest clockwise; -1 near the centre.
 *  WebXR's thumbstick y is positive pulled back (down). */
export function sliceAt(x: number, y: number, n: number): number {
  if (n <= 0 || Math.hypot(x, y) < STICK_DEAD) return -1;
  const a = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI), span = 2 * Math.PI / n;
  return Math.floor((a + span / 2) / span) % n;
}

/** A second ring's slices: its items, then Back, which lands at the bottom when there is an odd count (Back is the last
 *  slice clockwise, so it sits just left of straight down otherwise). */
export function subPage<T>(items: T[], back: T): T[] { return [...items, back]; }

/** the slice's word or two: short() if it has one, else the title up to a colon ("Vision: Cataract" -> "Vision") */
export const shortOf = (b: RingItem) => b.short?.() ?? b.text()[0].split(':')[0];

export type RadialEvent = 'tap' | 'open' | 'press' | 'turn' | 'close' | null;

const R = 0.12, PX = 1024;   // ring radius (m) and canvas size
const INK = '#f2f7fb', INK2 = '#aab8c5', ACCENT = '#2fbf71', AMBER = '#e8a33d', ON = '#4fe08f';
const GROUND = ['rgba(34,48,64,0.5)', 'rgba(24,36,50,0.5)'], HUB = 'rgba(12,18,26,0.68)';

/** Glass over the room: shape() traced, filled with a see-through tint, a sheen from the top fading out by the middle
 *  (top..bottom are the shape's canvas extent), and a hairline rim. The text drawn after gets a soft dark shadow so it
 *  reads over a bright scan. */
export function glass(c: CanvasRenderingContext2D, shape: () => void, tint: string, top: number, bottom: number, rim = 'rgba(255,255,255,0.32)', rimW = 3) {
  shape(); c.fillStyle = tint; c.fill();
  const g = c.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, 'rgba(255,255,255,0.2)'); g.addColorStop(0.5, 'rgba(255,255,255,0.04)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  shape(); c.fillStyle = g; c.fill();
  shape(); c.strokeStyle = rim; c.lineWidth = rimW; c.stroke();
}
/** a soft shadow under text on glass (call before fillText; shadowOff() after) */
export const textShadow = (c: CanvasRenderingContext2D) => { c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 10; c.shadowOffsetY = 2; };
export const shadowOff = (c: CanvasRenderingContext2D) => { c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0; };

// line icons on a 24-unit square (SVG path data, stroked)
export const ICONS: Record<string, string> = {
  danger: 'M12 3 L22 20 H2 Z M12 9 V14 M12 17 V17.4',
  night: 'M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z',
  eye: 'M2 12 C5 6 19 6 22 12 C19 18 5 18 2 12 Z M15 12 A3 3 0 1 1 9 12 A3 3 0 1 1 15 12',
  person: 'M15 6 A3 3 0 1 1 9 6 A3 3 0 1 1 15 6 M5 21 C5 14 19 14 19 21',
  paths: 'M4 19 C8 11 14 17 20 5 M4 19 V19.4 M20 5 V5.4',
  highlight: 'M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M5 5 L7 7 M17 17 L19 19 M5 19 L7 17 M17 7 L19 5 M16 12 A4 4 0 1 1 8 12 A4 4 0 1 1 16 12',
  fan: 'M12 21 L4 7 M12 21 L9 4 M12 21 L15 4 M12 21 L20 7',
  safer: 'M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z M8.5 12 L11 14.5 L15.5 9.5',
  compare: 'M3 4 H21 V20 H3 Z M12 4 V20',
  imagine: 'M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z',
  mark: 'M12 22 C12 22 19 15 19 9.5 A7 7 0 0 0 5 9.5 C5 15 12 22 12 22 Z M14.5 9.5 A2.5 2.5 0 1 1 9.5 9.5 A2.5 2.5 0 1 1 14.5 9.5',
  panel: 'M3 5 H21 V17 H3 Z M8 21 H16 M12 17 V21',
  back: 'M15 5 L8 12 L15 19',
  door: 'M6 21 V3 H18 V21 M3 21 H21 M14 12 V12.4',
  stairs: 'M3 20 H8 V15 H13 V10 H18 V5 H21',
  edit: 'M4 20 L5 15 L16 4 L20 8 L9 19 Z',
  walk: 'M13 4 A1.5 1.5 0 1 1 13 4.1 M11 8 L8 13 L11 14 L10 21 M11 8 L15 11 L18 10 M11 14 L15 21',
  month: 'M3 5 H21 V21 H3 Z M3 10 H21 M8 3 V7 M16 3 V7',
  hide: 'M3 3 L21 21 M10.5 6.2 C16 5.6 20 9 22 12 C21.3 13.3 20.3 14.5 19.2 15.4 M6.3 7.4 C4.5 8.6 3 10.2 2 12 C5 18 13 19.5 17.7 16.6',
  walker: 'M7 21 V8 H17 V21 M7 13 H17 M12 3 A2 2 0 1 1 12 3.1',
};
const PATHS = new Map<string, Path2D>();
const path = (k: string) => { let p = PATHS.get(k); if (!p) { p = new Path2D(ICONS[k] ?? ''); PATHS.set(k, p); } return p; };

export function radialMenu(scene: THREE.Scene, name: string) {
  let open = false, latched = false, fresh = false, skip = -2, held = 0, wasDown = false, hot = -1, dwell = 0, armed = true, key = '';
  let stack: { title: string; items: () => RingItem[] }[] = [];
  const back: RingItem = { text: () => ['Back', 'to the first ring'], short: () => 'Back', press: () => {}, icon: 'back' };
  const page = () => { const top = stack.at(-1); if (!top) return []; const its = top.items(); return stack.length > 1 ? subPage(its, back) : its; };
  const cv = document.createElement('canvas'); cv.width = cv.height = PX;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * R * 1.25, 2 * R * 1.25),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  mesh.name = name; mesh.renderOrder = 5; mesh.visible = false;
  scene.add(mesh);

  function draw(items: RingItem[]) {
    const fill = hot >= 0 && (items[hot] === back || items[hot]?.items) ? Math.min(1, dwell / OPEN_DWELL_S) : 0;
    const k = `${stack.length}|${hot}|${fill.toFixed(2)}|` + items.map(b => b.text().join('/') + (b.on?.() ? '*' : '') + (b.tone?.() ?? '')).join('|');
    if (k === key) return;
    key = k;
    const c = cv.getContext('2d')!, C = PX / 2, outer = PX * 0.48, inner = PX * 0.21, n = items.length, span = 2 * Math.PI / n;
    c.clearRect(0, 0, PX, PX);
    items.forEach((b, i) => {   // slice i is centred on i * span clockwise from straight up (canvas angle -pi/2)
      const a0 = -Math.PI / 2 + (i - 0.5) * span, a1 = a0 + span, isHot = i === hot, danger = b.icon === 'danger';
      const slice = () => { c.beginPath(); c.arc(C, C, outer - 2, a0 + 0.008, a1 - 0.008); c.arc(C, C, inner + 2, a1 - 0.008, a0 + 0.008, true); c.closePath(); };
      glass(c, slice, isHot ? (danger ? 'rgba(232,163,61,0.88)' : 'rgba(47,191,113,0.86)') : GROUND[i % 2], C - outer, C + outer,
        isHot ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)', isHot ? 4 : 2);   // alternate tone steps, a hairline gap between
      if (b.on?.() && !isHot) {   // switched on: a green band along the slice's outer edge
        c.beginPath(); c.arc(C, C, outer, a0 + 0.04, a1 - 0.04); c.arc(C, C, outer - 18, a1 - 0.04, a0 + 0.04, true); c.closePath();
        c.fillStyle = ON; c.fill();
      }
      if (isHot && fill > 0) {   // resting on a ▸ slice or Back: a bar fills along the edge, then the ring turns
        c.beginPath(); c.arc(C, C, outer, a0 + 0.04, a0 + 0.04 + (span - 0.08) * fill); c.arc(C, C, outer - 18, a0 + 0.04 + (span - 0.08) * fill, a0 + 0.04, true); c.closePath();
        c.fillStyle = 'rgba(6,20,12,0.6)'; c.fill();
      }
      const mid = a0 + span / 2, rr = (outer + inner) / 2, x = C + Math.cos(mid) * rr, y = C + Math.sin(mid) * rr;
      const ink = isHot ? '#06140c' : b.tone?.() === 'busy' ? AMBER : danger ? '#ffd29a' : INK;
      if (b.icon) {
        c.save(); c.translate(x - 36, y - 92); c.scale(3, 3);
        c.strokeStyle = ink; c.lineWidth = 1.7; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(path(b.icon)); c.restore();
      }
      const w = Math.min(2 * rr * Math.sin(span / 2) * 0.9, outer - inner + 30), label = shortOf(b) + (b.items ? ' ›' : '');
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = ink;
      c.font = `600 ${n > 6 ? 38 : 42}px system-ui, sans-serif`;
      if (!isHot) textShadow(c);
      wrap(c, label, x, y + (b.icon ? 26 : 0), w, n > 6 ? 40 : 44);
      shadowOff(c);
    });
    glass(c, () => { c.beginPath(); c.arc(C, C, inner * 0.94, 0, 2 * Math.PI); }, HUB, C - inner, C + inner);   // the hub says what you are on
    textShadow(c);
    const sel = hot >= 0 ? items[hot].text() : [stack.at(-1)?.title ?? '', latched ? 'tilt, then click · centre click closes' : 'tilt to choose · let go to close'];
    c.fillStyle = INK; c.font = '600 42px system-ui, sans-serif'; wrap(c, sel[0], C, C - 40, inner * 1.62, 46);
    c.fillStyle = INK2; c.font = '400 30px system-ui, sans-serif'; wrap(c, sel[1] ?? '', C, C + 52, inner * 1.62, 34);
    shadowOff(c);
    tex.needsUpdate = true;
  }

  // After the ring turns it stays open on its own (latched): the hold that turned it is let go of without choosing, and the
  // slice still under the stick is skipped until the stick moves, so the new page's slice there is never picked by accident
  function turn(to: RingItem | null, pad?: Gamepad) {   // into a second ring, or back to the first
    if (to) stack.push({ title: shortOf(to), items: to.items! }); else stack.pop();
    hot = -1; dwell = 0; armed = false; latched = true; fresh = false;
    skip = sliceAt(pad?.axes[2] ?? 0, pad?.axes[3] ?? 0, page().length);
    pulse(pad, 0.4, 25);
  }
  /** let go (or a latched click) with slice i lit */
  function choose(items: RingItem[], i: number, pad?: Gamepad): RadialEvent {
    const b = i >= 0 ? items[i] : null;
    if (b === back) { turn(null, pad); return 'turn'; }
    if (b?.items) { turn(b, pad); return 'turn'; }
    close();
    if (b) { b.press(); pulse(pad, 0.5, 40); return 'press'; }
    return 'close';
  }

  const at = new THREE.Vector3(), up = new THREE.Vector3(0, 0, 1);
  /** Per frame, from xr.ts: this hand's pad and controller, the head (floor frame), whether the hand is busy with something
   *  else, and the first ring's items. Returns what happened: 'tap' is a short click (undo or redo), the others say the
   *  ring took the stick. */
  function step(dt: number, pad: Gamepad | undefined, ctl: THREE.Object3D | undefined, head: THREE.Vector3, blocked: boolean, root: RingItem[], title: string): RadialEvent {
    const down = !!pad?.buttons[3]?.pressed && !!ctl && !blocked;
    let ev: RadialEvent = null;
    if (blocked && open) { close(); ev = 'close'; }
    else if (!open) {
      if (down) {
        held += dt;
        if (held >= MENU_HOLD_S) { open = true; latched = false; stack = [{ title, items: () => root }]; hot = -1; dwell = 0; armed = true; pulse(pad, 0.3, 30); ev = 'open'; }
      } else {
        if (wasDown && held < MENU_HOLD_S && !blocked) ev = 'tap';
        held = 0;
      }
    } else {
      const items = page(), raw = sliceAt(pad?.axes[2] ?? 0, pad?.axes[3] ?? 0, items.length), i = raw === skip ? -1 : raw;
      if (raw !== skip) skip = -2;
      // Letting go of the stick click lifts the thumb off the stick, so the axes usually re-centre in the very frame the
      // click releases. Choose the slice that was lit coming into this frame, not the one the centred stick now reads:
      // a stick deliberately centred for a frame before the release still leaves lit = -1 here, and so still closes.
      const lit = hot;
      if (i !== hot) { hot = i; dwell = 0; armed = true; if (i >= 0) pulse(pad, 0.15, 12); }
      const deeper = hot >= 0 && (items[hot] === back || !!items[hot].items);
      if (deeper && armed && (dwell += dt) >= OPEN_DWELL_S) { turn(items[hot] === back ? null : items[hot], pad); ev = 'turn'; }
      else if (down && !wasDown) fresh = true;   // a new click while it stays open: its release chooses
      else if (!down && wasDown) { held = 0; if (!latched || fresh) ev = choose(items, lit, pad); fresh = false; }
    }
    wasDown = down;
    mesh.visible = open;
    if (open && ctl) {   // just above the controller, turned to face the eyes and kept upright
      ctl.updateWorldMatrix(true, false); ctl.getWorldPosition(at);
      mesh.position.copy(at).setZ(at.z + 0.1);
      mesh.up.copy(up); mesh.lookAt(head);
      draw(page());
    }
    return ev;
  }

  function close() { open = false; latched = false; fresh = false; skip = -2; held = 0; hot = -1; dwell = 0; stack = []; mesh.visible = false; key = ''; }
  return {
    step, close, isOpen: () => open,
    /** scripted checks: whether it is open, how deep, its labels, the lit slice, where it is (floor frame) */
    state: () => ({ open, latched, depth: stack.length, hot, labels: page().map(shortOf), titles: page().map(b => b.text()[0]), on: page().map(b => !!b.on?.()),
      at: open ? mesh.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)) : null }),
    dispose() { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); tex.dispose(); },
  };
}

/** centred text in at most two lines inside width w, around (x, y) */
function wrap(c: CanvasRenderingContext2D, s: string, x: number, y: number, w: number, lh: number) {
  const words = s.split(' '), lines: string[] = [];
  for (const wd of words) { const l = lines.at(-1); if (l != null && c.measureText(l + ' ' + wd).width <= w) lines[lines.length - 1] = l + ' ' + wd; else lines.push(wd); }
  const shown = lines.slice(0, 2);
  if (lines.length > 2) shown[1] += '…';
  shown.forEach((l, i) => c.fillText(l, x, y + (i - (shown.length - 1) / 2) * lh, w));
}

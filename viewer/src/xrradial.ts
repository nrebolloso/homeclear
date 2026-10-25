// VR: the menu as a ring on the wand hand. Hold the wand stick click (MENU_HOLD_S) and the ring opens around the
// controller, facing you; tilt the stick into a slice and let go of the click to press it; let go with the stick centred to
// close without pressing. A short click is still the wand's undo (xr.ts). The story buttons are the first page; "More"
// holds the rest: rest the stick on it for MORE_DWELL_S and the page turns ("Back" turns it back).
// Drawn after the house rules of the Taste skill: one flat ground, slices told apart by a step in tone (no lines, glows or
// gradients), one accent for the slice you are on, sentence case, two type sizes.
import * as THREE from 'three';
import { MENU_HOLD_S, pulse } from './controls.ts';
import type { XrButton } from './xr.ts';

/** how far the stick must lean before a slice counts, and how long it rests on "More" or "Back" before the page turns */
export const STICK_DEAD = 0.45, MORE_DWELL_S = 0.5;

/** The slice the stick points at, of n round the ring, slice 0 straight up and the rest clockwise; -1 near the centre.
 *  WebXR's thumbstick y is positive pulled back (down). */
export function sliceAt(x: number, y: number, n: number): number {
  if (n <= 0 || Math.hypot(x, y) < STICK_DEAD) return -1;
  const a = (Math.atan2(x, -y) + 2 * Math.PI) % (2 * Math.PI), span = 2 * Math.PI / n;
  return Math.floor((a + span / 2) / span) % n;
}

/** The ring's pages: the first `primary` buttons plus "More" when there are others; then the rest plus "Back". */
export function ringPages<T>(items: T[], primary: number, more: T, back: T): T[][] {
  const front = Math.min(items.length, Math.max(0, primary));
  return front < items.length ? [[...items.slice(0, front), more], [...items.slice(front), back]] : [items.slice()];
}

export type RadialEvent = 'tap' | 'open' | 'press' | 'close' | null;

const R = 0.12, PX = 1024;   // ring radius (m) and canvas size
const INK = '#f2f7fb', INK2 = '#b9c6d2', ACCENT = '#2fbf71', ON = '#9be8b0';

export function radialMenu(scene: THREE.Scene, actions: XrButton[], primary: number) {
  let page = 0, open = false, held = 0, wasDown = false, hot = -1, dwell = 0, key = '';
  const more: XrButton = { text: () => ['More', 'everything else'], press: () => {} };
  const back: XrButton = { text: () => ['Back', 'the story'], press: () => {} };
  const pages = ringPages(actions, primary, more, back);
  const cv = document.createElement('canvas'); cv.width = cv.height = PX;
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * R * 1.25, 2 * R * 1.25),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  mesh.name = 'xr-ring-menu'; mesh.renderOrder = 5; mesh.visible = false;
  scene.add(mesh);

  function draw() {
    const items = pages[page], k = `${page}|${hot}|` + items.map(b => b.text().join('/') + (b.on?.() ? '*' : '')).join('|');
    if (k === key) return;
    key = k;
    const c = cv.getContext('2d')!, C = PX / 2, outer = PX * 0.48, inner = PX * 0.2, n = items.length, span = 2 * Math.PI / n;
    c.clearRect(0, 0, PX, PX);
    items.forEach((b, i) => {   // slice i is centred on i * span clockwise from straight up (canvas angle -pi/2)
      const a0 = -Math.PI / 2 + (i - 0.5) * span, a1 = a0 + span;
      c.beginPath(); c.arc(C, C, outer, a0, a1); c.arc(C, C, inner, a1, a0, true); c.closePath();
      c.fillStyle = i === hot ? ACCENT : i % 2 ? 'rgba(22,30,40,0.94)' : 'rgba(30,40,52,0.94)';   // alternate tone steps, no dividers
      c.fill();
      const mid = a0 + span / 2, rr = (outer + inner) / 2, x = C + Math.cos(mid) * rr, y = C + Math.sin(mid) * rr;
      const words = b.text()[0].split(':')[0], w = 2 * rr * Math.sin(span / 2) * 0.92;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `600 ${n > 6 ? 40 : 46}px system-ui, sans-serif`;
      c.fillStyle = i === hot ? '#06140c' : b.on?.() ? ON : INK;
      wrap(c, words, x, y, Math.min(w, outer - inner + 40), n > 6 ? 44 : 50);
    });
    c.beginPath(); c.arc(C, C, inner * 0.94, 0, 2 * Math.PI); c.fillStyle = 'rgba(10,14,20,0.96)'; c.fill();   // the hub says what you are on
    const sel = hot >= 0 ? items[hot].text() : ['Tilt to choose', 'let go in the middle to close'];
    c.fillStyle = INK; c.font = '600 44px system-ui, sans-serif'; wrap(c, sel[0].split(':')[0], C, C - 34, inner * 1.6, 46);
    c.fillStyle = INK2; c.font = '400 30px system-ui, sans-serif'; wrap(c, sel[1] ?? '', C, C + 48, inner * 1.6, 34);
    tex.needsUpdate = true;
  }

  const at = new THREE.Vector3(), up = new THREE.Vector3();
  /** Per frame, from xr.ts: the wand's pad, its controller and the head (floor frame). Returns what happened this frame;
   *  'tap' is a short click (undo), the others say the ring took the stick. */
  function step(dt: number, pad: Gamepad | undefined, ctl: THREE.Object3D | undefined, head: THREE.Vector3, blocked: boolean): RadialEvent {
    const down = !!pad?.buttons[3]?.pressed && !!ctl && !blocked;
    let ev: RadialEvent = null;
    if (down) {
      held += dt;
      if (!open && held >= MENU_HOLD_S) { open = true; page = 0; hot = -1; dwell = 0; pulse(pad, 0.3, 30); ev = 'open'; }
    }
    if (open && down) {
      const items = pages[page], i = sliceAt(pad!.axes[2] ?? 0, pad!.axes[3] ?? 0, items.length);
      if (i !== hot) { hot = i; dwell = 0; if (i >= 0) pulse(pad, 0.15, 12); }
      const turn = hot >= 0 && (items[hot] === more || items[hot] === back);
      if (turn && (dwell += dt) >= MORE_DWELL_S) { page = items[hot] === more ? 1 : 0; hot = -1; dwell = 0; pulse(pad, 0.4, 25); }
    }
    if (!down && wasDown) {
      if (open) {
        const b = hot >= 0 ? pages[page][hot] : null;
        open = false;
        if (b && b !== more && b !== back) { b.press(); pulse(pad, 0.5, 40); ev = 'press'; } else ev = 'close';
      } else if (!blocked && held < MENU_HOLD_S) ev = 'tap';
      held = 0; hot = -1;
    }
    if (!down) held = 0;
    if (blocked && open) { open = false; hot = -1; ev = 'close'; }
    wasDown = down;
    mesh.visible = open;
    if (open && ctl) {   // just above the controller, turned to face the eyes and kept upright
      ctl.updateWorldMatrix(true, false); ctl.getWorldPosition(at);
      mesh.position.copy(at).setZ(at.z + 0.1);
      up.set(0, 0, 1); mesh.up.copy(up); mesh.lookAt(head);
      draw();
    }
    return ev;
  }

  function close() { open = false; held = 0; hot = -1; wasDown = false; mesh.visible = false; }
  return {
    step, close, isOpen: () => open,
    /** scripted checks: whether it is open, the page's labels, which slice is lit, where it is (floor frame) */
    state: () => ({ open, page, hot, labels: pages[page].map(b => b.text()[0]), at: open ? mesh.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)) : null }),
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

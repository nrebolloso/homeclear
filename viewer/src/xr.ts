// VR (WebXR) for the walker game: the headset is the patient's eyes, 1:1 on the scanned floor. The VR lane owns this file
// (AGENTS.md); main.ts builds an XrHost and calls step() while presenting. Tested with no headset by e2e/xr.ts (Meta's
// IWER, ?emulate=quest2) and on a real Quest nobody wears by e2e/quest-sweep.ts.
// Frames: WebXR's local-floor space is y-up with the floor at y=0; the scene is the +z-up floor frame (frame.ts). The
// camera rides in a rig: +90 deg about x maps XR up (+y) to +z, then a turn about z by yaw - 90 deg points XR forward
// (-z) along yaw.
// Moving: walk for real (1:1). Holding a pinch or trigger on the non-wand hand glides forward where you look, only where
// free walk could stand (walls, furniture and unfilmed floor stop it). Thumbstick movement and snap-turning are disabled.
// Wand (right hand or controller; ?wand=left): point at furniture and hold to drag it (twist the wrist to turn it), hold
// still to delete it; point at filmed floor and release to teleport. A pinch and a trigger are the same WebXR "select".
// Moves go through the host's placement check and re-plan, like a desktop drag.
import * as THREE from 'three';
import { SparkXr } from '@sparkjsdev/spark';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import type { Pose, XY } from './grid.ts';
import { floorHit, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S, DELETE_SHOW_S, DRAG_DEADZONE_M } from './wand.ts';
import { tierAtLoad, xrCfg, type Tier } from './perf.ts';
import { resetHoldProgress } from './resets.ts';
import { card } from './reimagine.ts';

export interface XrItem { proxy: THREE.Object3D; group: THREE.Object3D; outline: THREE.LineSegments }
export interface XrHost {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; params: URLSearchParams;
  /** the walker user; VR writes it every frame (the walker and the live checks follow it) */
  body: { x: number; y: number; yaw: number };
  /** movable objects, in the scene's order, and their current poses */
  items: XrItem[]; names: string[]; poses(): (Pose & { removed?: boolean })[];
  canPlace(k: number, p: Pose): boolean;
  commit(k: number, p: Pose): unknown;
  remove(k: number): unknown;
  /** put every object back where the layout has it (a drag abandoned mid-way) */
  resync(): void;
  /** filmed, free floor inside the grid */
  standable(x: number, y: number): boolean;
  cellM: number;
  /** where to start, or null to stay where the walker user is: a route can start at the scan's edge, where the view across
   *  the room is the slowest to draw (Quest 2, kitchen4: ~60 fps at the edge, ~85 a quarter metre in) */
  startPose(): { x: number; y: number; yaw: number } | null;
  /** performance mode and in-headset labels: on entering and leaving */
  enter(tier: Tier): void; exit(): void;
  /** big buttons on a card that follows you lazily: pressed like furniture is grabbed (point the wand, pinch) */
  buttons?: XrButton[];
  resetObject(k: number): unknown; resetAll(): unknown;
  /** The annotation lane owns marking state; XR owns controller tracking and routes each gesture exactly once. */
  editor?: XrEditor;
  /** A visual comparison is read-only; only the story-card buttons remain interactive. */
  readOnly?(): boolean;
}
export interface XrButton { text(): string[]; press(): unknown; tone?(): 'go' | 'busy' | 'plain' }
export interface XrEditor {
  active(): boolean;
  down(ray: THREE.Ray, rotation: THREE.Quaternion): boolean;
  up(ray: THREE.Ray): void;
  frame(ray: THREE.Ray | null, rotation: THREE.Quaternion | null): number | null;
  buttons(pads: Record<string, Gamepad>, wand: XRHandedness): boolean;
  cancelDrag(): void;
  hint: THREE.Object3D;
}


export async function setupXR(host: XrHost) {
  const { renderer, scene, camera, params, body, items } = host;
  // ?emulate=quest2: IWER replaces navigator.xr with a scripted Quest 2 (head, controllers, hands). Loaded only with the
  // flag, before SparkXr checks support; forceInstall because desktop Chrome has its own (deviceless) navigator.xr.
  const device = params.has('emulate')
    ? await import('iwer').then(({ XRDevice, metaQuest2 }) => { const d = new XRDevice(metaQuest2); d.installRuntime({ forceInstall: true }); return d; })
    : null;
  // Quest Browser renders by itself (performance mode, Quest settings); a desktop browser in VR is streaming over Link
  const tier: Tier = /OculusBrowser|Quest/i.test(navigator.userAgent) || device ? tierAtLoad(location.search, true) : 'link';
  const cfg = xrCfg(location.search, tier);

  const rig = new THREE.Group();
  scene.add(rig);
  const xrRig = { x: 0, y: 0, yaw: 0 };
  const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), UP = new THREE.Vector3(0, 0, 1);
  const placeRig = () => {
    rig.position.set(xrRig.x, xrRig.y, 0);
    rig.quaternion.setFromAxisAngle(UP, xrRig.yaw - Math.PI / 2).multiply(TILT);
  };
  const head = new THREE.Vector3(), headDir = new THREE.Vector3();
  // the user camera, not renderer.xr.getCamera(): before render() that one still holds the raw y-up headset pose
  // without the rig; three writes the camera's rig-local pose after each render, so this is last frame's head, floor frame
  const readHead = () => { camera.getWorldPosition(head); camera.getWorldDirection(headDir); return Math.atan2(headDir.y, headDir.x); };

  // ---------- wand ----------
  const WAND: XRHandedness = params.get('wand') === 'left' ? 'left' : 'right';
  type Ctl = { group: THREE.XRTargetRaySpace; source?: XRInputSource; ray: THREE.Line };
  const wandRay = new THREE.Raycaster(), RED3 = new THREE.Color(0xff3030);
  const tpRing = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 32),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  tpRing.renderOrder = 1; tpRing.visible = false;
  scene.add(tpRing);
  let grab: { k: number; off: XY; start: XY; drag: number; t0: number; yaw0: number; q0: THREE.Quaternion; valid?: Pose } | null = null;
  let aiming = false, hover = -1;
  const pinching = new Set<object>();   // non-wand hands/controllers holding select: glide
  const isWand = (c: Ctl) => c.source?.handedness === WAND;
  const ctls: Ctl[] = [0, 1].map(i => {
    const group = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x66ccff }));
    ray.visible = false;
    group.add(ray); rig.add(group);
    const c: Ctl = { group, ray };
    group.addEventListener('connected', e => { c.source = e.data; });
    group.addEventListener('disconnected', () => { if (isWand(c)) dropWand(); pinching.delete(c); c.source = undefined; });
    group.addEventListener('selectstart', () => (isWand(c) ? wandDown(c) : pinching.add(c)));
    group.addEventListener('selectend', () => (isWand(c) ? wandUp() : pinching.delete(c)));
    return c;
  });
  // tracked hands drawn in the rig like the controllers; models served locally (models/hands/, webxr-input-profiles, MIT)
  const handModels = new XRHandModelFactory().setPath('models/hands/');
  for (const i of [0, 1]) { const hand = renderer.xr.getHand(i); hand.add(handModels.createHandModel(hand, 'mesh')); rig.add(hand); }

  function aim(c: Ctl) {   // the controller's pose is rig-local (reference space): refresh its world matrix through the rig
    c.group.updateWorldMatrix(true, false);
    return wandRay.setFromXRController(c.group), wandRay.ray;
  }
  function wandDown(c: Ctl) {
    if (host.readOnly?.()) { if (btnHover >= 0) btnPressed = btnHover; return; }
    const r = aim(c), q = c.group.getWorldQuaternion(new THREE.Quaternion());
    if (host.editor?.active() && host.editor.down(r, q)) { toolHeld = true; return; }
    if (btnHover >= 0) { btnPressed = btnHover; return; }
    if (host.editor?.down(r, q)) { toolHeld = true; return; }
    if (hover < 0) { aiming = true; return; }
    const f = floorHit(r.origin, r.direction), p = host.poses()[hover], at: XY = f ? [f.x, f.y] : [p.x, p.y];
    grab = { k: hover, off: [p.x - at[0], p.y - at[1]], start: at, drag: 0, t0: performance.now(), yaw0: p.yaw, q0: c.group.getWorldQuaternion(new THREE.Quaternion()) };
  }
  function wandUp() {
    if (toolHeld) { toolHeld = false; const c = ctls.find(isWand); if (c) host.editor?.up(aim(c)); return; }
    if (host.editor?.active()) return;
    if (btnPressed >= 0) { const i = btnPressed; btnPressed = -1; if (btnHover === i) btns[i].b.press(); return; }
    if (grab) { const { k, valid } = grab; grab = null; if (valid) host.commit(k, valid); return; }
    if (aiming && tpRing.visible) { xrRig.x += tpRing.position.x - head.x; xrRig.y += tpRing.position.y - head.y; placeRig(); anchor.set = false; }
    aiming = false; tpRing.visible = false;
  }
  function dropWand() {   // wand lost mid-gesture (hand out of view): put a dragged object back where the layout has it
    if (grab) host.resync();
    btnPressed = -1; grab = null; aiming = false; tpRing.visible = false;
    toolHeld = false; host.editor?.cancelDrag();
  }
  let toolHeld = false;
  function wandStep() {
    const c = ctls.find(isWand);
    const other = ctls.find(o => o.source && !isWand(o)), hint = host.editor?.hint;
    if (hint) {
      if (other && hint.parent !== other.group) other.group.add(hint);
      hint.visible = !!other?.source?.gamepad && !host.editor?.active() && !host.readOnly?.();
    }
    for (const o of ctls) o.ray.visible = o === c;
    tpRing.visible = false;
    let prog = -1;
    if (c) {
      const r = aim(c), f = floorHit(r.origin, r.direction);
      const toolDistance = host.editor?.frame(r, c.group.getWorldQuaternion(new THREE.Quaternion()));
      if (toolDistance != null) {
        hover = -1; btnHover = -1; aiming = false;
        for (const it of items) it.outline.visible = false;
        c.ray.scale.z = toolDistance; return;
      }
      let len = f ? r.origin.distanceTo(f) : 5;
      if (grab) {
        const it = items[grab.k], twist = snapQuarter(twistAngle(grab.q0, c.group.getWorldQuaternion(new THREE.Quaternion())));
        if (f) grab.drag = Math.max(grab.drag, Math.hypot(f.x - grab.start[0], f.y - grab.start[1]));
        if (twist) grab.drag = Math.max(grab.drag, DRAG_DEADZONE_M * 2);   // a turn is an edit too: never a delete
        if (f && grab.drag > DRAG_DEADZONE_M) {
          const p: Pose = { x: f.x + grab.off[0], y: f.y + grab.off[1], yaw: grab.yaw0 - twist };
          if (host.canPlace(grab.k, p)) { it.group.position.set(p.x, p.y, 0); it.group.rotation.z = p.yaw; grab.valid = p; }
        }
        prog = holdProgress((performance.now() - grab.t0) / 1000, grab.drag);
        if (prog >= 1) { const k = grab.k; grab = null; host.remove(k); prog = -1; }
      } else {
        const bh = dash.visible ? wandRay.intersectObjects(btns.map(x => x.mesh))[0] : undefined;   // buttons sit in front of the room
        btnHover = bh ? btns.findIndex(x => x.mesh === bh.object) : -1;
        const poses = host.poses();
        const hit = bh || host.readOnly?.() ? undefined : wandRay.intersectObjects(items.filter((_, k) => !poses[k].removed).map(i => i.proxy))[0];
        hover = hit ? items.findIndex(i => i.proxy === hit.object) : -1;
        if (bh) len = bh.distance; else if (hit) len = hit.distance;
        if (!host.readOnly?.() && !bh && hover < 0 && aiming && f && host.standable(f.x, f.y)) { tpRing.position.set(f.x, f.y, 0.03); tpRing.visible = true; }
      }
      c.ray.scale.z = len;
    } else { hover = -1; btnHover = -1; host.editor?.frame(null, null); }
    items.forEach((it, k) => {   // blue = pointed at, yellow = held, turning red = about to be deleted
      const held = grab?.k === k, m = it.outline.material as THREE.LineBasicMaterial;
      it.outline.visible = held || (!grab && k === hover);
      m.color.setHex(held ? 0xffd84d : 0x66ccff);
      if (held && prog > 0) m.color.lerp(RED3, THREE.MathUtils.clamp((prog * DELETE_HOLD_S - DELETE_SHOW_S) / (DELETE_HOLD_S - DELETE_SHOW_S), 0, 1));
    });
  }

  // ---------- buttons: a card at chest height, ahead and to the left; it stays put while you look around and catches up
  // when you turn past 40 deg or walk off, so it's always one point-and-pinch away. Canvas text on a plane (a mesh, so the
  // wand's ray hits it), drawn over the splats like the other overlays.
  const BW = 0.46, BH = 0.15, GAP = 0.025;   // up to three lines: headline, a plain sentence, a small hint
  const dash = new THREE.Group();
  dash.visible = false;
  scene.add(dash);
  const btns = (host.buttons ?? []).map((b, i) => {
    const cv = document.createElement('canvas');
    cv.width = 768; cv.height = 250;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BW, BH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 3;
    mesh.position.set(0, 0, -i * (BH + GAP));   // stacked downward in the card's frame (z is up)
    mesh.rotation.x = Math.PI / 2;               // the plane's face toward -y; the card's -y looks at you
    dash.add(mesh);
    return { b, mesh, cv, tex, key: '' };
  });
  const TONE = { go: '#2fbf71', busy: '#e0a33a', plain: '#7fa7c9' };
  function drawButtons(hot: number) {
    btns.forEach((x, i) => {
      const lines = x.b.text(), tone = x.b.tone?.() ?? 'plain', key = `${lines.join('|')}|${tone}|${hot === i}`;
      if (key === x.key) return;
      x.key = key;
      const c = x.cv.getContext('2d')!, W = x.cv.width, H = x.cv.height;
      c.clearRect(0, 0, W, H);
      c.fillStyle = 'rgba(14,20,28,0.88)'; c.strokeStyle = TONE[tone]; c.lineWidth = hot === i ? 14 : 6;
      c.beginPath(); c.roundRect(8, 8, W - 16, H - 16, 36); c.fill(); c.stroke();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const rows = [[[64], [0.5]], [[56, 40], [0.38, 0.72]], [[50, 38, 32], [0.27, 0.56, 0.81]]][Math.min(3, lines.length) - 1];
      lines.slice(0, 3).forEach((ln, r) => {
        c.font = `${r ? 400 : 600} ${rows[0][r]}px system-ui, sans-serif`;
        c.fillStyle = r === 0 ? '#f2f7fb' : r === 1 ? '#c6d3de' : TONE[tone];
        c.fillText(ln, W / 2, H * rows[1][r], W - 56);
      });
      x.tex.needsUpdate = true;
    });
  }
  const anchor = { x: 0, y: 0, yaw: 0, set: false };
  function placeDash(yaw: number) {
    const turned = Math.abs(Math.atan2(Math.sin(yaw - anchor.yaw), Math.cos(yaw - anchor.yaw))) > 0.7;
    if (!anchor.set || turned || Math.hypot(head.x - anchor.x, head.y - anchor.y) > 0.6) Object.assign(anchor, { x: head.x, y: head.y, yaw, set: true });
    const a = anchor.yaw + 0.5, d = 0.7;   // 0.7 m out, about 29 deg to the left of where you faced: off the line you look along
    dash.position.set(anchor.x + Math.cos(a) * d, anchor.y + Math.sin(a) * d, Math.max(0.8, head.z - 0.3));   // the top button; the rest stack down
    dash.lookAt(head.x, head.y, head.z);   // three's lookAt points +z at the eyes (tilted back, read square-on); -y faces you after:
    dash.rotateX(-Math.PI / 2);
  }
  let btnHover = -1, btnPressed = -1;

  // Controller shortcuts share the same priority as the wand: annotation gestures consume input before furniture.
  let gripWas = false, aWas = false, bothHeld = 0, resetFired = false, ringN = 0, ringCard: THREE.Sprite | null = null;
  function controllerButtons(dt: number, pads: Record<string, Gamepad>) {
    const wp = pads[WAND], op = pads[WAND === 'left' ? 'right' : 'left'];
    const grip = !!wp?.buttons[1]?.pressed, a = !!wp?.buttons[4]?.pressed, both = grip && !!op?.buttons[1]?.pressed;
    const consumed = host.readOnly?.() || (host.editor?.buttons(pads, WAND) ?? false);
    if (consumed) {
      if (grab) host.resync();
      grab = null; aiming = false;
      if (!host.readOnly?.()) btnPressed = -1;   // comparison mode still needs the card's press/release gesture
    } else {
      if (grip && !gripWas) { const k = grab?.k ?? hover; if (k >= 0) { grab = null; host.resync(); host.resetObject(k); } }
      if (a && !aWas && !grab && hover >= 0) host.remove(hover);
    }
    gripWas = grip; aWas = a;
    bothHeld = both && !consumed ? bothHeld + dt : 0;
    if (consumed && both) resetFired = true;   // cancelling an edit cannot turn into a global reset before both grips are released
    if (!both) resetFired = false;
    const p = resetHoldProgress(bothHeld);
    if (p >= 1 && !resetFired) { resetFired = true; host.resetAll(); }
    const n = both && !consumed && !resetFired ? Math.ceil(p * 5) : 0;
    if (n !== ringN) {
      ringN = n; ringCard?.removeFromParent(); ringCard?.material.dispose(); ringCard = null;
      if (n) { ringCard = card(['Reset everything', '▮'.repeat(n) + '▯'.repeat(5 - n)], '#ffd84d'); scene.add(ringCard); }
    }
    ringCard?.position.copy(head).addScaledVector(headDir, 1).setZ(head.z - 0.15);
  }

  // ---------- per frame ----------
  function step(dt: number) {
    const yaw = readHead();
    const pads: Record<string, Gamepad> = {};
    for (const source of renderer.xr.getSession()?.inputSources ?? []) if (source.gamepad) pads[source.handedness] = source.gamepad;
    if (pinching.size && !host.readOnly?.()) {   // glide forward in sub-steps of at most half a cell, as in free walk
      const v = 0.6 * dt, dx = Math.cos(yaw) * v, dy = Math.sin(yaw) * v, n = Math.max(1, Math.ceil(v / (host.cellM / 2)));
      for (let i = 0; i < n && host.standable(head.x + dx / n, head.y + dy / n); i++) {
        xrRig.x += dx / n; xrRig.y += dy / n; head.x += dx / n; head.y += dy / n;
      }
    }
    placeRig();
    body.x = head.x; body.y = head.y;
    body.yaw += Math.atan2(Math.sin(yaw - body.yaw), Math.cos(yaw - body.yaw)) * Math.min(1, dt * 4);
    controllerButtons(dt, pads);
    dash.visible = btns.length > 0 && !host.editor?.active();
    wandStep();
    if (btns.length) { placeDash(yaw); drawButtons(btnHover); }
  }
  /** Put the head at floor-frame (x, y) looking along yaw by moving the rig: scripted viewpoints on a headset nobody wears. */
  function place(x: number, y: number, yaw: number) {
    const a = yaw - readHead(), c = Math.cos(a), s = Math.sin(a), rx = xrRig.x - head.x, ry = xrRig.y - head.y;
    Object.assign(xrRig, { x: x + c * rx - s * ry, y: y + s * rx + c * ry, yaw: xrRig.yaw + a });   // turn about the head, then move it
    placeRig();
    anchor.set = false;   // the card comes along: a short hop can stay inside the follow thresholds and leave it on the hazard
  }

  new SparkXr({   // adds the Enter VR button; "VR not supported" where WebXR isn't available
    renderer, mode: 'vr', referenceSpaceType: 'local-floor', enableHands: true,
    frameBufferScaleFactor: cfg.scale, fixedFoveation: cfg.foveation,
    onEnterXr: () => {
      { const p = host.startPose(); if (p) Object.assign(body, p); }   // null: stay where the walker user is
      Object.assign(xrRig, { x: body.x, y: body.y, yaw: body.yaw }); placeRig(); rig.add(camera);
      anchor.set = false; dash.visible = btns.length > 0;
      host.enter(tier);
      // a lower refresh gives each frame more time (90 Hz = 11.1 ms, 72 Hz = 13.9 ms); the Quest 2 offers 60-120
      if (cfg.hz) renderer.xr.getSession()?.updateTargetFrameRate?.(cfg.hz).catch(() => {});
    },
    onExitXr: () => {
      camera.removeFromParent(); pinching.clear(); dropWand(); hover = -1; btnHover = -1; dash.visible = false;
      ringCard?.removeFromParent(); ringCard?.material.dispose(); ringCard = null; ringN = 0; bothHeld = 0; gripWas = false; aWas = false;
      for (const it of items) { it.outline.visible = false; (it.outline.material as THREE.LineBasicMaterial).color.setHex(0x66ccff); }
      host.exit();
    },
  });

  const w = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3));
  return {
    tier, device, rig, place, step,
    presenting: () => renderer.xr.isPresenting,
    /** where the XR camera and the user camera in its rig are (floor frame), and what is tracked */
    pose: () => ({ xr: renderer.xr.isPresenting, head: w(renderer.xr.getCamera()), userCam: w(camera), rig: { ...xrRig },
      inputs: [...renderer.xr.getSession()?.inputSources ?? []].map(s => `${s.handedness}:${s.hand ? 'hand' : 'controller'}`), pinching: pinching.size }),
    /** the button card: each button's text and where its centre is (floor frame), for scripted presses */
    buttons: () => btns.map(x => ({ text: x.b.text(), at: dash.visible ? w(x.mesh) : null })),
    /** press a card button as a pinch on it would (scripted checks on a headset nobody wears) */
    press: (i: number) => btns[i]?.b.press(),
    wand: () => ({ hover: hover >= 0 ? host.names[hover] : null, button: btnHover, grab: grab ? host.names[grab.k] : null, aiming, teleport: tpRing.visible,
      drag: grab?.drag, valid: grab?.valid ?? null }),
  };
}

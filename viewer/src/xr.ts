// VR (WebXR) for the walker game: the headset is the patient's eyes, 1:1 on the scanned floor. The VR lane owns this file
// (AGENTS.md); main.ts builds an XrHost and calls step() while presenting. Tested with no headset by e2e/xr.ts (Meta's
// IWER, ?emulate=quest2) and on a real Quest nobody wears by e2e/quest-sweep.ts.
// Frames: WebXR's local-floor space is y-up with the floor at y=0; the scene is the +z-up floor frame (frame.ts). The
// camera rides in a rig: +90 deg about x maps XR up (+y) to +z, then a turn about z by yaw - 90 deg points XR forward
// (-z) along yaw.
// Moving: walk for real (1:1). Holding a pinch or trigger on the non-wand hand glides forward where you look, only where
// free walk could stand (walls, furniture and unfilmed floor stop it). Left stick walks (same checks), right stick snap-turns
// 30 deg about the head; a held left-stick click is the planning shell's menu (frontend-xr.ts), not movement. A wand-stick
// click undoes the last object edit (with the off-hand grip held: redoes).
// Wand (right hand or controller; ?wand=left): point at furniture and hold to drag it (twist the wrist to turn it; the wand
// stick pushes and pulls it along the ray; a dashed ghost and an arrow (xrdrag.ts) show where it came from), hold still to
// delete it (or hold A), grip puts it back; point at filmed floor and release to teleport. A pinch and a trigger are the same WebXR "select".
// Moves go through the host's placement check and re-plan, like a desktop drag.
// Lining the scan up with the real room: ?scale= (size), ?floor= (cm up or down) and ?measure=1 (the wand's height).
import * as THREE from 'three';
import { bindXR } from './xr-session.ts';
import { onThree, own } from './lifetime.ts';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import type { Pose, XY } from './grid.ts';
import { floorHit, rayPlaneHit, pushPull, confirmProgress, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S, DELETE_SHOW_S, DRAG_DEADZONE_M } from './wand.ts';
import { tierAtLoad, xrCfg, type Tier } from './perf.ts';
import { resetHoldProgress } from './resets.ts';
import { card } from './reimagine.ts';
import { pulse } from './controls.ts';
import { stripSprite } from './xrstrip.ts';
import { dragFeedback } from './xrdrag.ts';

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
  /** big buttons on a card on an arc to the left (point the wand, pinch); also listed in the planning panel's Tour tab */
  buttons?: XrButton[];
  /** how many of `buttons` the card shows up front (the demo story); the rest go under "More", with "Back" to return */
  primary?: number;
  /** modes that are on right now ("Night", "Cataract"): a small chip above the controller strip, empty when all is normal */
  status?(): string[];
  /** a two-line glance at the applied fix (toe catches before/after, cost), or null: low in front, never a target */
  stats?(): string[] | null;
  lock?(k: number): boolean; unlock?(k: number): void;
  resetObject(k: number): unknown; resetAll(): unknown;
  /** where the scan had object k (a reset puts it back here): the ghost and arrow after a reset */
  home?(k: number): Pose;
  /** what the controls are for right now (hints.ts): a label and at most three key rows, drawn as the strip on the off-hand controller */
  hints?(): { label: string; rows: { key: string; text: string }[]; tone: string };
  /** undo / redo the last object edit (move, remove, reset); resolves to a line to show, e.g. "Undid: removed rug" */
  history?: { undo(): Promise<string>; redo(): Promise<string> };
  /** The annotation lane owns marking state; XR owns controller tracking and routes each gesture exactly once. */
  editor?: XrEditor;
  /** A visual comparison is read-only; only the planning panel remains interactive. */
  readOnly?(): boolean;
  movement?(): 'all' | 'teleport' | 'physical';
  /** the walker (or wheelchair) at this body pose clears furniture and stays on filmed floor; and how far ahead of the body
   *  its frame's centre is (walker.json legs), the point a mounted snap-turn spins it about */
  walkerFits?(b: { x: number; y: number; yaw: number }): boolean;
  walkerCentre?(): number;
  /** a move was refused (the device ran into furniture, a wall or unfilmed floor): flash it red */
  contact?(): void;
  eyeHeight?(): number | undefined;
  /** The planning shell (frontend-xr.ts) lays a menu over the wand: it can swallow a trigger press, freeze locomotion while
   *  its menu is open, drive the body along the route, and hears which furniture the wand points at. */
  shell?: XrShell;
}
export interface XrShell {
  activate(controller: THREE.XRTargetRaySpace): boolean; release(controller: THREE.XRTargetRaySpace): boolean;
  open(): boolean; follow(dt: number): boolean; hover(k: number): void;
}
/** `on`: a mode that stays on once pressed (drawn filled, with an ON badge) */
export interface XrButton { text(): string[]; press(): unknown; tone?(): 'go' | 'busy' | 'plain'; on?(): boolean }
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
  const device = (window as any).__xrEmulator ?? (params.has('emulate')
    ? await import('iwer').then(({ XRDevice, metaQuest2 }) => { const d = new XRDevice(metaQuest2); d.installRuntime({ forceInstall: true }); return d; })
    : null);
  if (device) (window as any).__xrEmulator = device;
  // Quest Browser renders by itself (performance mode, Quest settings); a desktop browser in VR is streaming over Link
  const tier: Tier = /OculusBrowser|Quest/i.test(navigator.userAgent) || device ? tierAtLoad(location.search, true) : 'link';
  const cfg = xrCfg(location.search, tier);

  const rig = new THREE.Group();
  scene.add(rig);
  // ?scale=1.1 shows the home 10% bigger, to try a scale against the real rooms before re-exporting with it (stage 4's
  // scale.manual_factor). Shrinking the rig shrinks you, your steps and the controllers in it; everything works in world
  // units, so moving and turning are unchanged. Only the scene's look and your eye height move; its metres don't.
  const worldScale = Number(params.get('scale')) || 1;
  rig.scale.setScalar(1 / worldScale);
  // ?floor=3 lifts the scan's floor 3 cm against the headset's (negative lowers it), for a scan whose floor sits off the
  // real one; check with ?measure=1 (a controller resting on the real floor should rest on the scan's)
  const floorLift = (Number(params.get('floor')) || 0) / 100;
  const xrRig = { x: 0, y: 0, yaw: 0 }; let lastSpawn = { ...xrRig }, pendingSpawn: { x: number; y: number; yaw: number } | null = null;
  const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), UP = new THREE.Vector3(0, 0, 1);
  const placeRig = () => {
    rig.position.set(xrRig.x, xrRig.y, (host.eyeHeight?.() == null ? 0 : Math.max(0, host.eyeHeight()! - camera.position.y)) - floorLift);
    rig.quaternion.setFromAxisAngle(UP, xrRig.yaw - Math.PI / 2).multiply(TILT);
  };
  const head = new THREE.Vector3(), headDir = new THREE.Vector3();
  // the user camera, not renderer.xr.getCamera(): before render() that one still holds the raw y-up headset pose
  // without the rig; three writes the camera's rig-local pose after each render, so this is last frame's head, floor frame
  const readHead = () => { camera.getWorldPosition(head); camera.getWorldDirection(headDir); return Math.atan2(headDir.y, headDir.x); };

  // ---------- wand ----------
  const WAND: XRHandedness = params.get('wand') === 'left' ? 'left' : 'right';
  // ?mount=left: that controller is fixed on the walker (VR_WALKER_MOUNT.md; no room to walk). Its stick drives: up/down
  // walks along the walker's heading, left/right snap-turns 30 deg; the virtual walker points where the real one does.
  // The strap (or cup holder) holds it at any angle and anywhere on the frame, so on entering VR (person standing centred
  // behind the walker, facing its way) the line-up takes which controller axis lies most level, its yaw offset from the
  // head, and where it sits in the walker's frame; from then on the virtual walker is where the real one is, wherever you
  // stand. The "Line up the walker" button retakes it. Its trigger is ignored.
  const MOUNT: XRHandedness | null = params.get('mount') === 'left' ? 'left' : params.get('mount') === 'right' ? 'right' : null;
  let mountOffset: number | null = null, mountAxis: THREE.Vector3 | null = null, mountAt: [number, number] | null = null;
  const rayYaw = new THREE.Vector3(), mountPos = new THREE.Vector3();
  const unmount = () => { mountOffset = null; mountAxis = null; mountAt = null; };
  type Ctl = { group: THREE.XRTargetRaySpace; source?: XRInputSource; ray: THREE.Line };
  const wandRay = new THREE.Raycaster(), RED3 = new THREE.Color(0xff3030);
  const tpRing = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 32),
    new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  tpRing.renderOrder = 1; tpRing.visible = false;
  scene.add(tpRing);
  // planeZ: the height of the plane the ray drags along (where it first hit the object, so a far or low-aimed ray doesn't jump);
  // push: metres added along the ray by the wand stick; from: the pose it was grabbed at (the arrow's tail)
  let grab: { k: number; off: XY; start: XY; drag: number; t0: number; yaw0: number; q0: THREE.Quaternion; planeZ: number; push: number; from: Pose; valid?: Pose; blocked?: boolean } | null = null;
  const fb = dragFeedback(scene, items, card);
  let hoverHit: THREE.Vector3 | null = null, wandStickY = 0;
  const ground = (o: THREE.Vector3, d: THREE.Vector3, z: number) => (z > 0.02 ? rayPlaneHit(o, d, z) : null) ?? floorHit(o, d);
  const VERBS = ['drag · hold still to delete', 'hold A delete · grip put back'];
  let aiming = false, hover = -1;
  let snapReady = true;   // one 30 deg turn per flick of the right stick
  const pinching = new Set<object>();   // non-wand hands/controllers holding select: glide
  const isWand = (c: Ctl) => c.source?.handedness === WAND;
  const isMount = (c: Ctl) => !!MOUNT && c.source?.handedness === MOUNT && !c.source?.hand;   // a tracked hand isn't strapped on
  const ctls: Ctl[] = [0, 1].map(i => {
    const group = renderer.xr.getController(i);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x66ccff }));
    ray.visible = false;
    group.add(ray); rig.add(group);
    const c: Ctl = { group, ray, source: [...renderer.xr.getSession()?.inputSources ?? []][i] };
    own(() => { ray.removeFromParent(); ray.geometry.dispose(); (ray.material as THREE.Material).dispose(); group.removeFromParent(); });
    onThree(group, 'connected', e => { c.source = e.data; });
    onThree(group, 'disconnected', () => { if (isWand(c)) dropWand(); pinching.delete(c); c.source = undefined; });
    onThree(group, 'selectstart', () => { if (host.shell?.activate(group)) return; if (isMount(c)) return; isWand(c) ? wandDown(c) : pinching.add(c); });
    onThree(group, 'selectend', () => { if (host.shell?.release(group)) return; isWand(c) ? wandUp() : pinching.delete(c); });
    return c;
  });
  // tracked hands drawn in the rig like the controllers; models served locally (models/hands/, webxr-input-profiles, MIT)
  const handModels = new XRHandModelFactory().setPath('models/hands/');
  for (const i of [0, 1]) { const hand = renderer.xr.getHand(i); if (!hand.children.length) hand.add(handModels.createHandModel(hand, 'mesh')); own(() => hand.removeFromParent()); rig.add(hand); }

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
    const planeZ = Math.max(0, hoverHit?.z ?? 0), f = ground(r.origin, r.direction, planeZ), p = host.poses()[hover], at: XY = f ? [f.x, f.y] : [p.x, p.y];
    if (host.lock && !host.lock(hover)) return;
    grab = { k: hover, off: [p.x - at[0], p.y - at[1]], start: at, drag: 0, t0: performance.now(), yaw0: p.yaw, q0: c.group.getWorldQuaternion(new THREE.Quaternion()), planeZ, push: 0, from: { x: p.x, y: p.y, yaw: p.yaw } };
  }
  function wandUp() {
    if (toolHeld) { toolHeld = false; const c = ctls.find(isWand); if (c) host.editor?.up(aim(c)); return; }
    if (host.editor?.active()) return;
    if (btnPressed >= 0) { const i = btnPressed; btnPressed = -1; if (btnHover === i) btns[i].b.press(); return; }
    if (grab) {
      const { k, valid, blocked } = grab; grab = null;
      if (valid) Promise.resolve(host.commit(k, valid)).finally(() => host.unlock?.(k)); else { if (blocked) host.resync(); host.unlock?.(k); }   // dropped on a collision: back where it was
      return;
    }
    if (aiming && tpRing.visible && host.movement?.() !== 'physical') { xrRig.x += tpRing.position.x - head.x; xrRig.y += tpRing.position.y - head.y; placeRig(); anchor.set = false; }
    aiming = false; tpRing.visible = false;
  }
  function dropWand() {   // wand lost mid-gesture (hand out of view): put a dragged object back where the layout has it
    if (grab) { host.resync(); host.unlock?.(grab.k); }
    btnPressed = -1; grab = null; aiming = false; tpRing.visible = false;
    toolHeld = false; host.editor?.cancelDrag();
  }
  let toolHeld = false;
  // the strip: the current mode and its keys, on the off-hand controller; rebuilt only when the words change
  const STRIP_TONE: Record<string, string> = { move: '#9be8b0', edit: '#7fe7de', mark: '#ffd27a', spectate: '#d8bcff', view: '#a9c8ff' };
  let strip: THREE.Sprite | null = null, stripKey = '';
  function stripStep(other?: Ctl) {
    const h = host.hints?.();
    if (!h || !other?.source?.gamepad || host.readOnly?.() || host.shell?.open()) { if (strip) strip.visible = false; return; }
    const key = h.tone + h.label + h.rows.map(r => `${r.key}|${r.text}`).join('|');
    if (!strip || key !== stripKey) {
      stripKey = key; strip?.removeFromParent(); strip?.material.dispose();
      strip = stripSprite(h.label, h.rows, STRIP_TONE[h.tone] ?? '#e9f6ff'); strip.position.set(0, 0.15, -0.1);   // above the grip, nearer the face
    }
    if (strip.parent !== other.group) other.group.add(strip);
    strip.visible = true;
  }
  // ?measure=1: the wand shows its height above the real floor, to rest it on a real surface (floor, table, fridge top)
  // and see whether the scan's surface sits at the same height
  let ruler: THREE.Sprite | null = null, rulerKey = '';
  function rulerStep(c?: Ctl) {
    if (!params.has('measure') || !c?.source) { if (ruler) ruler.visible = false; return; }
    const m = c.group.position.y, key = `${(m / 0.0254).toFixed(1)} in · ${(m * 100).toFixed(1)} cm`;   // rig-local y-up: the tracked height
    if (!ruler || key !== rulerKey) {
      rulerKey = key; ruler?.removeFromParent(); ruler?.material.dispose();
      ruler = card([key, 'above your floor'], '#ffd27a', undefined, 0.014); ruler.position.set(0, 0.08, -0.05); ruler.renderOrder = 4;
    }
    if (ruler.parent !== c.group) c.group.add(ruler);
    ruler.visible = true;
  }
  function wandStep(dt = 0) {
    const c = ctls.find(isWand);
    rulerStep(c);
    const other = ctls.find(o => o.source && !isWand(o)), hint = host.editor?.hint;
    if (host.hints) { if (hint) hint.visible = false; stripStep(other); }
    else if (hint) {
      if (other && hint.parent !== other.group) other.group.add(hint);
      hint.visible = !!other?.source?.gamepad && !host.editor?.active() && !host.readOnly?.();
    }
    for (const o of ctls) o.ray.visible = o === c;
    tpRing.visible = false;
    let prog = -1;
    if (c) {
      const r = aim(c), f0 = grab ? ground(r.origin, r.direction, grab.planeZ) : floorHit(r.origin, r.direction);
      let f = f0;
      if (grab && f0) {   // the wand stick pushes the object away along the ray (up) or pulls it in (down)
        grab.push = pushPull(grab.push, wandStickY, dt);
        const hd = Math.hypot(r.direction.x, r.direction.y);
        if (grab.push && hd > 0.05) f = new THREE.Vector3(f0.x + r.direction.x / hd * grab.push, f0.y + r.direction.y / hd * grab.push, f0.z);
      }
      const toolDistance = host.editor?.frame(r, c.group.getWorldQuaternion(new THREE.Quaternion()));
      if (toolDistance != null) {
        hover = -1; btnHover = -1; aiming = false; fb.hover(-1, null, []); fb.clearDrag();
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
          // it follows the wand either way; a spot that collides (furniture, a wall, unfilmed floor) turns it red and is never committed
          it.group.position.set(p.x, p.y, 0); it.group.rotation.z = p.yaw;
          const fits = host.canPlace(grab.k, p);
          fb.drag(grab.k, grab.from, p, fits);
          if (fits) grab.valid = p;
          if (!fits && !grab.blocked) pulse(c.source?.gamepad, 0.5, 60);
          grab.blocked = !fits;
        }
        prog = holdProgress((performance.now() - grab.t0) / 1000, grab.drag);
        if (prog >= 1) { const k = grab.k; grab = null; removeWithToast(k, true); prog = -1; }
        fb.hover(-1, null, []);
      } else {
        const bh = dash.visible ? wandRay.intersectObjects(btns.filter(x => x.mesh.visible).map(x => x.mesh))[0] : undefined;   // cards sit in front of the room
        btnHover = bh ? btns.findIndex(x => x.mesh === bh.object) : -1;
        const poses = host.poses();
        const hit = bh || host.readOnly?.() ? undefined : wandRay.intersectObjects(items.filter((_, k) => !poses[k].removed).map(i => i.proxy))[0];
        hover = hit ? items.findIndex(i => i.proxy === hit.object) : -1;
        hoverHit = hit ? hit.point.clone() : null;
        if (bh) len = bh.distance; else if (hit) len = hit.distance;
        fb.clearDrag(); fb.hover(hover, hover >= 0 ? poses[hover] : null, VERBS);
        if (!host.readOnly?.() && host.movement?.() !== 'physical' && !bh && hover < 0 && aiming && f && host.standable(f.x, f.y)) { tpRing.position.set(f.x, f.y, 0.03); tpRing.visible = true; }
      }
      c.ray.scale.z = len;
      if (hover >= 0 && !grab) host.shell?.hover(hover);
    } else { hover = -1; btnHover = -1; fb.hover(-1, null, []); fb.clearDrag(); host.editor?.frame(null, null); }
    items.forEach((it, k) => {   // blue = pointed at, yellow = held, turning red = about to be deleted
      const held = grab?.k === k, m = it.outline.material as THREE.LineBasicMaterial, ap = !held && !grab && aHeld > 0 && !aFired && k === aTarget ? confirmProgress(aHeld) : 0;
      it.outline.visible = held || (!grab && k === hover);
      m.color.setHex(held ? (grab?.blocked ? 0xff2020 : 0xffd84d) : 0x66ccff);   // red = this spot collides
      if (held && prog > 0) m.color.lerp(RED3, THREE.MathUtils.clamp((prog * DELETE_HOLD_S - DELETE_SHOW_S) / (DELETE_HOLD_S - DELETE_SHOW_S), 0, 1));
      else if (ap > 0) m.color.lerp(RED3, ap);   // holding A: fills red, then it goes
    });
  }

  // ---------- buttons: cards on an arc 0.7 m around where you stood, to the left of where you faced. Canvas text on a plane (a
  // mesh, so the wand's ray hits it), drawn over the splats like the other overlays. The demo story is up front
  // (host.primary of the host's buttons); the rest are behind "More". Tap the off-hand grip to hide or show the lot.
  const BW = 0.46, BH = 0.15, GAP = 0.025;   // up to three lines: headline, a plain sentence, a small hint
  const dash = new THREE.Group(); dash.name = 'xr-story-menu';
  dash.visible = false;
  scene.add(dash);
  const lineUp: XrButton = { text: () => ['Line up the walker', 'stand behind it facing its way, then pinch'], tone: () => 'plain', press: unmount };
  const actions: XrButton[] = [...(host.buttons ?? []), ...(MOUNT ? [lineUp] : [])];   // the planning panel's Tour tab lists these too
  const FRONT = Math.min(actions.length, host.primary ?? actions.length);
  let more = false, menuOn = true;
  const moreBtn: XrButton = { text: () => ['More...', actions.slice(FRONT).map(b => b.text()[0].split(':')[0].toLowerCase()).slice(0, 3).join(', ')], tone: () => 'plain', press: () => { more = true; } };
  const hideBtn: XrButton = { text: () => ['Hide this menu', 'tap the off-hand grip to bring it back'], tone: () => 'plain', press: () => { setMenu(false); } };
  const backBtn: XrButton = { text: () => ['Back'], tone: () => 'plain', press: () => { more = false; } };
  const extra = FRONT < actions.length ? [moreBtn, hideBtn, backBtn] : [hideBtn];
  const btns = [...actions, ...extra].map(b => {
    const cv = document.createElement('canvas');
    cv.width = 768; cv.height = 250;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BW, BH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 3;
    mesh.rotation.order = 'ZXY';   // stand it up (x), then turn it to face the middle of the arc (z); placed by placeDash
    dash.add(mesh);
    return { b, mesh, cv, tex, key: '' };
  });
  /** which cards show now: the front story + More, or the rest + Hide + Back */
  function shown(n: number) {
    const b = btns[n].b;
    if (b === moreBtn) return !more && FRONT < actions.length;
    if (b === backBtn) return more;
    if (b === hideBtn) return more || FRONT >= actions.length;
    return more ? n >= FRONT : n < FRONT;
  }
  const TONE = { go: '#2fbf71', busy: '#e0a33a', plain: '#7fa7c9' };
  function drawButtons(hot: number) {
    btns.forEach((x, i) => {
      const lines = x.b.text(), tone = x.b.tone?.() ?? 'plain', on = !!x.b.on?.(), key = `${lines.join('|')}|${tone}|${hot === i}|${on}`;
      if (key === x.key) return;
      x.key = key;
      const c = x.cv.getContext('2d')!, W = x.cv.width, H = x.cv.height;
      c.clearRect(0, 0, W, H);
      c.fillStyle = on ? 'rgba(16,64,44,0.94)' : 'rgba(14,20,28,0.88)'; c.strokeStyle = on ? '#4fe08f' : TONE[tone]; c.lineWidth = hot === i ? 14 : 6;
      c.beginPath(); c.roundRect(8, 8, W - 16, H - 16, 36); c.fill(); c.stroke();
      if (on) {   // a mode that is on stays visible: a filled badge in the corner
        c.fillStyle = '#4fe08f'; c.beginPath(); c.roundRect(W - 150, 24, 114, 54, 27); c.fill();
        c.fillStyle = '#0b2418'; c.font = '700 36px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('ON', W - 93, 52);
      }
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const rows = [[[64], [0.5]], [[56, 40], [0.38, 0.72]], [[50, 38, 32], [0.27, 0.56, 0.81]]][Math.min(3, lines.length) - 1];
      lines.slice(0, 3).forEach((ln, r) => {
        c.font = `${r ? 400 : 600} ${rows[0][r]}px system-ui, sans-serif`;
        c.fillStyle = r === 0 ? '#f2f7fb' : r === 1 ? '#c6d3de' : TONE[tone];
        c.fillText(ln, W / 2, H * rows[1][r], W - 56 - (on && r === 0 ? 120 : 0));
      });
      x.tex.needsUpdate = true;
    });
  }
  const anchor = { x: 0, y: 0, yaw: 0, set: false };
  // The cards stand on an arc 0.7 m around where you stood, each turned and tilted to face you: two columns 21 and 59 deg
  // to the left of where you faced (off the line you look along), rows centred 0.35 m below the eyes, never under 0.5 m.
  // The first card of a row is the one nearer your view.
  const ARC_D = 0.7, COL_A = [0.37, 1.03], STEP = BH + GAP;
  function placeCard(mesh: THREE.Mesh, a: number, z: number) {
    mesh.position.set(Math.cos(a) * ARC_D, Math.sin(a) * ARC_D, z);
    mesh.rotation.set(Math.PI / 2 - Math.atan2(head.z - z, ARC_D), 0, a - Math.PI / 2);   // face (-cos a, -sin a), tipped up to the eyes
  }
  function placeDash(yaw: number) {
    // turning toward the cards (left) doesn't move them; turning away past 40 deg or walking off brings them along
    const da = Math.atan2(Math.sin(yaw - anchor.yaw), Math.cos(yaw - anchor.yaw)), turned = da < -0.7 || da > 1.5;
    if (!anchor.set || turned || Math.hypot(head.x - anchor.x, head.y - anchor.y) > 0.6) Object.assign(anchor, { x: head.x, y: head.y, yaw, set: true });
    dash.position.set(anchor.x, anchor.y, 0);
    dash.rotation.set(0, 0, anchor.yaw);
    const vis = btns.map((_, n) => n).filter(n => btns[n].mesh.visible);
    const rows = Math.ceil(vis.length / 2), top = Math.max(0.5 + (rows - 1) * STEP, head.z - 0.35 + (rows - 1) * STEP / 2);
    vis.forEach((n, k) => placeCard(btns[n].mesh, COL_A[k % 2], top - Math.floor(k / 2) * STEP));
  }
  let btnHover = -1, btnPressed = -1;
  function setMenu(on: boolean) {
    menuOn = on; more = false; btnHover = -1; btnPressed = -1; anchor.set = false;
    if (!on) toast(['Menu hidden', 'tap the off-hand grip to show it'], '#a9c8ff');
  }

  // ---------- glance: a chip of the modes that are on (above the strip on the off-hand controller, else low in front) and, while a
  // fix is applied, two lines of stats low in front. Sprites, never in a ray test: a press, grab or teleport passes through them.
  let chip: THREE.Sprite | null = null, chipKey = '', statsCard: THREE.Sprite | null = null, statsKey = '', statsSince = 0;
  const lowAhead = (s: THREE.Sprite, yaw: number, dz: number) => s.position.set(head.x + Math.cos(yaw) * 1.6, head.y + Math.sin(yaw) * 1.6, head.z + dz);   // level, not along the gaze: it stays put as you look down
  function glanceStep(yaw: number, other?: Ctl) {
    const modes = host.status?.() ?? [], key = modes.join(' · '), hidden = !!host.editor?.active() || !!grab;
    if (key !== chipKey) {
      chipKey = key; chip?.removeFromParent(); chip?.material.dispose(); chip = null;
      if (key) { chip = card([key], '#9be8b0', 'rgba(8,12,18,0.95)', 0.034); chip.renderOrder = 4; }
    }
    if (chip) {
      const hand = other?.source?.gamepad ? other.group : null;
      if (hand) { if (chip.parent !== hand) hand.add(chip); chip.position.set(0, 0.31, -0.1); }
      else { if (chip.parent !== scene) scene.add(chip); lowAhead(chip, yaw, -0.5); }
      chip.visible = !hidden && !host.shell?.open();
    }
    const lines = host.stats?.() ?? null, sk = lines?.join('\n') ?? '';
    if (sk !== statsKey) {
      statsKey = sk; statsSince = performance.now(); statsCard?.removeFromParent(); statsCard?.material.dispose(); statsCard = null;
      if (lines) { statsCard = card(lines, '#9be8b0', 'rgba(8,12,18,0.95)', 0.05); statsCard.renderOrder = 4; scene.add(statsCard); }
    }
    if (statsCard) {   // shown for 8 s after it changes, then whenever you look down at it
      lowAhead(statsCard, yaw, -0.62);
      statsCard.visible = !hidden && (performance.now() - statsSince < 8000 || headDir.z < -0.3);
    }
  }
  function toast(lines: string[], color = '#9be8b0') {
    toastCard?.removeFromParent(); toastCard?.material.dispose(); toastCard = card(lines, color); scene.add(toastCard); toastUntil = performance.now() + 1800;
  }

  // Controller shortcuts share the same priority as the wand: annotation gestures consume input before furniture.
  let clickWas = false, toastCard: THREE.Sprite | null = null, toastUntil = 0;
  let aHeld = 0, aTarget = -1, aFired = false;   // A held on an object: it goes once held CONFIRM_S
  let opGripWas = false, opGripT = 0, opGripClean = false;
  let gripWas = false, aWas = false, bothHeld = 0, resetFired = false, ringN = 0, ringCard: THREE.Sprite | null = null;
  /** remove object k and say so, with the way back: a delete should never be silent */
  function removeWithToast(k: number, unlockAfter = false) {
    const name = (host.names[k] ?? 'object').replace(/_/g, ' ');
    const done = Promise.resolve(host.remove(k));
    if (unlockAfter) done.finally(() => host.unlock?.(k));
    toast([`Removed ${name}`, 'stick-click to undo'], '#ffd27a');
  }
  function controllerButtons(dt: number, pads: Record<string, Gamepad>) {
    const wp = pads[WAND], op = pads[WAND === 'left' ? 'right' : 'left'];
    const grip = !!wp?.buttons[1]?.pressed, a = !!wp?.buttons[4]?.pressed, click = !!wp?.buttons[3]?.pressed, both = grip && !!op?.buttons[1]?.pressed;
    const consumed = host.readOnly?.() || (host.editor?.buttons(pads, WAND) ?? false);
    if (consumed) {
      if (grab) { host.resync(); host.unlock?.(grab.k); }
      grab = null; aiming = false; aHeld = 0; aFired = true;
      if (!host.readOnly?.()) btnPressed = -1;   // comparison mode still needs the card's press/release gesture
    } else {
      if (grip && !gripWas) {
        const k = grab?.k ?? hover;
        if (k >= 0) {
          const before = { ...host.poses()[k] }, home = host.home?.(k);
          host.unlock?.(k); grab = null; host.resync(); host.resetObject(k); pulse(wp, 0.5, 40);
          const after = host.poses()[k], near = (q: Pose) => !!home && Math.hypot(q.x - home.x, q.y - home.y) < 0.01 && Math.abs(q.yaw - home.yaw) < 0.01;
          // it went back (not refused: the old spot taken, or it was already there): a green ghost of the spot, and an arrow from where it was
          if (home && !after.removed && near(after) && (before.removed || !near(before))) fb.flash(k, before.removed ? null : before, home);
        }
      }
      // A held on the pointed-at object removes it (a tap used to; the outline fills red while you hold)
      if (!a) { aHeld = 0; aFired = false; aTarget = -1; }
      else if (!aWas) { aTarget = hover; aHeld = 0; aFired = false; if (hover >= 0 && !grab) pulse(wp, 0.2, 25); }
      else if (!aFired && !grab && aTarget >= 0 && hover === aTarget) {
        aHeld += dt;
        if (confirmProgress(aHeld) >= 1) { aFired = true; removeWithToast(aTarget); pulse(wp, 0.5, 40); }
      } else if (!aFired) aHeld = 0;
      // wand stick click undoes the last object edit; with the off-hand grip held it redoes (marking has its own undo on B/Y)
      if (click && !clickWas && !grab && host.history) {
        pulse(wp, 0.4, 30);
        host.history[op?.buttons[1]?.pressed ? 'redo' : 'undo']().then(text => toast([text]));
      }
    }
    // a quick tap of the off-hand grip alone hides or shows the card menu (the wand grip resets an object, both held reset all)
    const opGrip = !!op?.buttons[1]?.pressed;
    if (opGrip && !opGripWas) { opGripT = performance.now(); opGripClean = true; }
    if (opGrip && (grip || click)) opGripClean = false;
    if (!opGrip && opGripWas && opGripClean && !consumed && performance.now() - opGripT < 350) setMenu(!menuOn);
    opGripWas = opGrip;
    gripWas = grip; aWas = a; clickWas = click;
    if (toastCard) {
      if (performance.now() > toastUntil) { toastCard.removeFromParent(); toastCard.material.dispose(); toastCard = null; }
      else toastCard.position.copy(head).addScaledVector(headDir, 1.6).setZ(head.z - 0.75);   // low and ahead (about 25 deg down), off the line of sight
    }
    bothHeld = both && !consumed ? bothHeld + dt : 0;
    if (consumed && both) resetFired = true;   // cancelling an edit cannot turn into a global reset before both grips are released
    if (!both) resetFired = false;
    const p = resetHoldProgress(bothHeld);
    if (p >= 1 && !resetFired) { resetFired = true; host.resetAll(); toast(['Room reset', 'stick-click to undo'], '#ffd84d'); }
    const n = both && !consumed && !resetFired ? Math.ceil(p * 5) : 0;
    if (n !== ringN) {
      ringN = n; ringCard?.removeFromParent(); ringCard?.material.dispose(); ringCard = null;
      if (n) { ringCard = card(['Reset everything', '▮'.repeat(n) + '▯'.repeat(5 - n)], '#ffd84d'); scene.add(ringCard); }
    }
    ringCard?.position.copy(head).addScaledVector(headDir, 1).setZ(head.z - 0.15);
  }

  /** The real walker's pose (floor frame) from the mounted controller: heading = its most level axis (picked at line-up:
   *  the ray when strapped flat, a side axis when it stands in a cup holder) plus the offset taken then; position = the
   *  controller less where it sat in the walker's frame at line-up. Null with no mount or no tracked controller. The first
   *  reading after a line-up takes axis, offset and spot, with the head as the walker user standing centred behind it. */
  function walkerPose(headYaw: number): { x: number; y: number; yaw: number } | null {
    const c = ctls.find(isMount);
    if (!c?.source) return null;
    c.group.updateWorldMatrix(true, false);
    if (!mountAxis) {
      const axes = [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
      const level = (a: THREE.Vector3) => { const d = a.clone().transformDirection(c.group.matrixWorld); return Math.hypot(d.x, d.y); };
      mountAxis = axes.reduce((b, a) => (level(a) > level(b) ? a : b));
    }
    rayYaw.copy(mountAxis).transformDirection(c.group.matrixWorld);
    if (Math.hypot(rayYaw.x, rayYaw.y) < 0.2) return null;
    const raw = Math.atan2(rayYaw.y, rayYaw.x);
    mountOffset ??= headYaw - raw;
    const yaw = raw + mountOffset, cs = Math.cos(yaw), sn = Math.sin(yaw);
    c.group.getWorldPosition(mountPos);
    if (!mountAt) { const dx = mountPos.x - head.x, dy = mountPos.y - head.y; mountAt = [cs * dx + sn * dy, -sn * dx + cs * dy]; }
    return { x: mountPos.x - (cs * mountAt[0] - sn * mountAt[1]), y: mountPos.y - (sn * mountAt[0] + cs * mountAt[1]), yaw };
  }

  // ---------- per frame ----------
  let refusedAt = 0;
  /** a move was stopped by furniture, a wall or unfilmed floor: tell the host (the device flashes red) and buzz, at most 5 a second */
  function refused(pad?: Gamepad) {
    host.contact?.();
    const now = performance.now();
    if (now - refusedAt > 200) { refusedAt = now; pulse(pad, 0.4, 60); }
  }
  function step(dt: number) {
    fb.update(dt);
    if (pendingSpawn) {
      const reference = renderer.xr.getReferenceSpace(), pose = reference && renderer.xr.getFrame()?.getViewerPose(reference);
      if (!pose) return;
      const { position: p, orientation: q } = pose.transform; camera.position.set(p.x, p.y, p.z); camera.quaternion.set(q.x, q.y, q.z, q.w);
      const destination = pendingSpawn; pendingSpawn = null; place(destination.x, destination.y, destination.yaw);
    }
    if (host.shell?.open()) { dash.visible = false; if (chip) chip.visible = false; if (statsCard) statsCard.visible = false; return; }
    const yaw = readHead();
    if (host.shell?.follow(dt)) { dash.visible = false; xrRig.x += body.x - head.x; xrRig.y += body.y - head.y; placeRig(); wandStep(); return; }   // the route drives the body
    const pads: Record<string, Gamepad> = {};
    for (const source of renderer.xr.getSession()?.inputSources ?? []) if (source.gamepad) pads[source.handedness] = source.gamepad;
    wandStickY = grab ? pads[WAND]?.axes[3] ?? 0 : 0;   // while holding an object the wand stick pushes and pulls it, so it doesn't also walk or turn you
    if (pinching.size && !host.readOnly?.() && (host.movement?.() ?? 'all') === 'all') {   // glide forward in sub-steps of at most half a cell, as in free walk
      const v = 0.6 * dt, dx = Math.cos(yaw) * v, dy = Math.sin(yaw) * v, n = Math.max(1, Math.ceil(v / (host.cellM / 2)));
      let i = 0;
      for (; i < n && host.standable(head.x + dx / n, head.y + dy / n); i++) {
        xrRig.x += dx / n; xrRig.y += dy / n; head.x += dx / n; head.y += dy / n;
      }
      if (i < n) refused();
    }
    if (!host.readOnly?.() && (host.movement?.() ?? 'all') === 'all') {   // thumbsticks: left walks (forward/back, sideways, relative to where you look), right snap-turns
      const stick = (g?: Gamepad) => (g ? [g.axes[2] ?? 0, g.axes[3] ?? 0].map(a => (Math.abs(a) < 0.2 ? 0 : a)) : [0, 0]);
      const wp = MOUNT ? walkerPose(yaw) : null, wy = wp?.yaw ?? null;
      // mounted: one stick, up/down along the walker's heading, left/right snap-turns; held: left walks relative to the view
      const [mx, my] = MOUNT ? stick(pads[MOUNT]) : [0, 0];
      const [sx, sy] = MOUNT ? [0, my] : grab && WAND === 'left' ? [0, 0] : stick(pads.left), [tx] = MOUNT ? [mx] : stick(pads.right), dir = wy ?? yaw;
      if (sx || sy) {   // sub-steps of at most half a cell, as in free walk
        const v = 0.6 * dt, dx = (-sy * Math.cos(dir) + sx * Math.sin(dir)) * v, dy = (-sy * Math.sin(dir) - sx * Math.cos(dir)) * v;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (host.cellM / 2)));
        // mounted: the real walker's legs must clear too (it moves with you); held: where you stand
        // (a walker that already doesn't fit, e.g. lined up at the scan's edge, may still move: out of the spot)
        const stuck = !!wp && !!host.walkerFits && !host.walkerFits(wp);
        const ok = (i: number) => (wp && host.walkerFits && !stuck ? host.walkerFits({ x: wp.x + dx * (i + 1) / n, y: wp.y + dy * (i + 1) / n, yaw: wp.yaw }) : host.standable(head.x + dx / n, head.y + dy / n));
        let i = 0;
        for (; i < n && ok(i); i++) {
          xrRig.x += dx / n; xrRig.y += dy / n; head.x += dx / n; head.y += dy / n;
        }
        if (i < n) refused(pads[MOUNT ?? 'left']);   // furniture or a wall stopped the move: the device flashes red
      }
      if (Math.abs(tx) > 0.7 && snapReady && !grab) {
        // held: turn the rig about the head, so turning doesn't also slide you sideways. Mounted: about the walker's centre,
        // like turning a real walker in place (you swing round behind it), and not into furniture: a refused turn buzzes
        const a = -Math.sign(tx) * Math.PI / 6, c = Math.cos(a), sn = Math.sin(a), cx = host.walkerCentre?.() ?? 0.5;
        const pv = wp ? { x: wp.x + Math.cos(wp.yaw) * cx, y: wp.y + Math.sin(wp.yaw) * cx } : head;
        const turned = wp && { x: pv.x - Math.cos(wp.yaw + a) * cx, y: pv.y - Math.sin(wp.yaw + a) * cx, yaw: wp.yaw + a };
        if (turned && host.walkerFits && !host.walkerFits(turned)) pulse(pads[MOUNT!], 0.6, 120);
        else { const rx = xrRig.x - pv.x, ry = xrRig.y - pv.y; Object.assign(xrRig, { x: pv.x + c * rx - sn * ry, y: pv.y + sn * rx + c * ry, yaw: xrRig.yaw + a }); }
        snapReady = false;
      } else if (Math.abs(tx) < 0.3) snapReady = true;
    }
    placeRig();
    const wpNow = MOUNT ? walkerPose(readHead()) : null;   // after a move or snap the rig carried the controller: read it again
    if (wpNow) Object.assign(body, wpNow);   // the walker is rigid: it stands and points where the real one does
    else { body.x = head.x; body.y = head.y; body.yaw += Math.atan2(Math.sin(yaw - body.yaw), Math.cos(yaw - body.yaw)) * Math.min(1, dt * 4); }
    controllerButtons(dt, pads);
    dash.visible = btns.length > 0 && menuOn && !host.editor?.active();
    wandStep(dt);
    if (btns.length) {
      btns.forEach((x, n) => { x.mesh.visible = shown(n); });
      placeDash(yaw); drawButtons(btnHover);
    }
    glanceStep(yaw, ctls.find(o => o.source && !isWand(o)));
  }
  /** Put the head at floor-frame (x, y) looking along yaw by moving the rig: scripted viewpoints on a headset nobody wears. */
  function place(x: number, y: number, yaw: number) {
    lastSpawn = { x, y, yaw }; if (pendingSpawn) pendingSpawn = { x, y, yaw };
    const a = yaw - readHead(), c = Math.cos(a), s = Math.sin(a), rx = xrRig.x - head.x, ry = xrRig.y - head.y;
    Object.assign(xrRig, { x: x + c * rx - s * ry, y: y + s * rx + c * ry, yaw: xrRig.yaw + a });   // turn about the head, then move it
    placeRig();
  }

  /** Slide the rig so the head stands at floor-frame (x, y), keeping its heading; and save/restore the whole rig pose. */
  function moveHead(x: number, y: number) { readHead(); xrRig.x += x - head.x; xrRig.y += y - head.y; placeRig(); }
  const rigState = () => ({ ...xrRig });
  function restoreRig(r: { x: number; y: number; yaw: number }) { Object.assign(xrRig, r); placeRig(); }

  function enterRoom() {
      { const p = host.startPose(); if (p) Object.assign(body, p); }   // null: stay where the walker user is
      Object.assign(xrRig, { x: body.x, y: body.y, yaw: body.yaw }); placeRig(); rig.add(camera);
      lastSpawn = { x: body.x, y: body.y, yaw: body.yaw };
      pendingSpawn = { ...lastSpawn }; camera.position.set(0, 0, 0); camera.quaternion.identity();
      anchor.set = false; more = false; unmount();
      host.enter(tier);
      // a lower refresh gives each frame more time (90 Hz = 11.1 ms, 72 Hz = 13.9 ms); the Quest 2 offers 60-120
      if (cfg.hz) renderer.xr.getSession()?.updateTargetFrameRate?.(cfg.hz).catch(() => {});
  }

  bindXR({   // adds the Enter VR button; "VR not supported" where WebXR isn't available
    renderer, mode: 'vr', referenceSpaceType: 'local-floor', enableHands: true,
    // bounded-floor asks for the room-scale boundary: with local-floor alone the Quest may fall back to a stationary one
    sessionInit: { optionalFeatures: ['bounded-floor'] },
    frameBufferScaleFactor: cfg.scale, fixedFoveation: cfg.foveation,
    onEnterXr: enterRoom,
    onExitXr: () => {
      camera.removeFromParent(); pinching.clear(); dropWand(); hover = -1; btnHover = -1; dash.visible = false; opGripWas = false; fb.clear(); aHeld = 0; aTarget = -1; aFired = false;
      chip?.removeFromParent(); chip?.material.dispose(); chip = null; chipKey = ''; statsCard?.removeFromParent(); statsCard?.material.dispose(); statsCard = null; statsKey = '';
      ringCard?.removeFromParent(); ringCard?.material.dispose(); ringCard = null; ringN = 0; bothHeld = 0; gripWas = false; aWas = false; clickWas = false;
      toastCard?.removeFromParent(); toastCard?.material.dispose(); toastCard = null;
      for (const it of items) { it.outline.visible = false; (it.outline.material as THREE.LineBasicMaterial).color.setHex(0x66ccff); }
      host.exit();
    },
  });

  const w = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3));
  return {
    tier, device, rig, place, step, resume: enterRoom, spawn: () => ({ ...lastSpawn }), moveHead, rigState, restoreRig, mount: () => ({ hand: MOUNT, offset: mountOffset, at: mountAt, axis: mountAxis?.toArray() ?? null }),
    presenting: () => renderer.xr.isPresenting,
    /** where the XR camera and the user camera in its rig are (floor frame), and what is tracked */
    pose: () => ({ xr: renderer.xr.isPresenting, head: w(renderer.xr.getCamera()), userCam: w(camera), rig: { ...xrRig },
      inputs: [...renderer.xr.getSession()?.inputSources ?? []].map(s => `${s.handedness}:${s.hand ? 'hand' : 'controller'}`), pinching: pinching.size }),
    /** the story actions the panel's Tour tab lists (live objects: text() and tone() are read when drawn) */
    actions,
    /** the cards: each one's text, whether it shows now and where its centre is (floor frame), for scripted presses */
    buttons: () => btns.map(x => ({ text: x.b.text(), on: !!x.b.on?.(), at: dash.visible && x.mesh.visible ? w(x.mesh) : null })),
    /** press a card as a point-and-pinch on it would (scripted checks on a headset nobody wears) */
    press: (i: number) => btns[i]?.b.press(),
    /** the card menu: shown or hidden (the off-hand grip tap), and whether "More" is open; pass a boolean to set it */
    menu: (on?: boolean) => { if (on != null) setMenu(on); return { on: menuOn, more }; },
    /** the glance: the mode chip's and the stats card's words, and whether each shows */
    glance: () => ({ chip: chipKey, chipVisible: !!chip?.visible, stats: statsKey, statsVisible: !!statsCard?.visible }),
    /** the strip card on the off-hand controller: its words and whether it shows */
    strip: () => ({ key: stripKey, visible: !!strip?.visible }),
    wand: () => ({ hover: hover >= 0 ? host.names[hover] : null, button: btnHover, grab: grab ? host.names[grab.k] : null, aiming, teleport: tpRing.visible,
      drag: grab?.drag, valid: grab?.valid ?? null, planeZ: grab?.planeZ ?? null, push: grab?.push ?? 0, fx: fb.state(), ruler: ruler?.visible ? rulerKey : null }),
  };
}

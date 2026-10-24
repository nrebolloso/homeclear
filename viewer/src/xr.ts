// VR (WebXR) for the walker game: the headset is the patient's eyes, 1:1 on the scanned floor. The VR lane owns this file
// (AGENTS.md); main.ts builds an XrHost and calls step() while presenting. Tested with no headset by e2e/xr.ts (Meta's
// IWER, ?emulate=quest2) and on a real Quest nobody wears by e2e/quest-sweep.ts.
// Frames: WebXR's local-floor space is y-up with the floor at y=0; the scene is the +z-up floor frame (frame.ts). The
// camera rides in a rig: +90 deg about x maps XR up (+y) to +z, then a turn about z by yaw - 90 deg points XR forward
// (-z) along yaw.
// Moving: walk for real (1:1). Holding a pinch or trigger on the non-wand hand glides forward where you look, only where
// free walk could stand (walls, furniture and unfilmed floor stop it). No thumbsticks: people found them hard to use.
// Wand (right hand or controller; ?wand=left): point at furniture and hold to drag it (twist the wrist to turn it), hold
// still to delete it; point at filmed floor and release to teleport. A pinch and a trigger are the same WebXR "select".
// Moves go through the host's placement check and re-plan, like a desktop drag.
import * as THREE from 'three';
import { SparkXr } from '@sparkjsdev/spark';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import type { Pose, XY } from './grid.ts';
import { floorHit, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S, DELETE_SHOW_S, DRAG_DEADZONE_M } from './wand.ts';
import { tierAtLoad, xrCfg, type Tier } from './perf.ts';

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
  /** where to start when the walker's spot isn't standable (a route can begin at the scan's edge, inside a wall's splats) */
  startPose(): { x: number; y: number; yaw: number } | null;
  /** performance mode and in-headset labels: on entering and leaving */
  enter(tier: Tier): void; exit(): void;
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
    if (hover < 0) { aiming = true; return; }
    const r = aim(c), f = floorHit(r.origin, r.direction), p = host.poses()[hover], at: XY = f ? [f.x, f.y] : [p.x, p.y];
    grab = { k: hover, off: [p.x - at[0], p.y - at[1]], start: at, drag: 0, t0: performance.now(), yaw0: p.yaw, q0: c.group.getWorldQuaternion(new THREE.Quaternion()) };
  }
  function wandUp() {
    if (grab) { const { k, valid } = grab; grab = null; if (valid) host.commit(k, valid); return; }
    if (aiming && tpRing.visible) { xrRig.x += tpRing.position.x - head.x; xrRig.y += tpRing.position.y - head.y; placeRig(); }
    aiming = false; tpRing.visible = false;
  }
  function dropWand() {   // wand lost mid-gesture (hand out of view): put a dragged object back where the layout has it
    if (grab) host.resync();
    grab = null; aiming = false; tpRing.visible = false;
  }
  function wandStep() {
    const c = ctls.find(isWand);
    for (const o of ctls) o.ray.visible = o === c;
    tpRing.visible = false;
    let prog = -1;
    if (c) {
      const r = aim(c), f = floorHit(r.origin, r.direction);
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
        const poses = host.poses();
        const hit = wandRay.intersectObjects(items.filter((_, k) => !poses[k].removed).map(i => i.proxy))[0];
        hover = hit ? items.findIndex(i => i.proxy === hit.object) : -1;
        if (hit) len = hit.distance;
        if (hover < 0 && aiming && f && host.standable(f.x, f.y)) { tpRing.position.set(f.x, f.y, 0.03); tpRing.visible = true; }
      }
      c.ray.scale.z = len;
    } else hover = -1;
    items.forEach((it, k) => {   // blue = pointed at, yellow = held, turning red = about to be deleted
      const held = grab?.k === k, m = it.outline.material as THREE.LineBasicMaterial;
      it.outline.visible = held || (!grab && k === hover);
      m.color.setHex(held ? 0xffd84d : 0x66ccff);
      if (held && prog > 0) m.color.lerp(RED3, THREE.MathUtils.clamp((prog * DELETE_HOLD_S - DELETE_SHOW_S) / (DELETE_HOLD_S - DELETE_SHOW_S), 0, 1));
    });
  }

  // ---------- per frame ----------
  function step(dt: number) {
    const yaw = readHead();
    if (pinching.size) {   // glide forward in sub-steps of at most half a cell, as in free walk
      const v = 0.6 * dt, dx = Math.cos(yaw) * v, dy = Math.sin(yaw) * v, n = Math.max(1, Math.ceil(v / (host.cellM / 2)));
      for (let i = 0; i < n && host.standable(head.x + dx / n, head.y + dy / n); i++) {
        xrRig.x += dx / n; xrRig.y += dy / n; head.x += dx / n; head.y += dy / n;
      }
    }
    placeRig();
    body.x = head.x; body.y = head.y;
    body.yaw += Math.atan2(Math.sin(yaw - body.yaw), Math.cos(yaw - body.yaw)) * Math.min(1, dt * 4);
    wandStep();
  }
  /** Put the head at floor-frame (x, y) looking along yaw by moving the rig: scripted viewpoints on a headset nobody wears. */
  function place(x: number, y: number, yaw: number) {
    const a = yaw - readHead(), c = Math.cos(a), s = Math.sin(a), rx = xrRig.x - head.x, ry = xrRig.y - head.y;
    Object.assign(xrRig, { x: x + c * rx - s * ry, y: y + s * rx + c * ry, yaw: xrRig.yaw + a });   // turn about the head, then move it
    placeRig();
  }

  new SparkXr({   // adds the Enter VR button; "VR not supported" where WebXR isn't available
    renderer, mode: 'vr', referenceSpaceType: 'local-floor', enableHands: true,
    frameBufferScaleFactor: cfg.scale, fixedFoveation: cfg.foveation,
    onEnterXr: () => {
      if (!host.standable(body.x, body.y)) { const p = host.startPose(); if (p) Object.assign(body, p); }
      Object.assign(xrRig, { x: body.x, y: body.y, yaw: body.yaw }); placeRig(); rig.add(camera);
      host.enter(tier);
      // a lower refresh gives each frame more time (90 Hz = 11.1 ms, 72 Hz = 13.9 ms); the Quest 2 offers 60-120
      if (cfg.hz) renderer.xr.getSession()?.updateTargetFrameRate?.(cfg.hz).catch(() => {});
    },
    onExitXr: () => {
      camera.removeFromParent(); pinching.clear(); dropWand(); hover = -1;
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
    wand: () => ({ hover: hover >= 0 ? host.names[hover] : null, grab: grab ? host.names[grab.k] : null, aiming, teleport: tpRing.visible,
      drag: grab?.drag, valid: grab?.valid ?? null }),
  };
}

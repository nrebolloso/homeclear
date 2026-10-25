import { onWindow } from './lifetime.ts';
import { pulse } from './controls.ts';
// Live object physics, main-thread side: owns physworker.ts, moves each object's splat with its rigid body, and makes
// every walker contact felt: haptic pulse (headset), a sound, a red flash on the object, a line in the events log.
// Masses/frictions are sampled per run from physics_ranges.json and shown as "sampled from an assumed range".
import * as THREE from 'three';
import type { WebGLRenderer } from 'three';
import ranges from '../../physics_ranges.json' with { type: 'json' };
import type { GridMeta, Layout, Pose, XY } from './grid.ts';
import type { WalkerCfg } from './walker.ts';
import type { PhysEvent, PhysRanges } from './objphys.ts';
import type { PhysInit } from './physworker.ts';

interface Item { group: THREE.Group; mesh: { recolor: THREE.Color } }
export interface LivePhysDeps {
  base: string; g: GridMeta; objs: { name: string; kind: string; splat: string; pivot: number[]; footprint: XY[]; height_m: number; layer: string }[];
  items: Item[]; scene: THREE.Scene; renderer: WebGLRenderer;
  /** measured walls/cabinets only (movable objects' own spots cleared) */
  obst: Uint8Array; bump: Float32Array; walker: () => WalkerCfg; layout: () => Layout;
  /** object pairs filmed overlapping (tucked chair): never collide with each other */
  overlap: [number, number][];
  /** objects physics must leave alone this frame (being dragged; the reimagined room animating) */
  hold: (k: number) => boolean;
  /** an object came to rest somewhere new after a push: the layout follows it */
  settled: (moves: { k: number; pose: Pose; moved_m: number; tipped: boolean }[]) => void;
  log: HTMLElement; sampledEl: HTMLElement;
  /** fixed physics seed (demo autoplay, demorun.ts); else a random one per run */
  seed?: number | null;
}

const TEXT: Record<PhysEvent['kind'], string> = { bumped: 'bumped', moved: 'pushed', tipped: 'TIPPED', slid: 'slid', corner_caught: 'corner caught', corner_folded: 'corner FOLDED' };

export function createLivePhys(D: LivePhysDeps) {
  const worker = new Worker(new URL('./physworker.ts', import.meta.url), { type: 'module' });
  let fold: { corner: XY; lift_m: number; size_m: number } | null = null;
  let busy = true, acc = 0, ready = false, steps = 0, inits = 1, seed = D.seed ?? Math.floor(Math.random() * 1e9);
  const xf = new Map<number, number[]>();   // object -> latest [k, x, y, z, qx, qy, qz, qw]
  let walkerPose: { x: number; y: number; yaw: number } | null = null, target = { x: 0, y: 0, yaw: 0 };
  const events: PhysEvent[] = [];
  // the curled corner: the mat splat can't fold, so the flap is drawn as a tinted proxy of its collider
  const flapMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
  flapMesh.visible = false; D.scene.add(flapMesh);

  const tapedKey = (lay: Layout) => lay.poses.map(p => +!!p.taped).join('');
  let taped = tapedKey(D.layout());
  const init = (): PhysInit => ({
    base: new URL(D.base, location.href).href, g: D.g, obst: D.obst, bump: D.bump, walker: D.walker(), ranges: ranges as unknown as PhysRanges, seed,
    overlap: D.overlap, poses: D.layout().poses, objects: D.objs.map(o => ({ name: o.name, kind: o.kind, splat: o.splat, pivot: o.pivot, footprint: o.footprint, height_m: o.height_m, layer: o.layer })),
  });
  worker.postMessage({ type: 'init', init: init() });

  // ---------- feedback ----------
  let audio: AudioContext | null = null;
  const unlock = () => { audio ??= new AudioContext(); void audio.resume(); };
  onWindow('pointerdown', unlock, { once: false });
  // a headset has no pointer events: entering VR (a click) and any controller select also unlock the sound
  D.renderer.xr.addEventListener('sessionstart', unlock);
  for (const i of [0, 1]) D.renderer.xr.getController(i).addEventListener('selectstart', unlock);
  function sound(kind: PhysEvent['kind']) {
    if (!audio || audio.state !== 'running') return;
    const t = audio.currentTime, [f, dur, noise] = ({ bumped: [140, 0.12, 0.4], moved: [110, 0.25, 0.7], tipped: [70, 0.6, 0.6], slid: [600, 0.35, 1], corner_caught: [900, 0.06, 0.2], corner_folded: [300, 0.2, 0.5] } as const)[kind];
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.35, t); gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const osc = audio.createOscillator();
    osc.frequency.setValueAtTime(f, t); osc.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur);
    osc.connect(gain);
    if (noise > 0) {   // contact noise: a short burst through a band-pass at the tone
      const n = audio.createBufferSource(), b = audio.createBuffer(1, Math.ceil(audio.sampleRate * dur), audio.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * noise;
      const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2;
      n.buffer = b; n.connect(bp).connect(gain); n.start(t);
    }
    gain.connect(audio.destination); osc.start(t); osc.stop(t + dur);
  }
  function haptic(strength: number, ms: number) {
    for (const s of D.renderer.xr.getSession()?.inputSources ?? []) pulse(s.gamepad, strength, ms);   // same buzz as the wand's (hapticActuators or vibrationActuator)
  }
  const flashing = new Map<number, number>();   // object -> seconds of red left
  const RED = new THREE.Color(1, 0.25, 0.25), plain = new Map<number, THREE.Color>();
  function flash(k: number) {
    if (k < 0 || !D.items[k]) return;
    if (!flashing.has(k)) plain.set(k, D.items[k].mesh.recolor.clone());
    flashing.set(k, 0.3); D.items[k].mesh.recolor = RED;
  }
  function logEvent(e: PhysEvent) {
    events.push(e);
    const li = document.createElement('li');
    const v = e.kind === 'tipped' ? ` ${e.value!.toFixed(0)}°` : e.kind === 'moved' || e.kind === 'slid' ? ` ${(e.value! * 100).toFixed(0)} cm+` : '';
    li.textContent = `${e.t.toFixed(1)} s · ${e.object.replace(/_/g, ' ')} ${TEXT[e.kind]}${v}`;
    if (e.kind === 'tipped' || e.kind === 'corner_folded') li.className = 'red';
    D.log.prepend(li);
    while (D.log.children.length > 30) D.log.lastChild!.remove();
  }

  worker.onmessage = ({ data: m }) => {
    busy = false;
    if (m.type === 'error') { console.error('[livephys]', m.msg); D.sampledEl.textContent = `physics failed: ${m.msg.split('\n')[0]}`; return; }
    if (m.type === 'ready') {
      if (--inits) return;   // a newer init is on its way (same seed and layout): only the last build is stepped
      ready = true; xf.clear(); walkerPose = null;
      const rows = Object.entries(m.sampled as Record<string, Record<string, number>>).map(([n, s]) =>
        `<tr><td>${n.replace(/_/g, ' ')}</td><td>${Object.entries(s).map(([k, v]) => `${k.replace(/_/g, ' ')} ${+v.toFixed(3)}`).join(', ')}</td></tr>`).join('');
      D.sampledEl.innerHTML = `<div class="hint">seed ${m.seed}: masses, frictions, flap stiffness <b>sampled from an assumed range, not measured</b> (physics_ranges.json); shapes and the corner curl are from the splat</div><table>${rows}</table>`;
      if (m.flap) {
        const [a, b, c] = m.flap.tri as XY[], t = 0.006;
        flapMesh.geometry.dispose();
        flapMesh.geometry = new THREE.BufferGeometry().setFromPoints([a, b, c].map(([x, y]) => new THREE.Vector3(x, y, -t / 2)));
        flapMesh.visible = true;
      } else flapMesh.visible = false;
      worker.postMessage({ type: 'place', body: target });
      return;
    }
    if (m.type !== 'step' || m.none) return;
    steps++; walkerPose = m.walker;
    fold = m.flapInfo?.folded ? { corner: m.flapInfo.corner, lift_m: m.flapInfo.lift_m, size_m: m.flapInfo.size_m } : null;
    for (const p of m.poses as number[][]) xf.set(p[0], p);
    if (m.flap && flapMesh.visible) { flapMesh.position.set(m.flap[0], m.flap[1], m.flap[2]); flapMesh.quaternion.set(m.flap[3], m.flap[4], m.flap[5], m.flap[6]); }
    if (!m.flapInfo) flapMesh.visible = false;
    for (const e of m.events as PhysEvent[]) {
      logEvent(e); sound(e.kind); flash(e.kind.startsWith('corner') ? -1 : e.k);
      haptic(e.kind === 'tipped' || e.kind === 'corner_folded' ? 1 : e.kind === 'bumped' ? 0.6 : 0.35, e.kind === 'tipped' ? 200 : 80);
    }
    if (m.settled.length) D.settled(m.settled);
  };

  const q = new THREE.Quaternion();
  return {
    events, ready: () => ready, /** ready and no step in the worker (demorun.ts lockstep) */ idle: () => ready && !busy, /** worker steps answered (e2e: physics runs in autoplay too) */ steps: () => steps,
    /** the mat's curled corner while folded over (futures.ts treats it as a bump), else null */
    fold: () => fold,
    /** The layout changed (drag, remove, fix, reset): bodies jump to it. */
    sync(lay: Layout) {
      if (!ready) return;
      if (tapedKey(lay) !== taped) { taped = tapedKey(lay); return this.resample(); }   // taping fixes the mat and drops its flap: rebuilt from the layout
      worker.postMessage({ type: 'poses', poses: lay.poses });
      for (const [k] of xf) { const p = lay.poses[k], v = xf.get(k)!; if (Math.hypot(v[1] - p.x, v[2] - p.y) > 0.01) xf.delete(k); }
    },
    resample() { ready = false; busy = true; inits++; taped = tapedKey(D.layout()); seed = D.seed ?? Math.floor(Math.random() * 1e9); worker.postMessage({ type: 'init', init: init() }); },
    /** Per frame. `body` = where the person wants the walker (their body centre + heading). In free walking the walker is
     *  where physics has it, and the person can't get more than 15 cm ahead of it (a heavy chair holds them back).
     *  `run` (default: free) steps the mat without that: autoplay's walker stays on its route and passes furniture as
     *  before, but the mat can still slide or fold under it, and the next lap meets the fold. */
    frame(dt: number, body: { x: number; y: number; yaw: number }, free: boolean, walkerGroup: THREE.Object3D, run = free) {
      target = { x: body.x, y: body.y, yaw: body.yaw };
      acc += dt;
      // a jump (setFree, a new route, autoplay's loop back to the start) teleports the walker in the worker
      if (!run) acc = 0;
      else if (ready && !busy && acc > 0) { busy = true; worker.postMessage({ type: 'step', dt: Math.min(acc, 0.1), target, floorOnly: !free }); acc = 0; }
      for (const [k, s] of flashing) {
        if (s - dt > 0) { flashing.set(k, s - dt); continue; }
        flashing.delete(k); D.items[k].mesh.recolor = plain.get(k)!;
      }
      const lay = D.layout();
      for (const [k, v] of xf) {
        const p = lay.poses[k], tilted = 1 - 2 * (v[4] * v[4] + v[5] * v[5]) < 0.999;
        if (D.hold(k) || p.removed) continue;
        const yaw = Math.atan2(2 * (v[7] * v[6] + v[4] * v[5]), 1 - 2 * (v[5] * v[5] + v[6] * v[6]));
        if (!tilted && Math.hypot(v[1] - p.x, v[2] - p.y) < 0.005 && Math.abs(Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw))) < 0.01) continue;   // where the layout has it
        const gr = D.items[k].group;
        gr.position.set(v[1], v[2], Math.max(0, v[3]));
        gr.quaternion.copy(q.set(v[4], v[5], v[6], v[7]));
      }
      if (free && walkerPose) {
        walkerGroup.position.set(walkerPose.x, walkerPose.y, 0); walkerGroup.rotation.z = walkerPose.yaw;
        const dx = body.x - walkerPose.x, dy = body.y - walkerPose.y, d = Math.hypot(dx, dy);
        // farther than 0.4 m = a jump (setFree, entering free walk): the worker teleports the walker to the body instead
        if (d > 0.15 && d < 0.4) { body.x = walkerPose.x + (dx / d) * 0.15; body.y = walkerPose.y + (dy / d) * 0.15; }
      }
    },
    dispose() { worker.terminate(); void audio?.close(); flapMesh.removeFromParent(); },
  };
}
export type LivePhys = ReturnType<typeof createLivePhys>;

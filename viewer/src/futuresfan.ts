// The live futures fan, life-size in the kitchen (desktop, demo mode and VR: everything is scene objects). Every ~0.5 s
// fanworker.ts imagines ~30 futures 2.5 s ahead from where the walker is right now (futures.ts); each is drawn as a faint
// trail on the floor plus a translucent walker + person at its end, green if clean, red if it hits a hazard (the hazard
// flash red of wmghosts.ts). A card above the walker says how many hit what. Learned (the persona world model folded with
// a gait style) or the hand rule. The sample count adapts so the frame rate stays within ~10% of the rate without the fan.
import * as THREE from 'three';
import { card } from './reimagine.ts';
import { toWorldModel, type Persona } from './gaitfit.ts';
import { fanLabel, type Fan, type FanScene, type Fold } from './futures.ts';
import type { Layout, XY } from './grid.ts';
import type { WalkerCfg } from './walker.ts';
import type { WorldModel } from './worldmodel.ts';

export interface FanDeps {
  scene: THREE.Scene; walker: () => WalkerCfg; fanScene: () => Omit<FanScene, 'walker'>; worldModel?: WorldModel;
  body: () => { x: number; y: number; yaw: number }; route: () => XY[] | null; layout: () => Layout; fold: () => Fold | null;
  night: () => boolean; fps: () => number;
}
const EVERY_S = 0.5, MAX_N = 30, MIN_N = 10, SEGS = 12, PERSON_EVERY = 3, RED = 0xff3030, GREEN = 0x3ddc84;
const $ = (id: string) => document.getElementById(id);

export function createFuturesFan(D: FanDeps) {
  const root = new THREE.Group();
  root.visible = false; root.renderOrder = 5;
  D.scene.add(root);
  const worker = new Worker(new URL('./fanworker.ts', import.meta.url), { type: 'module' });
  let on = false, model: 'learned' | 'hand' = 'learned', style = 'mean', n = MAX_N, acc = EVERY_S, busy = false, seq = 0;
  let F: Fan | null = null, ms = 0, label: THREE.Sprite | null = null, text = '', sceneRef: object | null = null;
  let M: Persona | null = null, styles: { name: string; e: number[] }[] = [];
  // fps: the rate with the fan off (kept up to date while it is off) is the budget; checked every 2 s while it is on
  let offFps = 0, fpsT = 0, fpsSum = 0;
  const ready = Promise.all([fetch(`${import.meta.env.BASE_URL}gait/persona.json`).then(r => (r.ok ? r.json() : null)), fetch(`${import.meta.env.BASE_URL}gait/styles.json`).then(r => (r.ok ? r.json() : null))])
    .then(([m, s]) => {
      M = m; styles = s?.styles ?? [];
      const sel = $('fanstyle') as HTMLSelectElement | null;
      if (sel) sel.innerHTML = styles.map(st => `<option value="${st.name}">${st.name === 'mean' ? 'average person (mean embedding)' : st.name}</option>`).join('');
      sendModel();
    }).catch(() => sendModel());

  const mat = (opacity: number) => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false });
  const inst = (geo: THREE.BufferGeometry, m: THREE.Material, count: number) => {
    const im = new THREE.InstancedMesh(geo, m, count);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3); im.count = 0; im.renderOrder = 5; im.frustumCulled = false; root.add(im); return im;
  };
  const w0 = D.walker();
  const trail = inst(new THREE.BoxGeometry(1, 0.025, 0.003), mat(0.35), MAX_N * SEGS);
  // a person on every 3rd future only: 30 stacked translucent bodies turn into one opaque blob a metre in front of the camera
  const body = inst(new THREE.CylinderGeometry(0.13, 0.15, 1.15, 8), mat(0.12), MAX_N), head = inst(new THREE.SphereGeometry(0.1, 8, 6), mat(0.12), MAX_N);
  const frame = inst(new THREE.BoxGeometry(w0.depth_m, w0.width_m, 0.04), mat(0.28), MAX_N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1), up = q.clone().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const red = new THREE.Color(RED), green = new THREE.Color(GREEN), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);

  function wm(): WorldModel | null {
    if (model === 'hand') return null;
    const st = styles.find(s => s.name === style) ?? styles[0], w = D.walker();
    return M && st ? toWorldModel(M, st.e, w.user_gap_m + w.depth_m / 2 - M.mean_gap_m) : D.worldModel ?? null;
  }
  function sendModel() { worker.postMessage({ type: 'model', wm: wm() }); }
  worker.onmessage = ({ data: m }) => {
    busy = false;
    if (m.type === 'error') { console.error('[futures fan]', m.msg); const s = $('fanstatus'); if (s) s.textContent = `fan failed: ${m.msg.split('\n')[0]}`; return; }
    if (m.id !== seq || !on) return;
    F = m.F; ms = m.ms; draw();
  };
  const modelName = () => (model === 'hand' ? 'Hand rule' : 'World model');

  function draw() {
    if (!F) return;
    const w = D.walker(), off = w.user_gap_m + w.depth_m / 2;
    let t = 0;
    F.futures.forEach((f, i) => {
      const c = f.hazard ? red : green;
      for (let k = 1; k < f.walker.length && t < trail.instanceMatrix.count; k++, t++) {
        const [ax, ay] = f.walker[k - 1], [bx, by] = f.walker[k], len = Math.hypot(bx - ax, by - ay);
        m4.compose(v.set((ax + bx) / 2, (ay + by) / 2, 0.012), q.setFromAxisAngle(zAxis, Math.atan2(by - ay, bx - ax)), new THREE.Vector3(len, 1, 1));
        trail.setMatrixAt(t, m4); trail.setColorAt(t, c);
      }
      const [x, y, yaw] = f.end, px = x - Math.cos(yaw) * off, py = y - Math.sin(yaw) * off;
      if (i % PERSON_EVERY === 0) {
        const j = i / PERSON_EVERY;
        body.setMatrixAt(j, m4.compose(v.set(px, py, 0.6), up, one)); body.setColorAt(j, c);
        head.setMatrixAt(j, m4.makeTranslation(px + 0.08 * Math.cos(yaw), py + 0.08 * Math.sin(yaw), 1.4)); head.setColorAt(j, c);
      }
      frame.setMatrixAt(i, m4.compose(v.set(x, y, w.handle_height_m), q.setFromAxisAngle(zAxis, yaw), one)); frame.setColorAt(i, c);
    });
    trail.count = t; frame.count = F.futures.length; body.count = head.count = Math.ceil(F.futures.length / PERSON_EVERY);
    for (const im of [trail, body, head, frame]) { im.instanceMatrix.needsUpdate = true; im.instanceColor!.needsUpdate = true; }
    const lines = [fanLabel(F, modelName()), `imagined, ${model === 'hand' ? 'hand-rule steps' : `learned gait · ${style === 'mean' ? 'average person' : style}`}, 2.5 s ahead`];
    if (lines.join('|') !== text) {
      text = lines.join('|');
      if (label) { label.removeFromParent(); label.material.dispose(); }
      label = card(lines, Object.keys(F.counts).length ? '#ffd0d0' : '#c8ffd8', 'rgba(14,20,28,0.78)', 0.07); label.renderOrder = 6; root.add(label);
      const s = $('fanstatus'); if (s) s.textContent = `${lines[0]} (${n} sampled, ${ms.toFixed(0)} ms in the worker${F.path === 'heading' ? ', off the route: straight ahead' : ''})`;
    }
  }

  /** per frame (desktop step() and xrFrame()) */
  function update(dt: number) {
    const fps = D.fps();
    if (!on) { if (fps > 0) offFps = offFps ? 0.95 * offFps + 0.05 * fps : fps; return; }   // smoothed: the page-load dip doesn't set the budget
    const b = D.body();
    // above the fan, just ahead of the frame: over the body it sits behind the third-person camera's look point and is clipped
    const w = D.walker(), ahead = w.user_gap_m + w.depth_m / 2 + 0.6;
    if (label) label.position.set(b.x + ahead * Math.cos(b.yaw), b.y + ahead * Math.sin(b.yaw), 1.6);
    // adaptive count: drop 5 futures while the frame rate is >10% under the fan-off rate, add back when there's room
    // (the mean over the 2 s window: single 1 s readings jitter by more than 10% and would ratchet the count down)
    fpsT += dt; fpsSum += fps * dt;
    if (fpsT >= 2 && fps > 0) {
      const mean = fpsSum / fpsT;
      fpsT = fpsSum = 0;
      if (!offFps) offFps = mean;
      if (mean < 0.9 * offFps && n > MIN_N) n -= 5; else if (mean > 0.95 * offFps && n < MAX_N) n += 5;
    }
    const sc = D.fanScene();
    if (sc !== sceneRef) { sceneRef = sc; worker.postMessage({ type: 'init', scene: { ...sc, walker: D.walker() } }); }
    acc += dt;
    if (acc < EVERY_S || busy) return;
    acc = 0; busy = true;
    worker.postMessage({ type: 'fan', id: ++seq, layout: D.layout(), fold: D.fold(), state: { x: b.x, y: b.y, yaw: b.yaw }, route: D.route(), n, seed: seq, night: D.night() });
  }
  function set(v: boolean) {
    on = v; root.visible = v; acc = EVERY_S; fpsT = fpsSum = 0; F = null; text = '';
    if (!v) for (const im of [trail, body, head, frame]) im.count = 0;
    const cb = $('fanon') as HTMLInputElement | null; if (cb) cb.checked = v;
  }
  return {
    ready, set, update, on: () => on,
    setModel(m: 'learned' | 'hand') { model = m; sendModel(); text = ''; },
    setStyle(name: string) { style = name; sendModel(); text = ''; },
    /** for e2e and the recording: the last fan (futures, counts, spread), the sample count and the fps budget */
    state: () => ({ on, model, style, n, offFps, ms, label: text.split('|')[0], styles: styles.map(s => s.name),
      fan: F && { n: F.futures.length, counts: { ...F.counts }, spread_m: F.spread_m, path: F.path, red: F.futures.filter(f => f.hazard).length, hits: F.futures.flatMap(f => (f.at ? [f.at] : [])) } }),
    root,
  };
}

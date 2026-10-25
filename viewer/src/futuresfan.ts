// The live futures fan, life-size in the kitchen (desktop, demo mode and VR: everything is scene objects). Every ~0.5 s
// fanworker.ts imagines ~30 futures 4-5 s ahead from where the walker is right now (futures.ts); each step of each future is
// a faint foot mark on the floor (30 futures x ~6 steps: a scatter that widens with time, where a filled band of 30 near-
// identical trails read as one blob), plus one small faint walker outline on the floor at its end. Colour = that step's toe-catch chance
// (futures.ts, the calibrated contact table) relative to this room's worst step (Fan.step_top), on a log scale: grey under a
// tenth of it, orange -> red up to it; a step over the folded corner gets a red ring. The end outlines are grey, amber
// where the frame brushes furniture. A card above the walker says what they cross and the expected toe catches/month. Learned (the persona world model folded with
// a gait style) or the hand rule. Where the way ahead forks (over / around the mat, past / wide of a chair) each route gets
// a card at its tip with how many futures took it. Foot lift: average or low-clearance shuffler (futures.ts LIFTS).
// The sample count adapts so the frame rate stays within ~10% of the rate without the fan.
import * as THREE from 'three';
import { card } from './reimagine.ts';
import { toWorldModel, type Persona } from './gaitfit.ts';
import { fanLabel, stickyLead, routeLabel, LIFTS, type Fan, type FanScene, type Fold, type Lift } from './futures.ts';
import type { Layout, XY } from './grid.ts';
import type { WalkerCfg } from './walker.ts';
import type { WorldModel } from './worldmodel.ts';

export interface FanDeps {
  scene: THREE.Scene; walker: () => WalkerCfg; fanScene: () => Omit<FanScene, 'walker'>; worldModel?: WorldModel;
  body: () => { x: number; y: number; yaw: number }; route: () => XY[] | null; layout: () => Layout; fold: () => Fold | null;
  night: () => boolean; fps: () => number;
  /** fixed seed (demo autoplay, demorun.ts): every fan draws the same numbers and keeps all MAX_N futures */
  seed?: number | null;
}
const EVERY_S = 0.5, MAX_N = 30, MIN_N = 10, STEPS = 30, RED = 0xff2020, ORANGE = 0xff9a2e, GREY = 0x5f6b77, AMBER = 0xffc040, TOE_OUT = 0.12;
/** a future at this catch chance or more is full red: ~the fan's top futures over the mat edge (average lift 2.5-3%, shuffler up to 4%) */
export const P_RED = 0.03;
const $ = (id: string) => document.getElementById(id);

export function createFuturesFan(D: FanDeps) {
  const root = new THREE.Group();
  root.visible = false; root.renderOrder = 5;
  D.scene.add(root);
  const worker = new Worker(new URL('./fanworker.ts', import.meta.url), { type: 'module' });
  let on = false, model: 'learned' | 'hand' = 'learned', style = 'mean', lift: Lift = 'average', forks: THREE.Sprite[] = [], n = MAX_N, acc = EVERY_S, busy = false, seq = 0;
  const lead = stickyLead(1.5);
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
  // foot marks: a 14 x 6 cm sole (heel at the predicted heel, toed out a little per side), low opacity so the overlap shows the density
  const foot = inst(new THREE.CircleGeometry(0.5, 12).scale(0.14, 0.06, 1).translate(0.06, 0, 0), mat(0.5), MAX_N * STEPS);
  const ring = inst(new THREE.RingGeometry(0.075, 0.09, 20), mat(0.85), MAX_N * STEPS);
  // the end of each future: a 60%-size walker outline on the floor (a 4-segment ring is a square). Standing frames and bodies
  // at handle height stacked 30 deep into one opaque blob in front of the camera; outlines overlap only along their edges
  const frame = inst(new THREE.RingGeometry(0.9 / Math.SQRT2, 1 / Math.SQRT2, 4, 1, Math.PI / 4).scale(0.6 * w0.depth_m, 0.6 * w0.width_m, 1), mat(0.25), MAX_N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
  const red = new THREE.Color(RED), orange = new THREE.Color(ORANGE), grey = new THREE.Color(GREY), amber = new THREE.Color(AMBER), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  /** 0 = a tenth of this room's worst step or less (grey), 1 = the worst step or more (red); log10 in between */
  const level = (p: number, top: number) => (p <= 0 || top <= 0 ? 0 : Math.max(0, Math.min(1, 1 + Math.log10(p / top))));
  const shade = (p: number, top: number) => { const t = level(p, top); return t <= 0 ? grey : orange.clone().lerp(red, t); };

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
    let t = 0, nr = 0;
    F.futures.forEach((f, i) => {
      f.heels.forEach((h, k) => {
        // walker[k + 1] is the frame as this foot lands: its heading points the sole
        const a = f.walker[k] ?? f.walker[0], b = f.walker[k + 1] ?? a, st = f.steps[k], yaw = (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-3 ? Math.atan2(b[1] - a[1], b[0] - a[0]) : f.end[2]) + (st.left ? TOE_OUT : -TOE_OUT);
        foot.setMatrixAt(t, m4.compose(v.set(h[0], h[1], 0.012), q.setFromAxisAngle(zAxis, yaw), one)); foot.setColorAt(t++, shade(st.p, F!.step_top));
        if (st.edge === 'folded corner') { ring.setMatrixAt(nr, m4.makeTranslation(h[0] + 0.06 * Math.cos(yaw), h[1] + 0.06 * Math.sin(yaw), 0.014)); ring.setColorAt(nr++, red); }
      });
      const [x, y, yaw] = f.end;
      frame.setMatrixAt(i, m4.compose(v.set(x, y, 0.015), q.setFromAxisAngle(zAxis, yaw), one)); frame.setColorAt(i, f.hazard ? amber : grey);   // the risk colour is on the feet only
    });
    foot.count = t; ring.count = nr; frame.count = F.futures.length;
    for (const im of [foot, ring, frame]) { im.instanceMatrix.needsUpdate = true; im.instanceColor!.needsUpdate = true; }
    const lines = [fanLabel(F, modelName(), lead(F, performance.now() / 1000)), ...(routeLabel(F) ? [routeLabel(F)] : []),
      `imagined, ${model === 'hand' ? 'hand-rule steps' : `learned gait · ${style === 'mean' ? 'average person' : style}`} · ${LIFTS[F.lift].label}, ${F.ahead_s.toFixed(1)} s ahead`,
      `toe-catch risk (relative): grey < 1/10 of this room's worst step · orange → red (log) up to it, ${(F.step_top * 100).toFixed(2)}% a step · red ring = over the fold`];
    if (lines.join('|') !== text) {
      text = lines.join('|');
      if (label) { label.removeFromParent(); label.material.dispose(); }
      for (const f of forks) { f.removeFromParent(); f.material.dispose(); }
      // a card at each route's tip once the way ahead forks: "around the mat · 12/30"
      forks = F.routes.length > 1 ? F.routes.flatMap(r => {
        if (!r.tip || !r.n) return [];
        const hit = F!.futures.some(f => F!.routes[f.route] === r && f.p >= P_RED / 2), c = card([`${r.label} · ${r.n}/${F!.futures.length}`], hit ? '#ffd0d0' : '#c8ffd8', 'rgba(14,20,28,0.7)', 0.05);
        c.position.set(r.tip[0], r.tip[1], 0.5); c.renderOrder = 6; root.add(c); return [c];
      }) : [];
      label = card(lines, F.catches_month >= 0.1 ? '#ffd0d0' : '#c8ffd8', 'rgba(14,20,28,0.78)', 0.07); label.renderOrder = 6; root.add(label);
      const s = $('fanstatus'); if (s) s.textContent = `${lines.slice(0, -2).join(' · ')} (${n} sampled, ${ms.toFixed(0)} ms in the worker${F.path === 'heading' ? ', off the route: straight ahead' : ''}; route odds: ASSUMPTION, from path length)`;
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
    if (D.seed == null && fpsT >= 2 && fps > 0) {
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
    worker.postMessage({ type: 'fan', id: ++seq, layout: D.layout(), fold: D.fold(), state: { x: b.x, y: b.y, yaw: b.yaw }, route: D.route(), n, seed: D.seed ?? seq, night: D.night(), lift });
  }
  function set(v: boolean) {
    on = v; root.visible = v; acc = EVERY_S; fpsT = fpsSum = 0; F = null; text = '';
    if (!v) { for (const im of [foot, ring, frame]) im.count = 0; for (const f of forks) f.removeFromParent(); forks = []; }
    const cb = $('fanon') as HTMLInputElement | null; if (cb) cb.checked = v;
  }
  return {
    ready, set, update, on: () => on,
    /** demorun.ts lockstep: false while a fan this tick would send is still waiting on the last one */
    idle: (dt: number) => !on || !busy || acc + dt < EVERY_S,
    /** the layout just changed (taping): drop the fan in flight, it was sampled on the old layout and would show up after */
    refresh() { seq++; F = null; acc = EVERY_S; },
    setModel(m: 'learned' | 'hand') { model = m; sendModel(); text = ''; },
    setStyle(name: string) { style = name; sendModel(); text = ''; },
    setLift(l: Lift) { lift = l; text = ''; acc = EVERY_S; const sel = $('fanlift') as HTMLSelectElement | null; if (sel) sel.value = l; },
    /** for e2e and the recording: the last fan (futures, counts, spread), the sample count and the fps budget */
    state: () => ({ on, model, style, lift, n, offFps, ms, label: text.split('|')[0], lines: text.split('|'), styles: styles.map(s => s.name),
      fan: F && { n: F.futures.length, counts: { ...F.counts }, crossed: { ...F.crossed }, routes: F.routes.map(r => ({ ...r })), ahead_s: F.ahead_s, lift: F.lift, spread_m: F.spread_m, path: F.path,
        catches_month: F.catches_month, p: F.futures.map(f => f.p), red: F.futures.filter(f => f.p >= P_RED / 2).length, brushes: F.futures.filter(f => f.hazard).length, hits: F.futures.flatMap(f => (f.at ? [f.at] : [])),
        step_top: F.step_top, feet: F.futures.reduce((a, f) => a + f.heels.length, 0), hot: F.futures.flatMap(f => f.steps.filter(s => level(s.p, F!.step_top) > 0).map(s => ({ p: s.p, edge: s.edge }))), rings: F.futures.reduce((a, f) => a + f.steps.filter(s => s.edge === 'folded corner').length, 0) } }),
    root,
  };
}

// Walking gait ghosts, life-size in the room (desktop, demo mode and VR: everything is scene objects). Per gait (average foot lift,
// low-clearance shuffler), each its own colour: a translucent mannequin pushing a walker down every way the route can go (as planned,
// around the mat, wide of a chair), its feet planted on the world model's heels and swinging with that gait's foot lift (drawn
// exaggerated so the difference shows), plus that way's other imagined futures as trails on the floor. The way the gait most likely
// takes (odds from path length and its own catch chance there, gaitplan.ts in fanworker.ts) is drawn solid, the others fainter.
// Heels land as discs; a risky step glows amber, a drawn catch flashes red; where the route crosses a rug the corner can fold (the
// same measured chance for every gait: the walker moves the cloth, not the feet). A card per gait gives its ways, odds and toe
// catches per month; the panel lists every assumption (assumptions.ts). Imagined, never measured.
import * as THREE from 'three';
import { card } from './reimagine.ts';
import { buildWalker, type WalkerCfg } from './walker.ts';
import { toWorldModel, type Persona } from './gaitfit.ts';
import { arc, poseAtArc } from './wmghosts.ts';
import { buildMannequin, feetAt, type Step } from './mannequin.ts';
import { LIFTS, ROUTE_RISK_M, type FanScene } from './futures.ts';
import type { Fold, Layout, XY } from './grid.ts';
import { GAITS, type GaitId, type GhostPath, type GhostRun } from './gaitplan.ts';
import { assumptions, countAssumed, KIND_CSS } from './assumptions.ts';
import { P_FOLD } from './rugcascade.ts';
import { rng } from './sim.ts';
import type { WorldModel } from './worldmodel.ts';

export interface GaitDeps {
  scene: THREE.Scene; walker: () => WalkerCfg; fanScene: () => Omit<FanScene, 'walker'>; worldModel?: WorldModel;
  /** the planned route from its start (the walker frame's path) */
  route: () => XY[] | null; layout: () => Layout; fold: () => Fold | null; night: () => boolean;
  /** fixed seed (demo autoplay), else defaultSeed */
  seed?: number | null; defaultSeed?: number;
  /** the walks switched on or off (the host hides the old path traces while they walk) */
  onToggle?: (on: boolean) => void;
  /** a camera that sees the whole route (the panel's Overview button; turning the walks on leaves the camera and the walk mode alone,
   *  so the live futures fan keeps following the walker) */
  view?: () => void;
}
const SPEED = 0.45, FLASH_S = 0.5, RISKY = 0.01, EVERY_S = 0.5, TAG = 'imagined (world model)';
/** the swing's peak height as drawn: the average lift at 8 cm, each gait scaled by its lift (futures.ts LIFTS). Real minimum toe clearance
 *  is ~1.4 cm, so this is ~6x exaggerated to show at room scale: display only, nothing is computed from it (assumptions.ts drawn_lift) */
export const DRAWN_LIFT_M = 0.08;
const $ = (id: string) => document.getElementById(id);
const pct = (p: number) => `${Math.round(100 * p)}%`;
const f2 = (c: number) => (c >= 0.095 ? c.toFixed(1) : c >= 0.001 ? c.toFixed(2) : '0');

/** translucent and tinted, a little self-lit so it reads against the bright scan (wmghosts.ts does the same) */
function tint(o: THREE.Object3D, color: number, opacity: number) {
  const mats: THREE.MeshStandardMaterial[] = [];
  o.traverse(m => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    Object.assign(mat, { transparent: true, opacity, depthWrite: false });
    mat.color.setHex(color); mesh.material = mat; mesh.renderOrder = 5; mats.push(mat);
  });
  const glow = new THREE.Color(color).multiplyScalar(0.35);
  mats.forEach(m => m.emissive?.copy(glow));
  return { flash: (c: number | null) => mats.forEach(m => (c == null ? m.emissive?.copy(glow) : m.emissive?.setHex(c))) };
}

interface Actor {
  run: GhostRun; gi: number; pi: number; path: GhostPath; main: boolean; W: [number, number, number][]; d: number[]; steps: Step[]; stride: number; lift: number;
  group: THREE.Group; man: ReturnType<typeof buildMannequin>; walker: ReturnType<typeof buildWalker>; look: ReturnType<typeof tint>; trails: THREE.LineSegments;
  discs: THREE.InstancedMesh; label: THREE.Sprite | null; labelKey: string; fold: THREE.Group | null; draws: number[];
  next: number; flashT: number; flashC: number; caught: number; risky: number; folded: boolean; lastRisk: number;
}

export function createGaitGhosts(D: GaitDeps) {
  const root = new THREE.Group();
  root.visible = false; root.renderOrder = 5;
  D.scene.add(root);
  const worker = new Worker(new URL('./fanworker.ts', import.meta.url), { type: 'module' });
  let on = false, seed = D.seed ?? D.defaultSeed ?? 1, riskM = ROUTE_RISK_M, foldOn = true, enabled: Record<GaitId, boolean> = { average: true, shuffler: true };
  let runs: GhostRun[] = [], actors: Actor[] = [], key = '', busy = false, id = 0, ms = 0, acc = EVERY_S, s = 0, sceneRef: object | null = null, err = '';
  let M: Persona | null = null, styles: { e: number[] }[] = [];
  const m4 = new THREE.Matrix4();

  function wm(): WorldModel | null {
    const w = D.walker();
    return M && styles[0] ? toWorldModel(M, styles[0].e, w.user_gap_m + w.depth_m / 2 - M.mean_gap_m) : D.worldModel ?? null;
  }
  const sendModel = () => worker.postMessage({ type: 'model', wm: wm() });
  const ready = Promise.all([fetch(`${import.meta.env.BASE_URL}gait/persona.json`).then(r => (r.ok ? r.json() : null)), fetch(`${import.meta.env.BASE_URL}gait/styles.json`).then(r => (r.ok ? r.json() : null))])
    .then(([m, st]) => { M = m; styles = st?.styles ?? []; sendModel(); }).catch(sendModel);

  function untag(t: THREE.Sprite | null) { if (t) { t.removeFromParent(); t.material.dispose(); } }
  function clear() {
    for (const a of actors) {
      a.group.removeFromParent(); a.group.traverse(o => (o as THREE.Mesh).geometry?.dispose());
      for (const o of [a.discs, a.trails]) { o.removeFromParent(); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
      untag(a.label); a.fold?.removeFromParent();
    }
    actors = []; s = 0;
  }
  /** one actor per gait and per way it could go: a translucent mannequin + walker on that way's typical future, its other futures as trails */
  function build() {
    clear();
    const w = D.walker();
    actors = runs.flatMap((run, gi) => run.paths.map((path, pi) => {
      const gt = GAITS.find(g => g.id === run.gait)!, main = pi === run.pick, g = new THREE.Group(), man = buildMannequin(1.65), walker = buildWalker(w);
      g.add(man.group, walker.group); root.add(g);
      const look = tint(g, gt.color, main ? 0.62 : 0.25 + 0.3 * path.odds);
      const n = Math.max(1, path.trip.heels.length), W = path.poses, d = arc(W);
      const discs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.04, 0.04, 0.01, 12).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: main ? 0.9 : 0.5, depthTest: false }), n);
      discs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); discs.count = 0; discs.renderOrder = 6; discs.frustumCulled = false; root.add(discs);
      // the way's other futures, faint on the floor: amber where a future risks a catch somewhere (half of futuresfan.ts P_RED)
      const v: number[] = [], c: number[] = [], base = new THREE.Color(gt.color), warm = new THREE.Color(0xffc040);
      for (const t of path.trails) {
        const k = t.p >= 0.015 ? warm : base;
        for (let j = 1; j < t.walker.length; j++) { v.push(t.walker[j - 1][0], t.walker[j - 1][1], 0.03, t.walker[j][0], t.walker[j][1], 0.03); c.push(k.r, k.g, k.b, k.r, k.g, k.b); }
      }
      const trails = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: main ? 0.55 : 0.3, depthTest: false }));
      trails.geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); trails.geometry.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); trails.renderOrder = 5; root.add(trails);
      // feet: heel k lands with pose k + 1, so its arc length is d[k + 1]; the mannequin's stride is wmghosts.ts's (1.6 x the mean step)
      const steps: Step[] = path.trip.heels.map((xy, k) => ({ xy, side: path.left[k] ? 1 : 0, hit: false, s: d[k + 1] ?? d[d.length - 1] }));
      const R = rng(seed * 131 + gi * 17 + pi * 7 + 5);
      return { run, gi, pi, path, main, W, d, steps, stride: 1.6 * d[d.length - 1] / Math.max(1, d.length - 1), lift: DRAWN_LIFT_M * LIFTS[run.lift].scale,
        group: g, man, walker, look, trails, discs, label: null, labelKey: '', fold: null, draws: path.swings.map(() => R.u()), next: 0, flashT: 0, flashC: 0xff2020, caught: 0, risky: 0, folded: false, lastRisk: 0 };
    }));
  }
  function foldMark(a: Actor, f: Fold) {
    const g = new THREE.Group(), gt = GAITS[a.gi];
    const disc = new THREE.Mesh(new THREE.CircleGeometry(f.size_m, 32), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.55, depthWrite: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(f.size_m * 1.05, f.size_m * 1.3, 32), new THREE.MeshBasicMaterial({ color: gt.color, transparent: true, opacity: 0.9, depthWrite: false }));
    g.add(disc, ring); g.position.set(f.corner[0], f.corner[1], f.lift_m + 0.012); g.renderOrder = 2; root.add(g); return g;
  }
  function lines(a: Actor): string[] {
    const r = a.run, ro = r.routes[r.pick], gt = GAITS[a.gi], other = r.routes.filter((_, i) => i !== r.pick).map(x => `${pct(x.odds)} ${x.label || 'as planned'} (≈${f2(x.catches_month)})`);
    const L = [`${gt.label} · foot lift drawn ${Math.round(a.lift * 100)} cm (exaggerated)`, `${ro.label || 'as planned'} · ${pct(ro.odds)} of its walks${other.length ? `; else ${other.join(', ')}` : ''}`,
      `≈${f2(r.catches_month)} toe catches/month this way · ≈${f2(r.expected_month)} over its route odds`];
    if (a.flashT > 0) L.push(a.flashC === 0xff2020 ? 'toe caught on this step' : `toe risk ${pct(a.lastRisk)} on this step`);
    else if (a.folded) {
      const b = r.back;
      L.push(`rug corner folded here (${P_FOLD.toFixed(2)} per crossing, measured)`);
      if (b && b.folded_month - b.flat_month >= 0.02) L.push(`on the way back ≈${f2(b.folded_month)} catches/month with it (${f2(b.flat_month)} flat)`);
    }
    L.push(TAG);
    return L;
  }
  function status() {
    const el = $('gaitstatus');
    if (!el) return;
    if (err) { el.textContent = `gait ghosts failed: ${err.split('\n')[0]}`; return; }
    if (!runs.length) { el.textContent = !on ? '' : D.route() ? 'imagining the walks…' : 'no planned route in this scene to walk (its start and goal need a path for this walker)'; return; }
    const sc = D.fanScene(), n = countAssumed(assumptions(sc.risk, sc.persona.speed_mps));
    el.innerHTML = `<b>${TAG}</b> · ${runs.map(r => `${GAITS.find(g => g.id === r.gait)!.label}: ${r.routes.map(x => `${pct(x.odds)} ${x.label || 'as planned'}`).join(' / ')}, ≈${f2(r.catches_month)} catches/month this way`).join('<br>')}` +
      `<br><small>seed ${seed} · ${ms.toFixed(0)} ms in the worker · ${n} of the inputs are assumptions (listed below), not measurements</small>`;
  }

  function request() {
    const route = D.route();
    if (!on || busy || !route || route.length < 2) return;
    const sc = D.fanScene();
    if (sc !== sceneRef) { sceneRef = sc; worker.postMessage({ type: 'init', scene: { ...sc, walker: D.walker() } }); }
    busy = true; err = '';
    worker.postMessage({ type: 'ghosts', id: ++id, layout: D.layout(), fold: D.fold(), route, opts: { seed, riskM, foldP: foldOn ? P_FOLD : null, night: D.night() } });
  }
  worker.onmessage = ({ data: m }) => {
    busy = false;
    if (m.type === 'error') { err = m.msg; console.error('[gait ghosts]', m.msg); status(); return; }
    if (m.id !== id || !on) return;
    runs = m.runs; ms = m.ms; build(); status();
  };
  const keyOf = () => { const r = D.route(); return JSON.stringify([D.layout(), D.fold(), r?.length, r?.at(-1), seed, riskM, foldOn, D.night()]); };

  const col = new THREE.Color();
  /** per frame (desktop step() and xrFrame()) */
  function update(dt: number) {
    if (!on) return;
    acc += dt;
    if (acc >= EVERY_S) { acc = 0; const k = keyOf(); if (k !== key && !busy) { key = k; request(); } }
    if (!actors.length) return;
    s += SPEED * dt;
    const w = D.walker(), off = w.user_gap_m + w.depth_m / 2, hy = w.width_m / 2 - w.leg_radius_m, gx = w.user_gap_m + 0.05;
    for (const a of actors) {
      const gt = GAITS[a.gi], heels = a.path.trip.heels, vis = enabled[a.run.gait];
      a.group.visible = a.discs.visible = a.trails.visible = vis; if (a.fold) a.fold.visible = vis;
      while (a.next < heels.length && a.d[a.next + 1] !== undefined && a.d[a.next + 1] <= s) {   // heel next lands with pose next + 1
        const k = a.next, ps = a.path.swings[k] ?? 0, hit = a.draws[k] < ps, risky = ps >= RISKY;
        col.setHex(hit ? 0xff3030 : risky ? 0xffc040 : gt.color);
        m4.makeTranslation(heels[k][0], heels[k][1], 0.03); a.discs.setMatrixAt(k, m4); a.discs.setColorAt(k, col);
        a.discs.count = k + 1; a.discs.instanceMatrix.needsUpdate = true; a.discs.instanceColor!.needsUpdate = true;
        if (hit) a.steps[k].hit = true;
        if (hit || risky) { a.flashT = FLASH_S; a.flashC = hit ? 0xff2020 : 0xffa630; a.lastRisk = ps; a.caught += +hit; a.risky += +risky; }
        if (a.path.trip.fold && a.path.trip.foldStep === k && !a.fold) { a.fold = foldMark(a, a.path.trip.fold); a.folded = true; }
        a.next++;
      }
      a.flashT = Math.max(0, a.flashT - dt);
      a.look.flash(a.flashT > 0 ? a.flashC : null);
      // the walker frame and the person behind it (wmghosts.ts place()): feet on the heels, swinging at this gait's drawn lift
      const [x, y, yaw] = poseAtArc(a.W, a.d, s), body = { x: x - Math.cos(yaw) * off, y: y - Math.sin(yaw) * off, yaw };
      a.walker.group.position.set(body.x, body.y, 0); a.walker.group.rotation.z = yaw;
      const f = feetAt(a.steps, s, a.stride, a.lift);
      a.man.update(body, [f[1], f[0]], [[gx, hy], [gx, -hy]], w.handle_height_m);
      if (!a.main) continue;   // one card per gait, on the way it most likely takes
      const L = lines(a), k = L.join('|');
      if (a.labelKey !== k) { untag(a.label); a.label = card(L, gt.css, 'rgba(14,20,28,0.78)', 0.07); a.label.renderOrder = 6; root.add(a.label); a.labelKey = k; }
      a.label!.visible = vis; a.label!.position.set(body.x, body.y, 2.0 + 0.32 * a.gi);
    }
    if (s > Math.max(...actors.map(a => a.d[a.d.length - 1])) + 1.5) {   // everyone has arrived: loop
      s = 0;
      for (const a of actors) { a.next = 0; a.discs.count = 0; a.caught = a.risky = 0; a.folded = false; a.flashT = 0; a.fold?.removeFromParent(); a.fold = null; a.steps.forEach(st => (st.hit = false)); }
    }
  }

  function set(v: boolean) {
    on = v; root.visible = v; key = ''; acc = EVERY_S; D.onToggle?.(v);
    if (!v) { clear(); runs = []; } else request();
    const cb = $('gaiton') as HTMLInputElement | null; if (cb) cb.checked = v;
    status();
  }
  function renderAssumptions() {
    const el = $('gaitassume');
    if (!el) return;
    const sc = D.fanScene();
    el.innerHTML = assumptions(sc.risk, sc.persona.speed_mps).map(a => `<li><span style="color:${KIND_CSS[a.kind]}">●</span> ${a.label}: <b>${a.value}</b> <small>${a.kind}: ${a.note}</small></li>`).join('');
  }
  /** wire the panel (index.html #gaitpanel); the old path traces and the mannequin are the host's */
  function bind() {
    const chk = (id: string, f: (v: boolean) => void) => { const el = $(id) as HTMLInputElement | null; if (el) el.onchange = () => f(el.checked); };
    chk('gaiton', set);
    const ov = $('gaitview'); if (ov) ov.onclick = () => D.view?.();
    for (const g of GAITS) chk(`gait-${g.id}`, v => { enabled[g.id] = v; });
    chk('gaitfold', v => { foldOn = v; });
    const rk = $('gaitrisk') as HTMLInputElement | null;
    if (rk) {
      const show = () => { const o = $('gaitriskval'); if (o) o.textContent = `${(riskM / 100).toFixed(2)} m of detour per 1% catch chance`; };
      rk.value = String(riskM); rk.oninput = () => { riskM = Number(rk.value); show(); }; show();
    }
    const sd = $('gaitseed'); if (sd) sd.onclick = () => { seed++; };
    renderAssumptions();
  }
  return {
    ready, set, update, bind, on: () => on, setGait(g: GaitId, v: boolean) { enabled[g] = v; const el = $(`gait-${g}`) as HTMLInputElement | null; if (el) el.checked = v; },
    setSeed(n: number) { seed = n; }, setRisk(r: number) { riskM = r; }, setFold(v: boolean) { foldOn = v; }, idle: () => !busy, assumptions: () => assumptions(D.fanScene().risk),
    /** for e2e and the recording: the plan per gait and where playback is */
    state: () => ({ on, seed, riskM, foldOn, enabled: { ...enabled }, t: s, ms, error: err, busy,
      gaits: actors.filter(a => a.main).map(a => ({ gait: a.run.gait, route: a.run.routes[a.run.pick].label, odds: a.run.routes[a.run.pick].odds, routes: a.run.routes.map(x => ({ ...x })), catches_month: a.run.catches_month,
        expected_month: a.run.expected_month, folds: a.run.folds, steps: a.path.trip.heels.length, foldStep: a.path.trip.foldStep ?? null, landed: a.next, caught: a.caught, risky: a.risky, folded: a.folded,
        done: a.next >= a.path.trip.heels.length, visible: a.group.visible, label: a.labelKey, lift_m: a.lift,
        /** every way this gait could go, each walked by its own ghost */
        paths: actors.filter(b => b.run === a.run).map(b => ({ label: b.path.label, odds: b.path.odds, main: b.main, steps: b.path.trip.heels.length, landed: b.next, trails: b.path.trails.length, folded: b.folded })) })) }),
    root,
  };
}

// The world model, life-size in the kitchen (desktop and demo mode). Everything here is imagined and labelled so.
// - Two gait styles start together at the fridge: the population-mean embedding ("average person") and one
//   participant's, as translucent mannequins with walkers. A ghost flashes red where its step catches a toe or its
//   frame brushes something.
// - A fan of imagined futures is drawn ahead of the average ghost at each heel strike, and its predicted self (the
//   model's own walker pose ~0.5 s ahead) walks in front of it.
// - A month of trips (60) runs at once as low-detail ghosts, before and after the planner's fixes, with a counter.
// Trips are planner.ts score()'s own rollouts (imagine.ts, in the planner worker), walked by the persona network folded
// with each style's embedding (gaitfit.ts toWorldModel; styles from planner/persona_effect.py).
import * as THREE from 'three';
import { buildMannequin, feetAt, type Step } from './mannequin.ts';
import { buildWalker, type WalkerCfg } from './walker.ts';
import { toWorldModel, type Persona } from './gaitfit.ts';
import { card } from './reimagine.ts';
import { rng } from './sim.ts';
import type { Imagined, ImaginedStep } from './imagine.ts';
import type { PlanLayout } from './planner.ts';
import type { WorldModel } from './worldmodel.ts';

export interface Style { name: string; e: number[]; placement: { step_cm: number; lateral_cm: number; vs_mean_cm: number | null; steps: number }; scanned: { risk: number; brushes: number; contacts: number } }
export interface WmGhostDeps {
  scene: THREE.Scene; walker: () => WalkerCfg; view: () => void; /** show the mannequin on the ghosts (default: yes) */ mannequin?: () => boolean;   // a camera that sees the whole route (first person sits inside the ghosts)
  planfix: { layouts(): { now: PlanLayout; scan: PlanLayout; chosen: PlanLayout } | null; imagine(pl: PlanLayout, wm: WorldModel, n: number, nf?: number): Promise<Imagined>; goto(pl: PlanLayout): Promise<void> };
}
const SPEED = 0.45, AHEAD_S = 0.5, FLASH_S = 0.5, TAG = 'imagined (world model)';
const $ = (id: string) => document.getElementById(id)!;

/** arc length of the walker centre at each step: the clock every ghost is played on (one speed for all: the model
 *  predicts where feet and frame go, not how fast) */
export function arc(W: [number, number, number][]): number[] {
  const d = [0];
  for (let k = 1; k < W.length; k++) d.push(d[k - 1] + Math.hypot(W[k][0] - W[k - 1][0], W[k][1] - W[k - 1][1]));
  return d;
}
/** walker pose at arc length s (yaw by the short way round); past the end it stays at the last pose */
export function poseAtArc(W: [number, number, number][], d: number[], s: number): [number, number, number] {
  let k = 1;
  while (k < d.length - 1 && d[k] < s) k++;
  if (d.length < 2) return W[0];
  const f = THREE.MathUtils.clamp((s - d[k - 1]) / (d[k] - d[k - 1] || 1), 0, 1), a = W[k - 1], b = W[k];
  return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * Math.atan2(Math.sin(b[2] - a[2]), Math.cos(b[2] - a[2]))];
}
/** what one step caught, for the flash and the counter: a drawn toe contact, else the thing the frame brushed */
export const caught = (s: ImaginedStep) => (s.toe ? 'toe catch' : s.brush);

export function createWmGhosts(D: WmGhostDeps) {
  const root = new THREE.Group();
  root.renderOrder = 5;
  D.scene.add(root);
  let M: Persona | null = null, styles: Style[] = [];
  const ready = Promise.all([fetch(`${import.meta.env.BASE_URL}gait/persona.json`).then(r => (r.ok ? r.json() : null)), fetch(`${import.meta.env.BASE_URL}gait/styles.json`).then(r => (r.ok ? r.json() : null))])
    .then(([m, s]) => {
      M = m; styles = s?.styles ?? [];
      const sel = $('wgstyle') as HTMLSelectElement;
      sel.innerHTML = styles.slice(1).map(st => `<option>${st.name}</option>`).join('');
      $('wgstatus').textContent = M && styles.length ? '' : 'no persona model / styles (planner/persona_effect.py)';
    });
  const wmOf = (e: number[]) => { const w = D.walker(); return toWorldModel(M!, e, w.user_gap_m + w.depth_m / 2 - M!.mean_gap_m); };
  const offset = () => D.walker().user_gap_m + D.walker().depth_m / 2;   // body centre -> walker frame centre

  const walks = new Map<string, Promise<Imagined>>();
  const walk = (pl: PlanLayout, st: Style, nf: number) => {
    const key = JSON.stringify([pl, st.name, nf]);
    if (!walks.has(key)) walks.set(key, D.planfix.imagine(pl, wmOf(st.e), 1, nf));
    return walks.get(key)!;
  };
  function tag(lines: string[], fg = '#e9f6ff') { const s = card(lines, fg, 'rgba(14,20,28,0.78)', 0.07); s.renderOrder = 6; root.add(s); return s; }
  function untag(s: THREE.Sprite | null) { if (s) { s.removeFromParent(); s.material.dispose(); } }
  function translucent(o: THREE.Object3D, tint: number, opacity: number) {
    const mats: THREE.MeshStandardMaterial[] = [];
    o.traverse(m => {
      if (!(m instanceof THREE.Mesh)) return;
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      Object.assign(mat, { transparent: true, opacity, depthWrite: false });
      mat.color.setHex(tint);
      m.material = mat; m.renderOrder = 5; mats.push(mat);
    });
    const glow = new THREE.Color(tint).multiplyScalar(0.35);   // self-lit a little so the ghost reads against the bright scan
    mats.forEach(m => m.emissive.copy(glow));
    return { mats, flash: (on: boolean) => mats.forEach(m => (on ? m.emissive.setHex(0xff2020) : m.emissive.copy(glow))) };
  }

  // ---------- two gait styles, life-size ----------
  interface Actor { name: string; trip: ImaginedStep[]; W: [number, number, number][]; d: number[]; steps: Step[]; stride: number; man: ReturnType<typeof buildMannequin>;
    walker: ReturnType<typeof buildWalker>; look: ReturnType<typeof translucent>; label: THREE.Sprite | null; flashT: number; next: number; caught: string[] }
  let actors: Actor[] = [], futures: Imagined['futures'] = [], fan: THREE.Group | null = null, fanTag: THREE.Sprite | null = null, ahead: { walker: ReturnType<typeof buildWalker>; label: THREE.Sprite } | null = null;
  let s = 0, mode: 'off' | 'styles' | 'month' = 'off', fanShown = { k: -1, n: 0, hazard: 0, toe: 0 }, runId = 0;

  function actor(name: string, trip: ImaginedStep[], tint: number): Actor {
    const W = trip.map(t => t.walker), d = arc(W), man = buildMannequin(1.65), walker = buildWalker(D.walker()), g = new THREE.Group();
    man.group.visible = D.mannequin?.() ?? true;
    g.add(man.group, walker.group); root.add(g);
    const look = translucent(g, tint, 0.62), L = d[d.length - 1] / Math.max(1, d.length - 1);
    return { name, trip, W, d, steps: trip.map((t, k) => ({ xy: t.heel, side: t.side > 0 ? 1 : 0, hit: !!caught(t), s: d[k] })), stride: 1.6 * L, man, walker, look,
      label: null, flashT: 0, next: 0, caught: [] };
  }
  function clear() {
    runId++;
    for (const a of actors) { a.man.group.parent?.removeFromParent(); untag(a.label); }
    actors = [];
    if (fan) { fan.removeFromParent(); fan.traverse(o => (o as THREE.Mesh).geometry?.dispose()); fan = null; }
    untag(fanTag); fanTag = null;
    if (ahead) { ahead.walker.group.removeFromParent(); untag(ahead.label); ahead = null; }
    clearMonth();
    mode = 'off'; s = 0; fanShown = { k: -1, n: 0, hazard: 0, toe: 0 };
  }

  /** the average person and one participant's style, side by side from the fridge, in the room as it is now */
  async function twoStyles(name = ($('wgstyle') as HTMLSelectElement).value) {
    await ready;
    const L = D.planfix.layouts(), st = styles.find(x => x.name === name) ?? styles[1];
    if (!M || !L || !st) return null;
    ($('wgstyle') as HTMLSelectElement).value = st.name;
    clear(); D.view();
    const id = runId;
    $('wgstatus').textContent = `imagining the kitchen route for ${st.name}…`;
    const [a, b] = await Promise.all([walk(L.now, styles[0], 30), walk(L.now, st, 0)]);
    styles.slice(1).forEach(x => walk(L.now, x, 0));   // the other styles in the background: the swap is instant
    if (id !== runId) return null;
    actors = [actor('average person', a.trips[0], 0x4dc9f0), actor(`${st.name.split(' ')[0]}-style`, b.trips[0], 0xffb347)];
    futures = a.futures;
    fan = new THREE.Group(); fan.renderOrder = 4; root.add(fan);
    const w = buildWalker(D.walker());
    translucent(w.group, 0xffffff, 0.22);
    root.add(w.group);
    ahead = { walker: w, label: tag([`predicted self +${AHEAD_S} s`, TAG], '#ffffff') };
    mode = 'styles';
    const pl = (x: Style) => `${x.placement.step_cm} cm steps, ${x.placement.lateral_cm} cm off the route`;
    $('wgstatus').innerHTML = `<b>${TAG}</b>: average person (${pl(styles[0])}) vs ${st.name} (${pl(st)}; heel ${st.placement.vs_mean_cm} cm from the average's)` +
      `<br>this room: ${a.score.contacts.toFixed(2)} vs <b>${b.score.contacts.toFixed(2)}</b> toe catches/month (search objective ${a.score.risk.toFixed(1)} vs ${b.score.risk.toFixed(1)}; brushes ${a.score.brushes.toFixed(1)} vs ${b.score.brushes.toFixed(1)})`;
    return state();
  }

  function showFutures(k: number) {
    if (!fan) return;
    for (const o of [...fan.children]) { fan.remove(o); const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    const F = futures[k] ?? [];
    if (!F.length) return;
    // one segment list per colour: green clean, red a toe catch, amber the frame brushes something, within the next 4 steps
    for (const kind of ['clean', 'toe', 'brush']) {
      const v: number[] = [], h: number[] = [];
      for (const f of F) if ((f.hazard ? (f.hazard === 'toe catch' ? 'toe' : 'brush') : 'clean') === kind) {
        for (let j = 1; j < f.walker.length; j++) v.push(f.walker[j - 1][0], f.walker[j - 1][1], 0.04, f.walker[j][0], f.walker[j][1], 0.04);
        for (const p of f.heels) h.push(p[0], p[1], 0.03);
      }
      const col = kind === 'toe' ? 0xff3030 : kind === 'brush' ? 0xffa630 : 0x3ddc84, line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthTest: false }));
      line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      // heels as floor discs: points and 1 px lines vanish at room scale
      const dots = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false }), Math.max(1, h.length / 3));
      for (let i = 0; i < h.length / 3; i++) dots.setMatrixAt(i, m4.makeTranslation(h[3 * i], h[3 * i + 1], h[3 * i + 2]));
      dots.count = h.length / 3; dots.renderOrder = 6; line.renderOrder = 6;
      fan.add(line, dots);
    }
    const toe = F.filter(f => f.hazard === 'toe catch').length, br = F.filter(f => f.hazard && f.hazard !== 'toe catch'), what = [...new Set(br.map(f => f.hazard))].slice(0, 2).join(', ');
    fanShown = { k, n: F.length, hazard: toe + br.length, toe };
    untag(fanTag);
    fanTag = tag([`${F.length} imagined futures, next 4 steps`, `red toe catch ${toe} · amber brush ${br.length}${what ? ` (${what})` : ''} · green ${F.length - toe - br.length}`, TAG], toe ? '#ffb0b0' : br.length ? '#ffd9a8' : '#bff3d4');
    const end = F[0].walker[F[0].walker.length - 1];
    fanTag.position.set(end[0], end[1], 0.55);
  }

  function place(a: Actor, at: number) {
    const [x, y, yaw] = poseAtArc(a.W, a.d, at), body = { x: x - Math.cos(yaw) * offset(), y: y - Math.sin(yaw) * offset(), yaw }, w = D.walker();
    a.walker.group.position.set(body.x, body.y, 0); a.walker.group.rotation.z = yaw;
    const f = feetAt(a.steps, at, a.stride), hy = w.width_m / 2 - w.leg_radius_m, gx = w.user_gap_m + 0.05;
    a.man.update(body, [f[1], f[0]], [[gx, hy], [gx, -hy]], w.handle_height_m);
    return body;
  }

  // ---------- a month of trips at once ----------
  let month: { every: number; trips: ImaginedStep[][]; W: [number, number, number][][]; d: number[][]; next: number[]; flashT: number[]; snagAt: { k: number; what: string }[][];
    body: THREE.InstancedMesh; head: THREE.InstancedMesh; frame: THREE.InstancedMesh; counts: Record<string, number>; label: THREE.Sprite | null; which: string; key: string; im: Imagined } | null = null;
  function clearMonth() {
    if (!month) return;
    for (const m of [month.body, month.head, month.frame]) { m.removeFromParent(); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    untag(month.label); month = null;
  }
  /** 60 trips (a month: 2 a night) of the average person at once, as scanned ('before') or with the planner's fixes ('after') */
  async function runMonth(which: 'before' | 'after' = ($('wgmonthlay') as HTMLSelectElement).value as 'before' | 'after') {
    await ready;
    const L = D.planfix.layouts();
    if (!M || !L) return null;
    ($('wgmonthlay') as HTMLSelectElement).value = which;
    clear(); D.view();
    const id = runId, pl = which === 'before' ? L.scan : L.chosen;
    $('wgstatus').textContent = `${which === 'before' ? 'as scanned' : "with the planner's fixes"}: imagining a month of trips…`;
    await D.planfix.goto(pl);
    const im = await D.planfix.imagine(pl, wmOf(styles[0].e), 60);
    if (id !== runId) return null;
    // demo mode: every 3rd trip drawn (20 ghosts, coarser and unlit: 60 overlapping translucent figures on the splat cost
    // the frame rate); all 60 still walk and count
    const demo = document.body.classList.contains('demo'), every = demo ? 3 : 1;
    const n = im.trips.length, drawn = Math.ceil(n / every), w = D.walker(), mk = (geo: THREE.BufferGeometry) => {
      const opt = { color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false };
      const m = new THREE.InstancedMesh(geo, demo ? new THREE.MeshBasicMaterial(opt) : new THREE.MeshStandardMaterial(opt), drawn);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(drawn * 3), 3); m.renderOrder = 5; m.frustumCulled = false; root.add(m); return m;
    };
    // the batch tables' snags (mat slides, chair knocked) are rates per trip, not per step: drawn per trip with their own
    // seed, shown at the step nearest the object
    const R = rng(5);
    const snagAt = im.trips.map(t => im.snags.flatMap(o => (R.u() < o.per_month / im.trips_per_month ? [{
      k: t.reduce((b, st, k) => (Math.hypot(st.walker[0] - o.at[0], st.walker[1] - o.at[1]) < Math.hypot(t[b].walker[0] - o.at[0], t[b].walker[1] - o.at[1]) ? k : b), 0),
      what: `${o.object} ${o.event}` }] : [])));
    month = { every, trips: im.trips, W: im.trips.map(t => t.map(x => x.walker)), d: [], next: new Array(n).fill(0), flashT: new Array(n).fill(0), snagAt,
      body: mk(new THREE.CylinderGeometry(0.13, 0.15, 1.15, demo ? 5 : 8)), head: mk(new THREE.SphereGeometry(0.1, demo ? 5 : 8, demo ? 3 : 6)), frame: mk(new THREE.BoxGeometry(w.depth_m, w.width_m, 0.04)),
      counts: {}, label: null, which, key: '', im };
    month.d = month.W.map(arc);
    mode = 'month'; s = 0;
    return state();
  }
  function monthLines() {
    const c = month!.counts, toe = c['toe catch'] ?? 0, total = Object.values(c).reduce((a, b) => a + b, 0), top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const done = month!.next.filter((k, i) => k >= month!.trips[i].length).length;
    return [`${month!.which === 'before' ? 'as scanned' : "after the planner's fixes"}: ${done}/${month!.trips.length} trips (1 month) done · ${toe} toe catch${toe === 1 ? '' : 'es'} · ${total - toe} brushes / snags`,
      ...top.map(([k, v]) => `${k}: ${v}`), TAG];
  }

  // ---------- per frame ----------
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(1, 0, 0), zAxis = new THREE.Vector3(0, 0, 1), pv = new THREE.Vector3(), sv = new THREE.Vector3(), red = new THREE.Color(0xff3030), calm = new THREE.Color(0x9fd8ff);
  function update(dt: number) {
    if (mode === 'off') return;
    s += SPEED * dt;
    if (mode === 'styles') {
      actors.forEach((a, n) => {
        while (a.next < a.d.length && a.d[a.next] <= s) {   // heel a.next lands now
          const c = caught(a.trip[a.next]);
          if (c) { a.flashT = FLASH_S; a.caught.push(c); }
          if (n === 0) showFutures(a.next);
          a.next++;
        }
        a.flashT = Math.max(0, a.flashT - dt);
        a.look.flash(a.flashT > 0);
        const body = place(a, s), k = Math.max(0, a.next - 1), lines = [a.name, a.flashT > 0 ? `caught: ${a.trip[k] && caught(a.trip[k])}` : TAG], key = lines.join('|');
        if (a.label?.userData.key !== key) { untag(a.label); a.label = tag(lines, n ? '#ffd9a8' : '#bfeaff'); a.label.userData.key = key; }
        a.label.position.set(body.x, body.y, 2.05 + 0.3 * n);   // two labels never sit on each other
      });
      if (ahead && actors[0]) {
        const a = actors[0], [x, y, yaw] = poseAtArc(a.W, a.d, s + SPEED * AHEAD_S);
        ahead.walker.group.position.set(x - Math.cos(yaw) * offset(), y - Math.sin(yaw) * offset(), 0); ahead.walker.group.rotation.z = yaw;
        ahead.label.position.set(x, y, 1.0);
      }
      if (actors.length && s > Math.max(...actors.map(a => a.d[a.d.length - 1])) + 1.5) {   // both arrived: loop
        s = 0; actors.forEach(a => { a.next = 0; a.caught = []; });
      }
    } else if (month) {
      const M2 = month, w = D.walker();
      M2.trips.forEach((t, i) => {
        // trips leave the fridge 0.12 s apart: all 60 walk the same route, so started together they'd draw as one ghost
        const si = s - i * 0.12 * SPEED, sc = si < 0 ? 0 : 1;
        while (M2.next[i] < t.length && M2.d[i][M2.next[i]] <= si) {
          const k = M2.next[i], st = t[k], hits = [caught(st), ...M2.snagAt[i].filter(x => x.k === k).map(x => x.what)].filter(Boolean) as string[];
          for (const h of new Set(hits)) {
            // brushes count once per thing per trip, as the score counts them
            const seen = t.slice(0, k).some(p => p.brush === h && !p.toe);
            if (h === 'toe catch' || !seen || M2.snagAt[i].some(x => x.what === h)) M2.counts[h] = (M2.counts[h] ?? 0) + 1;
          }
          if (hits.length) M2.flashT[i] = FLASH_S;
          M2.next[i]++;
        }
        M2.flashT[i] = Math.max(0, M2.flashT[i] - dt);
        if (i % M2.every) return;
        const j = i / M2.every, [x, y, yaw] = poseAtArc(M2.W[i], M2.d[i], Math.max(0, si)), bx = x - Math.cos(yaw) * offset(), by = y - Math.sin(yaw) * offset();
        q.setFromAxisAngle(up, Math.PI / 2); sv.setScalar(sc);
        M2.body.setMatrixAt(j, m4.compose(pv.set(bx, by, 0.6), q, sv));
        M2.head.setMatrixAt(j, m4.makeTranslation(bx + 0.08 * Math.cos(yaw), by + 0.08 * Math.sin(yaw), 1.4).scale(sv));
        M2.frame.setMatrixAt(j, m4.compose(pv.set(x, y, w.handle_height_m), q.setFromAxisAngle(zAxis, yaw), sv));
        const c = M2.flashT[i] > 0 ? red : calm;
        for (const m of [M2.body, M2.head, M2.frame]) m.setColorAt(j, c);
      });
      for (const m of [M2.body, M2.head, M2.frame]) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; }
      const lines = monthLines(), key = lines.join('|');
      if (key !== M2.key) {
        M2.key = key; untag(M2.label); M2.label = tag(lines, '#ffd0d0');
        const t0 = M2.trips[0], st = t0[t0.length >> 1]?.walker ?? [0, 0, 0];   // over the middle of the route: in view from any angle
        M2.label.position.set(st[0], st[1], 2.0);
        $('wgstatus').innerHTML = `${lines.slice(0, -1).join('<br>')}<br><small>${TAG}: the evaluator expects ${M2.im.score.contacts.toFixed(2)} toe catches/month in this layout ` +
          `(search objective ${M2.im.score.risk.toFixed(1)}: + snags ${M2.im.score.snags.toFixed(1)}, brushes ${M2.im.score.brushes.toFixed(1)}); this is one month's draw</small>`;
      }
    }
  }

  const state = () => ({ mode, s, styles: styles.map(x => x.name),
    actors: actors.map(a => ({ name: a.name, steps: a.trip.length, heels: a.trip.map(t => t.heel), caught: [...a.caught], flashing: a.flashT > 0, done: a.next >= a.d.length })),
    fan: fanShown, futures_steps: futures.filter(f => f.length).length,
    month: month ? { which: month.which, trips: month.trips.length, counts: { ...month.counts }, done: month.next.every((k, i) => k >= month!.trips[i].length), expected: month.im.score } : null });
  return { ready, twoStyles, month: runMonth, stop: clear, update, state };
}

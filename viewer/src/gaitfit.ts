// Gait personalization (worldmodel/persona.py): the world model with a per-person gait embedding, fitted online from what
// a headset sees (walker + head when each heel lands; the feet are not tracked). Starts at the population mean and takes
// Adam steps on the embedding only (network frozen) after every observed step. Desktop replays a held-out PhysioNet
// participant as "the user" (measured, never trained on); VR feeds observe() (HANDOFF_GAIT.md). Shows a predicted-self
// ghost, the next-step error of mean vs fitted embedding, and a 2-D style map of the training people with the user's dot.
// "Re-plan for me" folds the embedding into a plain WorldModel and reruns the planner with it (planfix.ts replanFor).
import * as THREE from 'three';
import { frame, toLocal, toWorld, type WorldModel } from './worldmodel.ts';
import type { XY } from './grid.ts';

export interface Persona {
  K: number; E: number; min_w: number; mean_gap_m: number; x_mean: number[]; x_std: number[]; x_min: number[]; x_max: number[];
  layers: { W: number[][]; b: number[] }[]; e_pop: number[]; people: { pid: number; e: number[]; map: number[] }[];
  map_axes: number[][]; map_center: number[]; fit: { steps: number; lr: number; window_s: number; prior_w: number; prior_prec: number[][] }; trained_on: string;
}
/** one step: state when a heel lands (heels newest first, sides, route ahead) and what the headset saw when the next landed */
export interface GaitSample { heels: XY[]; sides: number[]; action: XY[]; walker1: [number, number, number]; head1: [number, number, number]; dt: number; heel1?: XY }
type Stream = { heel1: XY[]; heels: XY[][]; sides: number[][]; action: XY[][]; walker1: number[][]; head1: number[][]; dt: number[]; trial: string[] };

/** persona.py features + targets: x (10,) as learned.py, y = [heel xy, walker x y yaw, head x y z] in the step's local frame */
export function sampleXY(s: GaitSample) {
  const f = frame(s.heels, s.sides, s.action);
  const x = [s.heels[1], s.heels[2], ...s.action].flatMap(p => toLocal(f, p));
  const d: XY = [Math.cos(s.walker1[2]), Math.sin(s.walker1[2])];
  const yaw = Math.atan2(f.mir * (-d[0] * f.t[1] + d[1] * f.t[0]), d[0] * f.t[0] + d[1] * f.t[1]);
  const heel = s.heel1 ? toLocal(f, s.heel1) : [NaN, NaN];   // the headset never sees it: only scored when the replay has it
  return { f, x, y: [...heel, ...toLocal(f, [s.walker1[0], s.walker1[1]]), yaw, ...toLocal(f, [s.head1[0], s.head1[1]]), s.head1[2]] };
}

/** persona.py Net forward: the hidden layer's x part is fixed per sample, so fitting only recomputes e's contribution */
export function forward(m: Persona, x: number[], e: number[]): number[] {
  let h = [...x.map((v, i) => (v - m.x_mean[i]) / m.x_std[i]), ...e];
  m.layers.forEach((l, li) => {
    h = l.W.map((row, o) => row.reduce((a, w, i) => a + w * h[i], l.b[o]));
    if (li < m.layers.length - 1) h = h.map(v => v / (1 + Math.exp(-v)));
  });
  return h;
}
const cl = (v: number) => Math.min(2, Math.max(-7, v));
/** walker + head negative log likelihood of one observed step (persona.py nll, the parts a headset can see) */
export function obsNll(m: Persona, o: number[], y: number[]) {
  const b = 5 * m.K, g = (d: number, s: number) => 0.5 * (d / Math.exp(cl(s))) ** 2 + cl(s) + 0.5 * Math.log(2 * Math.PI);
  const dyaw = Math.atan2(Math.sin(y[4] - o[b + 2]), Math.cos(y[4] - o[b + 2]));
  return g(y[2] - o[b], o[b + 3]) + g(y[3] - o[b + 1], o[b + 4]) + g(dyaw, o[b + 5]) +
    g(y[5] - o[b + 6], o[b + 9]) + g(y[6] - o[b + 7], o[b + 10]) + g(y[7] - o[b + 8], o[b + 11]);
}
/** next-step errors (cm) of one prediction: heel = mixture mean, walker xy, head xyz */
export function stepErr(m: Persona, o: number[], y: number[]) {
  const lg = [...Array(m.K)].map((_, k) => o[5 * k]), mx = Math.max(...lg), w = lg.map(v => Math.exp(v - mx)), z = w.reduce((a, c) => a + c);
  const hx = w.reduce((a, v, k) => a + (v / z) * o[5 * k + 1], 0), hy = w.reduce((a, v, k) => a + (v / z) * o[5 * k + 2], 0), b = 5 * m.K;
  return { heel: 100 * Math.hypot(hx - y[0], hy - y[1]), walker: 100 * Math.hypot(o[b] - y[2], o[b + 1] - y[3]),
    head: 100 * Math.hypot(o[b + 6] - y[5], o[b + 7] - y[6], o[b + 8] - y[7]), heelLocal: [hx, hy] as XY };
}

/** embedding folded into the first layer's bias: a plain WorldModel (worldmodel.ts predict) for this person */
export function toWorldModel(m: Persona, e: number[], shift: number): WorldModel {
  const [l0, ...rest] = m.layers, nx = m.x_mean.length;
  return { K: m.K, min_w: m.min_w, mean_gap_m: m.mean_gap_m, x_mean: m.x_mean, x_std: m.x_std, x_min: m.x_min, x_max: m.x_max, shift,
    layers: [{ W: l0.W.map(r => r.slice(0, nx)), b: l0.b.map((v, o) => e.reduce((a, ej, j) => a + l0.W[o][nx + j] * ej, v)) }, ...rest] };
}

/** Adam on e, central finite differences (8 dims: 16 passes per sample) of mean NLL + prior_w/n x the training-embedding
 *  Gaussian around e_pop (persona.py fit: a tempered posterior, so a few head samples can't drag e off the training people) */
export function fitSteps(m: Persona, obs: { x: number[]; y: number[] }[], e: number[], st: { mo: number[]; v: number[]; t: number }, iters: number) {
  const P = m.fit.prior_prec, d = (q: number[]) => q.map((v, i) => v - m.e_pop[i]);
  const J = (q: number[]) => { const u = d(q); return obs.reduce((a, s) => a + obsNll(m, forward(m, s.x, q), s.y), 0) / obs.length
    + m.fit.prior_w * 0.5 * u.reduce((a, ui, i) => a + ui * P[i].reduce((b, p, j) => b + p * u[j], 0), 0) / obs.length; };
  const h = 1e-3, lr = m.fit.lr;
  for (let it = 0; it < iters; it++) {
    const g = e.map((_, j) => { const a = [...e], b = [...e]; a[j] += h; b[j] -= h; return (J(a) - J(b)) / (2 * h); });
    st.t++;
    e = e.map((v, j) => {
      st.mo[j] = 0.9 * st.mo[j] + 0.1 * g[j]; st.v[j] = 0.999 * st.v[j] + 0.001 * g[j] ** 2;
      return v - (lr * st.mo[j]) / (1 - 0.9 ** st.t) / (Math.sqrt(st.v[j] / (1 - 0.999 ** st.t)) + 1e-8);
    });
  }
  return e;
}

export interface GaitDeps { scene: THREE.Scene; walker: () => { width_m: number; depth_m: number; user_gap_m: number }; replan: (wm: WorldModel, label: string) => Promise<unknown> }
const $ = (id: string) => document.getElementById(id)!;

export function createGaitFit(D: GaitDeps) {
  const url = (f: string) => `${import.meta.env.BASE_URL}gait/${f}`;
  let M: Persona | null = null, streams: Record<string, Stream> = {};
  const ready = Promise.all([fetch(url('persona.json')).then(r => (r.ok ? r.json() : null)), fetch(url('persona_stream.json')).then(r => (r.ok ? r.json() : null))])
    .then(([m, s]) => { M = m; streams = s?.people ?? {}; $('gfstatus').textContent = m ? `${m.trained_on}` : 'no gait model (worldmodel/persona.py)'; reset(); })
    .catch(() => { $('gfstatus').textContent = 'no gait model (worldmodel/persona.py)'; });
  let e: number[] = [], adam = { mo: [] as number[], v: [] as number[], t: 0 }, obs: { x: number[]; y: number[] }[] = [];
  let hist: { t: number; pop: ReturnType<typeof stepErr>; fit: ReturnType<typeof stepErr> }[] = [], trail: number[][] = [], tsec = 0, playing = false, who = '';
  let last: { sample: GaitSample; pop: number[]; fit: number[]; f: ReturnType<typeof frame> } | null = null;

  // in-world ghost (scene objects, so it also renders in the headset): head + walker where the model expects the user
  const ghost = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0x4dc9f0, transparent: true, opacity: 0.5, depthTest: false });
  const headM = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), mat), frameM = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 0.85)), new THREE.LineBasicMaterial({ color: 0x4dc9f0, depthTest: false }));
  ghost.add(headM, frameM); ghost.visible = false; ghost.renderOrder = 4; D.scene.add(ghost);
  // the style map as a texture, so the VR side can hang it on a controller (HANDOFF_GAIT.md)
  const mapTex = new THREE.CanvasTexture($('gfmap') as HTMLCanvasElement);
  const panel = new THREE.Sprite(new THREE.SpriteMaterial({ map: mapTex, depthTest: false }));
  panel.scale.set(0.4, 0.3, 1); panel.visible = false;

  function reset() {
    if (!M) return;
    e = [...M.e_pop]; adam = { mo: e.map(() => 0), v: e.map(() => 0), t: 0 }; obs = []; hist = []; trail = [mapOf(e)]; tsec = 0; last = null; draw();
  }
  const mapOf = (q: number[]) => M!.map_axes.map(ax => ax.reduce((a, v, j) => a + v * (q[j] - M!.map_center[j]), 0));

  /** one observed step: score the predictions made BEFORE seeing it (mean and current embedding), then fit on it */
  function observe(s: GaitSample, world = true) {
    if (!M) return null;
    const { f, x, y } = sampleXY(s);
    const oPop = forward(M, x, M.e_pop), oFit = forward(M, x, e);
    const r = { t: tsec, pop: stepErr(M, oPop, y), fit: stepErr(M, oFit, y) };
    hist.push(r); last = { sample: s, pop: oPop, fit: oFit, f };
    tsec += s.dt;
    obs.push({ x, y });
    if (obs.length > 60) obs.shift();   // shortcut: fits the last 60 steps (~1 min) only, to stay a few ms per step; fine while one person walks
    e = fitSteps(M, obs, e, adam, 8);
    trail.push(mapOf(e));
    if (world) placeGhost(s, oFit, f);
    draw();
    return { err: { pop: r.pop, fit: r.fit }, e: [...e] };
  }
  function placeGhost(s: GaitSample, o: number[], f: ReturnType<typeof frame>) {
    const b = 5 * M!.K, hd = toWorld(f, [o[b + 6], o[b + 7]]), wk = toWorld(f, [o[b], o[b + 1]]), a = Math.atan2(f.t[1], f.t[0]) + f.mir * o[b + 2];
    const w = D.walker(), sh = w.user_gap_m + w.depth_m / 2 - M!.mean_gap_m;   // the sim's walker frame centre (learned.py Learned.shift)
    headM.position.set(hd[0], hd[1], o[b + 8]);
    frameM.scale.set(w.depth_m, w.width_m, 1); frameM.position.set(wk[0] + sh * Math.cos(a), wk[1] + sh * Math.sin(a), 0.425); frameM.rotation.z = a;
    ghost.visible = true;
    void s;
  }

  // ---- panel drawing: predicted-self ghost (top-down, follows the user), error meter, style map
  function draw() {
    if (!M) return;
    const avg = (k: 'heel' | 'head' | 'walker', w: 'pop' | 'fit', n = 10) => { const r = hist.slice(-n); return r.length ? r.reduce((a, h) => a + h[w][k], 0) / r.length : NaN; };
    const f1 = (v: number) => (isNaN(v) ? '–' : v.toFixed(1));
    $('gfmeter').innerHTML = hist.length ? `<b>${who}</b> · ${tsec.toFixed(0)} s, ${hist.length} steps<br>next-step error, last 10 steps (cm): heel <b>${f1(avg('heel', 'fit'))}</b> vs mean ${f1(avg('heel', 'pop'))} · ` +
      `head <b>${f1(avg('head', 'fit'))}</b> vs ${f1(avg('head', 'pop'))} · walker <b>${f1(avg('walker', 'fit'))}</b> vs ${f1(avg('walker', 'pop'))}` : 'no steps yet';
    // error over time: fitted (cyan) vs population mean (grey), heel + head
    const cv = $('gfchart') as HTMLCanvasElement, c = cv.getContext('2d')!, W = cv.width, H = cv.height, P = 22;
    c.clearRect(0, 0, W, H);
    const tot = (h: typeof hist[0], k: 'pop' | 'fit') => h[k].heel + h[k].head;
    const sm = (k: 'pop' | 'fit') => hist.map((_, i) => { const r = hist.slice(Math.max(0, i - 4), i + 1); return r.reduce((a, h) => a + tot(h, k), 0) / r.length; });
    const sp = sm('pop'), sf = sm('fit'), ymax = Math.max(10, ...sp, ...sf), tmax = Math.max(40, tsec);
    const X = (t: number) => P + (t / tmax) * (W - P - 4), Y = (v: number) => H - 14 - (v / ymax) * (H - 20);
    c.strokeStyle = '#3a4048'; c.beginPath(); c.moveTo(P, 2); c.lineTo(P, H - 14); c.lineTo(W, H - 14); c.stroke();
    c.fillStyle = '#9aa0a6'; c.font = '10px system-ui'; c.fillText('s', W - 8, H - 3); c.fillText(ymax.toFixed(0), 0, 10); c.fillText('heel+head err cm', P + 4, 10);
    c.fillText(`${M.fit.window_s}`, X(M.fit.window_s) - 6, H - 3);
    c.setLineDash([2, 3]); c.beginPath(); c.moveTo(X(M.fit.window_s), 2); c.lineTo(X(M.fit.window_s), H - 14); c.stroke(); c.setLineDash([]);
    for (const [s, col] of [[sp, '#9aa0a6'], [sf, '#4dc9f0']] as const) {
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath(); s.forEach((v, i) => (i ? c.lineTo : c.moveTo).call(c, X(hist[i].t), Y(v))); c.stroke(); c.lineWidth = 1;
    }
    drawGhost(); drawMap();
  }
  function drawGhost() {
    const cv = $('gfghost') as HTMLCanvasElement, c = cv.getContext('2d')!, W = cv.width, H = cv.height;
    c.fillStyle = '#111418'; c.fillRect(0, 0, W, H);
    if (!last) return;
    const b = 5 * M!.K, { sample: s, f } = last, cen = s.head1, sc = 90;
    const P = (p: number[]) => [W / 2 + (p[0] - cen[0]) * sc, H / 2 - (p[1] - cen[1]) * sc];
    const dot = (p: number[], r: number, col: string, fill = true) => { const q = P(p); c.beginPath(); c.arc(q[0], q[1], r, 0, 7); if (fill) { c.fillStyle = col; c.fill(); } else { c.strokeStyle = col; c.lineWidth = 2; c.stroke(); c.lineWidth = 1; } };
    const walk = (p: number[], yaw: number, col: string) => { const q = P(p); c.save(); c.translate(q[0], q[1]); c.rotate(-yaw); c.strokeStyle = col; c.lineWidth = 2; c.strokeRect(-0.1 * sc, -0.3 * sc, 0.2 * sc, 0.6 * sc); c.restore(); c.lineWidth = 1; };
    const pr = (o: number[], col: string) => {
      const h = toWorld(f, [o[b + 6], o[b + 7]]), w = toWorld(f, [o[b], o[b + 1]]), a = Math.atan2(f.t[1], f.t[0]) + f.mir * o[b + 2];
      const lg = [...Array(M!.K)].map((_, k) => o[5 * k]), mx = Math.max(...lg), ww = lg.map(v => Math.exp(v - mx)), z = ww.reduce((x, y) => x + y);
      const hl = toWorld(f, [ww.reduce((x, v, k) => x + (v / z) * o[5 * k + 1], 0), ww.reduce((x, v, k) => x + (v / z) * o[5 * k + 2], 0)]);
      walk(w, a, col); dot(h, 6, col, false); dot(hl, 3, col);
    };
    pr(last.pop, '#9aa0a6'); pr(last.fit, '#4dc9f0');
    walk([s.walker1[0], s.walker1[1]], s.walker1[2], '#ffffff'); dot(s.head1, 4, '#ffffff');
    dot(s.heels[0], 2.5, '#ffffff');
    c.fillStyle = '#9aa0a6'; c.font = '10px system-ui';
    c.fillText('measured', 4, 12); c.fillStyle = '#4dc9f0'; c.fillText('predicted (you)', 4, 24); c.fillStyle = '#9aa0a6'; c.fillText('predicted (mean)', 4, 36);
    c.fillText('top-down, 1 m', 4, H - 6); c.fillStyle = '#ffffff'; c.fillRect(70, H - 9, sc, 2);
  }
  function drawMap() {
    const cv = $('gfmap') as HTMLCanvasElement, c = cv.getContext('2d')!, W = cv.width, H = cv.height;
    c.fillStyle = '#111418'; c.fillRect(0, 0, W, H);
    const pts = [...M!.people.map(p => p.map), ...trail], r = Math.max(0.5, ...pts.flatMap(p => p.map(Math.abs))) * 1.15;
    const P = (p: number[]) => [W / 2 + (p[0] / r) * (W / 2 - 8), H / 2 - (p[1] / r) * (H / 2 - 8)];
    c.font = '10px system-ui';
    for (const p of M!.people) { const q = P(p.map); c.fillStyle = '#9aa0a6'; c.beginPath(); c.arc(q[0], q[1], 3, 0, 7); c.fill(); c.fillText(`P${String(p.pid).padStart(2, '0')}`, q[0] + 4, q[1] - 3); }
    c.strokeStyle = 'rgba(77,201,240,0.6)'; c.beginPath(); trail.forEach((p, i) => { const q = P(p); (i ? c.lineTo : c.moveTo).call(c, q[0], q[1]); }); c.stroke();
    const q = P(trail[trail.length - 1]); c.fillStyle = '#4dc9f0'; c.beginPath(); c.arc(q[0], q[1], 5, 0, 7); c.fill(); c.fillText('you', q[0] + 6, q[1] + 10);
    c.fillStyle = '#9aa0a6'; c.fillText('gait style map (training people, 2 main axes)', 4, 11);
    mapTex.needsUpdate = true;
  }

  /** desktop: a held-out participant's measured stream plays as "the user", real time / speed */
  async function play(speed = 1, pid?: string) {
    await ready;
    if (!M || playing) return null;
    const id = pid ?? Object.keys(streams)[0], s = streams[id];
    if (!s) return null;
    reset(); playing = true; who = `held-out participant P${id} (measured, PhysioNet)`;
    ghost.visible = false;   // lab coordinates: the 3-D ghost only follows a user walking in this room (observe from xr)
    for (let i = 0; i < s.dt.length && playing; i++) {
      observe({ heels: s.heels[i], sides: s.sides[i], action: s.action[i], walker1: s.walker1[i] as GaitSample['walker1'], head1: s.head1[i] as GaitSample['head1'], dt: s.dt[i], heel1: s.heel1[i] }, false);
      await new Promise(r => setTimeout(r, (1000 * s.dt[i]) / speed));
    }
    playing = false;
    return state();
  }
  const shift = () => { const w = D.walker(); return w.user_gap_m + w.depth_m / 2 - M!.mean_gap_m; };
  /** the planner rerun with this person's world model (and, for comparison, the same network at the population mean) */
  const replan = () => (M ? D.replan(toWorldModel(M, e, shift()), who || 'you') : Promise.resolve(null));
  const state = () => {
    const tail = hist.slice(-10), m = (k: 'pop' | 'fit', q: 'heel' | 'head' | 'walker') => tail.reduce((a, h) => a + h[k][q], 0) / (tail.length || 1);
    return { loaded: !!M, playing, steps: hist.length, seconds: tsec, e: [...e], map: trail[trail.length - 1],
      err_last10: { heel: { pop: m('pop', 'heel'), fit: m('fit', 'heel') }, head: { pop: m('pop', 'head'), fit: m('fit', 'head') }, walker: { pop: m('pop', 'walker'), fit: m('fit', 'walker') } } };
  };
  return { ready, play, stop: () => { playing = false; }, reset, observe, replan, state, ghost, panel, people: () => Object.keys(streams),
    worldModel: () => (M ? toWorldModel(M, e, shift()) : null), popWorldModel: () => (M ? toWorldModel(M, M.e_pop, shift()) : null) };
}

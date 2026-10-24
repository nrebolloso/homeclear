import { cameraToW2C } from './frame.ts';   // first: sets the +z-up convention before any camera exists
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { stamp, placementOk, polyCells, worldFootprint, toCell, applyIntervention, type GridMeta, type Layers, type Layout, type Pose, type XY, type Intervention } from './grid.ts';
import { buildDevice, type WalkerCfg } from './walker.ts';
import { nightShader } from './night.ts';
import { createVision, PROFILES, type Profile } from './vision.ts';
import { createHeatOverlay, nights, drawTimeline } from './heat.ts';
import { buildMannequin, feetAt, type Step } from './mannequin.ts';
import { setupXR } from './xr.ts';
import { initClips, exportForCosmos, listClips, type ExportOpts } from './cosmos.ts';
import { layoutKey } from './prerender.ts';
import { drawTopdown } from './topdown.ts';
import { cardState, encodeCard, type ActionOut, type ReportPayload } from './share.ts';
import QRCode from 'qrcode';
import type { Eval, Init, RouteDef } from './worker.ts';
import type { WorldModel } from './worldmodel.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RUN = new URLSearchParams(location.search).get('scene') ?? 'game_synth';
const BASE = `scene/${RUN}/`;
const json = (f: string) => fetch(BASE + f).then(r => { if (!r.ok) throw new Error(`${BASE}${f}: ${r.status}`); return r.json(); });
const bin = (f: string) => fetch(BASE + f).then(r => r.arrayBuffer());

const sc = await json('scene.json');
let [walkerCfg, persona, route, hzFile] = await Promise.all([json(sc.walker), json(sc.persona), json(sc.route), json(sc.hazards)]) as
  [WalkerCfg, any, { start: XY; goal: XY }, { hazards: any[] }];
const STEP = new URLSearchParams(location.search).get('step');   // ?step=learned|world|hand
persona.step_model = STEP ?? persona.step_model ?? 'hand';
// who walks: this patient, or a comparison (cane, Parkinson's) with assumed gait; older exports have only the patient
const personas: Record<string, { label: string; walker: WalkerCfg; gait: any; plan: any; vision?: string }> = sc.personas ? await json(sc.personas)
  : { patient: { label: 'This patient', walker: walkerCfg, gait: persona, plan: {}, vision: persona.vision } };
let personaKey = 'patient';
const stepModel = persona.step_model === 'learned' ? await fetch('models/step_model.json').then(r => r.json()) : undefined;
const worldModel: WorldModel | undefined = persona.step_model === 'world' ? await fetch('models/world_model.json').then(r => r.json()) : undefined;
if (worldModel) worldModel.shift = walkerCfg.user_gap_m + walkerCfg.depth_m / 2 - worldModel.mean_gap_m;   // learned.py Learned.shift
const g: GridMeta = sc.grid;
const [nx, ny] = g.shape;
const base: Layers = { floor: new Uint8Array(await bin(sc.grid.floor)), obst: new Uint8Array(await bin(sc.grid.obstacles)), bump: new Float32Array(await bin(sc.grid.bump_height_m)) };
const coverage = new Uint8Array(await bin(sc.grid.coverage));
// cables and other thin bumps: classified, height is a typical value from config, never measured
const est = sc.grid.bump_estimated ? new Uint8Array(await bin(sc.grid.bump_estimated)) : new Uint8Array(nx * ny);
const objs: any[] = sc.objects;
const interventions: Intervention[] = sc.interventions;
const risk = sc.risk;
// every walk the patient makes (stage 12 routes.json); older exports have only route.json: one night route
const routes: RouteDef[] = sc.routes ? await json(sc.routes) : [{ name: 'route', ...route, trips_per_night: risk.trips_per_night, night: true }];
let selRoute = 0;

// ---------- three + Spark ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
$('view').appendChild(renderer.domElement);
const css = new CSS2DRenderer();
css.setSize(innerWidth, innerHeight);
Object.assign(css.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
document.body.appendChild(css.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2126);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 60);
scene.add(new SparkRenderer({ renderer }));
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 2.2);
scene.add(hemi);
const vision = createVision(renderer, scene, camera);
// ?xr=1: headset mode (xr.ts). Off by default: nothing below changes without it
const xr = new URLSearchParams(location.search).has('xr') ? setupXR(renderer, scene, camera) : null;
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); css.setSize(innerWidth, innerHeight); vision.resize();
});

const night = nightShader();
const splats: SplatMesh[] = [];
const splat = (url: string) => { const s = new SplatMesh({ url: BASE + url, worldModifier: night.modifier }); splats.push(s); return s; };
scene.add(splat(sc.splat));
const PARAMS = new URLSearchParams(location.search);
// Deja View's ceiling fill (tools/dv_ceiling.py): the ceiling was never filmed, so this plane is imagined, tinted pink
const ceiling = sc.imagined_ceiling ? splat(sc.imagined_ceiling) : null;
if (ceiling) { ceiling.recolor = new THREE.Color(1, 0.8, 0.95); scene.add(ceiling); }
if (sc.removed_splat && PARAMS.has('removed')) {   // cleanup before/after: what stage 5b dropped, tinted magenta
  const r = splat(sc.removed_splat);
  r.recolor = new THREE.Color(1, 0.2, 1);
  scene.add(r);
}

const label = (text: string, cls = '') => {
  const d = document.createElement('div');
  d.className = `label3d ${cls}`; d.textContent = text;
  return new CSS2DObject(d);
};

// movable objects: splat in a group at its pivot (PLY is pivot-local), invisible box proxy for picking, tinted fill
const original: Pose[] = objs.map(o => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 }));
// the floor under each object was never filmed, and specks inside its box are its own splat leftovers, but it stands
// there now: count its own spot as clear floor for placement only (planning still sees the measured layers), else every
// drag that still overlaps that spot snaps back (the kitchen rug couldn't move at all otherwise)
const placeBase: Layers = { ...base, floor: base.floor.slice(), obst: base.obst.slice() };
objs.forEach((o, k) => { for (const c of polyCells(g, worldFootprint(o, original[k]))) { placeBase.floor[c] = 1; placeBase.obst[c] = 0; } });
// objects filmed overlapping (a chair pushed in under the table) share floor cells but not space: they may keep overlapping
// shortcut: 2D footprints, so once apart they may also be dropped into each other; a height-aware check would fix that
const startCells = objs.map((o, k) => new Set(polyCells(g, worldFootprint(o, original[k]))));
const overlapOk = objs.map((_, k) => new Set(objs.map((_, n) => n).filter(n => n !== k && [...startCells[k]].some(c => startCells[n].has(c)))));
const items = objs.map(o => {
  const group = new THREE.Group();
  group.position.set(o.pivot[0], o.pivot[1], 0);
  const mesh = splat(o.splat);
  group.add(mesh);
  // footprint = rotated rectangle (cv2.boxPoints order): box along its own edges, not the axis-aligned bounds (a tilted rug's would be far too big)
  const [p0, p1, p2] = o.footprint as XY[];
  const [w, d, h] = [Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), Math.max(o.height_m, 0.05)];
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, d + 0.04, h), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  proxy.position.set((p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2, h / 2);
  proxy.rotation.z = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  proxy.userData.item = o.name;
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(proxy.geometry), new THREE.LineBasicMaterial({ color: 0x66ccff }));
  outline.position.copy(proxy.position); outline.rotation.copy(proxy.rotation); outline.visible = false;
  group.add(proxy, outline);
  scene.add(group);
  const fill = splat(o.fill);
  fill.recolor = new THREE.Color(1, 0.75, 1);      // tint: imagined, not measured (light, so a generated floor texture still reads)
  fill.visible = false;
  const tag = label('imagined, not measured', 'imag');
  tag.position.set(o.pivot[0], o.pivot[1], 0.15);
  tag.visible = false;
  scene.add(fill, tag);
  return { o, group, mesh, proxy, outline, fill, tag };
});
await Promise.all(splats.map(s => s.initialized));
for (const h of sc.synthetic ?? []) {   // test hazards stamped into the grids (stage 6), not measured: always labelled
  const [[x0, y0], [x1, y1]] = h.box_xy, z = h.kind === 'bump' ? h.height_m : 0.8;
  const box = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), z),
    new THREE.MeshBasicMaterial({ color: h.kind === 'bump' ? 0xff9a2e : 0xb46bff, transparent: true, opacity: 0.45, depthWrite: false }));
  box.position.set((x0 + x1) / 2, (y0 + y1) / 2, z / 2);
  const tag = label(`SYNTHETIC ${h.label}`, 'synth');
  tag.position.set((x0 + x1) / 2, (y0 + y1) / 2, z + 0.12);
  box.renderOrder = 1;
  scene.add(box, tag);
}

// ---------- room shell (stage 5c): walls the splat implies, drawn tinted; visual only ----------
const shellGroup = new THREE.Group();
shellGroup.visible = false;
if (sc.shell) {
  const shell = await json(sc.shell);
  const mat = new THREE.MeshBasicMaterial({ color: 0xe070ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
  for (const w of shell.walls) {
    const [a, b] = [w.a, w.b], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, shell.ceiling_z), mat);
    m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, shell.ceiling_z / 2);
    m.rotation.set(Math.PI / 2, 0, Math.atan2(b[1] - a[1], b[0] - a[0]), 'ZXY');   // stand it up (x), then turn it along the wall (z)
    shellGroup.add(m);
  }
}
scene.add(shellGroup);

// ---------- re-scan verification (stage 14): each hazard of this capture, looked up in the capture after the fixes ----------
const verification = sc.verification ? await json(sc.verification) : null;
const verifyGroup = new THREE.Group();
if (verification) {
  for (const it of [...verification.items, ...verification.new]) {
    const good = it.status === 'resolved' || it.status === 'improved' || it.status === 'reduced';
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.3, 40), new THREE.MeshBasicMaterial({ color: good ? 0x2fbf5f : 0xff3b3b, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(it.position_m[0], it.position_m[1], 0.05);
    ring.renderOrder = 1;
    const what = it.type === 'floor_bump' ? 'bump' : 'squeeze';
    const tag = label(`re-scan: ${what} ${it.status}${it.after_m !== undefined ? ` (${(it.after_m * 100).toFixed(1)} cm now)` : ''}`, good ? '' : 'red');
    tag.position.set(0, 0, 0.5);
    ring.add(tag);
    verifyGroup.add(ring);
  }
  verifyGroup.visible = false;
}
scene.add(verifyGroup);

// ---------- grid overlays: route, hazards, ghosts, fog, taped strips ----------
const routeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x33ddff }));
// ghost walkers as one dot per step (WebGL lines are 1 px: trails hugging the route vanished); red = a toe contact
const ghostDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false }));
const hazardGroup = new THREE.Group(), tapeGroup = new THREE.Group();
// overlays draw after the splats: splats don't write depth, so drawn first they'd be painted over (rings, ghosts, fog would vanish)
for (const o of [routeLine, ghostDots, hazardGroup, tapeGroup]) o.renderOrder = 1;
scene.add(routeLine, ghostDots, hazardGroup, tapeGroup);
{ // fog where the capture saw a cell from fewer than coverage_good cameras: we don't trust the splat there
  const cv = document.createElement('canvas');
  cv.width = nx; cv.height = ny;
  const ctx = cv.getContext('2d')!, img = ctx.createImageData(nx, ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = i * ny + j, p = ((ny - 1 - j) * nx + i) * 4;
    img.data.set([150, 155, 160, base.floor[k] && coverage[k] < sc.grid.coverage_good ? 255 : 0], p);
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.LinearFilter;
  for (const z of [0.02]) {   // one floor-level tint: stacked slabs read as a staircase once drawn over the splat
    const m = new THREE.Mesh(new THREE.PlaneGeometry(nx * g.cell_m, ny * g.cell_m),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.3, depthWrite: false }));
    m.position.set(g.origin_xy[0] + (nx * g.cell_m) / 2, g.origin_xy[1] + (ny * g.cell_m) / 2, z);
    m.renderOrder = 1;
    scene.add(m);
  }
}

// ---------- walker + camera ----------
let walker = buildDevice(walkerCfg);
scene.add(walker.group);
let centreOffset = walkerCfg.user_gap_m + walkerCfg.depth_m / 2;   // body centre -> walker frame centre (the planned path)
const legTags = [0, 1, 2, 3].map(() => { const t = label(''); t.visible = false; scene.add(t); return t; });
const gapTag = label('', 'red');
gapTag.visible = false;
scene.add(gapTag);
const body = { x: 0, y: 0, yaw: 0, pitch: -(+(PARAMS.get('pitch') ?? 28)) * Math.PI / 180 };   // ?pitch=<deg down>: more walker, less room
let mode: 'auto' | 'free' | 'fly' = 'auto', autoS = 0, autoPause = 0;

// ---------- layout state + worker ----------
let layout: Layout = { poses: original.map(p => ({ ...p })), flattened: [] };
let applied: string[] = [];
let L = stamp(g, base, objs, layout.poses);
let current: Eval | null = null, baselinePerMonth: number | null = null;
let routeS: number[] = [];
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let init: Init = { g, base, est, objects: objs, routes, persona, risk, interventions, stepModel, worldModel, fixtures: sc.fixtures, transfer: sc.transfer, ems: sc.ems,
  plan: { walker_width_m: walkerCfg.width_m, ...sc.plan }, rules: sc.hazard_rules };
worker.postMessage({ type: 'init', init });
let seq = 0, latestEval = 0;
const waiting = new Map<number, (d: any) => void>();
worker.onmessage = e => {
  if (e.data.type === 'progress') { $('optstatus').textContent = e.data.msg; return; }   // the optimizer reports as it goes
  waiting.get(e.data.id)?.(e.data); waiting.delete(e.data.id);
};
const ask = (msg: object) => new Promise<any>(res => { const id = ++seq; waiting.set(id, res); worker.postMessage({ ...msg, id }); });

const game: any = { ready: false, fps: 0, evals: 0 };
(window as any).game = game;

function replanRoute(k: number) {
  selRoute = k; autoS = 0;
  return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); return ms; });
}
async function replan(): Promise<number> {
  const t = performance.now();
  L = stamp(g, base, objs, layout.poses, layout.flattened);
  const id = seq + 1;
  latestEval = id;
  const { r } = await ask({ type: 'eval', layout, sel: selRoute, heat: $<HTMLInputElement>('heat').checked });
  if (id !== latestEval) return performance.now() - t;    // a newer layout is already on its way
  current = r;
  baselinePerMonth ??= r.per_month;
  routeS = [0];
  for (let k = 1; k < r.xy.length; k++) routeS.push(routeS[k - 1] + Math.hypot(r.xy[k][0] - r.xy[k - 1][0], r.xy[k][1] - r.xy[k - 1][1]));
  drawPlan(r);
  setHeroSteps(r.steps, r.ghosts[0]?.walker);
  game.clipsForLayout = listClips(layoutKey(objs, layout), routes[selRoute].name);
  if (r.heat) heat.update(r.heat);
  heat.mesh.visible = !!r.heat;
  drawNights();
  const ms = performance.now() - t;
  game.evals++; game.lastReplanMs = ms;
  $('status').textContent = r.error ? `No route: ${r.error}` : `route ${r.length_m.toFixed(2)} m · replanned in ${ms.toFixed(0)} ms (worker ${r.ms.toFixed(0)} ms)`;
  $('status').style.color = r.error ? 'var(--red)' : '';
  return ms;
}

function drawPlan(r: Eval) {
  routeLine.geometry.dispose();
  routeLine.geometry = new THREE.BufferGeometry().setFromPoints(r.xy.map(p => new THREE.Vector3(p[0], p[1], 0.035)));
  const pos: number[] = [], col: number[] = [];
  r.ghosts.forEach((gh, n) => {
    const z = 0.04 + n * 0.0004;
    gh.pts.forEach((q, k) => { pos.push(q[0], q[1], z); col.push(...(gh.hit[k] ? [1, 0.15, 0.15] : [0.45, 0.7, 1])); });
  });
  ghostDots.geometry.dispose();
  ghostDots.geometry = new THREE.BufferGeometry();
  ghostDots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  ghostDots.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  for (const c of [...hazardGroup.children]) { hazardGroup.remove(c); c.traverse(x => { if (x instanceof CSS2DObject) x.element.remove(); }); }
  for (const h of r.hazards) {
    const bump = h.type === 'floor_bump';
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 32), new THREE.MeshBasicMaterial({ color: bump ? 0xff8a1f : 0xffe14d, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(h.position[0], h.position[1], 0.03);
    ring.userData.s = routeS[h.a] ?? 0;
    const t = label(bump ? `${h.name} ${h.estimated ? '~' : ''}${(h.height_m! * 100).toFixed(1)} cm${h.estimated ? ' (est.)' : ''}` : `${(h.min_side_clearance_m! * 100).toFixed(0)} cm/side`);
    t.position.set(0, 0, 0.35);
    ring.add(t);
    hazardGroup.add(ring);
  }
  renderPanels();
}

const fmt = (x: number) => (x < 0.05 && x > 0 ? x.toFixed(2) : x.toFixed(1));
function renderPanels() {
  const r = current!;
  const d = r.per_month - (baselinePerMonth ?? r.per_month);
  const perRoute = r.routes.map((q, k) => `<li class="${k === r.sel ? 'sel' : ''}">${q.name}${q.night ? ' (night)' : ''}, ${q.trips_per_night}/night: ` +
    (q.error ? '<span class="delta-bad">no route</span>' : `<span class="measured">${fmt(q.per_month)}</span> (${fmt(q.lo)}–${fmt(q.hi)})`) + '</li>').join('');
  $('risk').innerHTML = r.error ? `<span class="delta-bad">no route for this walker</span><ul>${perRoute}</ul>` :
    `<div class="big measured">${fmt(r.per_month)}</div><div class="range">likely ${fmt(r.per_month_lo)}–${fmt(r.per_month_hi)}</div>` +
    `expected toe contacts / month, all routes (${risk.rollouts} simulated trips per route; steps: ${persona.step_model === 'world' ? 'world model (heels + walker)' : persona.step_model === 'learned' ? 'learned model' : 'hand rule'}; ` +
    `range = measured height error ±${(100 * sc.hazard_rules.margin_m.height).toFixed(1)} cm + simulation noise)` +
    `<ul class="routes">${perRoute}</ul>` +
    `original layout: ${fmt(baselinePerMonth!)} → now ${fmt(r.per_month)} <span class="${d <= 0 ? 'delta-good' : 'delta-bad'}">(${d <= 0 ? '' : '+'}${fmt(d)})</span>`;
  const geo = r.hazards.map(h => `<li><span class="measured">${h.type === 'floor_bump' ? (h.estimated ? `${h.name}: thin cable/cord, ~${(h.height_m! * 100).toFixed(1)} cm ESTIMATED (classified, not measured)` : `${h.name}: ${(h.height_m! * 100).toFixed(1)} cm bump`) : `tight passage: ${(h.min_side_clearance_m! * 100).toFixed(0)} cm each side`}</span>` +
    ` over ${h.length_m.toFixed(2)} m${h.type === 'floor_bump' ? ` · ${fmt(h.per_month)}/month` : ''}${h.ot_check ? ' · <span class="ot">OT should check</span>' : ''}</li>`);
  // Cosmos Reason: proposals already checked against the grids (cosmos/reason.py); the dismissed ones are not listed
  const reason = hzFile.hazards.filter(h => h.source === 'cosmos_reason' && h.verdict !== 'dismissed').map(h =>
    `<li><span class="imagined">${h.note}</span> · proposed by Cosmos Reason${h.verdict === 'confirmed' ? `, <span class="measured">geometry agrees: ${h.measured}</span>` : ', not measurable from the scan · <span class="ot">OT should check</span>'}</li>`);
  $('hazards').innerHTML = [...geo, ...reason].join('') || '<li>none on this route</li>';
  const vcls = (v: string) => (v === 'ok' ? 'delta-good' : v === 'fail' ? 'delta-bad' : 'ot');
  $('checks').innerHTML = r.checks.map(c => `<li><span class="${vcls(c.verdict)}">${c.verdict}</span> ${c.label}<br><small>${c.note}</small></li>`).join('')
    || '<li>no fixtures marked for this home</li>';
}

// ---------- furniture editing ----------
const tc = new TransformControls(camera, renderer.domElement);
tc.setRotationSnap(Math.PI / 2);
tc.setSpace('world');
const setMode = (m: 'translate' | 'rotate') => { tc.setMode(m); tc.showX = tc.showY = m === 'translate'; tc.showZ = m === 'rotate'; };
setMode('translate');
scene.add(tc.getHelper());
let selected = -1, lastValid: Pose | null = null;
const poseOf = (k: number): Pose => ({ x: items[k].group.position.x, y: items[k].group.position.y, yaw: items[k].group.rotation.z });
function select(k: number) {
  if (selected >= 0) items[selected].outline.visible = false;
  selected = k;
  if (k < 0) { tc.detach(); $<HTMLButtonElement>('remove').disabled = true; return; }
  items[k].outline.visible = true;
  $<HTMLButtonElement>('remove').disabled = false;
  tc.attach(items[k].group);
  lastValid = poseOf(k);
}
tc.addEventListener('objectChange', () => {   // walls/furniture block placement: snap back to the last valid spot
  const p = poseOf(selected), poses = layout.poses.map((q, n) => (n === selected ? p : q));
  if (placementOk(g, placeBase, objs, poses, selected, overlapOk[selected])) lastValid = p;
  else { items[selected].group.position.set(lastValid!.x, lastValid!.y, 0); items[selected].group.rotation.z = lastValid!.yaw; refused(); }
});
function refused() {   // say why it snapped back; the next replan overwrites this
  $('status').textContent = "Can't go there: part of that spot is unfilmed floor, a wall or furniture (objects only land on floor the camera saw)";
  $('status').style.color = 'var(--red)';
}
function nudge(code: string) {   // 5 cm per press along the view direction on the floor; same placement check and re-plan as a drag
  const f = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize(), r = new THREE.Vector3(f.y, -f.x, 0);
  const d = { ArrowUp: f, ArrowDown: f.clone().negate(), ArrowRight: r, ArrowLeft: r.clone().negate() }[code]!.multiplyScalar(0.05);
  const q = poseOf(selected), p = { x: q.x + d.x, y: q.y + d.y, yaw: q.yaw };
  if (!placementOk(g, placeBase, objs, layout.poses.map((o, n) => (n === selected ? p : o)), selected, overlapOk[selected])) return refused();
  items[selected].group.position.set(p.x, p.y, 0); lastValid = p;
  commitPose(selected, p);
}
tc.addEventListener('dragging-changed', e => { if (!e.value && selected >= 0) commitPose(selected, poseOf(selected)); });

function syncObjects() {
  items.forEach((it, k) => {
    const p = layout.poses[k], o = original[k];
    it.group.position.set(p.x, p.y, 0); it.group.rotation.z = p.yaw;
    it.group.visible = !p.removed;
    const moved = !!p.removed || Math.hypot(p.x - o.x, p.y - o.y) > 0.01 || Math.abs(p.yaw - o.yaw) > 0.01;
    it.fill.visible = it.tag.visible = moved && $<HTMLInputElement>('imagfill').checked;   // the spot it used to cover was never filmed
  });
  for (const c of [...tapeGroup.children]) tapeGroup.remove(c);
  for (const [[x0, y0], [x1, y1]] of layout.flattened) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), new THREE.MeshBasicMaterial({ color: 0x8a8f96, transparent: true, opacity: 0.8 }));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.022);
    tapeGroup.add(m);
  }
  const gone = objs.flatMap((o, k) => (layout.poses[k].removed ? [k] : []));
  $('inventory').innerHTML = gone.length ? '' : '<li class="hint">nothing removed</li>';
  for (const k of gone) {
    const li = document.createElement('li'), b = document.createElement('button');
    li.textContent = `${objs[k].name} (${objs[k].kind}) `;
    b.textContent = 'Put back'; b.onclick = () => restoreObject(k);
    li.appendChild(b); $('inventory').appendChild(li);
  }
  updateNight();
}
function restoreObject(k: number) {   // back where it stood when removed, if that spot is still free
  const poses = layout.poses.map((q, n) => (n === k ? { ...q, removed: false } : q));
  if (!placementOk(g, placeBase, objs, poses, k, overlapOk[k])) return refused();
  layout = { ...layout, poses };
  syncObjects();
  return replan();
}
function commitPose(k: number, p: Pose) {
  layout = { ...layout, poses: layout.poses.map((q, n) => (n === k ? { x: p.x, y: p.y, yaw: Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2) } : q)) };
  syncObjects();
  return replan();
}
function removeObject(k: number) {   // take it out of the room: no footprint, no splat; the spot it covered shows the imagined fill
  layout = { ...layout, poses: layout.poses.map((q, n) => (n === k ? { ...q, removed: true } : q)) };
  select(-1);
  syncObjects();
  return replan();
}
$('remove').onclick = () => { if (selected >= 0) removeObject(selected); };

// ---------- fixes ----------
const costOf = (id: string) => {   // what a fix takes: money, time, product (config interventions)
  const iv = interventions.find(i => i.id === id);
  if (!iv || iv.cost_usd === undefined) return '';
  return ` <small class="cost">$${iv.cost_usd}${iv.minutes ? ` · ${iv.minutes} min` : ''}${iv.product ? ` · ${iv.product}` : ''}</small>`;
};
$('planfixes').onclick = async () => {
  $('fixes').innerHTML = '<li>rolling out each fix…</li>';
  const { before, fixes } = await ask({ type: 'fixes', layout, sel: selRoute });
  $('fixes').innerHTML = '';
  for (const f of fixes) {
    const li = document.createElement('li');
    li.innerHTML = f.error ? `${f.label}: <span class="delta-bad">blocks the route</span> ` :
      `${f.label}: <b class="${f.reduction > 0 ? 'delta-good' : ''}">−${fmt(Math.max(0, f.reduction))}/month</b> (${before > 0 ? Math.round((100 * f.reduction) / before) : 0}%)` +
      (f.clearance_gain_m > 0.005 ? ` <b class="delta-good">+${(f.clearance_gain_m * 100).toFixed(0)} cm</b> at the tightest spot` : '') + `${costOf(f.id)} `;
    const b = document.createElement('button');
    b.textContent = 'Apply'; b.disabled = !!f.error || applied.includes(f.id);
    b.onclick = () => applyFix(f.id);
    li.appendChild(b);
    $('fixes').appendChild(li);
  }
  game.fixes = fixes;
};
function applyFix(id: string) {
  layout = applyIntervention(objs, layout, interventions.find(i => i.id === id)!);
  applied.push(id);
  syncObjects();
  return replan().then(() => $('planfixes').click());
}
// ---------- physics pass (physics.ts in the worker): where the walker itself catches ----------
const snagGroup = new THREE.Group();
snagGroup.renderOrder = 1;
scene.add(snagGroup);
async function physicsPass() {
  for (const c of [...snagGroup.children]) { snagGroup.remove(c); c.traverse(x => { if (x instanceof CSS2DObject) x.element.remove(); }); }
  if (walkerCfg.device === 'cane') { $('snags').innerHTML = '<li>walker only (this persona uses a cane)</li>'; return (game.physics = null); }
  $('snags').innerHTML = '<li>pushing the walker along each route…</li>';
  const { routes: res } = await ask({ type: 'physics', layout, walker: walkerCfg });
  const items = res.flatMap((r: any) => r.error ? [`<li>${r.name}: no route</li>`] : r.snags.length === 0
    ? [`<li>${r.name}: <span class="delta-good">no snags</span> <small>(hardest push ${Math.max(0, ...Object.values(r.peak_push_n) as number[]).toFixed(0)} N)</small></li>`]
    : r.snags.map((s: any) => `<li>${r.name}: <span class="measured">${s.leg} ${s.tipped ? 'tips the frame' : 'catches'} on ${r.names[s.comp] ?? 'a floor edge'}` +
      ` (${(s.height_m * 100).toFixed(1)} cm edge)</span> at ${s.s_m.toFixed(1)} m · <span class="ot">estimate, OT to verify</span></li>`));
  $('snags').innerHTML = items.join('') + `<li><small>Rapier: the measured floor; the walker's push (${PHYS_NOTE}) is assumed</small></li>`;
  for (const r of res) for (const s of r.snags ?? []) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 24), new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(s.position[0], s.position[1], 0.032);
    const t = label(`snag: ${s.leg}`);
    t.position.set(0, 0, 0.25);
    ring.add(t);
    snagGroup.add(ring);
  }
  return (game.physics = res);
}
const PHYS_NOTE = 'up to 40 N, 30 N leaned on the grips, 5 in front wheels, glides behind';
$('physics').onclick = () => physicsPass();

// ---------- suggested layouts (optimize.ts in the worker) ----------
let suggestions: any[] = [];
async function suggest() {
  $('optstatus').textContent = 'searching layouts…';
  $('options').innerHTML = '';
  const res = await ask({ type: 'optimize', layout });
  suggestions = res.options;
  $('optstatus').textContent = `${res.evals} layouts scored in ${(res.ms / 1000).toFixed(1)} s · every number below is a full re-run of that layout`;
  for (const [n, o] of suggestions.entries()) {
    const li = document.createElement('li');
    li.className = 'option';
    li.innerHTML = `<b>${o.name}</b>: <span class="measured">${fmt(o.per_month)}</span>/month (${fmt(o.per_month_lo)}–${fmt(o.per_month_hi)}), ` +
      `${o.checks_failed} failed checks · $${o.cost_usd} · ${o.minutes} min<ol>${o.actions.map((a: any) => `<li>${a.label}</li>`).join('')}</ol>`;
    const b = document.createElement('button');
    b.textContent = 'Apply and walk it';
    b.onclick = () => applyOption(n);
    li.appendChild(b);
    $('options').appendChild(li);
  }
  game.suggestions = suggestions;
  return suggestions;
}
function applyOption(n: number) {
  const o = suggestions[n];
  layout = o.layout;
  applied = o.actions.map((a: any) => a.id);
  syncObjects();
  return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); setWalk('auto'); return ms; });
}
$('suggest').onclick = () => suggest();

// ---------- what leaves the game: OT report, family fix card ----------
/** Every change in the layout on screen, in order, with what it takes and where (for the card's numbered pins). */
function describeChanges(): ActionOut[] {
  const out: ActionOut[] = [], covered = new Set<string>();
  const poseOf = (name: string): XY | undefined => {
    const k = objs.findIndex(o => o.name === name);
    if (k < 0) return undefined;
    const p = layout.poses[k].removed ? original[k] : layout.poses[k];
    return [p.x, p.y];
  };
  for (const id of applied) {
    const iv = interventions.find(i => i.id === id), sa = suggestions.flatMap(o => o.actions).find((a: any) => a.id === id);
    if (iv) {
      const at = iv.kind === 'flatten' ? [(iv.box_xy![0][0] + iv.box_xy![1][0]) / 2, (iv.box_xy![0][1] + iv.box_xy![1][1]) / 2] as XY
        : iv.kind === 'raise' ? (sc.fixtures?.find((f: any) => f.name === iv.target)?.xyz?.slice(0, 2) as XY | undefined) ?? poseOf(iv.target!)
        : iv.kind === 'add' ? poseOf(iv.fixture?.attach ?? '') : poseOf(iv.object!);
      out.push({ label: iv.label, cost_usd: iv.cost_usd, minutes: iv.minutes, product: iv.product, at });
      if (iv.object) covered.add(iv.object);
    } else if (sa) {
      const name = id.split(':')[1];
      out.push({ label: sa.label, cost_usd: sa.cost_usd, minutes: sa.minutes, product: sa.product, at: poseOf(name) });
      covered.add(name);
    }
  }
  objs.forEach((o, k) => {   // drags and deletes done by hand
    const p = layout.poses[k], q = original[k];
    if (covered.has(o.name)) return;
    if (p.removed) out.push({ label: `Take the ${o.name} out of the room`, at: [q.x, q.y] });
    else if (Math.hypot(p.x - q.x, p.y - q.y) > 0.02 || Math.abs(p.yaw - q.yaw) > 0.01)
      out.push({ label: `Move the ${o.name} ${Math.hypot(p.x - q.x, p.y - q.y).toFixed(1)} m (see map)`, at: [p.x, p.y] });
  });
  return out;
}
function topdownURL() {
  const cv = document.createElement('canvas');
  drawTopdown(cv, { g, L, coverage, coverageGood: sc.grid.coverage_good, objs, layout, original: { poses: original, flattened: [] },
    route: current?.xy, hazards: current?.hazards });
  return cv.toDataURL('image/png');
}
function openReport() {
  const p = personas[personaKey], c = current!;
  const payload: ReportPayload = {
    scene: RUN, created: new Date().toISOString(), synthetic: (sc.synthetic ?? []).length > 0 || /synth/.test(RUN), scale_note: sc.scale_note,
    route: routes[selRoute].name,
    persona: { key: personaKey, label: p.label, knee_height_m: persona.knee_height_m ?? 0.5, reach_m: persona.reach_m ?? 0.6, hip_precautions: !!persona.hip_precautions },
    current: { ...c, dist_m: undefined as any, heat: undefined, ghosts: [] }, baseline: baselinePerMonth ?? c.per_month,
    rollouts: risk.rollouts, gait: persona.gait_profile, dark_multiplier: risk.dark_contact_multiplier,
    calibration: 'MTC 14.1 ± 8.3 mm lognormal shape; ~1 in 578 strides contact a 1 cm obstacle (Frontiers 2014)',
    margins: sc.hazard_rules.margin_m, actions: describeChanges(), suggestions,
    reason: hzFile.hazards.filter(h => h.source === 'cosmos_reason'),
    clips: (game.clips ?? []).filter((k: any) => k.layout_key === layoutKey(objs, layout)).map((k: any) => k.title ?? k.file),
    topdown: topdownURL(), view: renderer.domElement.toDataURL('image/jpeg', 0.85),
  };
  sessionStorage.setItem(`report:${RUN}`, JSON.stringify(payload));
  return window.open(`report.html?scene=${encodeURIComponent(RUN)}`, '_blank');
}
const LOCAL = /^(localhost|127\.)/;
async function openFixCard() {
  const acts = describeChanges();
  const hash = encodeCard(cardState(RUN, objs, layout, acts));
  // a phone can't open "localhost": use the laptop's LAN address (vite --host) when there is one
  const lan: string[] = await fetch('/api/lan').then(r => r.json()).catch(() => []);
  const host = LOCAL.test(location.hostname) && lan.length ? `${location.protocol}//${lan[0]}:${location.port}` : location.origin;
  const url = `${host}/fixcard.html#${hash}`;
  ($('qrimg') as HTMLImageElement).src = await QRCode.toDataURL(url, { margin: 1, width: 260 });
  ($('qrlink') as HTMLAnchorElement).href = url;
  $('qrlink').textContent = `${acts.length} change${acts.length === 1 ? '' : 's'} · open on this computer`;
  $('qrnote').textContent = LOCAL.test(new URL(host).hostname)
    ? 'Start the viewer with "npx vite --host" so a phone on the same Wi-Fi can open this.' : `Phone on the same Wi-Fi: ${host}`;
  $('qr').hidden = false;
  return url;
}
$('report').onclick = () => openReport();
$('fixcard').onclick = () => openFixCard();
$('closeqr').onclick = () => { $('qr').hidden = true; };
$('reset').onclick = () => { layout = { poses: original.map(p => ({ ...p })), flattened: [] }; applied = []; $('fixes').innerHTML = ''; syncObjects(); replan(); };

// ---------- night ----------
function updateNight() {
  const k = objs.findIndex(o => o.kind === 'nightlight');
  const p = k >= 0 && !layout.poses[k].removed ? layout.poses[k] : null;
  const on = $<HTMLInputElement>('night').checked;
  night.set(on, p && { x: p.x, y: p.y, r: objs[k].light_radius_m ?? 1.5 });
  for (const s of splats) s.updateVersion();
  hemi.intensity = on ? 0.25 : 2.2;
  scene.background = new THREE.Color(on ? 0x050607 : 0x1d2126);
}
$('night').onchange = updateNight;
const heat = createHeatOverlay(g, scene);
$('heat').onchange = () => replan();
$('third').onchange = () => { view.third = $<HTMLInputElement>('third').checked; if (view.third) Object.assign(view, { back: 1.8, up: 0.5 }); };
$('verify').onchange = () => { verifyGroup.visible = $<HTMLInputElement>('verify').checked; };
($('verify').parentElement as HTMLElement).hidden = !verification;
if (verification) $('verifyinfo').textContent = `Re-scan (${verification.after_run}): ` +
  `${verification.items.filter((i: any) => i.status === 'resolved').length} of ${verification.items.length} hazards resolved, ` +
  `${verification.new.length} new · aligned to ${(verification.alignment.inlier_rms_m * 100).toFixed(1)} cm`;
$('shell').onchange = () => { shellGroup.visible = $<HTMLInputElement>('shell').checked; };
($('shell').parentElement as HTMLElement).hidden = !sc.shell;
let nightSel = -1;
function drawNights() {   // 30 nights at the current rate; the selected night says where its contacts happened
  if (!current || current.error) return;
  const data = nights(current.per_month, current.hazards.filter(h => h.per_month > 0));
  drawTimeline($<HTMLCanvasElement>('timeline'), data, nightSel);
  const bad = data.filter(d => d.count).length;
  $('nightinfo').textContent = nightSel >= 0
    ? `night ${nightSel + 1}: ${data[nightSel].count ? data[nightSel].at.join(', ') : 'no toe contact'}`
    : `${bad} of 30 nights with a toe contact (one draw at ${current.per_month.toFixed(1)}/month)`;
}
$<HTMLInputElement>('nightscrub').oninput = e => { nightSel = +(e.target as HTMLInputElement).value - 1; drawNights(); };
/** Swap who walks: device mesh + footprint, gait, planner penalties, default eyes; then re-plan everything. */
async function setPersona(key: string) {
  const p = personas[key];
  personaKey = key;
  $<HTMLSelectElement>('persona').value = key;
  walkerCfg = p.walker;
  persona = { ...p.gait, step_model: STEP ?? p.gait.step_model ?? 'hand' };
  scene.remove(walker.group);
  walker = buildDevice(walkerCfg);
  scene.add(walker.group);
  centreOffset = walkerCfg.user_gap_m + walkerCfg.depth_m / 2;
  if (worldModel) worldModel.shift = centreOffset - worldModel.mean_gap_m;   // learned.py Learned.shift, for this walker
  init = { ...init, persona, plan: { ...sc.plan, ...p.plan, walker_width_m: walkerCfg.width_m } };
  worker.postMessage({ type: 'init', init });
  baselinePerMonth = null;
  if (p.vision) game.setVision(p.vision);
  $('personanote').textContent = key === 'patient' ? '' : 'comparison: gait and planner numbers for this persona are assumptions, not this patient';
  const ms = await replan();
  if (!current?.error) Object.assign(body, routePose(0, 0, Infinity));
  return ms;
}
{
  const sel = $<HTMLSelectElement>('persona');
  sel.innerHTML = Object.entries(personas).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.onchange = () => setPersona(sel.value);
  sel.disabled = Object.keys(personas).length < 2;
}
{ // vision loss: a post pass on the finished frame (visual only), defaulting to the persona's profile
  const sel = $<HTMLSelectElement>('vision');
  sel.innerHTML = Object.entries(PROFILES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.value = persona.vision ?? 'normal';
  sel.onchange = () => vision.set(sel.value as Profile);
  vision.set(sel.value as Profile);
}
{ // route selector: the panels, autoplay and the Cosmos export follow the selected route; the risk total covers all of them
  const sel = $<HTMLSelectElement>('routesel');
  sel.innerHTML = routes.map((r, k) => `<option value="${k}">${r.name}${r.night ? ' (night)' : ''}</option>`).join('');
  sel.onchange = () => replanRoute(+sel.value);
  sel.disabled = routes.length < 2;
}
$('imagfill').onchange = () => syncObjects();
$('imagceil').onchange = () => { if (ceiling) ceiling.visible = $<HTMLInputElement>('imagceil').checked; };
{ // which imagined fill (stage 12b backends): median patch, telea / ns (OpenCV inpainting), lama, cosmos
  const backends = [...new Set(objs.flatMap(o => Object.keys(o.fills ?? { median: o.fill })))];
  const sel = $<HTMLSelectElement>('fillsel');
  sel.innerHTML = backends.map(b => `<option value="${b}">${b}</option>`).join('');
  sel.value = backends.find(b => objs.every(o => (o.fills ?? {})[b] === o.fill)) ?? backends[0];
  sel.hidden = backends.length < 2;
  sel.onchange = () => setFillBackend(sel.value);
}
async function setFillBackend(b: string) {
  $<HTMLSelectElement>('fillsel').value = b;   // also when called from the game API
  for (const it of items) {
    const url = it.o.fills?.[b];
    if (!url) continue;
    const f = splat(url);
    f.recolor = it.fill.recolor;
    f.visible = it.fill.visible;
    await f.initialized;
    scene.remove(it.fill);
    splats.splice(splats.indexOf(it.fill), 1);
    it.fill.dispose();
    it.fill = f;
    scene.add(f);
  }
  updateNight();
  return b;
}
$('ghosts').onchange = () => { ghostDots.visible = $<HTMLInputElement>('ghosts').checked; };

// ---------- input ----------
const keys = new Set<string>();
addEventListener('keydown', e => {
  if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
  if (selected >= 0 && e.code.startsWith('Arrow')) { nudge(e.code); e.preventDefault(); return; }   // arrows move the selected object, not you
  keys.add(e.code);
  if (e.code === 'KeyT') setMode('translate');
  if (e.code === 'KeyR') setMode('rotate');
  if (e.code === 'Escape') select(-1);
  if ((e.code === 'Delete' || e.code === 'Backspace') && selected >= 0) removeObject(selected);
  if (e.code === 'KeyF') setWalk(mode === 'fly' ? 'free' : 'fly');
  else if (/^(Key[WASD]|Arrow)/.test(e.code) && mode !== 'fly') setWalk('free');
});
addEventListener('keyup', e => keys.delete(e.code));
const ray = new THREE.Raycaster();
let look: { x: number; y: number; moved: number } | null = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (tc.dragging || (tc as any).axis) return;
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObjects(items.filter((_, k) => !layout.poses[k].removed).map(i => i.proxy))[0];
  if (hit) { select(items.findIndex(i => i.proxy === hit.object)); return; }
  look = { x: e.clientX, y: e.clientY, moved: 0 };
});
addEventListener('pointermove', e => {
  if (!look) return;
  const dx = e.clientX - look.x, dy = e.clientY - look.y;
  look = { x: e.clientX, y: e.clientY, moved: look.moved + Math.abs(dx) + Math.abs(dy) };
  body.yaw -= dx * 0.004; body.pitch = THREE.MathUtils.clamp(body.pitch - dy * 0.004, mode === 'fly' ? -1.5 : -1.2, mode === 'fly' ? 1.5 : 0.6);
  if (mode === 'auto' && look.moved > 4) setWalk('free');
});
addEventListener('pointerup', () => { if (look && look.moved < 3) select(-1); look = null; });
function setWalk(m: 'auto' | 'free' | 'fly') {
  if (m === 'fly' && mode !== 'fly') Object.assign(fly, camera.position);
  if (m !== 'fly') body.pitch = THREE.MathUtils.clamp(body.pitch, -1.2, 0.6);
  mode = m;
  $('autoplay').classList.toggle('on', m === 'auto'); $('free').classList.toggle('on', m === 'free'); $('fly').classList.toggle('on', m === 'fly');
  if (m === 'auto') { autoS = 0; autoPause = 0; }
}
$('autoplay').onclick = () => setWalk('auto');
$('free').onclick = () => setWalk('free');
$('fly').onclick = () => setWalk('fly');

// ---------- motion + live checks ----------
const cellAt = (x: number, y: number) => { const [i, j] = toCell(g, [x, y]); return i * ny + j; };
const walkerPoint = (b: { x: number; y: number; yaw: number }, [px, py]: number[]): XY =>
  [b.x + Math.cos(b.yaw) * px - Math.sin(b.yaw) * py, b.y + Math.sin(b.yaw) * px + Math.cos(b.yaw) * py];
function canStand(b: { x: number; y: number; yaw: number }) {
  const c = cellAt(b.x, b.y);
  if (!L.floor[c] || L.obst[c] || coverage[c] === 0) return false;           // only where the capture actually saw floor
  return walker.probes.every(p => { const k = cellAt(...walkerPoint(b, p)); return L.floor[k] && !L.obst[k]; });
}
/** Route point + heading at arc length s (the route is the walker frame's centre). */
function routeAt(s: number): [number, number, number] {
  const xy = current!.xy;
  let k = 1;
  while (k < routeS.length - 1 && routeS[k] < s) k++;
  const f = THREE.MathUtils.clamp((s - routeS[k - 1]) / (routeS[k] - routeS[k - 1] || 1), 0, 1);
  return [xy[k - 1][0] + f * (xy[k][0] - xy[k - 1][0]), xy[k - 1][1] + f * (xy[k][1] - xy[k - 1][1]), 0];
}
const SPEED = 0.45;   // m/s, also the Cosmos export's pace
// world model: autoplay replays ghost 0, the walker on the walker head's poses and its last two heels shown
const feet = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, size: 14, sizeAttenuation: false, depthWrite: false }));
feet.renderOrder = 2;
scene.add(feet);
function worldStep(dt: number): boolean {
  const gh = current?.ghosts[0];
  if (!gh?.walker || gh.walker.length < 2) return false;
  const W = gh.walker, d = [0];
  for (let k = 1; k < W.length; k++) d.push(d[k - 1] + Math.hypot(W[k][0] - W[k - 1][0], W[k][1] - W[k - 1][1]));
  const Ls = d[d.length - 1];
  if (autoS >= Ls) { autoPause += dt; if (autoPause > 2) { autoS = 0; autoPause = 0; } }
  else autoS = Math.min(Ls, autoS + SPEED * dt);
  let k = 1;
  while (k < d.length - 1 && d[k] < autoS) k++;
  const f = THREE.MathUtils.clamp((autoS - d[k - 1]) / (d[k] - d[k - 1] || 1), 0, 1), a = W[k - 1], b = W[k];
  const yaw = a[2] + f * Math.atan2(Math.sin(b[2] - a[2]), Math.cos(b[2] - a[2]));
  Object.assign(body, { x: a[0] + f * (b[0] - a[0]) - Math.cos(yaw) * centreOffset, y: a[1] + f * (b[1] - a[1]) - Math.sin(yaw) * centreOffset, yaw });
  const pos: number[] = [], col: number[] = [];
  for (const j of [k - 1, k - 2]) if (j >= 0) {   // heel k lands with walker pose k: show the two latest landed heels
    pos.push(gh.pts[j][0], gh.pts[j][1], 0.05);
    col.push(...(gh.hit[j] ? [1, 0.1, 0.1] : heroSteps[j]?.side ? [1, 0.55, 0.2] : [0.3, 0.6, 1]));   // orange = left, blue = right
  }
  feet.geometry.dispose();
  feet.geometry = new THREE.BufferGeometry();
  feet.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  feet.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return true;
}
function autoStep(dt: number) {
  if (!current || current.error || routeS.length < 2) return;
  if (persona.step_model === 'world' && worldStep(dt)) return;
  const Ls = routeS[routeS.length - 1];
  if (autoS >= Ls) { autoPause += dt; if (autoPause > 2) { autoS = 0; autoPause = 0; } }
  else autoS = Math.min(Ls, autoS + SPEED * dt);
  const pose = routePose(autoS, body.yaw, dt);
  Object.assign(body, pose);
}
/** Body pose that puts the walker frame centre on the route at s; heading eases toward the route ahead. */
function routePose(s: number, prevYaw: number, dt: number) {
  const [x, y] = routeAt(s), Ls = routeS[routeS.length - 1];
  const [ax, ay] = routeAt(Math.min(Ls, s + 0.35)), [bx, by] = routeAt(Math.max(0, s - 0.1));
  const want = Math.atan2(ay - by, ax - bx);
  const yaw = dt === Infinity ? want : prevYaw + Math.atan2(Math.sin(want - prevYaw), Math.cos(want - prevYaw)) * Math.min(1, dt * 4);
  return { x: x - Math.cos(yaw) * centreOffset, y: y - Math.sin(yaw) * centreOffset, yaw };
}
function freeStep(dt: number) {
  const k = (c: string) => keys.has(c);
  const turn = (+(k('KeyA') || k('ArrowLeft')) - +(k('KeyD') || k('ArrowRight'))) * 1.1 * dt;
  const fwd = (+(k('KeyW') || k('ArrowUp')) - +(k('KeyS') || k('ArrowDown'))) * 0.5 * dt;
  // sub-steps of at most half a cell, so a slow frame can't step over a one-cell-thin wall
  const n = Math.max(1, Math.ceil(Math.abs(fwd) / (g.cell_m / 2)));
  for (let i = 0; i < n; i++) {
    const yaw = body.yaw + turn / n, next = { x: body.x + Math.cos(yaw) * fwd / n, y: body.y + Math.sin(yaw) * fwd / n, yaw };
    if (canStand(next)) Object.assign(body, next);
    else { if (turn && canStand({ ...body, yaw })) body.yaw = yaw; break; }
  }
}
const fly = { x: 0, y: 0, z: 0 };   // noclip camera: ignores floor, walls and coverage; the walker stays where it was
function flyStep(dt: number) {
  const k = (c: string) => keys.has(c), v = (k('ShiftLeft') || k('ShiftRight') ? 4 : 1) * dt;
  const f = +(k('KeyW') || k('ArrowUp')) - +(k('KeyS') || k('ArrowDown')), r = +(k('KeyD') || k('ArrowRight')) - +(k('KeyA') || k('ArrowLeft'));
  const c = Math.cos(body.pitch), cy = Math.cos(body.yaw), sy = Math.sin(body.yaw);
  fly.x += v * (f * c * cy + r * sy); fly.y += v * (f * c * sy - r * cy);
  fly.z += v * (f * Math.sin(body.pitch) + +k('KeyE') - +k('KeyQ'));
}

const state = { legs: [] as { x: number; y: number; h: number; flash: boolean; est: boolean }[], gap: Infinity, red: false };
function liveChecks(t: number) {
  // measured, per frame: bump under each leg, frame clearance from the obstacle distance field
  legTags.forEach((t, n) => { if (n >= walkerCfg.legs.length) t.visible = false; });
  state.legs = walkerCfg.legs.map((p, n) => {
    const [x, y] = walkerPoint(body, p), c = cellAt(x, y), h = L.bump[c] || 0, e = !!est[c] && h > 0, flash = h >= risk.leg_flash_m || e;
    walker.setLegRed(n, flash && Math.floor(t * 6) % 2 === 0);
    legTags[n].visible = flash;
    if (flash) { legTags[n].position.set(x, y, 0.25); legTags[n].element.textContent = e ? `cable ~${(h * 100).toFixed(1)} cm (estimated)` : `${(h * 100).toFixed(1)} cm bump`; legTags[n].element.className = 'label3d red'; }
    return { x, y, h, flash, est: e };
  });
  let gap = Infinity, at: XY = [0, 0];
  if (current?.dist_m) for (const p of walker.probes) {
    const q = walkerPoint(body, p), d = current.dist_m[cellAt(...q)] - walkerCfg.leg_radius_m;
    if (d < gap) { gap = d; at = q; }
  }
  state.gap = gap; state.red = gap < sc.hazard_rules.clearance_margin_m;
  walker.setFrameRed(state.red);
  gapTag.visible = state.red;
  if (state.red) { gapTag.position.set(at[0], at[1], walkerCfg.handle_height_m + 0.1); gapTag.element.textContent = `${Math.max(0, gap * 100).toFixed(0)} cm gap`; }
  // upcoming hazards (next 2.5 m of the route) glow
  const sNow = mode === 'auto' ? autoS : nearestS(...walkerPoint(body, [centreOffset, 0]));
  for (const ring of hazardGroup.children as THREE.Mesh[]) {
    const ahead = ring.userData.s - sNow, mat = ring.material as THREE.MeshBasicMaterial;
    const glow = ahead > -0.3 && ahead < 2.5;
    mat.opacity = glow ? 0.55 + 0.45 * Math.sin(t * 8) : 0.35;
    ring.scale.setScalar(glow ? 1.25 : 1);
  }
}
function nearestS(x: number, y: number) {
  let best = Infinity, s = 0;
  current?.xy.forEach((p, k) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < best) { best = d; s = routeS[k]; } });
  return s;
}

// third person in autoplay: a mannequin walks behind the walker on the simulation's own footsteps (hero trip)
const mannequin = buildMannequin(persona.eye_height_m / 0.94);
mannequin.group.visible = false;
scene.add(mannequin.group);
let heroSteps: Step[] = [];
/** The hero trip's footsteps, moved from the walker frame's centre line (where the simulation puts the route) back to
 *  the user's own feet, each with its arc length along the route. */
function setHeroSteps(steps: { xy: XY; side: number; hit: boolean }[], walker?: [number, number, number][]) {
  // world model: the steps are already heels and heel k lands with walker pose k, so s = distance along the walker's
  // own poses (what worldStep plays back)
  if (walker && walker.length === steps.length) {
    let d = 0;
    heroSteps = steps.map((p, k) => ({ ...p, s: k ? (d += Math.hypot(walker[k][0] - walker[k - 1][0], walker[k][1] - walker[k - 1][1])) : 0 }));
    return;
  }
  heroSteps = steps.map(p => {
    const s = nearestS(p.xy[0], p.xy[1]), [ax, ay] = routeAt(Math.min(s + 0.1, routeS.at(-1) ?? 0)), [bx, by] = routeAt(Math.max(0, s - 0.1));
    const h = Math.atan2(ay - by, ax - bx);
    return { ...p, xy: [p.xy[0] - Math.cos(h) * centreOffset, p.xy[1] - Math.sin(h) * centreOffset] as XY, s };
  });
}
const view = { third: false, back: 1.0, up: 0.4 };   // third person: behind, just above the user (higher looks through a real splat's low-opacity haze and hides the walker)
function placeCamera(cam: THREE.PerspectiveCamera, b: typeof body) {
  if (view.third && cam === camera) {
    cam.position.set(b.x - Math.cos(b.yaw) * view.back, b.y - Math.sin(b.yaw) * view.back, persona.eye_height_m + view.up);
    cam.lookAt(b.x + Math.cos(b.yaw) * centreOffset, b.y + Math.sin(b.yaw) * centreOffset, 0.3);
    return;
  }
  cam.position.set(b.x, b.y, persona.eye_height_m);
  const c = Math.cos(b.pitch);
  cam.lookAt(b.x + Math.cos(b.yaw) * c, b.y + Math.sin(b.yaw) * c, persona.eye_height_m + Math.sin(b.pitch));
}

// ---------- loop ----------
let last = performance.now(), frames = 0, fpsT = last, clockT = 0;
function frame(now: number) {
  if (game.manual) return;   // recorder drives the clock with game.tick()
  if (xr) { xrFrame(now); return; }
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt, now / 1000);
  frames++;
  if (now - fpsT > 1000) {
    game.fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now;
    $('hud').textContent = `${game.fps.toFixed(0)} fps · ${mode === 'auto' ? 'autoplay' : mode === 'fly' ? 'fly (noclip)' : 'free walk'} · ${RUN}${sc.scale_note ? ` · ${sc.scale_note}` : ""}`;
  }
  requestAnimationFrame(frame);
}
/** XR runs on the renderer's animation loop (window rAF stops while presenting). */
function xrFrame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (xr!.presenting()) {
    if (mode === 'auto' && keys.size) setWalk('free');
    body.yaw += xr!.input(keys, dt);
  }
  step(dt, now / 1000);
}
function step(dt: number, t: number) {
  if (mode === 'auto') autoStep(dt); else if (mode === 'fly') flyStep(dt); else freeStep(dt);
  walker.group.position.set(body.x, body.y, 0);
  walker.group.rotation.z = body.yaw;
  if (mode === 'fly') {
    const c = Math.cos(body.pitch);
    camera.position.set(fly.x, fly.y, fly.z);
    camera.lookAt(fly.x + Math.cos(body.yaw) * c, fly.y + Math.sin(body.yaw) * c, fly.z + Math.sin(body.pitch));
  } else if (xr?.presenting()) xr.place(body);
  else placeCamera(camera, body);
  const showMan = view.third && mode === 'auto' && heroSteps.length > 0;
  mannequin.group.visible = showMan;
  if (showMan) {
    const f = feetAt(heroSteps, autoS, persona.stride_m ?? 0.35), hy = walkerCfg.width_m / 2 - walkerCfg.leg_radius_m, gx = walkerCfg.user_gap_m + 0.05;
    mannequin.update(body, [f[1], f[0]], [[gx, hy], [gx, -hy]], walkerCfg.handle_height_m);   // sim side 1 = left
  }
  liveChecks(t);
  if (xr?.presenting()) renderer.render(scene, camera);   // the post pass can't run per eye: plain render in the headset
  else vision.render();
  css.render(scene, camera);
}

// ---------- start ----------
setWalk('auto');
await replan();
if ((current as Eval | null)?.error === undefined && current) Object.assign(body, routePose(0, 0, Infinity));
else { const [sx, sy] = routes[selRoute].start; Object.assign(body, { x: sx - centreOffset, y: sy, yaw: 0 }); }
if (xr) renderer.setAnimationLoop(frame); else requestAnimationFrame(frame);

const ctx = { RUN, sc, objs, layout: () => layout, applied: () => applied, current: () => current, routePose, routeS: () => routeS,
  get walker() { return walkerCfg; }, get persona() { return persona; }, body, renderer, scene, get walkerGroup() { return walker.group; },
  placeCamera, cameraToW2C, night: () => $<HTMLInputElement>('night').checked,
  layoutKey: () => layoutKey(objs, layout), routeName: () => routes[selRoute].name };
initClips();
$('export').onclick = () => exportForCosmos(ctx, { hero: $<HTMLInputElement>('hero').checked });

Object.assign(game, {
  ready: true, state, body, fly, items: objs.map(o => o.name), view,
  /** Fixed-step clock for recordings: game.manual = true stops the rAF loop; each tick advances dt s and renders. */
  tick(dt: number) { clockT += dt; step(dt, clockT); },
  resume() { game.manual = false; last = performance.now(); if (!xr) requestAnimationFrame(frame); },
  xr: () => !!xr,
  autoS: () => autoS, setAuto: () => setWalk('auto'),
  setFree(x: number, y: number, yaw: number) { setWalk('free'); Object.assign(body, { x, y, yaw }); },
  layout: () => layout, current: () => current, routes,
  setPersona, physicsPass, personas: () => Object.keys(personas), persona: () => personaKey, suggest, applyOption, setFillBackend,
  /** a layout from configured fixes, in order (pre-render scenarios); one re-plan */
  applyFixes(ids: string[]) {
    layout = ids.reduce((l, id) => applyIntervention(objs, l, interventions.find(i => i.id === id)!), { poses: original.map(p => ({ ...p })), flattened: [] } as Layout);
    applied = [...ids];
    syncObjects();
    return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); return ms; });
  },
  setNight(on: boolean) { $<HTMLInputElement>('night').checked = on; updateNight(); },
  openReport, openFixCard, describeChanges, mannequinVisible: () => mannequin.group.visible, heroSteps: () => heroSteps,
  setVision(p: Profile) { $<HTMLSelectElement>('vision').value = p; vision.set(p); return vision.profile; },
  selectRoute(k: number) { const s = $<HTMLSelectElement>('routesel'); s.value = String(k); return replanRoute(k); },
  cell(x: number, y: number) { const c = cellAt(x, y); return { floor: L.floor[c], obst: L.obst[c], cov: coverage[c] }; },
  fillVisible: (name: string) => items[objs.findIndex(o => o.name === name)].fill.visible,
  moveObject(name: string, x: number, y: number, yawDeg = 0) {   // same path as a finished drag
    const k = objs.findIndex(o => o.name === name), p = { x, y, yaw: (yawDeg * Math.PI) / 180 };
    if (!placementOk(g, placeBase, objs, layout.poses.map((q, n) => (n === k ? p : q)), k, overlapOk[k])) return Promise.resolve({ ok: false });
    return commitPose(k, p).then(ms => ({ ok: true, ms }));
  },
  removeObject: (name: string) => removeObject(objs.findIndex(o => o.name === name)),
  restoreObject: (name: string) => restoreObject(objs.findIndex(o => o.name === name)),
  inventory: () => objs.filter((_, k) => layout.poses[k].removed).map(o => o.name),
  applyFix, select: (name: string) => select(objs.findIndex(o => o.name === name)),
  exportForCosmos: (opts?: ExportOpts) => exportForCosmos(ctx, opts), layoutKey: () => layoutKey(objs, layout),
});

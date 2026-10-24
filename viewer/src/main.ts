import { cameraToW2C } from './frame.ts';   // first: sets the +z-up convention before any camera exists
import * as THREE from 'three';
import { SparkRenderer, SparkXr, SplatMesh } from '@sparkjsdev/spark';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { stamp, placementOk, polyCells, worldFootprint, toCell, applyIntervention, type GridMeta, type Layers, type Layout, type Pose, type XY, type Intervention } from './grid.ts';
import { buildWalker, type WalkerCfg } from './walker.ts';
import { nightShader } from './night.ts';
import { initClips, exportForCosmos } from './cosmos.ts';
import type { Eval, Init } from './worker.ts';
import { floorHit, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S, DELETE_SHOW_S, DRAG_DEADZONE_M } from './wand.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RUN = new URLSearchParams(location.search).get('scene') ?? 'game_synth';
const BASE = `scene/${RUN}/`;
const json = (f: string) => fetch(BASE + f).then(r => { if (!r.ok) throw new Error(`${BASE}${f}: ${r.status}`); return r.json(); });
const bin = (f: string) => fetch(BASE + f).then(r => r.arrayBuffer());

const sc = await json('scene.json');
const [walkerCfg, persona, route, hzFile] = await Promise.all([json(sc.walker), json(sc.persona), json(sc.route), json(sc.hazards)]) as
  [WalkerCfg, any, { start: XY; goal: XY }, { hazards: any[] }];
persona.step_model = new URLSearchParams(location.search).get('step') ?? persona.step_model ?? 'hand';   // ?step=learned|hand
const stepModel = persona.step_model === 'learned' ? await fetch('models/step_model.json').then(r => r.json()) : undefined;
const g: GridMeta = sc.grid;
const [nx, ny] = g.shape;
const base: Layers = { floor: new Uint8Array(await bin(sc.grid.floor)), obst: new Uint8Array(await bin(sc.grid.obstacles)), bump: new Float32Array(await bin(sc.grid.bump_height_m)) };
const coverage = new Uint8Array(await bin(sc.grid.coverage));
// cables and other thin bumps: classified, height is a typical value from config, never measured
const est = sc.grid.bump_estimated ? new Uint8Array(await bin(sc.grid.bump_estimated)) : new Uint8Array(nx * ny);
const objs: any[] = sc.objects;
const interventions: Intervention[] = sc.interventions;
const risk = sc.risk;

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
const spark = new SparkRenderer({ renderer });
scene.add(spark);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 2.2);
scene.add(hemi);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); css.setSize(innerWidth, innerHeight);
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
const walker = buildWalker(walkerCfg);
scene.add(walker.group);
const centreOffset = walkerCfg.user_gap_m + walkerCfg.depth_m / 2;   // body centre -> walker frame centre (the planned path)
const legTags = walker.legs.map(() => { const t = label(''); t.visible = false; scene.add(t); return t; });
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
const init: Init = { g, base, est, objects: objs, route, persona, risk, interventions, stepModel,
  plan: { walker_width_m: walkerCfg.width_m, ...sc.plan }, rules: sc.hazard_rules };
worker.postMessage({ type: 'init', init });
let seq = 0, latestEval = 0;
const waiting = new Map<number, (d: any) => void>();
worker.onmessage = e => { waiting.get(e.data.id)?.(e.data); waiting.delete(e.data.id); };
const ask = (msg: object) => new Promise<any>(res => { const id = ++seq; waiting.set(id, res); worker.postMessage({ ...msg, id }); });

const game: any = { ready: false, fps: 0, evals: 0 };
(window as any).game = game;

async function replan(): Promise<number> {
  const t = performance.now();
  L = stamp(g, base, objs, layout.poses, layout.flattened);
  const id = seq + 1;
  latestEval = id;
  const { r } = await ask({ type: 'eval', layout });
  if (id !== latestEval) return performance.now() - t;    // a newer layout is already on its way
  current = r;
  baselinePerMonth ??= r.per_month;
  routeS = [0];
  for (let k = 1; k < r.xy.length; k++) routeS.push(routeS[k - 1] + Math.hypot(r.xy[k][0] - r.xy[k - 1][0], r.xy[k][1] - r.xy[k - 1][1]));
  drawPlan(r);
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
  $('risk').innerHTML = r.error ? '<span class="delta-bad">no route for this walker</span>' :
    `<div class="big measured">${fmt(r.per_month)}</div>expected toe contacts / month (${risk.rollouts} simulated trips, ${risk.trips_per_night}/night; steps: ${persona.step_model === 'learned' ? 'learned model' : 'hand rule'})` +
    `<br>original layout: ${fmt(baselinePerMonth!)} → now ${fmt(r.per_month)} <span class="${d <= 0 ? 'delta-good' : 'delta-bad'}">(${d <= 0 ? '' : '+'}${fmt(d)})</span>`;
  const geo = r.hazards.map(h => `<li><span class="measured">${h.type === 'floor_bump' ? (h.estimated ? `${h.name}: thin cable/cord, ~${(h.height_m! * 100).toFixed(1)} cm ESTIMATED (classified, not measured)` : `${h.name}: ${(h.height_m! * 100).toFixed(1)} cm bump`) : `tight passage: ${(h.min_side_clearance_m! * 100).toFixed(0)} cm each side`}</span>` +
    ` over ${h.length_m.toFixed(2)} m${h.type === 'floor_bump' ? ` · ${fmt(h.per_month)}/month` : ''}${h.ot_check ? ' · <span class="ot">OT should check</span>' : ''}</li>`);
  const reason = hzFile.hazards.filter(h => h.source === 'cosmos_reason').map(h => `<li><span class="imagined">${h.note}</span> · proposed by Cosmos Reason, not measured · <span class="ot">OT should check</span></li>`);
  $('hazards').innerHTML = [...geo, ...reason].join('') || '<li>none on this route</li>';
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
  if (placementOk(g, placeBase, objs, poses, selected)) lastValid = p;
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
  if (!placementOk(g, placeBase, objs, layout.poses.map((o, n) => (n === selected ? p : o)), selected)) return refused();
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
  updateNight();
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
$('planfixes').onclick = async () => {
  $('fixes').innerHTML = '<li>rolling out each fix…</li>';
  const { before, fixes } = await ask({ type: 'fixes', layout });
  $('fixes').innerHTML = '';
  for (const f of fixes) {
    const li = document.createElement('li');
    li.innerHTML = f.error ? `${f.label}: <span class="delta-bad">blocks the route</span> ` :
      `${f.label}: <b class="${f.reduction > 0 ? 'delta-good' : ''}">−${fmt(Math.max(0, f.reduction))}/month</b> (${before > 0 ? Math.round((100 * f.reduction) / before) : 0}%) `;
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
$('imagfill').onchange = () => syncObjects();
$('imagceil').onchange = () => { if (ceiling) ceiling.visible = $<HTMLInputElement>('imagceil').checked; };
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
function autoStep(dt: number) {
  if (!current || current.error || routeS.length < 2) return;
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
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt, now / 1000);
  frames++;
  if (now - fpsT > 1000) {
    game.fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now;
    $('hud').textContent = `${game.fps.toFixed(0)} fps · ${mode === 'auto' ? 'autoplay' : mode === 'fly' ? 'fly (noclip)' : 'free walk'} · ${RUN}${sc.scale_note ? ` · ${sc.scale_note}` : ""}`;
  }
}
function step(dt: number, t: number) {
  if (renderer.xr.isPresenting) xrStep(dt);
  else if (mode === 'auto') autoStep(dt); else if (mode === 'fly') flyStep(dt); else freeStep(dt);
  walker.group.position.set(body.x, body.y, 0);
  walker.group.rotation.z = body.yaw;
  if (renderer.xr.isPresenting) {
    liveChecks(t);
    renderer.render(scene, camera);   // CSS2D labels are DOM: they can't show inside the headset
    return;
  }
  if (mode === 'fly') {
    const c = Math.cos(body.pitch);
    camera.position.set(fly.x, fly.y, fly.z);
    camera.lookAt(fly.x + Math.cos(body.yaw) * c, fly.y + Math.sin(body.yaw) * c, fly.z + Math.sin(body.pitch));
  } else placeCamera(camera, body);
  liveChecks(t);
  renderer.render(scene, camera);
  css.render(scene, camera);
}

// ---------- VR (WebXR, e.g. Quest Browser) ----------
// WebXR's local-floor space is y-up with the floor at y=0; the scene is the +z-up floor frame. The camera rides in a
// rig: +90 deg about x maps XR up (+y) to +z, then a turn about z by yaw - 90 deg points XR forward (-z) along yaw.
// Room-scale walking is 1:1. Left stick walks along the floor, only where free walk could stand (walls, furniture and
// unfilmed floor block it: no noclip); right stick snap-turns 30 deg about the head. Holding a pinch or trigger on the
// non-wand hand walks forward where you look (the wand hand edits: see below). The walker stays at your feet.
// ?emulate=quest2: Meta's IWER replaces navigator.xr with a scripted Quest 2 (head, controllers, hands), so e2e/xr.ts
// can enter VR, look, point and press with no headset. Loaded only with the flag; must run before SparkXr checks support.
const xrDevice = PARAMS.has('emulate')
  ? await import('iwer').then(({ XRDevice, metaQuest2 }) => {   // forceInstall: desktop Chrome has its own (deviceless) navigator.xr
    const d = new XRDevice(metaQuest2); d.installRuntime({ forceInstall: true }); return d;
  })
  : null;
const rig = new THREE.Group();
scene.add(rig);
const xrRig = { x: 0, y: 0, yaw: 0 };
const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), UP = new THREE.Vector3(0, 0, 1);
function placeRig() {
  rig.position.set(xrRig.x, xrRig.y, 0);
  rig.quaternion.setFromAxisAngle(UP, xrRig.yaw - Math.PI / 2).multiply(TILT);
}
let snapReady = true;
const pinching = new Set<object>();   // non-wand hands/controllers holding select: walk
const head = new THREE.Vector3(), headDir = new THREE.Vector3();
function xrStep(dt: number) {
  // the user camera, not renderer.xr.getCamera(): before render() that one still holds the raw y-up headset pose
  // without the rig; three writes the camera's rig-local pose after each render, so this is last frame's head, in the floor frame
  camera.getWorldPosition(head); camera.getWorldDirection(headDir);
  const yaw = Math.atan2(headDir.y, headDir.x);
  const pads: Record<string, Gamepad> = {};
  for (const s of renderer.xr.getSession()?.inputSources ?? []) if (s.gamepad) pads[s.handedness] = s.gamepad;
  const stick = (p?: Gamepad) => (p ? [p.axes[2] ?? 0, p.axes[3] ?? 0].map(a => (Math.abs(a) < 0.2 ? 0 : a)) : [0, 0]);
  const [sx, stickY] = stick(pads.left), [tx] = stick(pads.right), sy = stickY || (pinching.size ? -1 : 0);
  if (sx || sy) {   // sub-steps of at most half a cell, as in free walk
    const v = 0.6 * dt, dx = (-sy * Math.cos(yaw) + sx * Math.sin(yaw)) * v, dy = (-sy * Math.sin(yaw) - sx * Math.cos(yaw)) * v;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (g.cell_m / 2)));
    for (let i = 0; i < n; i++) {
      const c = cellAt(head.x + dx / n, head.y + dy / n);
      if (!L.floor[c] || L.obst[c] || coverage[c] === 0) break;
      xrRig.x += dx / n; xrRig.y += dy / n; head.x += dx / n; head.y += dy / n;
    }
  }
  if (Math.abs(tx) > 0.7 && snapReady) {   // rotate the rig about the head, so turning doesn't also slide you sideways
    const a = -Math.sign(tx) * Math.PI / 6, c = Math.cos(a), s = Math.sin(a), rx = xrRig.x - head.x, ry = xrRig.y - head.y;
    Object.assign(xrRig, { x: head.x + c * rx - s * ry, y: head.y + s * rx + c * ry, yaw: xrRig.yaw + a });
    snapReady = false;
  } else if (Math.abs(tx) < 0.3) snapReady = true;
  placeRig();
  body.x = head.x; body.y = head.y;
  body.yaw += Math.atan2(Math.sin(yaw - body.yaw), Math.cos(yaw - body.yaw)) * Math.min(1, dt * 4);
  wandStep();
}

// ---------- VR wand: point at furniture and hold to drag it (twist the wrist to turn it), hold still to delete it;
// point at the floor and release to teleport. A hand pinch and a controller trigger are the same WebXR "select", so
// hands stand in for the controllers. Moves go through the desktop editor's placement check and commitPose re-plan.
const WAND: XRHandedness = PARAMS.get('wand') === 'left' ? 'left' : 'right';   // ?wand=left for left-handed users
type Ctl = { group: THREE.XRTargetRaySpace; source?: XRInputSource; ray: THREE.Line };
const wandRay = new THREE.Raycaster(), RED3 = new THREE.Color(0xff3030);
const tpRing = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.24, 32),
  new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
tpRing.renderOrder = 1; tpRing.visible = false;
scene.add(tpRing);
let grab: { k: number; off: XY; start: XY; drag: number; t0: number; yaw0: number; q0: THREE.Quaternion; valid?: Pose } | null = null;
let aiming = false, hover = -1;
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

// The headset GPU is fill-bound: a splat's soft tail and huge near-eye splats cost the most for the least. In VR only,
// trim splats to ?stddev= standard deviations (Spark default sqrt 8) and cap them at ?maxpx= pixels (default 512).
// Quest 2, kitchen 120K at 72 Hz: 36 fps with Spark's defaults, 72 with 2.0 and 128.
const XR_SPLAT = { maxStdDev: +(PARAMS.get('stddev') ?? 2.0), maxPixelRadius: +(PARAMS.get('maxpx') ?? 128) };
const DESK_SPLAT = { maxStdDev: spark.maxStdDev, maxPixelRadius: spark.maxPixelRadius };

function aim(c: Ctl) {   // the controller's pose is rig-local (reference space): refresh its world matrix through the rig
  c.group.updateWorldMatrix(true, false);
  return wandRay.setFromXRController(c.group), wandRay.ray;
}
const inGrid = (x: number, y: number) => x >= g.origin_xy[0] && y >= g.origin_xy[1] && x < g.origin_xy[0] + nx * g.cell_m && y < g.origin_xy[1] + ny * g.cell_m;
const standable = (x: number, y: number) => { const c = cellAt(x, y); return inGrid(x, y) && !!L.floor[c] && !L.obst[c] && coverage[c] > 0; };
function wandDown(c: Ctl) {
  if (hover < 0) { aiming = true; return; }
  const r = aim(c), f = floorHit(r.origin, r.direction), p = layout.poses[hover], at: XY = f ? [f.x, f.y] : [p.x, p.y];
  grab = { k: hover, off: [p.x - at[0], p.y - at[1]], start: at, drag: 0, t0: performance.now(), yaw0: p.yaw, q0: c.group.getWorldQuaternion(new THREE.Quaternion()) };
}
function wandUp() {
  if (grab) { const { k, valid } = grab; grab = null; if (valid) commitPose(k, valid); return; }
  if (aiming && tpRing.visible) { xrRig.x += tpRing.position.x - head.x; xrRig.y += tpRing.position.y - head.y; placeRig(); }
  aiming = false; tpRing.visible = false;
}
/** Put the head at floor-frame (x, y) looking along yaw by moving the rig: scripted viewpoints on a headset nobody
 * wears (e2e/quest-sweep.ts). Uses last frame's head pose, like xrStep. */
function xrPlace(x: number, y: number, yaw: number) {
  camera.getWorldPosition(head); camera.getWorldDirection(headDir);
  const a = yaw - Math.atan2(headDir.y, headDir.x), c = Math.cos(a), s = Math.sin(a), rx = xrRig.x - head.x, ry = xrRig.y - head.y;
  Object.assign(xrRig, { x: x + c * rx - s * ry, y: y + s * rx + c * ry, yaw: xrRig.yaw + a });   // turn about the head, then move it
  placeRig();
}
function dropWand() {   // wand lost mid-gesture (hand out of view): put a dragged object back where the layout has it
  if (grab) syncObjects();
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
        if (placementOk(g, placeBase, objs, layout.poses.map((q, n) => (n === grab!.k ? p : q)), grab.k)) {
          it.group.position.set(p.x, p.y, 0); it.group.rotation.z = p.yaw; grab.valid = p;
        }
      }
      prog = holdProgress((performance.now() - grab.t0) / 1000, grab.drag);
      if (prog >= 1) { const k = grab.k; grab = null; removeObject(k); prog = -1; }
    } else {
      const hit = wandRay.intersectObjects(items.filter((_, k) => !layout.poses[k].removed).map(i => i.proxy))[0];
      hover = hit ? items.findIndex(i => i.proxy === hit.object) : -1;
      if (hit) len = hit.distance;
      if (hover < 0 && aiming && f && standable(f.x, f.y)) { tpRing.position.set(f.x, f.y, 0.03); tpRing.visible = true; }
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

new SparkXr({   // adds the Enter VR button; "VR not supported" where WebXR isn't available
  renderer, mode: 'vr', referenceSpaceType: 'local-floor', enableHands: true,
  // ?xrscale=<0..1> render resolution per eye (Spark's default 0.5), ?foveation=<0..1> blur toward the edges (headset GPUs are fill-bound)
  frameBufferScaleFactor: PARAMS.has('xrscale') ? +PARAMS.get('xrscale')! : undefined,
  fixedFoveation: PARAMS.has('foveation') ? +PARAMS.get('foveation')! : undefined,
  onEnterXr: () => {
    // a route can start at the edge of the scan (kitchen4: a doorway outside the grid): start at the first point along
    // it with filmed floor, or the headset begins inside a wall's splats (slow, and you see the room through the wall)
    if (!standable(body.x, body.y) && current && !current.error) {
      for (let s = 0; s < routeS[routeS.length - 1]; s += 0.05) { const p = routePose(s, body.yaw, Infinity); if (standable(p.x, p.y)) { Object.assign(body, p); break; } }
    }
    Object.assign(xrRig, { x: body.x, y: body.y, yaw: body.yaw }); placeRig(); rig.add(camera); snapReady = true; game.xr = true;
    select(-1);   // the desktop gizmo has no place in the headset
    Object.assign(spark, XR_SPLAT);
    // ?hz=72: a lower refresh gives each frame more time (90 Hz = 11.1 ms, 72 Hz = 13.9 ms); the Quest 2 offers 60-120
    if (PARAMS.has('hz')) renderer.xr.getSession()?.updateTargetFrameRate?.(+PARAMS.get('hz')!).catch(() => {});
  },
  onExitXr: () => {
    camera.removeFromParent(); pinching.clear(); dropWand(); hover = -1; game.xr = false;
    Object.assign(spark, DESK_SPLAT);
    for (const it of items) { it.outline.visible = false; (it.outline.material as THREE.LineBasicMaterial).color.setHex(0x66ccff); }
  },
});

// ---------- start ----------
setWalk('auto');
await replan();
if ((current as Eval | null)?.error === undefined && current) Object.assign(body, routePose(0, 0, Infinity));
else { const [sx, sy] = route.start; Object.assign(body, { x: sx - centreOffset, y: sy, yaw: 0 }); }
renderer.setAnimationLoop(frame);   // not requestAnimationFrame: in a headset session only the XR frame loop runs

const ctx = { RUN, sc, objs, layout: () => layout, applied: () => applied, current: () => current, routePose, routeS: () => routeS,
  walker: walkerCfg, persona, body, renderer, scene, walkerGroup: walker.group, placeCamera, cameraToW2C, night: () => $<HTMLInputElement>('night').checked };
initClips();
$('export').onclick = () => exportForCosmos(ctx);

Object.assign(game, {
  ready: true, state, body, fly, items: objs.map(o => o.name), view,
  /** Fixed-step clock for recordings: game.manual = true stops the rAF loop; each tick advances dt s and renders. */
  tick(dt: number) { clockT += dt; step(dt, clockT); },
  resume() { game.manual = false; last = performance.now(); },   // the animation loop never stopped: frame() was skipping
  autoS: () => autoS, setAuto: () => setWalk('auto'),
  /** Live profiling from DevTools (e.g. hide splats in a headset session and watch game.fps). */
  debug: { renderer, scene, spark, splats, main: splats[0], items, overlays: [routeLine, ghostDots, hazardGroup, tapeGroup],
    rig, xrDevice, xrPlace, wand: () => ({ hover: hover >= 0 ? objs[hover].name : null, grab: grab ? objs[grab.k].name : null, aiming, teleport: tpRing.visible,
      drag: grab?.drag, valid: grab?.valid ?? null }) },
  /** In a headset session: where the XR camera, the user camera in its rig, and the walker actually are (floor frame). */
  xrPose() {
    const w = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3));
    return { xr: renderer.xr.isPresenting, head: w(renderer.xr.getCamera()), userCam: w(camera), rig: { ...xrRig }, body: { ...body }, walker: w(walker.group),
      inputs: [...renderer.xr.getSession()?.inputSources ?? []].map(s => `${s.handedness}:${s.hand ? 'hand' : 'controller'}`), pinching: pinching.size };
  },
  setFree(x: number, y: number, yaw: number) { setWalk('free'); Object.assign(body, { x, y, yaw }); },
  layout: () => layout, current: () => current,
  cell(x: number, y: number) { const c = cellAt(x, y); return { floor: L.floor[c], obst: L.obst[c], cov: coverage[c] }; },
  fillVisible: (name: string) => items[objs.findIndex(o => o.name === name)].fill.visible,
  moveObject(name: string, x: number, y: number, yawDeg = 0) {   // same path as a finished drag
    const k = objs.findIndex(o => o.name === name), p = { x, y, yaw: (yawDeg * Math.PI) / 180 };
    if (!placementOk(g, placeBase, objs, layout.poses.map((q, n) => (n === k ? p : q)), k)) return Promise.resolve({ ok: false });
    return commitPose(k, p).then(ms => ({ ok: true, ms }));
  },
  removeObject: (name: string) => removeObject(objs.findIndex(o => o.name === name)),
  applyFix, select: (name: string) => select(objs.findIndex(o => o.name === name)),
  exportForCosmos: () => exportForCosmos(ctx),
});

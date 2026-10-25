import { cameraToW2C } from './frame.ts';   // first: sets the +z-up convention before any camera exists
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { stamp, carvedPolys, placementOk, polyCells, edt, worldFootprint, toCell, applyIntervention, placedFixtures, type GridMeta, type Layers, type Layout, type Pose, type XY, type Intervention } from './grid.ts';
import { buildDevice as deviceMesh, type WalkerCfg } from './walker.ts';
import { groundDevice, footShadows, roomEnvironment } from './ground.ts';
import { WHEELCHAIR, wheelchairPersona, ZERO_CONTACTS, ADA, SEAT_Z, WHEEL_R } from './wheelchair.ts';
import { chairGeometry, clearOf, driveStep, spinBy, type Chair } from './drive.ts';
import { keyIntent, createHistory, createKeyOverlay } from './controls.ts';
import { controlHints, hintLines, type HintCtx } from './hints.ts';
import { pathLights, createLights3d } from './lights.ts';
import { strokePersona } from './stroke.ts';
import { bathroomFixes, createBathroom3d } from './bathroom.ts';
import { nightShader } from './night.ts';
import { createVision, PROFILES, type Profile } from './vision.ts';
import { createHeatOverlay, nights, drawTimeline } from './heat.ts';
import { buildMannequin, feetAt, type Step } from './mannequin.ts';
import { loadRigged } from './rig.ts';
import { createLivePhys, type LivePhys } from './livephys.ts';
import { initClips, exportForCosmos, listClips, type ExportOpts } from './cosmos.ts';
import { layoutKey } from './prerender.ts';
import { drawTopdown } from './topdown.ts';
import { spots, vantage, heightTexels, type Spot } from './spotlight.ts';
import { summarize, drawPushChart, poseAt, pushColor, sampleText } from './physdebug.ts';
import { cardState, encodeCard, type ActionOut, type ReportPayload } from './share.ts';
import { createReimagine, undoChange, costText, card, poseAt as layoutPoseAt, type Change } from './reimagine.ts';
import { moveCost, removeCost, sumCosts } from './movecost.ts';
import { isMoved, movedText, resetPose } from './resets.ts';
import { twistAngle, snapQuarter } from './wand.ts';
import { createObjLabel } from './objlabel.ts';
import { measureStair, stairFixes, stairFrame, stairYaml, mirrorRail, inRailBand, stepLights, withRails, pitchAt, parkedPose, walkerPlacement, SPLAT_STRIDE, type Stair, type Side } from './stairs.ts';
import { createStairs3d } from './stairs3d.ts';
import { railSplats, toneOf, fitRail, NEUTRAL_RAIL, type RGB } from './railsplat.ts';
import { doorFixes, doorYaml, needWidth, hingeSide, growOf, type Door } from './doors.ts';
import { createDoors3d } from './doors3d.ts';
import { startMarking, place, undo as undoMark, isComplete, prompt as markPrompt, placeError, preview, buildLevels, snapZ, checkAll,
  stairHandles, moveStairHandle, stairPoints, doorHandles, moveDoorHandle, type Marking, type MarkKind, type P3, type Levels } from './marker.ts';
import { createMarker3d } from './marker3d.ts';
import { MAX_EXTRA_LIGHTS, type PointLight } from './night.ts';
import { PERF, FULL, tierAtLoad, perfAtLoad, splatCfg, xrCfg, clusterHazards } from './perf.ts';
import QRCode from 'qrcode';
import { mountFrontend, type FrontendAdapter } from './frontend.ts';
import { headingMismatch, nearestStandable, routeResume } from './navmode.ts';
import { createFrontendXR } from './frontend-xr.ts';
import type { Eval, Init, RouteDef } from './worker.ts';
import type { Ghost } from './sim.ts';
import type { WorldModel } from './worldmodel.ts';
import { setupXR, type XrEditor } from './xr.ts';
import { plainSpot, tourStand } from './xrtour.ts';
import { createXRComparison } from './xrcompare.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// model and scene text (Cosmos Reason notes, hazard details) goes into innerHTML escaped; same as report.ts's, which can't
// be imported: that module renders the report page when loaded
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const RUN = new URLSearchParams(location.search).get('scene') ?? 'kitchen4_lighter';
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
// ---------- wheelchair (wheelchair.ts): one more comparison persona in every scene; a chair has no fall model, so its
// contact table is all zeros and the ADA checks (turning space, level changes, door width, stairs) carry the result
if (!personas.wheelchair) personas.wheelchair = wheelchairPersona(personas.patient);
if (!personas.stroke) personas.stroke = strokePersona(personas.patient);   // stroke.ts: the stronger hand flips to the right
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
let pathLightIvs: Intervention[] = [];   // "Light the path" (lights.ts): kept in the fix list like the stair and door fixes
const risk = sc.risk;
risk.contact_table.wheelchair ??= ZERO_CONTACTS;
// every walk the patient makes (stage 12 routes.json); older exports have only route.json: one night route
const routes: RouteDef[] = sc.routes ? await json(sc.routes) : [{ name: 'route', ...route, trips_per_night: risk.trips_per_night, night: true }];
let selRoute = 0;

// ---------- three + Spark ----------
// performance mode (perf.ts): on in a standalone headset, off over Link (the PC renders the full scene); ?perf=1|0 decides,
// else what the person chose last time. ?stddev= and ?maxpx= (the Link guide's names) always set the splat limits.
const wantXR = new URLSearchParams(location.search).has('xr');
let inXR = false;   // presenting in a headset (xr.ts): hazard labels are scene cards then, DOM labels don't render in WebXR
const tier = tierAtLoad(location.search, wantXR);
let perfOn = perfAtLoad(location.search, tier, (() => { try { return localStorage.getItem('homeclear.perf'); } catch { return null; } })());
// the drawing buffer is kept on the monitor for screenshots (fix card, e2e); a headset frame doesn't need the extra copy
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: !wantXR });
renderer.setPixelRatio(Math.min(devicePixelRatio, perfOn ? PERF.pixel_ratio : FULL.pixel_ratio));
renderer.setSize(innerWidth, innerHeight);
$('view').appendChild(renderer.domElement);
const css = new CSS2DRenderer();
css.setSize(innerWidth, innerHeight);
Object.assign(css.domElement.style, { position: 'fixed', inset: '0', pointerEvents: 'none' });
document.body.appendChild(css.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2126);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 60);
const sparkR = new SparkRenderer({ renderer });
scene.add(sparkR);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 2.2);
scene.add(hemi);
const HEMI_ENV = 0.6;   // the hemisphere's share once the room's env map lights the meshes (ground.ts)
const nightLamp = new THREE.PointLight(0xffb36b, 0, 1.5, 2);   // night: the nightlight on the meshes (updateNight)
scene.add(nightLamp);
const vision = createVision(renderer, scene, camera);
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
// scanned = where the piece was filmed (its fill, its never-filmed floor); original = where the walk starts: the scanned
// spot, or a staged `start` [x, y, yaw deg] (tools/stage_demo_hazards.py pulls a chair into the path)
const scanned: Pose[] = objs.map(o => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 }));
const original: Pose[] = objs.map((o, k) => (o.start ? { x: o.start[0], y: o.start[1], yaw: (o.start[2] * Math.PI) / 180 } : scanned[k]));
// the floor under each object was never filmed, and specks inside its box are its own splat leftovers, but it stands
// there now: count its own spot as clear floor for placement only (planning still sees the measured layers), else every
// drag that still overlaps that spot snaps back (the kitchen rug couldn't move at all otherwise)
const placeBase: Layers = { ...base, floor: base.floor.slice(), obst: base.obst.slice() };
objs.forEach((o, k) => { for (const c of polyCells(g, worldFootprint(o, scanned[k]))) { placeBase.floor[c] = 1; placeBase.obst[c] = 0; } });
// free walk keeps to filmed floor, but the floor under the furniture was never filmed: once a piece is moved or removed
// you can walk onto its spot (only where it is floor: a box on a cabinet doesn't open the cabinet top). Unfilmed seams
// up to 12 cm wide (beside a chair leg, between two outlines) count as filmed too, else they stop you mid-room
const seen = coverage.map(v => +(v > 0));
objs.forEach((o, k) => { for (const c of polyCells(g, worldFootprint(o, scanned[k]))) if (base.floor[c]) seen[c] = 1; });
const unseen = edt(seen, nx, ny).map(d => +(d * g.cell_m > 0.06));
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
  fill.recolor = new THREE.Color(1, 0.9, 1);       // tint: imagined, not measured (faint, so the generated floor reads as floor; the "imagined" tag says the rest)
  fill.visible = false;
  const tag = o.placed ? new THREE.Object3D() : label('imagined, not measured', 'imag');   // staged for the demo: the floor under it was filmed
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
const routeLine = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x55c7ef, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false }));
// ghost walkers as one dot per step (WebGL lines are 1 px: trails hugging the route vanished); red = a toe contact
// one palette: cyan = footsteps (ghosts, heatmap, next-step cloud), orange -> red = bumps and contacts (rings, heat, leg flash), white = hand-rule baseline
const DOT = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d')!; const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, '#fff'); g.addColorStop(0.6, '#fffd'); g.addColorStop(1, '#fff0'); x.fillStyle = g; x.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();   // round soft dots, not square pixels
const ghostDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: DOT, vertexColors: true, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false }));
const hazardGroup = new THREE.Group(), tapeGroup = new THREE.Group();
// overlays draw after the splats: splats don't write depth, so drawn first they'd be painted over (rings, ghosts, fog would vanish)
// the hand-rule baseline's ghosts (when a learned model walks): white, toggled apart, to show where the two disagree
const handDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: DOT, vertexColors: true, size: 4, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }));
handDots.visible = false;
for (const o of [routeLine, ghostDots, handDots, hazardGroup, tapeGroup]) o.renderOrder = 1;
scene.add(routeLine, ghostDots, handDots, hazardGroup, tapeGroup);
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
    m.renderOrder = 1; m.name = 'fog';
    scene.add(m);
  }
}

// ---------- walker + camera ----------
// every device gets contact shadows under its legs (ground.ts): the patient's, the replay's, the one parked up the stairs
const GROUND = !PARAMS.has('noground');   // ?noground: the old look, for before/after shots
const buildDevice = (w: WalkerCfg) => { const d = deviceMesh(w); if (GROUND) groundDevice(d.group, w); return d; };
let walker = buildDevice(walkerCfg);
scene.add(walker.group);
let centreOffset = walkerCfg.user_gap_m + walkerCfg.depth_m / 2;   // body centre -> walker frame centre (the planned path)
const legTags = [0, 1, 2, 3].map(() => { const t = label(''); t.visible = false; scene.add(t); return t; });
const gapTag = label('', 'red');
gapTag.visible = false;
scene.add(gapTag);
const body = { x: 0, y: 0, yaw: 0, pitch: -(+(PARAMS.get('pitch') ?? 28)) * Math.PI / 180 };   // ?pitch=<deg down>: more walker, less room
// Explore (the toolbar button) is for looking around, not for testing the walker: the walker stays parked where you
// left it and nothing collides with you (walls, furniture, live physics), so the camera can't snag or shove a chair.
// Free walk (keys / game.setFree) keeps the walker on you and stays fenced; that's what the physics and e2e checks use.
const explore = { on: false, parked: null as null | { x: number; y: number; yaw: number } };
function setExplore(on: boolean) { explore.on = on; explore.parked = on ? { x: body.x, y: body.y, yaw: body.yaw } : null; }
const chairVel = { v: 0, w: 0 };   // the wheelchair's speed and turn rate (driving: see "wheelchair driving" below)
const isChair = () => walkerCfg.device === 'wheelchair';
let mode: 'auto' | 'free' | 'fly' = 'auto', autoS = 0, autoPause = 0;
let routePaused = false, routeSpeed = 1, frontendVR: ReturnType<typeof createFrontendXR> | null = null, xrFollowRoute = false;

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
  showPhysics();
  return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); return ms; });
}
async function replan(): Promise<number> {
  const t = performance.now();
  L = stamp(g, base, objs, layout.poses, layout.flattened, carvedPolys(layout));
  updateHeights();
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
  refreshReimagine();
  return ms;
}

function drawPlan(r: Eval) {
  routeLine.geometry.dispose();
  routeLine.geometry = new THREE.BufferGeometry().setFromPoints(r.xy.map(p => new THREE.Vector3(p[0], p[1], 0.035)));
  const dots = (pts: THREE.Points, ghosts: Ghost[], rgb: number[]) => {
    const pos: number[] = [], col: number[] = [];
    ghosts.forEach((gh, n) => {
      const z = 0.04 + n * 0.0004;
      gh.pts.forEach((q, k) => { pos.push(q[0], q[1], z); col.push(...(gh.hit[k] ? [1, 0.19, 0.19] : rgb)); });
    });
    pts.geometry.dispose();
    pts.geometry = new THREE.BufferGeometry();
    pts.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pts.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  };
  dots(ghostDots, r.ghosts, [0.3, 0.79, 0.94]);
  dots(handDots, r.hand?.ghosts ?? [], [0.92, 0.92, 0.96]);
  for (const c of [...hazardGroup.children]) {
    hazardGroup.remove(c);
    c.traverse(x => {
      if (x instanceof CSS2DObject) x.element.remove();
      else if (x instanceof THREE.Mesh || x instanceof THREE.Sprite) { (x as THREE.Mesh).geometry?.dispose(); (x.material as THREE.Material).dispose(); }   // rebuilt on every re-plan; card textures are cached
    });
  }
  for (const { rep: h, label: text } of clusterHazards(r.hazards)) {   // a row of bumps is one ring and one label (perf.ts)
    const bump = h.type === 'floor_bump';
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 32), new THREE.MeshBasicMaterial({ color: bump ? 0xff8a1f : 0xffe14d, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.set(h.position[0], h.position[1], 0.03);
    ring.userData.s = routeS[h.a] ?? 0;
    const t = wantXR || inXR ? card([text], bump ? '#ffcf99' : '#fff0a8', 'rgba(14,20,28,0.8)', 0.05) : label(text);   // DOM labels don't render in WebXR
    t.position.set(0, 0, 0.35);
    ring.add(t);
    hazardGroup.add(ring);
  }
  drawSpots(r);
  renderPanels();
}

const fmt = (x: number) => (x < 0.05 && x > 0 ? x.toFixed(2) : x.toFixed(1));
function renderPanels() {
  const r = current!;
  const d = r.per_month - (baselinePerMonth ?? r.per_month);
  const perRoute = r.routes.map((q, k) => `<li class="${k === r.sel ? 'sel' : ''}">${q.name}${q.night ? ' (night)' : ''}, ${q.trips_per_night}/night: ` +
    (q.error ? '<span class="delta-bad">no route</span>' : `<span class="measured">${fmt(q.per_month)}</span><span class="dbg"> (${fmt(q.lo)}–${fmt(q.hi)})</span>`) + '</li>').join('');
  $('risk').innerHTML = r.error ? `<span class="delta-bad">no route for this walker</span><ul>${perRoute}</ul>` :
    `<div class="big measured">${fmt(r.per_month)}</div><div class="range dbg">likely ${fmt(r.per_month_lo)}–${fmt(r.per_month_hi)}</div>` +
    `expected toe contacts / month, all routes (${risk.rollouts} simulated trips per route; steps: ${persona.step_model === 'world' ? 'world model (heels + walker)' : persona.step_model === 'learned' ? 'learned model' : 'hand rule'})` +
    `<span class="dbg"> range = measured height error ±${(100 * sc.hazard_rules.margin_m.height).toFixed(1)} cm + simulation noise</span>` +
    (r.hand ? `<div class="range">hand-rule baseline on the same route: ${fmt(r.hand.per_month)}</div>` : '') +
    `<ul class="routes">${perRoute}</ul>` +
    `original layout: ${fmt(baselinePerMonth!)} → now ${fmt(r.per_month)} <span class="${d <= 0 ? 'delta-good' : 'delta-bad'}">(${d <= 0 ? '' : '+'}${fmt(d)})</span>`;
  const geo = r.hazards.map(h => `<li><span class="measured">${h.type === 'floor_bump' ? (h.estimated ? `${h.name}: thin cable/cord, ~${(h.height_m! * 100).toFixed(1)} cm ESTIMATED (classified, not measured)` : `${h.name}: ${(h.height_m! * 100).toFixed(1)} cm bump`) : `tight passage: ${(h.min_side_clearance_m! * 100).toFixed(0)} cm each side`}</span>` +
    ` over ${h.length_m.toFixed(2)} m${h.type === 'floor_bump' ? ` · ${fmt(h.per_month)}/month` : ''}${h.ot_check ? ' · <span class="ot">OT should check</span>' : ''}</li>`);
  // Cosmos Reason: proposals already checked against the grids (cosmos/reason.py); the dismissed ones are not listed
  const reason = hzFile.hazards.filter(h => h.source === 'cosmos_reason' && h.verdict !== 'dismissed').map(h =>
    `<li><span class="imagined">${esc(h.note)}</span> · proposed by Cosmos Reason${h.verdict === 'confirmed' ? `, <span class="measured">geometry agrees: ${esc(h.measured)}</span>` : ', not measurable from the scan · <span class="ot">OT should check</span>'}</li>`);
  $('hazards').innerHTML = [...geo, ...reason].join('') || '<li>none on this route</li>';
  const vcls = (v: string) => (v === 'ok' ? 'delta-good' : v === 'fail' ? 'delta-bad' : 'ot');
  $('checks').innerHTML = r.checks.map(c => `<li><span class="${vcls(c.verdict)}">${c.verdict}</span> ${c.label}<br><small>${c.note}</small></li>`).join('')
    || '<li>no fixtures marked for this home</li>';
}

// ---------- hazard spotlights (spotlight.ts): the object behind each measured hazard glows, proposals get pins ----------
// Measured hazards pulse orange on the object that makes them; Cosmos Reason proposals are pins in their own colours and
// always say "proposed": teal when the measured grids agree, violet when only an OT can check.
const spotGroup = new THREE.Group();
spotGroup.renderOrder = 2;
scene.add(spotGroup);
const glow = items.map(it => {
  const m = new THREE.Mesh(it.proxy.geometry, new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.position.copy(it.proxy.position); m.rotation.copy(it.proxy.rotation); m.visible = false; m.renderOrder = 2;
  it.group.add(m);
  return m;
});
const SPOT_RGB = { measured: 0xff8a1f, 'reason-confirmed': 0x2fd6a8, 'reason-ot': 0xb48cff };
let spotList: Spot[] = [], tourSpot = -1;
function clearGroup(grp: THREE.Group) { for (const c of [...grp.children]) { grp.remove(c); c.traverse(x => { if (x instanceof CSS2DObject) x.element.remove(); }); } }
function drawSpots(r: Eval) {
  clearGroup(spotGroup);
  glow.forEach(m => { m.visible = false; m.userData.sev = 0; });
  spotList = r.error ? [] : spots(r.hazards, objs, hzFile.hazards, sc.hazard_rules?.margin_m?.height ?? 0);
  if (!$<HTMLInputElement>('spot').checked) return;
  for (const s of spotList) {
    if (s.object >= 0 && !layout.poses[s.object].removed) { glow[s.object].visible = true; glow[s.object].userData.sev = s.severity; }
    if (s.kind === 'measured') continue;
    const hz = hzFile.hazards.find(h => h.source === 'cosmos_reason' && Math.abs(h.position_m[0] - s.xy[0]) < 1e-6 && Math.abs(h.position_m[1] - s.xy[1]) < 1e-6);
    const z = Math.max(0.05, hz?.position_m[2] ?? 0.05), col = SPOT_RGB[s.kind];
    const pin = new THREE.Group();
    pin.position.set(s.xy[0], s.xy[1], 0);
    pin.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, 0, z + 0.4)]), new THREE.LineBasicMaterial({ color: col })));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false }));
    head.position.set(0, 0, z + 0.4);
    const t = label(s.label, 'imag');
    t.position.set(0, 0, z + 0.55);
    pin.add(head, t);
    spotGroup.add(pin);
  }
}
$('spot').onchange = () => current && drawSpots(current);
/** pulse the glow (tour stop stronger); called every frame from step() */
function pulseSpots(t: number) {
  glow.forEach((m, k) => {
    if (!m.visible) return;
    const sev = m.userData.sev as number, here = tourSpot >= 0 && spotList[tourSpot]?.object === k;
    (m.material as THREE.MeshBasicMaterial).opacity = (0.08 + 0.16 * sev + (here ? 0.12 : 0)) * (0.65 + 0.35 * Math.sin(t * 3.2));
  });
}

// the measured bump heights as a floor overlay: colour = height, hatched where the height is only a typical value
const heightTex = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat);
heightTex.magFilter = heightTex.minFilter = THREE.NearestFilter;
const heightMesh = new THREE.Mesh(new THREE.PlaneGeometry(nx * g.cell_m, ny * g.cell_m), new THREE.MeshBasicMaterial({ map: heightTex, transparent: true, depthWrite: false }));
heightMesh.position.set(g.origin_xy[0] + (nx * g.cell_m) / 2, g.origin_xy[1] + (ny * g.cell_m) / 2, 0.024);
heightMesh.renderOrder = 1; heightMesh.visible = false;
scene.add(heightMesh);
function updateHeights() {
  heightMesh.visible = $<HTMLInputElement>('heights').checked;
  if (!heightMesh.visible) return;
  (heightTex.image.data as Uint8Array).set(heightTexels(g, L.bump, est));
  heightTex.needsUpdate = true;
}
$('heights').onchange = updateHeights;

// hazard tour: fly to each spot (worst first), hold with its caption; any key or a drag in the view ends it
const tour = { on: false, k: 0, t: 0, phase: 'fly' as 'fly' | 'hold', from: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, to: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 } };
const TOUR_FLY_S = 1.4, TOUR_HOLD_S = 3;
function tourGo(k: number) {
  const s = spotList[k];
  tour.k = k; tour.t = 0; tour.phase = 'fly'; tourSpot = k;
  tour.from = { x: fly.x, y: fly.y, z: fly.z, yaw: body.yaw, pitch: body.pitch };
  tour.to = vantage(s.xy, current!.xy);
  $('tourcap').hidden = true;
}
function startTour() {
  if (tour.on) return endTour();
  if (!spotList.length || !current || current.error) { $('status').textContent = 'no hazards on this route to tour'; return; }
  setWalk('fly');
  tour.on = true; $('tour').textContent = 'Stop tour';
  tourGo(0);
}
function endTour() {
  if (!tour.on) return;
  tour.on = false; tourSpot = -1; $('tour').textContent = 'Hazard tour'; $('tourcap').hidden = true;
}
function tourStep(dt: number) {
  if (!tour.on) return;
  tour.t += dt;
  if (tour.phase === 'fly') {
    const f = Math.min(1, tour.t / TOUR_FLY_S), e = f * f * (3 - 2 * f), a = tour.from, b = tour.to;
    fly.x = a.x + e * (b.x - a.x); fly.y = a.y + e * (b.y - a.y); fly.z = a.z + e * (b.z - a.z);
    body.yaw = a.yaw + e * Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    body.pitch = a.pitch + e * (b.pitch - a.pitch);
    if (f >= 1) {
      tour.phase = 'hold'; tour.t = 0;
      const s = spotList[tour.k], cap = $('tourcap');
      cap.hidden = false;
      cap.innerHTML = `<b>${tour.k + 1}/${spotList.length}</b> · ${s.kind === 'measured' ? 'measured' : '<span class="imagined">proposed by Cosmos Reason, not measured</span>'}<br>${esc(s.detail)}`;   // model/scene text: escaped
    }
  } else if (tour.t >= TOUR_HOLD_S) {
    if (tour.k + 1 < spotList.length) tourGo(tour.k + 1);
    else { endTour(); setWalk('auto'); }
  }
}
$('tour').onclick = startTour;
renderer.domElement.addEventListener('pointerdown', endTour);
addEventListener('keydown', e => { if (tour.on && (e.target as HTMLElement).tagName !== 'BUTTON') endTour(); });

// ---------- furniture editing ----------
const tc = new TransformControls(camera, renderer.domElement);
tc.setRotationSnap(Math.PI / 2);
tc.setSpace('world');
const setMode = (m: 'translate' | 'rotate') => { tc.setMode(m); tc.showX = tc.showY = m === 'translate'; tc.showZ = m === 'rotate'; };
setMode('translate');
scene.add(tc.getHelper());
let selected = -1, lastValid: Pose | null = null;
let grabbing: { k: number; off: XY; yaw: number; start: Pose } | null = null;   // G: the picked object follows the mouse (hotkeys block, below)
const poseOf = (k: number): Pose => ({ x: items[k].group.position.x, y: items[k].group.position.y, yaw: items[k].group.rotation.z });
let onSelect: ((k: number) => void) | null = null;   // the reimagined room shows the picked object's cost tag
function select(k: number) {
  if (selected >= 0) items[selected].outline.visible = false;
  selected = k;
  onSelect?.(k);
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
    const p = layout.poses[k], o = scanned[k];
    it.group.position.set(p.x, p.y, 0); it.group.rotation.set(0, 0, p.yaw);   // upright (live physics re-tilts a tipped one)
    it.group.visible = !p.removed;
    it.mesh.opacity = 1;
    const moved = !!p.removed || Math.hypot(p.x - o.x, p.y - o.y) > 0.01 || Math.abs(p.yaw - o.yaw) > 0.01;
    it.fill.visible = it.tag.visible = moved && $<HTMLInputElement>('imagfill').checked;   // the spot it used to cover was never filmed
  });
  drawTape(layout);
  const gone = objs.flatMap((o, k) => (layout.poses[k].removed ? [k] : []));
  $('inventory').innerHTML = gone.length ? '' : '<li class="hint">nothing removed</li>';
  for (const k of gone) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.title = `Put back ${objs[k].name}`; b.onclick = () => restoreObject(k);
    b.innerHTML = `<svg viewBox="0 0 24 24">${iconOf(objs[k])}</svg>`;
    b.append(objs[k].name.replace(/_/g, ' '));
    li.appendChild(b); $('inventory').appendChild(li);
  }
  updateNight();
  live?.sync(layout);
}
function drawTape(lay: Layout) {
  for (const c of [...tapeGroup.children] as THREE.Mesh[]) { tapeGroup.remove(c); c.geometry.dispose(); (c.material as THREE.Material).dispose(); }
  for (const [[x0, y0], [x1, y1]] of lay.flattened) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), new THREE.MeshBasicMaterial({ color: 0x8a8f96, transparent: true, opacity: 0.8 }));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.022); tapeGroup.add(m);
  }
}
const ICONS: Record<string, string> = {   // line drawings for the Removed list, by kind or name
  chair: '<path d="M7 3v18M7 12h10v9M7 12V3m0 0h3"/>',
  table: '<path d="M2 8h20M5 8v12M19 8v12"/>',
  nightstand: '<rect x="5" y="5" width="14" height="12"/><path d="M5 11h14M11 8h2M11 14h2M7 17v3M17 17v3"/>',
  rug: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 7v10M17 7v10"/>',
  basket: '<path d="M3 10h18l-2 10H5zM8 10l3-6M16 10l-3-6"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15"/>',
  other: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
};
const iconOf = (o: { name: string; kind: string }) =>
  ICONS[o.kind] ?? ICONS[Object.keys(ICONS).find(n => o.name.startsWith(n)) ?? 'other'];
// Ctrl+Z / Ctrl+Shift+Z over object edits (controls.ts): a snapshot of the layout before and after each one
const snap = () => ({ layout, applied });
const editHist = createHistory<ReturnType<typeof snap>>(s => s.layout);
const nameOf = (k: number) => objs[k].name.replace(/_/g, ' ');
function restoreObject(k: number) {   // back where it stood when removed, if that spot is still free
  const poses = layout.poses.map((q, n) => (n === k ? { ...q, removed: false } : q));
  if (!placementOk(g, placeBase, objs, poses, k, overlapOk[k])) return refused();
  const was = snap();
  layout = { ...layout, poses };
  editHist.record(`put back ${nameOf(k)}`, was, snap());
  syncObjects();
  return replan();
}
function commitPose(k: number, p: Pose) {
  const was = snap(), q = layout.poses[k], np = { x: p.x, y: p.y, yaw: Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2) };
  layout = { ...layout, poses: layout.poses.map((o, n) => (n === k ? np : o)) };
  if (Math.hypot(np.x - q.x, np.y - q.y) > 1e-4 || Math.abs(Math.atan2(Math.sin(np.yaw - q.yaw), Math.cos(np.yaw - q.yaw))) > 1e-4) editHist.record(`moved ${nameOf(k)}`, was, snap());
  syncObjects();
  return replan();
}
function removeObject(k: number) {   // take it out of the room: no footprint, no splat; the spot it covered shows the imagined fill
  const was = snap();
  layout = { ...layout, poses: layout.poses.map((q, n) => (n === k ? { ...q, removed: true } : q)) };
  editHist.record(`removed ${nameOf(k)}`, was, snap());
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
  // an Apply re-runs this: keep the old list up until the new one is ready (a one-line placeholder shrinks the pane and snaps its scroll to the top)
  if (!$('fixes').childElementCount) $('fixes').innerHTML = '<li>rolling out each fix…</li>';
  const note = (text: string) => { const li = document.createElement('li'); li.textContent = text; $('fixes').replaceChildren(li); };   // textContent: door names are user input
  let res: { before: number; fixes: any[] };
  try { res = await ask({ type: 'fixes', layout, sel: selRoute }); }
  catch (e) { note(`Could not evaluate the fixes: ${String((e as Error)?.message ?? e)}`); return; }   // say so instead of leaving the list blank
  const { before, fixes } = res;
  if (!fixes.length) {   // nothing to roll out: say why (a door no planned route uses has no fixes, and a scene may configure none)
    const offRoute = current?.checks.filter(c => c.kind === 'door' && c.on_route === false).map(c => c.id.slice('door:'.length)) ?? [];
    note(`No fixes to evaluate on this route${offRoute.length ? `: ${offRoute.join(', ')} ${offRoute.length === 1 ? 'is' : 'are'} not on a planned route, so ${offRoute.length === 1 ? 'its' : 'their'} fixes are left out` : ' (this scene configures none, or all are applied)'}.`);
    game.fixes = fixes; return;
  }
  const items: HTMLLIElement[] = [];
  for (const f of fixes) {
    const li = document.createElement('li');
    li.innerHTML = f.error ? `${f.label}: <span class="delta-bad">blocks the route</span> ` :
      `${f.label}: <b class="${f.reduction > 0 ? 'delta-good' : ''}">−${fmt(Math.max(0, f.reduction))}/month</b> (${before > 0 ? Math.round((100 * f.reduction) / before) : 0}%)` +
      (f.clearance_gain_m > 0.005 ? ` <b class="delta-good">+${(f.clearance_gain_m * 100).toFixed(0)} cm</b> at the tightest spot` : '') + `${costOf(f.id)} `;
    const b = document.createElement('button');
    b.textContent = 'Apply'; b.disabled = !!f.error || applied.includes(f.id);
    b.onclick = () => applyFix(f.id);
    li.appendChild(b);
    items.push(li);
  }
  $('fixes').replaceChildren(...items);
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
const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
trail.renderOrder = 1; trail.visible = false;
scene.add(trail);
const replay = { on: false, t: 0, dev: null as null | ReturnType<typeof buildDevice> };
const PHYS_TEXT = (r: any) => {
  const sm = summarize(r);
  return `${r.name}: hardest push after the run-up ${sm.peak_push_n.toFixed(0)}/${sm.limit_n.toFixed(0)} N` + (sm.peak_push_n > 0 ? ` at ${sm.peak_at_s.toFixed(1)} m` : '') +
    `, ${sm.at_limit_s.toFixed(1)} s at the limit, tallest edge under a leg ${(sm.max_leg_height_m * 100).toFixed(1)} cm, tilt ≤ ${sm.max_tilt_deg.toFixed(1)}°, mean ${(sm.mean_speed_mps * 100).toFixed(0)} cm/s`;
};
/** chart, push-coloured trail and replay for the selected route's physics run */
function showPhysics() {
  const res: any[] | null = game.physics, r = res?.[selRoute], cv = $<HTMLCanvasElement>('pushchart');
  stopReplay();
  const ok = !!r && !r.error && r.trace?.length;
  cv.hidden = !ok; $('replay').hidden = !ok; trail.visible = false;
  $('physinfo').textContent = ok ? PHYS_TEXT(r) : '';
  if (!ok) return;
  drawPushChart(cv, r);
  trail.geometry.dispose();
  trail.geometry = new THREE.BufferGeometry().setFromPoints(r.trace.map((p: any) => new THREE.Vector3(p.x, p.y, 0.06)));
  trail.geometry.setAttribute('color', new THREE.Float32BufferAttribute(r.trace.flatMap((p: any) => pushColor(p.push, r.limit_n)), 3));
  trail.visible = true;
}
function stopReplay() {
  replay.on = false;
  if (replay.dev) replay.dev.group.visible = false;
  walker.group.visible = true;
  $('replay').textContent = 'Replay walker'; $('replaycap').textContent = '';
}
function startReplay() {
  const r = game.physics?.[selRoute];
  if (!r?.trace?.length) return;
  if (replay.dev) scene.remove(replay.dev.group);
  replay.dev = buildDevice(walkerCfg);
  scene.add(replay.dev.group);
  replay.on = true; replay.t = 0; walker.group.visible = false;
  $('replay').textContent = 'Stop replay';
}
/** one frame of the replay: the pushed walker at its recorded pose, legs red while standing on an edge, frame red when tipped */
function replayStep(dt: number) {
  const r = game.physics?.[selRoute];
  if (!replay.on || !r?.trace?.length || !replay.dev) return;
  const last = r.trace[r.trace.length - 1];
  replay.t += dt;
  if (replay.t > last.t + 1) replay.t = 0;
  const p = poseAt(r.trace, replay.t)!;
  replay.dev.group.position.set(p.x - Math.cos(p.yaw) * r.frame_off_m, p.y - Math.sin(p.yaw) * r.frame_off_m, 0);
  replay.dev.group.rotation.z = p.yaw;
  p.legs.forEach((h, k) => replay.dev!.setLegRed(k, h >= 0.003));
  replay.dev.setFrameRed(p.tilt_deg > 10);
  $('replaycap').textContent = sampleText(p, r.limit_n);
  drawPushChart($<HTMLCanvasElement>('pushchart'), r, p.s);
}
$('replay').onclick = () => (replay.on ? stopReplay() : startReplay());

async function physicsPass() {
  clearGroup(snagGroup);
  if (walkerCfg.device === 'cane' || walkerCfg.device === 'wheelchair') { $('snags').innerHTML = `<li>walker only (this persona uses a ${walkerCfg.device})</li>`; game.physics = null; showPhysics(); return null; }
  $('snags').innerHTML = '<li>pushing the walker along each route…</li>';
  const { routes: res } = await ask({ type: 'physics', layout, walker: walkerCfg, cfg: game.physicsCfg });   // game.physicsCfg = { push_max_n: 60, ... } to try other people
  const ot = '<span class="ot">estimate, OT to verify</span>';
  const items = res.flatMap((r: any) => {
    if (r.error) return [`<li>${r.name}: no route</li>`];
    // a walker that never got to the goal and was not called stalled is neither "no snags" nor fine: say where it sat
    const stuck = r.done ? [] : [`<li><span class="delta-bad">${r.name}: walker STUCK ${r.stuck ? `at ${r.stuck.s_m.toFixed(1)} m` : 'before the goal'}, never reached the end</span> ` +
      `<small>(push ${r.stuck?.push_n.toFixed(0) ?? '?'} N after ${r.sim_s.toFixed(0)} s; it was not called a snag, so the stall time may be longer than the run)</small> · ${ot}</li>`];
    const snags = r.snags.map((s: any) => `<li>${r.name}: <span class="measured">${s.leg} ${s.tipped ? 'tips the frame' : 'catches'} on ${r.names[s.comp] ?? 'a floor edge'}` +
      ` (${(s.height_m * 100).toFixed(1)} cm edge)</span> at ${s.s_m.toFixed(1)} m · ${ot}</li>`);
    const clear = r.done && !r.snags.length
      ? [`<li>${r.name}: <span class="delta-good">no snags</span> <small>(hardest push ${Math.max(0, ...Object.values(r.peak_push_n) as number[]).toFixed(0)} N)</small></li>`] : [];
    return [...stuck, ...snags, ...clear];
  });
  $('snags').innerHTML = items.join('') + `<li><small>Rapier: the measured floor; the walker's push (${PHYS_NOTE}) is assumed</small></li>`;
  for (const r of res) {
    const marks = [...(r.snags ?? []).map((s: any) => ({ xy: s.position, text: `snag: ${s.leg}`, col: 0xff3030 })),
      ...(r.stuck ? [{ xy: r.stuck.position, text: 'STUCK', col: 0xff2fd0 }] : [])];
    for (const m of marks) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 24), new THREE.MeshBasicMaterial({ color: m.col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
      ring.position.set(m.xy[0], m.xy[1], 0.032);
      const t = label(m.text);
      t.position.set(0, 0, 0.25);
      ring.add(t);
      snagGroup.add(ring);
    }
  }
  game.physics = res;
  showPhysics();
  return res;
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
  return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); setWalk('auto'); reim.play(); return ms; });
}
$('suggest').onclick = () => suggest();

// ---------- reimagined room (reimagine.ts): the room morphing into the layout on screen, with what each change takes ----------
const reim = createReimagine({ scene, items, objs, original, interventions, sync: syncObjects,
  centre: [g.origin_xy[0] + (nx * g.cell_m) / 2, g.origin_xy[1] + (ny * g.cell_m) / 2],
  camera, fillsOn: () => $<HTMLInputElement>('imagfill').checked, onT: t => { $<HTMLInputElement>('reimt').value = String(Math.round(t * 100)); } });
let baseEvals: (Eval | undefined)[] = [];   // the room as filmed, per route: what the reimagined one is compared with
/** after every re-plan: changes since the room as filmed, overlays, receipt */
function refreshReimagine() {
  const cur = current && !current.error ? current : null, sel = selRoute;
  const cs = reim.refresh(layout, applied, baseEvals[sel] ?? null, cur);
  if (!cs.length && cur) baseEvals[sel] = cur;
  else if (cs.length && !baseEvals[sel])   // route or persona changed since: score the room as filmed once
    ask({ type: 'eval', layout: { poses: original.map(p => ({ ...p })), flattened: [] }, sel, heat: false })
      .then(({ r }) => { baseEvals[sel] = r; if (sel === selRoute) refreshReimagine(); });
  const tot = sumCosts(cs.map(c => c.cost));
  $('reimtotal').textContent = cs.length ? `${cs.length} change${cs.length === 1 ? '' : 's'} · ${tot.usd ? `$${tot.usd}` : 'no purchases'} · ${tot.minutes} min` +
    `${tot.helpers > 1 ? ` · ${tot.helpers} people` : ''}${cs.some(c => c.cost.source === 'placeholder') ? ' (placeholder costs)' : ''}` : 'no changes yet: reimagine, suggest a layout, or drag something';
  $('receipt').innerHTML = '';
  for (const c of cs) {
    const li = document.createElement('li');
    li.innerHTML = `${c.label} <small class="cost">${costText(c.cost)}</small> `;
    const b = document.createElement('button');
    b.textContent = 'Undo';
    b.onclick = () => undoReimagined(c);
    li.appendChild(b);
    $('receipt').appendChild(li);
  }
  drawStairs();   // added rails / lights / walker follow the layout
}
function undoReimagined(c: Change) {
  layout = undoChange(layout, original, c, interventions);
  applied = applied.filter(id => id !== c.iv && !(id.startsWith('move:') && id.split(':')[1] === c.name));
  syncObjects();
  return replan();
}
/** Search layouts (if not done yet), take the one with the fewest toe contacts, and morph the room into it. */
async function reimagineRoom() {
  const why = (msg: string) => { $('reimtotal').textContent = msg; return []; };   // say why nothing moved instead of doing nothing
  if (!objs.length && !interventions.length)
    return why('Nothing to rearrange: this scene exported no movable objects and no fixes (furniture is still part of the room splat). Try ?scene=game_synth.');
  if (!suggestions.length) {
    $('reimtotal').textContent = `searching layouts: every move of ${objs.length} objects and each fix, re-run in full (10–30 s)…`;
    await suggest();
  }
  if (!suggestions.length) return why('The layout search returned no options.');
  // the optimizer's own score (toe contacts + squeezes + failed checks + route length), not toe contacts alone: with none
  // to save (0.0/month) every option ties on them, and the one that widens a squeeze would lose to doing nothing
  const better = (o: any, b: any) => o.score < b.score - 1e-9 || (o.score <= b.score + 1e-9 && o.actions.length < b.actions.length);
  const best = suggestions.reduce((b, o, n) => (better(o, suggestions[b]) ? n : b), 0);
  if (!suggestions[best].actions.length)
    return why(`No change earns its place: ${fmt(current?.per_month ?? 0)} toe contacts/month already, and no move or fix lowers it or clears a failed check.`);
  await applyOption(best);
  return reim.changes();
}
$('reimagine').onclick = () => reimagineRoom();
$('reimplay').onclick = () => reim.play();
$<HTMLInputElement>('reimt').oninput = e => reim.setT(+(e.target as HTMLInputElement).value / 100);
$('reimshow').onchange = () => reim.setVisible($<HTMLInputElement>('reimshow').checked);
const reimParts = () => reim.setParts({ ghosts: $<HTMLInputElement>('reimghosts').checked, arrows: $<HTMLInputElement>('reimarrows').checked,
  tags: $<HTMLSelectElement>('reimtags').value as 'all' | 'selected' | 'off', receipt: $<HTMLInputElement>('reimreceipt').checked });
for (const id of ['reimghosts', 'reimarrows', 'reimtags', 'reimreceipt']) $(id).onchange = reimParts;
onSelect = k => reim.selectChange(k);
// for e2e and the VR team: bind a controller to setT / play (AGENTS.md)
game.reimagine = { run: reimagineRoom, setT: reim.setT, t: reim.t, play: reim.play, playing: reim.playing, refresh: refreshReimagine,
  changes: reim.changes, resolved: reim.resolved, undo: (n: number) => undoReimagined(reim.changes()[n]),
  pose: (name: string) => { const gr = items[objs.findIndex(o => o.name === name)].group; return { x: gr.position.x, y: gr.position.y, yaw: gr.rotation.z, visible: gr.visible }; } };

// ---------- stairs (stairs.ts, stairs3d.ts): measured against code and this patient; rail, step lights, a walker at the top ----------
// From config game.stairs (stage 12) and/or marked here with three clicks and measured from the splat (kept per scene in
// this browser; "Copy as config YAML" makes it permanent). Their fixes are interventions like any other.
const mainSplat = splats[0];
// the second rail: the scanned rail on the other side, mirrored (stairs.ts mirrorRail), then redrawn as a dense bar of splats
// in the real rail's own colour (railsplat.ts), with level returns and wall brackets; cached. No tint: the card says "designed".
const railCopies = new Map<string, SplatMesh | null>(), railBars = new Map<string, SplatMesh>(), railTones = new Map<string, RGB>();
/** a SplatMesh of designed splat records in the room's light (night shader), cached by key; kept across stairs3d rebuilds */
function splatBars(key: string, recs: () => Float32Array): SplatMesh {
  let mesh = railBars.get(key);
  if (mesh) return mesh;
  const m = recs(), c = new THREE.Vector3(), sc3 = new THREE.Vector3(), q = new THREE.Quaternion(), col = new THREE.Color();
  mesh = new SplatMesh({ worldModifier: night.modifier, constructSplats: ps => {
    for (let i = 0; i < m.length; i += SPLAT_STRIDE)
      ps.pushSplat(c.set(m[i], m[i + 1], m[i + 2]), sc3.set(m[i + 3], m[i + 4], m[i + 5]), q.set(m[i + 6], m[i + 7], m[i + 8], m[i + 9]), m[i + 10], col.setRGB(m[i + 11], m[i + 12], m[i + 13]));
  } });
  mesh.userData.shared = true; mesh.userData.count = m.length / SPLAT_STRIDE;
  splats.push(mesh); railBars.set(key, mesh);
  return mesh;
}
function scanRail(st: Stair, side: Side): SplatMesh | null {
  const from: Side = side === 'left' ? 'right' : 'left', key = `${JSON.stringify([st.bottom, st.top, st.treads_z, st.rails])}:${side}`;
  if (st.rails?.[from] !== 'seen') return null;
  if (railCopies.has(key)) return railCopies.get(key)!;
  const band = inRailBand(st, from), src: number[] = [];
  mainSplat.forEachSplat((_, c, s, q, op, col) => { if (op >= 0.2 && band(c.x, c.y, c.z)) src.push(c.x, c.y, c.z, s.x, s.y, s.z, q.x, q.y, q.z, q.w, op, col.r, col.g, col.b); });
  let mesh: SplatMesh | null = null;
  if (src.length >= 30 * SPLAT_STRIDE) {   // too few points is a gap in the scan, not a rail: the neutral designed rail stands in
    const m = mirrorRail(new Float32Array(src), st, from), tone = toneOf(new Float32Array(src)), fit = fitRail(m, st);
    railTones.set(JSON.stringify([st.bottom, st.top]), tone);
    mesh = splatBars(`copy:${key}`, () => railSplats(st, { t: fit.t, z: fit.z, tone }));
  }
  railCopies.set(key, mesh);
  return mesh;
}
/** the scanned rail's colour on this stair, once seen (else a neutral metal): for every designed bar */
function railTone(st: Stair): RGB {
  const known = railTones.get(JSON.stringify([st.bottom, st.top]));
  if (known) return known;
  for (const side of ['left', 'right'] as Side[]) if (st.rails?.[side] === 'seen') {   // sample the real rail even if no copy was asked for
    const band = inRailBand(st, side), src: number[] = [];
    mainSplat.forEachSplat((_, c, s, q, op, col) => { if (op >= 0.2 && band(c.x, c.y, c.z)) src.push(c.x, c.y, c.z, s.x, s.y, s.z, q.x, q.y, q.z, q.w, op, col.r, col.g, col.b); });
    if (src.length >= 30 * SPLAT_STRIDE) { const t = toneOf(new Float32Array(src)); railTones.set(JSON.stringify([st.bottom, st.top]), t); return t; }
  }
  return NEUTRAL_RAIL;
}
const parkedWalkerCfg = { ...personas.patient.walker, device: 'walker' as const };
const stairs3d = createStairs3d(scene, () => buildDevice(parkedWalkerCfg).group, scanRail, () => buildDevice(WHEELCHAIR).group, { bars: splatBars, tone: railTone });
const lights3d = createLights3d(scene), bath3d = createBathroom3d(scene);
let pathLightKey = '';
const doors3d = createDoors3d(scene, mainSplat);
const STAIR_KEY = `homeclear:stairs:${RUN}`, DOOR_KEY = `homeclear:doors:${RUN}`, baseIvCount = interventions.length;
let stairs: Stair[] = [], marked: Stair[] = [];
let doors: Door[] = [], markedDoors: Door[] = [];
const cfgDoors: Door[] = sc.doors ?? [];
try { markedDoors = JSON.parse(localStorage.getItem(DOOR_KEY) ?? '[]'); } catch { markedDoors = []; }
let stepLightList: PointLight[] = [];
let strongSide: Side | null = persona.strong_side ?? null;
const patientStrong = strongSide;   // a comparison persona may bring its own (stroke.ts); back to this on the patient
// the marking tool's state (its hook block is below the doorways): a marking in progress, or handles shown to drag
const mk3d = createMarker3d(scene);
let mk: Marking | null = null, editing = false;
/** splat centres + |normal z| (the shortest axis) around a stair, for measureStair */
function splatPoints(st: Stair): Float32Array {
  const F = stairFrame(st), pad = 0.45, out: number[] = [], ax = new THREE.Vector3();
  const cs = [F.world(-pad, F.width / 2 + pad), F.world(-pad, -F.width / 2 - pad), F.world(F.run + pad, F.width / 2 + pad), F.world(F.run + pad, -F.width / 2 - pad)];
  const [x0, x1, y0, y1] = [Math.min(...cs.map(c => c[0])), Math.max(...cs.map(c => c[0])), Math.min(...cs.map(c => c[1])), Math.max(...cs.map(c => c[1]))];
  mainSplat.forEachSplat((_, c, s, q, op) => {
    if (op < 0.3 || c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1 || c.z > 3.2) return;
    const k = s.x <= s.y && s.x <= s.z ? 0 : s.y <= s.z ? 1 : 2;
    ax.set(+(k === 0), +(k === 1), +(k === 2)).applyQuaternion(q);
    out.push(c.x, c.y, c.z, Math.abs(ax.z));
  });
  return new Float32Array(out);
}
const moreAbove = new Map<string, number>();   // stairs whose top was marked below the real top: how high the scan goes on
const measured = (st: Stair): Stair => {
  const { flat_points: _, more_above_z, ...m } = measureStair(splatPoints(st), st);
  if (more_above_z !== null) moreAbove.set(st.name, more_above_z); else moreAbove.delete(st.name);
  return { ...m, scan_continues_above: more_above_z !== null };
};
const cfgStairs: Stair[] = (sc.stairs ?? []).map((st: Stair) => (st.treads_z ? st : measured(st)));
try { marked = JSON.parse(localStorage.getItem(STAIR_KEY) ?? '[]'); } catch { marked = []; }
/** stairs and doors -> their fixes in the intervention list, the worker's init, the drawing; no re-plan (callers do it) */
function setupStairs() {
  // one marked here with a config one's name replaces it (its handles were dragged)
  stairs = [...cfgStairs.filter(c => !marked.some(m => m.name === c.name)), ...marked].map(withRails);
  for (const name of moreAbove.keys()) if (!stairs.some(st => st.name === name)) moreAbove.delete(name);
  // a door-leaf object next to a jamb marks the hinge side (widening grows the other way) and brings its own fixes
  const leaves = objs.flatMap((o, k) => (o.kind === 'door' ? [worldFootprint(o, original[k])] : []));
  doors = [...cfgDoors.filter(c => !markedDoors.some(m => m.name === c.name)), ...markedDoors].map(d => ({ ...d, hinge: d.hinge ?? hingeSide(d, leaves) }));
  const need = Math.max(needWidth(walkerCfg.width_m, init.rules.clearance_margin_m), walkerCfg.device === 'wheelchair' ? ADA.door_clear_m : 0);
  interventions.splice(baseIvCount, Infinity, ...stairs.flatMap(stairFixes), ...doors.flatMap(d => doorFixes(d, need, { leafObject: hingeSide(d, leaves) !== null })), ...pathLightIvs,
    ...bathroomFixes(sc.fixtures ?? [], g, base, strongSide));   // a grab bar beside each toilet, on its side wall (bathroom.ts)
  const ids = new Set(interventions.map(i => i.id)), keep = (id: string) => !/^(stair_|door_|path_light:|grab_bar_toilet:)/.test(id) || ids.has(id);
  applied = applied.filter(keep);
  layout = { ...layout, added: layout.added?.filter(keep), ...(layout.carved ? { carved: layout.carved.filter(c => ids.has(c.id)) } : {}),
    ...(layout.placed ? { placed: Object.fromEntries(Object.entries(layout.placed).filter(([id]) => ids.has(id))) } : {}) };
  init = { ...init, interventions, stairs, doors, strong_side: strongSide, device: walkerCfg.device,
    walker: { width_m: parkedWalkerCfg.width_m, depth_m: parkedWalkerCfg.depth_m, user_gap_m: parkedWalkerCfg.user_gap_m } };
  worker.postMessage({ type: 'init', init });
  suggestions = [];   // searched without these stairs
  drawStairs();
  $('stairstatus').textContent = stairs.length ? stairs.map(st => `${st.name}: ${st.treads_z?.length ?? 0} treads ${st.measured === 'tape' ? 'tape-measured' : 'seen in the scan'}` +
    (moreAbove.has(st.name) ? ` (the scan goes on ${Math.round((moreAbove.get(st.name)! - (st.top_z ?? st.treads_z?.at(-1) ?? 0)) * 100)} cm higher: Edit marks, drag the top handle up)` : '')).join(' · ') +
    ' · checks under "Transfers, reach, emergencies", additions under Plan fixes' : 'no stairs marked: Fly (F) to see them, then Mark stairs';
  $<HTMLSelectElement>('topdevice').value = stairs[0]?.top_device ?? 'walker';
  markRefresh();
}
function drawStairs(lay = layout) {
  stairs3d.build(stairs, lay.added ?? [], lay.placed ?? {});
  const verdict = (d: Door) => current?.checks.find(c => c.id === `door:${d.name}`)?.verdict === 'ok';
  const change = (d: Door) => { const c = lay.carved?.find(x => x.target === d.name); return c ? { gain: c.by_m, grow: growOf(d, c.id.split(':')[0].slice('door_'.length)) } : { gain: 0, grow: 'both' as const }; };
  doors3d.build(doors, Object.fromEntries(doors.map(d => [d.name, change(d)])), Object.fromEntries(doors.map(d => [d.name, verdict(d)])));
  // motion step lights light the scan itself at night (night.ts); only re-light when they change: it regenerates every splat
  // added nightlights (lights.ts): a bulb, and at night a point light and a halo; they light the scan like the step lights
  const pl = placedFixtures(interventions, lay).filter(f => f.light_r && f.xyz), plKey = JSON.stringify(pl);
  if (plKey !== pathLightKey) { pathLightKey = plKey; lights3d.build(pl); }
  bath3d.build(placedFixtures(interventions, lay).filter(f => f.kind === 'grab_bar' && (sc.fixtures ?? []).some((t: any) => t.kind === 'toilet' && t.name === f.attach)));
  const L = [...stairs.filter(st => lay.added?.includes(`stair_lights:${st.name}`)).flatMap(st => stepLights(st).map(p => ({ ...p, r: 0.7 }))),
    ...pl.map(f => ({ x: f.xyz![0], y: f.xyz![1], z: f.xyz![2], r: f.light_r! }))].slice(0, MAX_EXTRA_LIGHTS);
  if (JSON.stringify(L) !== JSON.stringify(stepLightList)) { stepLightList = L; updateNight(); }
}
function saveMarked() { try { localStorage.setItem(STAIR_KEY, JSON.stringify(marked)); } catch { /* private window: kept for this visit only */ } }
async function markStair(a: XY, b: XY, top: XY, topZ: number | null = null) {
  const n = cfgStairs.length + marked.length, st = measured({ name: n ? `stairs ${n + 1}` : 'stairs', bottom: [a, b], top, top_z: topZ });
  marked.push(st);
  saveMarked(); setupStairs(); await replan();
  return st;
}
$('markstairs').onclick = () => beginMark('stairs');   // the marking tool (below the doorways)
$('editstairs').onclick = () => setEditing(!editing);
$('clearstairs').onclick = () => { marked = []; saveMarked(); setupStairs(); replan(); };
$<HTMLSelectElement>('topdevice').onchange = () => setTopDevice($<HTMLSelectElement>('topdevice').value as 'walker' | 'rollator');
/** What waits at the top of the first stair: a folding walker or a rollator (kept with the stair). */
function setTopDevice(dev: 'walker' | 'rollator') {
  const name = stairs[0]?.name, src = marked.find(st => st.name === name) ?? cfgStairs.find(st => st.name === name);
  if (!src) return null;
  const changed = { ...src, top_device: dev }, k = marked.findIndex(st => st.name === name);
  if (k >= 0) marked[k] = changed; else marked.push(changed);
  saveMarked(); setupStairs();
  return replan();
}
/** Fly to a clear view of a stair: 2.2 m out in front of it, from the first angle (straight on, then swinging out to
 *  either side) that stands over well-filmed floor (elsewhere the splat is floaters), looking at the middle of the flight. */
function viewStairs(k = 0) {
  const st = stairs[k];
  if (!st) return false;
  const F = stairFrame(st), mid = F.world(F.run / 2, 0), D = 2.2;
  const filmed = ([x, y]: XY) => {
    const i = Math.floor((x - g.origin_xy[0]) / g.cell_m), j = Math.floor((y - g.origin_xy[1]) / g.cell_m);
    return i >= 0 && j >= 0 && i < nx && j < ny && coverage[i * ny + j] >= sc.grid.coverage_good;
  };
  const at = (a: number): XY => { const c = Math.cos(a), s = Math.sin(a), d: XY = [c * F.u[0] - s * F.u[1], s * F.u[0] + c * F.u[1]]; return [F.o[0] - d[0] * D, F.o[1] - d[1] * D]; };
  const angles = [0, 20, -20, 40, -40, 60, -60, 80, -80].map(a => (a * Math.PI) / 180);
  const [x, y] = at(angles.find(a => filmed(at(a))) ?? 0), z = 1.6;
  setWalk('fly');
  Object.assign(fly, { x, y, z });
  body.yaw = Math.atan2(mid[1] - y, mid[0] - x);
  body.pitch = Math.atan2((st.treads_z?.at(-1) ?? 0.5) / 2 - z, Math.hypot(mid[0] - x, mid[1] - y));
  return true;
}
$('viewstairs').onclick = () => viewStairs();
async function copyStairsYaml() {
  const yaml = `  stairs:\n${stairs.map(st => stairYaml(st).replace(/^/gm, '  ')).join('\n')}\n`;
  try { await navigator.clipboard.writeText(yaml); $('stairstatus').textContent = 'copied: paste under game: in config.<scene>.yaml'; }
  catch { $('stairstatus').textContent = yaml; }
  return yaml;
}
$('copystairs').onclick = () => copyStairsYaml();
{
  const sel = $<HTMLSelectElement>('strongside');
  sel.value = strongSide ?? '';
  sel.onchange = () => { strongSide = (sel.value || null) as Side | null; setupStairs(); replan(); };   // setupStairs posts init (the toilet grab bar's side note follows too)
}
/** What is really at each side of a stair (the first by default), set by hand over what the scan saw (kept with the stair). */
function setRail(side: Side, v: 'seen' | 'none' | null, name = stairs[0]?.name) {
  const src = marked.find(st => st.name === name) ?? cfgStairs.find(st => st.name === name);
  if (!src) return null;
  const changed = { ...src, rails_set: { ...src.rails_set, [side]: v ?? undefined } }, k = marked.findIndex(st => st.name === name);
  if (k >= 0) marked[k] = changed; else marked.push(changed);
  saveMarked(); setupStairs();
  if (name === stairs[0]?.name) $<HTMLSelectElement>(side === 'left' ? 'railleft' : 'railright').value = v ?? '';
  return replan();
}
$('railleft').onchange = () => setRail('left', ($<HTMLSelectElement>('railleft').value || null) as 'seen' | 'none' | null);
$('railright').onchange = () => setRail('right', ($<HTMLSelectElement>('railright').value || null) as 'seen' | 'none' | null);
for (const side of ['left', 'right'] as Side[]) $<HTMLSelectElement>(side === 'left' ? 'railleft' : 'railright').value = (marked.find(st => st.name === stairs[0]?.name) ?? cfgStairs[0])?.rails_set?.[side] ?? '';
game.stairs = { mark: markStair, list: () => stairs, clear: () => $('clearstairs').click(), copyYaml: copyStairsYaml, view: viewStairs,
  railCopies: () => [...railCopies.values()].filter((m): m is SplatMesh => !!m), setRail,
  measure: (st: Stair) => measureStair(splatPoints(st), st), setStrongSide: (s: Side | null) => { $<HTMLSelectElement>('strongside').value = s ?? ''; $('strongside').onchange!(new Event('change')); } };

// ---------- doorways (doors.ts, doors3d.ts): clear width against code and this walker; hinges, door off, a wider opening ----------
// Marked here with two clicks on the jambs (kept per scene in this browser) and/or config game.doors. The options are
// carve fixes like any other (Plan fixes, Reimagine, receipt); applying one widens the floor map and the scan.
function saveDoors() { try { localStorage.setItem(DOOR_KEY, JSON.stringify(markedDoors)); } catch { /* private window: kept for this visit only */ } }
function doorStatus() {
  $('doorstatus').textContent = doors.length ? doors.map(d => `${d.name}: ${(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * 100).toFixed(0)} cm between the jambs`).join(' · ') +
    ' · the options are under Plan fixes' : 'no doorways marked: Mark doorway, then click the inside face of each jamb';
}
async function markDoor(a: XY, b: XY, name?: string) {
  const n = cfgDoors.length + markedDoors.length, d: Door = { name: name ?? (n ? `doorway ${n + 1}` : 'doorway'), a, b, measured: 'clicks' };
  markedDoors.push(d);
  saveDoors(); setupStairs(); doorStatus(); await replan();
  return d;
}
$('markdoor').onclick = () => beginMark('door');   // the marking tool (below)
$('editdoors').onclick = () => setEditing(!editing);
$('cleardoors').onclick = () => { markedDoors = []; saveDoors(); setupStairs(); doorStatus(); replan(); };
async function copyDoorsYaml() {
  const yaml = `  doors:\n${doors.map(d => doorYaml(d).replace(/^/gm, '  ')).join('\n')}\n`;
  try { await navigator.clipboard.writeText(yaml); $('doorstatus').textContent = 'copied: paste under game: in config.<scene>.yaml'; }
  catch { $('doorstatus').textContent = yaml; }
  return yaml;
}
$('copydoors').onclick = () => copyDoorsYaml();
doorStatus();
game.doors = { mark: markDoor, list: () => doors, clear: () => $('cleardoors').click(), copyYaml: copyDoorsYaml, edits: () => doors3d.edits().length,
  /** apply one option by key: 'offset' | 'remove' | 'widen' (same path as Plan fixes' Apply) */
  apply: (name: string, key: 'offset' | 'remove' | 'widen') => applyFix(`door_${key}:${name}`) };

// ---------- marking tool (marker.ts, marker3d.ts): point at the scan to mark stairs and doorways; handles fix them ----------
// Desktop: a pointer rides the splat under the mouse (green: snapped to a flat level; red: a point there would be refused,
// and the status says why). A click places a point (a drag still looks around), right click or Backspace takes the last
// one back, Esc cancels, Shift holds off snapping, Space places at the screen centre (aim in fly mode). After measuring,
// every point is a handle to drag and each side of a stair is a rail to click on or off; Enter or Esc ends editing. The
// parked second walker drags on its landing (R turns it while dragging, right click puts it back). VR: the same on the
// wand ray (see "VR marking" below the wand).
const markRay = new THREE.Raycaster();
let levels: Levels | null = null, markHover: { p: P3; snapped: boolean } | null = null, markMsg = '';
let mouseAt: THREE.Vector2 | null = null, shiftHeld = false, press: { x: number; y: number; moved: number } | null = null, lastAim = '';
let handleList: (ReturnType<typeof stairHandles>[number] & { owner: string })[] = [];
let handleDrag: { owner: string; key: string; at: P3 } | null = null;
let parkDrag: { id: string; st: Stair; z: number; pose: Pose; off: XY; yaw0: number; q0?: THREE.Quaternion } | null = null;
/** flat levels of the whole scan, for the pointer to snap to (built once, on the first marking) */
function allLevels(): Levels {
  if (levels) return levels;
  const out: number[] = [], ax = new THREE.Vector3();
  mainSplat.forEachSplat((_, c, s, q, op) => {
    if (op < 0.3) return;
    const k = s.x <= s.y && s.x <= s.z ? 0 : s.y <= s.z ? 1 : 2;
    ax.set(+(k === 0), +(k === 1), +(k === 2)).applyQuaternion(q);
    if (Math.abs(ax.z) >= 0.8) out.push(c.x, c.y, c.z, Math.abs(ax.z));
  });
  return (levels = buildLevels(new Float32Array(out)));
}
/** where a ray meets the scan, its height snapped to a flat level unless `snap` is off (doorways: only x, y count) */
function markHit(ray: THREE.Ray, snap: boolean): { p: P3; snapped: boolean } | null {
  markRay.ray.copy(ray);
  const hit = markRay.intersectObject(mainSplat, false)[0];
  if (!hit) return null;
  const { x, y, z } = hit.point, sz = snap && mk?.kind !== 'door' ? snapZ(allLevels(), x, y, z) : null;
  return { p: [x, y, sz ?? z], snapped: sz !== null };
}
const rayAtZ = (r: THREE.Ray, z: number): XY | null => { const t = (z - r.origin.z) / r.direction.z; return Number.isFinite(t) && t > 0 && t < 20 ? [r.origin.x + r.direction.x * t, r.origin.y + r.direction.y * t] : null; };
const eyeXY = (): XY => { const e = camera.getWorldPosition(new THREE.Vector3()); return [e.x, e.y]; };
const markCtx = () => ({ eye: eyeXY(), need_m: needWidth(walkerCfg.width_m, init.rules.clearance_margin_m) });

/** The prompt: the panel's status line, a bar over the view (desktop), a card by the pointer (headset). */
function say(msg = markMsg || (mk && markHover ? placeError(mk, markHover.p) ?? '' : '') ||
  (editing && moreAbove.size ? 'The scan continues above a marked top: drag its top handle onto the landing' : '')) {
  const xr = renderer.xr.isPresenting, hud = $('markhud');
  const text = mk ? markPrompt(mk) : editing ? 'Editing marks: drag a handle to move a point; click a side of a stair for rail / no rail' : parkDrag ? msg : '';
  const help = mk ? (xr ? 'trigger: place · B / Y: undo · grip: cancel · off-hand grip: no snap' : 'click: place · right click or Backspace: undo · Esc: cancel · Shift: no snapping · Space: at the centre')
    : editing ? (xr ? 'trigger: drag a handle / toggle rail · A or grip: done · off-hand A/X: top device' : 'Enter or Esc: done') : '';
  hud.hidden = !text || xr;
  hud.replaceChildren(Object.assign(document.createElement('b'), { textContent: text }), document.createElement('br'),
    Object.assign(document.createElement('small'), { textContent: msg && msg !== text ? `${msg} · ${help}` : help }));
  hud.classList.toggle('bad', !!msg && !parkDrag);
  if (text) $(mk?.kind === 'door' ? 'doorstatus' : 'stairstatus').textContent = msg && msg !== text ? `${text} — ${msg}` : text;
  $('markcross').hidden = !mk || xr;
  const ahead = camera.getWorldPosition(new THREE.Vector3()).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(1));
  mk3d.setPrompt(xr && text ? `${text}${msg && msg !== text ? ` — ${msg}` : ''}\n${help}` : null,
    markHover?.p ?? [ahead.x, ahead.y, ahead.z - 0.65]);
}
function markDraw() {
  const P = markHover?.p ?? null, err = mk && P && !isComplete(mk) ? placeError(mk, P) : null;
  mk3d.setPointer(mk || editing ? P : null, { ok: !err, snapped: markHover?.snapped, text: err ? 'not here' : undefined });
  if (mk) { mk3d.setPoints(mk.pts); mk3d.setPreview(preview(mk, P, markCtx())); }
  else if (handleDrag) {   // the flight or the opening as it would be with this handle here
    const [kind, name] = handleDrag.owner.split('|'), st = stairs.find(s => s.name === name), d = doors.find(x => x.name === name);
    const pts: P3[] = kind === 'stairs' && st ? stairPoints(moveStairHandle(st, handleDrag.key, handleDrag.at)) : d ? (() => { const m = moveDoorHandle(d, handleDrag!.key, handleDrag!.at); return [[...m.a, 1], [...m.b, 1]] as P3[]; })() : [];
    mk3d.setPreview(preview({ kind: kind as MarkKind, pts }, null, markCtx()));
    mk3d.setHandles(handleList.map(h => (`${h.owner}:${h.key}` === `${handleDrag!.owner}:${handleDrag!.key}` ? { ...h, at: handleDrag!.at } : h)), `${handleDrag.owner}:${handleDrag.key}`);
  } else mk3d.setPreview({ lines: [], tags: [] });
}
/** handles and rail toggles for every stair and doorway while editing (called by setupStairs whenever they change) */
function markRefresh() {
  if (!editing) { handleList = []; mk3d.setHandles([]); mk3d.setToggles([]); if (!mk) mk3d.setPointer(null); return; }
  handleList = [...stairs.flatMap(st => stairHandles(st).map(h => ({ ...h, owner: `stairs|${st.name}` }))), ...doors.flatMap(d => doorHandles(d).map(h => ({ ...h, owner: `door|${d.name}` })))];
  mk3d.setHandles(handleList);
  mk3d.setToggles(stairs.flatMap(st => {
    const F = stairFrame(st), pitch = pitchAt(st);
    return (['left', 'right'] as Side[]).map(side => {
      const t = (side === 'left' ? 1 : -1) * (F.width / 2 - 0.06), on = st.rails?.[side] === 'seen';
      return { id: `${st.name}|${side}`, on, label: `${side.toUpperCase()}: ${on ? 'rail' : 'no rail'}`,
        a: [...F.world(0.1, t), pitch(0.1) + 0.9] as P3, b: [...F.world(F.run - 0.1, t), pitch(F.run - 0.1) + 0.9] as P3 };
    });
  }));
}
function beginMark(kind: MarkKind) {
  select(-1); handleDrag = null; press = null; markHover = null; editing = false; mk3d.clear(); markRefresh();
  mk = startMarking(kind); markMsg = ''; lastAim = '';
  $('editstairs').classList.remove('on'); $('editdoors').classList.remove('on');
  allLevels();
  say(); markDraw();
}
function markPlace(p: P3 | null): Promise<unknown> | void {
  if (!mk) return;
  if (!p) { markMsg = 'nothing there: point at the scan'; say(); return; }
  const r = place(mk, p);
  mk = r.m; markMsg = r.error ?? '';
  if (isComplete(mk)) return finishMark();
  say(); markDraw();
}
async function finishMark() {
  const m = mk!, xy = (p: P3): XY => [p[0], p[1]];
  mk = null; markMsg = ''; mk3d.setPoints([]); mk3d.setPreview({ lines: [], tags: [] });
  $(m.kind === 'door' ? 'doorstatus' : 'stairstatus').textContent = 'measuring from the splat…';
  if (m.kind === 'stairs') await markStair(xy(m.pts[0]), xy(m.pts[1]), xy(m.pts[2]), m.pts[2][2]);
  else await markDoor(xy(m.pts[0]), xy(m.pts[1]));
  setEditing(true);   // straight into editing: drag a point that landed wrong, say which sides have rails
}
function undoPoint() {
  if (!mk) return;
  if (!mk.pts.length) return cancelMark();
  mk = undoMark(mk); markMsg = '';
  say(); markDraw();
}
function cancelMark() {
  mk = null; press = null; markHover = null; markMsg = ''; mk3d.clear(); say();
  setupStairs(); doorStatus();
}
function setEditing(on: boolean) {
  mk = null; press = null; handleDrag = null; editing = on; markMsg = ''; mk3d.setPoints([]);
  $('editstairs').classList.toggle('on', on); $('editdoors').classList.toggle('on', on);
  if (!on) { mk3d.clear(); setupStairs(); doorStatus(); }
  markRefresh(); say();
}
async function commitHandle() {
  const h = handleDrag!, [kind, name] = h.owner.split('|');
  handleDrag = null;
  if (kind === 'stairs') {
    const src = marked.find(s => s.name === name) ?? cfgStairs.find(s => s.name === name);
    if (!src) return;
    const moved = moveStairHandle(src, h.key, h.at), err = checkAll('stairs', stairPoints(moved));
    if (err) { markMsg = `can't move it there: ${err}`; markRefresh(); say(); markDraw(); return; }
    const m = measured(moved), i = marked.findIndex(s => s.name === name);
    if (i >= 0) marked[i] = m; else marked.push(m);   // an edited config stair is kept here, under its name
    saveMarked();
  } else {
    const src = markedDoors.find(d => d.name === name) ?? cfgDoors.find(d => d.name === name);
    if (!src) return;
    const moved = moveDoorHandle(src, h.key, h.at), err = checkAll('door', [[...moved.a, 1], [...moved.b, 1]]);
    if (err) { markMsg = `can't move it there: ${err}`; markRefresh(); say(); markDraw(); return; }
    const i = markedDoors.findIndex(d => d.name === name);
    if (i >= 0) markedDoors[i] = moved; else markedDoors.push(moved);
    saveDoors(); doorStatus();
  }
  markMsg = '';
  setupStairs(); say(); markDraw();
  await replan();
}
function toggleRail(id: string) {
  const [name, side] = id.split('|') as [string, Side], st = stairs.find(s => s.name === name);
  return setRail(side, st?.rails?.[side] === 'seen' ? 'none' : 'seen', name);
}
// the parked second walker: dragged on the landing's plane (the landing is upstairs, never in the floor map)
function startParkDrag(id: string, ray: THREE.Ray, q0?: THREE.Quaternion) {
  const st = stairs.find(s => `stair_walker:${s.name}` === id);
  if (!st) return;
  const z = st.top_z ?? pitchAt(st)(stairFrame(st).run), p0 = layout.placed?.[id] ?? parkedPose(st), at = rayAtZ(ray, z) ?? [p0.x, p0.y];
  parkDrag = { id, st, z, pose: { ...p0 }, off: [p0.x - at[0], p0.y - at[1]], yaw0: p0.yaw, q0 };
}
function moveParked(ray: THREE.Ray, twist = 0) {
  const d = parkDrag!, at = rayAtZ(ray, d.z);
  if (at) { d.pose.x = at[0] + d.off[0]; d.pose.y = at[1] + d.off[1]; }
  if (d.q0) d.pose.yaw = d.yaw0 - twist;
  const grp = stairs3d.walkers().find(p => p.userData.parked === d.id)?.parent;
  grp?.position.set(d.pose.x, d.pose.y, d.z); if (grp) grp.rotation.z = d.pose.yaw;
  const r = walkerPlacement(d.st, d.pose, init.walker);
  say(`${r.label} (${r.verdict})`);
}
async function commitPark(pose?: Pose) {
  const id = parkDrag?.id; if (!id) return;
  if (walkerPlacement(parkDrag!.st, pose ?? parkDrag!.pose, init.walker).verdict === 'fail') {
    parkDrag = null; drawStairs(); say('Place the device on the landing, within reach of the top step'); return;
  }
  layout = { ...layout, placed: { ...layout.placed, [id]: pose ?? parkDrag!.pose } };
  parkDrag = null; say('');
  drawStairs();
  await replan();
}
async function resetParked(id: string) {
  const placed = { ...layout.placed }; delete placed[id];
  layout = { ...layout, placed };
  drawStairs();
  await replan();
}
const ndc = (e: { clientX: number; clientY: number }) => document.pointerLockElement === renderer.domElement ? new THREE.Vector2() : new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);   // locked mouse: the crosshair
renderer.domElement.addEventListener('pointerdown', e => {   // capture: before furniture picking and the gizmo
  if (renderer.xr.isPresenting) return;
  if (grabbing) { e.stopImmediatePropagation(); if (e.button === 0) dropGrab(); else if (e.button === 2) cancelGrab(); return; }   // G: click drops, right click cancels
  markRay.setFromCamera(ndc(e), camera);
  const w = mk ? null : markRay.intersectObjects(stairs3d.walkers(), false)[0];
  if (w) {   // the parked walker: drag it on its landing; right click (no drag): back to where the fix puts it
    e.stopImmediatePropagation();
    if (e.button === 2) look = { x: e.clientX, y: e.clientY, moved: 0, right: true, act: () => resetParked(w.object.userData.parked) };
    else if (e.button === 0) { select(-1); startParkDrag(w.object.userData.parked, markRay.ray); mouseAt = ndc(e); lastAim = ''; }
    return;
  }
  if (!mk && !editing) return;
  if (e.button === 2) { e.stopImmediatePropagation(); look = { x: e.clientX, y: e.clientY, moved: 0, right: true, act: undoPoint }; return; }   // a right click undoes a point, a right drag looks
  if (e.button !== 0) return;
  const pk = mk ? null : markRay.intersectObjects(mk3d.pickables(), false)[0];
  if (pk?.object.userData.handle) { e.stopImmediatePropagation(); const { owner, key } = pk.object.userData.handle; handleDrag = { owner, key, at: handleList.find(h => h.owner === owner && h.key === key)!.at }; return; }
  if (pk?.object.userData.toggle) { e.stopImmediatePropagation(); toggleRail(pk.object.userData.toggle); return; }
  mouseAt = ndc(e); lastAim = '';
  press = { x: e.clientX, y: e.clientY, moved: 0 };   // a click places, a drag looks around (the look handler below starts it)
}, { capture: true });
addEventListener('pointermove', e => {
  mouseAt = ndc(e); shiftHeld = e.shiftKey;
  if (press) press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
});
addEventListener('pointerup', e => {
  if (handleDrag) { commitHandle(); return; }
  if (parkDrag) { commitPark(); return; }
  const p = press; press = null;
  if (p && mk && e.button === 0 && p.moved < 5) { markRay.setFromCamera(ndc(e), camera); markPlace(markHit(markRay.ray, !e.shiftKey)?.p ?? null); }
});
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());   // the right button looks or undoes: never a browser menu
addEventListener('keydown', e => {
  if ((!mk && !editing && !parkDrag) || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { shiftHeld = true; lastAim = ''; return; }
  if (e.code === 'Escape') { if (parkDrag) { parkDrag = null; drawStairs(); say(); } else if (mk) cancelMark(); else if (editing) setEditing(false); }
  else if (e.code === 'Backspace' && mk) { e.preventDefault(); undoPoint(); }
  else if (e.code === 'Enter' && editing && !mk) setEditing(false);
  else if (e.code === 'Space' && mk) { e.preventDefault(); markRay.setFromCamera(new THREE.Vector2(0, 0), camera); markPlace(markHit(markRay.ray, !e.shiftKey)?.p ?? null); }
  else if (e.code === 'KeyR' && parkDrag) { parkDrag.yaw0 = parkDrag.pose.yaw += Math.PI / 2; moveParked(markRay.ray); }
});
/** per frame on the desktop: the pointer under the mouse (only when the mouse or the view moved: a splat raycast isn't free) */
function markStep() {
  if (renderer.xr.isPresenting || !mouseAt || (!mk && !editing && !parkDrag)) return;
  const c = camera.matrixWorld.elements, aim = `${mouseAt.x},${mouseAt.y},${c[12].toFixed(3)},${c[13].toFixed(3)},${c[14].toFixed(3)},${c[8].toFixed(3)},${c[9].toFixed(3)},${c[10].toFixed(3)},${shiftHeld}`;
  if (aim === lastAim && !handleDrag && !parkDrag) return;
  lastAim = aim;
  markRay.setFromCamera(mouseAt, camera);
  if (parkDrag) return moveParked(markRay.ray);
  const h = markHit(markRay.ray, !shiftHeld);
  if (h) markHover = h; else if (!handleDrag) markHover = null;
  if (handleDrag && h) handleDrag.at = h.p;
  markDraw();
}
game.marker = {   // for e2e and the VR team: the same actions as the clicks
  begin: beginMark, place: (p: P3) => markPlace(p), undo: undoPoint, cancel: cancelMark, edit: (on = true) => setEditing(on),
  done: () => setEditing(false),
  state: () => ({ marking: mk && { kind: mk.kind, pts: mk.pts, prompt: markPrompt(mk) }, editing, msg: markMsg, handles: handleList.map(h => ({ owner: h.owner, key: h.key, at: h.at })),
    pointer: markHover, dragging: handleDrag?.key ?? parkDrag?.id ?? null, preview: mk ? preview(mk, markHover?.p ?? null, markCtx()) : null }),
  /** drag a handle to a point (as if released there): re-measures the stair or the doorway */
  dragHandle: (owner: string, key: string, p: P3) => { handleDrag = { owner, key, at: p }; return commitHandle().then(() => markMsg); },
  toggleRail: (name: string, side: Side) => toggleRail(`${name}|${side}`),
  /** the parked walker of a stair to (x, y, yaw), as if dragged there; null: back to where the fix puts it */
  moveWalker: (name: string, p: Pose | null) => { const id = `stair_walker:${name}`; if (!p) return resetParked(id); parkDrag = { id, st: stairs.find(s => s.name === name)!, z: 0, pose: p, off: [0, 0], yaw0: p.yaw }; return commitPark(p); },
  setTopDevice,
};
// The marking state must exist before setup calls markRefresh (also for stairs loaded from config/storage).
setupStairs();

// The marking lane owns these actions; xr.ts supplies tracked rays and gives editing priority over its story card.
let xrPlacing = false, xrSnap = true;
let markGripWas = false, markAWas = false, markBWas = false, markOAWas = false, markOBWas = false;
const xrMarkHelp = card(['A/X: mark doorway · B/Y: mark stairs', 'wand B/Y: edit saved marks'], '#ffe27a', undefined, 0.025);
xrMarkHelp.position.set(0, 0.12, -0.15); xrMarkHelp.renderOrder = 4;
const markerXR: XrEditor = {
  hint: xrMarkHelp,
  active: () => !!(mk || editing || handleDrag || parkDrag),
  down(ray, q) {
    if (mk) { xrPlacing = true; return true; }
    markRay.ray.copy(ray);
    const h = editing ? markRay.intersectObjects(mk3d.pickables(), false)[0] : null;
    if (h?.object.userData.handle) {
      const { owner, key } = h.object.userData.handle;
      handleDrag = { owner, key, at: handleList.find(h => h.owner === owner && h.key === key)!.at }; return true;
    }
    if (h?.object.userData.toggle) { toggleRail(h.object.userData.toggle); return true; }
    const w = markRay.intersectObjects(stairs3d.walkers(), false)[0];
    if (w) { startParkDrag(w.object.userData.parked, ray, q); return true; }
    return editing;
  },
  up(ray) {
    if (xrPlacing) { xrPlacing = false; if (mk) markPlace(markHit(ray, xrSnap)?.p ?? null); }
    else if (handleDrag) commitHandle();
    else if (parkDrag) commitPark();
  },
  frame(ray, q) {
    if (!this.active()) return null;
    if (!ray) { markHover = null; markDraw(); say(); return null; }
    if (parkDrag) moveParked(ray, snapQuarter(twistAngle(parkDrag.q0!, q!)));
    else {
      markHover = markHit(ray, xrSnap);
      if (handleDrag && markHover) handleDrag.at = markHover.p;
      markDraw(); say();
    }
    return markHover ? ray.origin.distanceTo(new THREE.Vector3(...markHover.p)) : 5;
  },
  buttons(pads, wand) {
    const wp = pads[wand], op = pads[wand === 'left' ? 'right' : 'left'];
    const grip = !!wp?.buttons[1]?.pressed, a = !!wp?.buttons[4]?.pressed, b = !!wp?.buttons[5]?.pressed;
    const oa = !!op?.buttons[4]?.pressed, ob = !!op?.buttons[5]?.pressed, active = this.active();
    let handled = active;
    xrSnap = !op?.buttons[1]?.pressed;
    if (active) {
      if (grip && !markGripWas) {
        xrPlacing = false;
        if (parkDrag) { parkDrag = null; drawStairs(); say(); }
        else if (mk) cancelMark(); else setEditing(false);
      } else if (b && !markBWas) {
        xrPlacing = false;
        if (mk) undoPoint(); else if (parkDrag) { const id = parkDrag.id; parkDrag = null; resetParked(id); }
      } else if (a && !markAWas && editing) setEditing(false);
      else if (oa && !markOAWas && editing && stairs.length) setTopDevice(stairs[0].top_device === 'rollator' ? 'walker' : 'rollator');
    } else if ((oa && !markOAWas) || (ob && !markOBWas) || (b && !markBWas)) {
      handled = true;
      if (oa && !markOAWas) beginMark('door'); else if (ob && !markOBWas) beginMark('stairs'); else setEditing(true);
    }
    markGripWas = grip; markAWas = a; markBWas = b; markOAWas = oa; markOBWas = ob;
    return handled;
  },
  cancelDrag() {
    xrPlacing = false; handleDrag = null;
    if (parkDrag) { parkDrag = null; drawStairs(); }
    markHover = null; markDraw(); say();
  },
};

// ---------- live object physics (livephys.ts, Rapier in its own worker): objects the walker pushes, slides, tips ----------
const live: LivePhys | null = PARAMS.has('nophys') ? null : createLivePhys({ base: BASE, g, objs, items, scene, renderer, obst: placeBase.obst, bump: base.bump,
  walker: () => walkerCfg, layout: () => layout, overlap: overlapOk.flatMap((s, k) => [...s].filter(n => n > k).map(n => [k, n] as [number, number])),
  hold: k => reim.t() < 1 || ((tc as any).dragging && k === selected) || grabbing?.k === k, log: $('physevents'), sampledEl: $('physsampled'),
  settled: moves => {   // the layout follows where the walker left things (no yaw snap: it lies as it fell)
    layout = { ...layout, poses: layout.poses.map((q, n) => { const m = moves.find(v => v.k === n); return m ? { ...m.pose, removed: q.removed } : q; }) };
    syncObjects(); replan();
  } });
$('physresample').onclick = () => live?.resample();
if (!live) $('physpanel').hidden = true;
game.livephys = live;

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
        : iv.kind === 'carve' ? [iv.poly_xy!.reduce((a, p) => a + p[0], 0) / iv.poly_xy!.length, iv.poly_xy!.reduce((a, p) => a + p[1], 0) / iv.poly_xy!.length] as XY
        : iv.kind === 'add' ? poseOf(iv.fixture?.attach ?? '') ?? (iv.fixture?.xyz?.slice(0, 2) as XY | undefined) : poseOf(iv.object!);
      const p = layout.placed?.[iv.id], xyz = iv.fixture?.xyz;
      const moved = p && xyz ? `; parked ${Math.hypot(p.x - xyz[0], p.y - xyz[1]).toFixed(1)} m from its suggested spot` : '';
      out.push({ label: iv.label + moved, cost_usd: iv.cost_usd, minutes: iv.minutes, product: iv.product, at: p ? [p.x, p.y] : at });
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
    if (p.removed) { const c = removeCost(o); out.push({ label: `Take the ${o.name} out of the room`, cost_usd: c.usd, minutes: c.minutes, at: [q.x, q.y] }); }
    else if (Math.hypot(p.x - q.x, p.y - q.y) > 0.02 || Math.abs(p.yaw - q.yaw) > 0.01) {
      const c = moveCost(o, q, p);
      out.push({ label: `Move the ${o.name} ${Math.hypot(p.x - q.x, p.y - q.y).toFixed(1)} m (see map)`, cost_usd: c.usd, minutes: c.minutes, at: [p.x, p.y] });
    }
  });
  return out;
}
function topdownURL() {
  const cv = document.createElement('canvas');
  drawTopdown(cv, { g, L, coverage, coverageGood: sc.grid.coverage_good, objs, layout, original: { poses: original, flattened: [] },
    route: current?.xy, hazards: current?.hazards });
  return cv.toDataURL('image/png');
}
async function openReport() {
  const w = window.open('about:blank', '_blank');   // opened before the await so the click still counts as a user gesture
  const p = personas[personaKey], c = current!;
  const { before, fixes } = await ask({ type: 'fixes', layout, sel: selRoute });   // the fixes not yet applied, each rolled out from this layout
  const ranked_fixes = fixes.filter((f: any) => !applied.includes(f.id)).map((f: any) => {
    const iv = interventions.find(i => i.id === f.id);
    return { label: f.label, error: f.error, reduction: Math.max(0, f.reduction), share: before > 0 ? f.reduction / before : 0, clearance_gain_m: f.clearance_gain_m,
      cost_usd: iv?.cost_usd, minutes: iv?.minutes, effort: iv?.effort, product: iv?.product };
  }).sort((a: any, b: any) => (+!!a.error - +!!b.error) || (b.reduction - a.reduction) || (b.clearance_gain_m - a.clearance_gain_m) || ((a.cost_usd ?? 0) - (b.cost_usd ?? 0)));
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
    topdown: topdownURL(), view: renderer.domElement.toDataURL('image/jpeg', 0.85), ranked_fixes,
  };
  sessionStorage.setItem(`report:${RUN}`, JSON.stringify(payload));
  if (!w) return window.open(`report.html?scene=${encodeURIComponent(RUN)}`, '_blank');
  w.sessionStorage.setItem(`report:${RUN}`, JSON.stringify(payload));   // about:blank shares our origin; its storage survives the navigation
  w.location.href = `report.html?scene=${encodeURIComponent(RUN)}`;
  return w;
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

// ---------- reset: one object back where the scan had it, or the whole room (objects, removals, fixes) ----------
function resetObject(k: number) {   // moved, turned or removed: back to the original spot, if it is still free
  if (!isMoved(layout.poses[k], original[k])) return;
  const poses = layout.poses.map((q, n) => (n === k ? resetPose(original[k]) : q));
  if (!placementOk(g, placeBase, objs, poses, k, overlapOk[k])) return refused();
  const was = snap();
  layout = { ...layout, poses };
  editHist.record(`reset ${nameOf(k)}`, was, snap());
  syncObjects();
  if (selected === k) lastValid = poseOf(k);
  return replan();
}
function resetAll() {   // hand-marked stairs and doors are scan annotations, not renovations: they stay
  select(-1);
  const was = snap();
  layout = { poses: original.map(resetPose), flattened: [] }; applied = []; suggestions = [];
  editHist.record('reset the whole room', was, snap());
  $('fixes').innerHTML = ''; $('options').innerHTML = '';
  $<HTMLInputElement>('reimt').value = '100'; reim.setT(1);   // not left mid-morph
  syncObjects();
  return replan();
}
$('reset').onclick = resetAll;
$('resetobj').onclick = () => { if (selected >= 0) resetObject(selected); };
game.resetObject = (name: string) => resetObject(objs.findIndex(o => o.name === name));
game.resetAll = resetAll;

// the name pill over the picked object (desktop) or the pointed-at / held one (VR)
const objLabel = createObjLabel(scene);
let labelLines: string[] = [];
function labelStep() {
  const inHeadset = renderer.xr.isPresenting, wand = inHeadset ? xr.wand() : null;
  const k = wand ? objs.findIndex(o => o.name === (wand.grab ?? wand.hover)) : selected;
  const resetBtn = $<HTMLButtonElement>('resetobj'), canReset = !inHeadset && selected >= 0 && isMoved(layout.poses[selected], original[selected]);
  if (resetBtn.disabled === canReset) resetBtn.disabled = !canReset;
  if (k < 0 || layout.poses[k].removed) { labelLines = []; return objLabel.set(null, [], false); }
  const name = objs[k].name.replace(/_/g, ' '), moved = movedText(poseOf(k), original[k]);
  labelLines = [name[0].toUpperCase() + name.slice(1), moved ? `${moved} · ${inHeadset ? 'grip' : 'Z'} resets` : ''].filter(Boolean);
  objLabel.set(items[k].proxy, labelLines, !inHeadset || !!wand?.grab);
  objLabel.update(camera);
}
game.label = () => labelLines;

// ---------- night ----------
function updateNight() {
  const k = objs.findIndex(o => o.kind === 'nightlight');
  const p = k >= 0 && !layout.poses[k].removed ? layout.poses[k] : null;
  const on = $<HTMLInputElement>('night').checked;
  night.set(on, p && { x: p.x, y: p.y, r: objs[k].light_radius_m ?? 1.5 }, stepLightList);
  lights3d.setNight(on);
  for (const s of splats) s.updateVersion();
  hemi.intensity = scene.environment ? (on ? 0.1 : HEMI_ENV) : on ? 0.25 : 2.2;
  scene.environmentIntensity = on ? 0.07 : 1;   // the room's light, captured by day (ground.ts); night.ts scales the scan by 0.07
  nightLamp.intensity = on && p ? 1.2 : 0;   // the nightlight lights the walker and mannequin too, not only the scan
  if (p) { nightLamp.position.set(p.x, p.y, 0.15); nightLamp.distance = objs[k].light_radius_m ?? 1.5; }
  scene.background = new THREE.Color(on ? 0x050607 : 0x1d2126);
}
$('night').onchange = updateNight;
// ---------- light the path (lights.ts): nightlights where the selected route is dark, applied as fixes ----------
async function lightPath() {
  if (!current?.xy?.length) return { added: 0, note: 'no route to light' };
  const k = objs.findIndex(o => o.kind === 'nightlight');
  const have = [...(k >= 0 && !layout.poses[k].removed ? [{ x: layout.poses[k].x, y: layout.poses[k].y, r: objs[k].light_radius_m ?? 1.5 }] : []),
    ...placedFixtures(interventions, layout).flatMap(f => (f.light_r && f.xyz ? [{ x: f.xyz[0], y: f.xyz[1], r: f.light_r }] : []))];
  const before = current.per_month, fresh = pathLights(g, base, current.xy, have, routes[selRoute].name, 0.75, pathLightIvs.length + 1);   // fixed walls only: never on a door leaf or furniture
  if (!fresh.length) return { added: 0, note: 'this route is already lit end to end' };
  pathLightIvs = [...pathLightIvs, ...fresh];
  setupStairs();
  for (const iv of fresh) { layout = applyIntervention(objs, layout, iv); applied.push(iv.id); }
  syncObjects(); await replan(); drawStairs();
  const pct = before > 0 && current ? Math.round((100 * (before - current.per_month)) / before) : 0;
  return { added: fresh.length, note: `${fresh.length} motion nightlight${fresh.length === 1 ? '' : 's'} added along the ${routes[selRoute].name}` +
    (pct > 0 ? `: simulated toe contacts down ${pct}%` : '') + ` (darkness raises contacts ${risk.dark_contact_multiplier}×, an assumed number). Designed, not built.` };
}
async function clearPathLights() {
  const ids = new Set(pathLightIvs.map(iv => iv.id));
  layout = { ...layout, added: layout.added?.filter(id => !ids.has(id)) };
  applied = applied.filter(id => !ids.has(id));
  pathLightIvs = [];
  setupStairs(); syncObjects(); await replan(); drawStairs();
}
game.lights = { lightPath, clear: clearPathLights, list: () => pathLightIvs.map(iv => ({ id: iv.id, ...iv.fixture })) };
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
  live?.resample();   // the physics walker takes the new frame
  persona = { ...p.gait, step_model: STEP ?? p.gait.step_model ?? 'hand' };
  scene.remove(walker.group);
  walker = buildDevice(walkerCfg);
  scene.add(walker.group);
  centreOffset = walkerCfg.user_gap_m + walkerCfg.depth_m / 2;
  chairVel.v = chairVel.w = 0; $('free').textContent = isChair() ? 'Drive' : 'Free walk';
  if (worldModel) worldModel.shift = centreOffset - worldModel.mean_gap_m;   // learned.py Learned.shift, for this walker
  init = { ...init, persona, plan: { ...sc.plan, ...p.plan, walker_width_m: walkerCfg.width_m }, device: walkerCfg.device };
  strongSide = p.gait.strong_side ?? patientStrong; $<HTMLSelectElement>('strongside').value = strongSide ?? '';
  setupStairs();   // posts init; door fixes widen to this device's need (ADA 815 mm for a wheelchair)
  night.setReach(walkerCfg.device === 'wheelchair'); for (const s of splats) s.updateVersion();   // reach lens (night.ts)
  baselinePerMonth = null; baseEvals = [];
  if (p.vision) game.setVision(p.vision);
  $('personanote').textContent = key === 'patient' ? '' : walkerCfg.device === 'wheelchair' ? 'comparison: a typical chair (assumed size); no trip model for a wheelchair, so trips read zero: see the ADA checks. Green: within seated reach (38-122 cm); red: out of reach. Drive: W/S roll, A/D steer while rolling, Q/E spin on the spot'
    : 'comparison: gait and planner numbers for this persona are assumptions, not this patient';
  const ms = await replan();
  if (!current?.error) Object.assign(body, routePose(0, 0, Infinity));
  return ms;
}
/** P: the next persona in the Who list, with the keys that drive it. */
async function cyclePersona() {
  const ks = Object.keys(personas), next = ks[(ks.indexOf(personaKey) + 1) % ks.length];
  await setPersona(next);
  keyHelp.toast(`${personas[next].label}${isChair() ? ': W/S roll · A/D steer while rolling · Q/E spin' : ''}`, 4000);
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
$('handghosts').onchange = () => { handDots.visible = $<HTMLInputElement>('handghosts').checked; };

// ---------- performance mode (perf.ts) ----------
// One switch thins what is drawn: no ghost walkers, heatmap, imagined ceiling, bump heights or fog, fewer splat pixels, a
// lower pixel ratio, no per-change cost cards, hazard labels only just ahead. It drives the same checkboxes the person
// has (nothing new to drift), and leaving it puts them back as they were. Numbers and checks never change.
const PERF_BOXES = ['ghosts', 'heat', 'imagceil', 'heights'];
let perfSaved: Record<string, boolean> | null = null;
function setBox(id: string, on: boolean) {
  const el = $<HTMLInputElement>(id);
  if (el.checked === on) return;
  el.checked = on;
  el.onchange?.(new Event('change'));
}
function applyPerf(on: boolean, remember = true) {
  perfOn = on;
  if (remember) try { localStorage.setItem('homeclear.perf', on ? '1' : '0'); } catch { /* private window: the choice is just not remembered */ }   // only a person's choice, not the headset's default
  $<HTMLInputElement>('perf').checked = on;
  if (on) { perfSaved ??= Object.fromEntries(PERF_BOXES.map(id => [id, $<HTMLInputElement>(id).checked])); PERF_BOXES.forEach(id => setBox(id, false)); }
  else if (perfSaved) { for (const id of PERF_BOXES) setBox(id, perfSaved[id]); perfSaved = null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, (on ? PERF : FULL).pixel_ratio));
  renderer.setSize(innerWidth, innerHeight);
  const lim = splatCfg(location.search, on);
  sparkR.maxStdDev = lim.max_std_dev; sparkR.maxPixelRadius = lim.max_pixel_radius;
  const fog = scene.getObjectByName('fog');
  if (fog) fog.visible = !on;
  $<HTMLSelectElement>('reimtags').value = on ? 'off' : 'selected';
  reim.setParts({ tags: on ? 'off' : 'selected', ringLabels: !on });
  for (const ring of hazardGroup.children) if (ring.children[0]) ring.children[0].visible = true;
}
$('perf').onchange = () => applyPerf($<HTMLInputElement>('perf').checked);
applyPerf(perfOn, false);
game.perf = { set: (on: boolean) => applyPerf(on), on: () => perfOn, tier };   // for the VR team: bind a controller button to it

// ---------- desktop hotkeys (controls.ts) ----------
// M then 1/2 starts marking, G grabs the picked object (it follows the mouse), X removes it, L locks the mouse to look,
// Ctrl+Z / Ctrl+Shift+Z undo and redo object edits, F1 lists them. Registered before the general key handler below, which
// they pre-empt (R while grabbing turns the object instead of switching the gizmo).
const keyHelp = createKeyOverlay();
let choosing = false;   // M was pressed: 1 or 2 picks stairs or a doorway
function startGrab() {
  if (mk || editing || parkDrag || handleDrag) return;
  let k = selected;
  const m = mouseAt ?? new THREE.Vector2();
  if (k < 0) {   // nothing picked: take the object under the mouse
    markRay.setFromCamera(m, camera);
    const hit = markRay.intersectObjects(items.filter((_, n) => !layout.poses[n].removed).map(i => i.proxy))[0];
    if (hit) k = items.findIndex(i => i.proxy === hit.object);
  }
  if (k < 0) return keyHelp.toast('Click an object (or point at one), then press G');
  select(k); tc.detach();
  markRay.setFromCamera(m, camera);
  const p = poseOf(k), at = rayAtZ(markRay.ray, 0) ?? [p.x, p.y];
  grabbing = { k, off: [p.x - at[0], p.y - at[1]], yaw: p.yaw, start: p };
  keyHelp.toast(`Moving ${nameOf(k)}: click or Enter drops, R turns, Esc cancels`, 4000);
}
/** per frame: the grabbed object stands under the pointer, or stays at its last valid spot (walls, furniture, unfilmed floor) */
function grabStep() {
  if (!grabbing) return;
  const { k, off, yaw } = grabbing;
  markRay.setFromCamera(mouseAt ?? new THREE.Vector2(), camera);
  const at = rayAtZ(markRay.ray, 0); if (!at) return;
  const p = { x: at[0] + off[0], y: at[1] + off[1], yaw };
  if (!placementOk(g, placeBase, objs, layout.poses.map((o, n) => (n === k ? p : o)), k, overlapOk[k])) return;
  items[k].group.position.set(p.x, p.y, 0); items[k].group.rotation.z = yaw; lastValid = p;
}
function endGrab() { const k = grabbing!.k; grabbing = null; if (!layout.poses[k].removed) tc.attach(items[k].group); }
let droppedAt = 0;   // a click that drops must not become half of a double-click (which resets the object)
function dropGrab() { const k = grabbing!.k, p = poseOf(k); droppedAt = performance.now(); endGrab(); lastValid = p; commitPose(k, p); }
function cancelGrab() {
  const { k, start } = grabbing!;
  items[k].group.position.set(start.x, start.y, 0); items[k].group.rotation.z = start.yaw; lastValid = start;
  endGrab(); keyHelp.toast('Cancelled');
}
function turnGrab() {
  const { k } = grabbing!, yaw = grabbing!.yaw + Math.PI / 2, p = poseOf(k);
  if (!placementOk(g, placeBase, objs, layout.poses.map((o, n) => (n === k ? { ...p, yaw } : o)), k, overlapOk[k])) return keyHelp.toast('No room to turn it here');
  grabbing!.yaw = yaw; grabStep();
}
/** Undo or redo the last object edit; resolves to what happened, in one line (also shown as a toast and, in VR, a card). */
async function stepHistory(dir: 'undo' | 'redo'): Promise<string> {
  const r = editHist[dir](snap());
  const tell = (m: string) => (keyHelp.toast(m), m);
  if (!r) return tell(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  if (r === 'stale') return tell("Can't " + dir + ': the room changed another way since');
  layout = r.to.layout; applied = r.to.applied;
  if (selected >= 0 && layout.poses[selected].removed) select(-1);
  syncObjects(); if (selected >= 0) lastValid = poseOf(selected);
  const m = tell(`${dir === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`);
  await replan();
  return m;
}
function toggleLock() {
  const c = renderer.domElement;
  if (document.pointerLockElement === c) return document.exitPointerLock();
  Promise.resolve(c.requestPointerLock()).catch(() => keyHelp.toast('The browser would not lock the mouse'));
}
document.addEventListener('pointerlockchange', () => {
  const on = document.pointerLockElement === renderer.domElement;
  keyHelp.setLocked(on); look = null; lastAim = '';
  mouseAt = on ? new THREE.Vector2() : mouseAt;
  if (on) keyHelp.toast('Mouse locked: move to look, click acts at the dot, Esc lets go', 3500);
});
addEventListener('keydown', e => {
  if (renderer.xr.isPresenting) return;
  const el = e.target as HTMLElement, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable;
  const it = keyIntent(e, { typing, grabbing: !!grabbing, choosing });
  if (it === 'choose-cancel') { choosing = false; return; }   // the key still does its own job
  if (!it || (keyHelp.isOpen() && it !== 'help')) return;
  e.preventDefault(); e.stopImmediatePropagation();
  choosing = false;
  if (it === 'help') keyHelp.toggle();
  else if (it === 'undo') { if (grabbing) cancelGrab(); else if (mk) undoPoint(); else stepHistory('undo'); }
  else if (it === 'redo') { if (!mk && !grabbing) stepHistory('redo'); }
  else if (it === 'mark') { if (mk) { cancelMark(); keyHelp.toast('Marking cancelled'); } else { choosing = true; keyHelp.toast('Mark: 1 stairs · 2 doorway', 4000); } }
  else if (it === 'mark-stairs') beginMark('stairs');
  else if (it === 'mark-door') beginMark('door');
  else if (it === 'remove') { if (selected >= 0 && !mk) { const n = nameOf(selected); removeObject(selected); keyHelp.toast(`Removed ${n} · Ctrl+Z puts it back`); } }
  else if (it === 'grab') startGrab();
  else if (it === 'grab-drop') dropGrab();
  else if (it === 'grab-cancel') cancelGrab();
  else if (it === 'grab-turn') turnGrab();
  else if (it === 'lock') toggleLock();
  else if (it === 'persona') cyclePersona();
  else if (it.startsWith('nav-')) { if (!mk && !editing && !grabbing) frontend.setNavigation(({ 'nav-route': 'route', 'nav-walk': 'walk', 'nav-explore': 'explore', 'nav-fly': 'fly' } as const)[it as 'nav-route']); }
  else if (it === 'recenter' && isChair()) { if (mode === 'free') { headTurn.yaw -= spinBy(body, headTurn.yaw, chairOf(), chairOk()); keyHelp.toast(Math.abs(headTurn.yaw) < 0.01 ? 'Chair turned to face your view' : 'No room to turn the chair further'); } }
  else if (it === 'recenter') { if (mode === 'free') { const was = body.yaw; body.yaw = viewYaw(); if (!canStand(body)) body.yaw = was; else headTurn.yaw = 0; keyHelp.toast('Walker turned to face your view'); } }
});

// ---------- input ----------
const keys = new Set<string>();
addEventListener('keydown', e => {
  if (e.defaultPrevented || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) return;
  if (selected >= 0 && e.code.startsWith('Arrow')) { nudge(e.code); e.preventDefault(); return; }   // arrows move the selected object, not you
  keys.add(e.code);
  if (e.code === 'KeyT') setMode('translate');
  if (e.code === 'KeyR') setMode('rotate');
  if (e.code === 'Escape') select(-1);
  if (e.code === 'KeyZ' && !e.ctrlKey && !e.metaKey && !/^(INPUT|SELECT)$/.test((e.target as HTMLElement).tagName)) {   // Z: put the picked object back; Shift+Z: the whole room
    if (e.shiftKey) resetAll(); else if (selected >= 0) resetObject(selected);
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && selected >= 0) removeObject(selected);
  if (e.code === 'KeyF') { if (mode === 'fly') goWalk(); else setWalk('fly'); }
  else if (/^(Key[WASD]|Arrow)/.test(e.code) && mode !== 'fly') setWalk('free');
});
addEventListener('keyup', e => { keys.delete(e.code); shiftHeld = e.shiftKey; });
const ray = new THREE.Raycaster();
// a drag with the left or right button looks; `right` + `act`: a right click that didn't move runs act (undo a mark point...)
let look: { x: number; y: number; moved: number; right?: boolean; act?: () => unknown } | null = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if ((e.button !== 0 && e.button !== 2) || renderer.xr.isPresenting || handleDrag || parkDrag || tc.dragging || (tc as any).axis) return;
  if (e.button === 2) { look = { x: e.clientX, y: e.clientY, moved: 0, right: true }; return; }
  if (mk || editing) { look = { x: e.clientX, y: e.clientY, moved: 0 }; return; }
  ray.setFromCamera(ndc(e), camera);
  const hit = ray.intersectObjects(items.filter((_, k) => !layout.poses[k].removed).map(i => i.proxy))[0];
  if (hit) { select(items.findIndex(i => i.proxy === hit.object)); return; }
  look = { x: e.clientX, y: e.clientY, moved: 0 };
});
renderer.domElement.addEventListener('dblclick', e => {   // double-click an object: back where it started
  if (mk || editing || parkDrag || renderer.xr.isPresenting || performance.now() - droppedAt < 600) return;
  ray.setFromCamera(ndc(e), camera);
  const hit = ray.intersectObjects(items.filter((_, k) => !layout.poses[k].removed).map(i => i.proxy))[0];
  if (hit) resetObject(items.findIndex(i => i.proxy === hit.object));
});
/** The head turns on the walker's body (limited, like a neck); the walker keeps its heading, so W/S push it where it points
 *  while you look around. ?look=coupled: the old behaviour, looking turns the walker. Fly always looks with the body. */
const headTurn = { yaw: 0 }, HEAD_MAX = 2.1, COUPLED = PARAMS.get('look') === 'coupled';
const viewYaw = () => body.yaw + headTurn.yaw;
function lookBy(dx: number, dy: number) {
  if (mode !== 'fly' && !COUPLED) headTurn.yaw = THREE.MathUtils.clamp(headTurn.yaw - dx * 0.004, -HEAD_MAX, HEAD_MAX); else body.yaw -= dx * 0.004;
  body.pitch = THREE.MathUtils.clamp(body.pitch - dy * 0.004, mode === 'fly' ? -1.5 : -1.2, mode === 'fly' ? 1.5 : 0.6);
}
addEventListener('pointermove', e => {
  if (document.pointerLockElement === renderer.domElement) {   // L: the locked mouse looks without a button held
    if (e.movementX || e.movementY) { if (mode === 'auto') setWalk('free'); lookBy(e.movementX, e.movementY); }
    return;
  }
  if (!look) return;
  const dx = e.clientX - look.x, dy = e.clientY - look.y;
  look.x = e.clientX; look.y = e.clientY; look.moved += Math.abs(dx) + Math.abs(dy);
  lookBy(dx, dy);
  if (mode === 'auto' && look.moved > 4) setWalk('free');
});
addEventListener('pointerup', () => {
  if (look && (look.right ? look.moved < 4 && look.act : look.moved < 3)) { if (look.right) look.act!(); else select(-1); }
  look = null;
});
/** Scroll, two-finger scroll and pinch walk forward and back where free walk could stand; sideways scroll turns. */
function dolly(d: number) {
  if (mode === 'auto') setWalk('free');
  const cy = Math.cos(body.yaw), sy = Math.sin(body.yaw);
  if (mode === 'fly') { const c = Math.cos(body.pitch); fly.x += d * c * cy; fly.y += d * c * sy; fly.z += d * Math.sin(body.pitch); return; }
  if (explore.on) {
    const [x0, y0] = g.origin_xy, x1 = x0 + g.shape[0] * g.cell_m, y1 = y0 + g.shape[1] * g.cell_m;
    body.x = THREE.MathUtils.clamp(body.x + cy * d, x0, x1); body.y = THREE.MathUtils.clamp(body.y + sy * d, y0, y1);
    return;
  }
  const n = Math.max(1, Math.ceil(Math.abs(d) / (g.cell_m / 2)));
  for (let i = 0; i < n; i++) {
    const next = { x: body.x + cy * d / n, y: body.y + sy * d / n, yaw: body.yaw };
    if (!(isChair() ? chairOk()(next) : canStand(next))) break;
    Object.assign(body, next);
  }
}
renderer.domElement.addEventListener('wheel', e => {
  if (renderer.xr.isPresenting || tour.on) return;
  e.preventDefault();   // also stops a pinch (ctrl + wheel) from zooming the page
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;   // lines and pages to pixels
  if (e.deltaX) { if (mode === 'auto') setWalk('free'); if (isChair() && mode === 'free') spinBy(body, -e.deltaX * unit * 0.002, chairOf(), chairOk()); else body.yaw -= e.deltaX * unit * 0.002; }
  if (e.deltaY) dolly(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));   // a pinch sends small deltas: more gain
}, { passive: false });
function setWalk(m: 'auto' | 'free' | 'fly') {
  if (m === 'fly' && mode !== 'fly') { Object.assign(fly, camera.position); flyHold = { x: body.x, y: body.y, yaw: body.yaw }; body.yaw = viewYaw(); }   // body.yaw is the fly view now; the walker keeps its own pose
  if (m !== 'fly' && mode === 'fly' && flyHold) { Object.assign(body, flyHold); flyHold = null; }
  if (m !== 'fly') body.pitch = THREE.MathUtils.clamp(body.pitch, -1.2, 0.6);
  mode = m;
  $('autoplay').classList.toggle('on', m === 'auto'); $('free').classList.toggle('on', m === 'free'); $('fly').classList.toggle('on', m === 'fly');
  if (m === 'auto') { autoS = 0; autoPause = 0; setExplore(false); }
  if (m !== 'free') { headTurn.yaw = 0; chairVel.v = chairVel.w = 0; }   // the head is the walker's in route-follow and fly
}
$('autoplay').onclick = () => setWalk('auto');
$('free').onclick = () => setWalk('free');
$('fly').onclick = () => setWalk('fly');

// ---------- movement modes (navmode.ts): Follow route / Walk / Look around / Fly, and how you move between them ----------
// While flying, body.yaw/pitch are the camera's; the walker stays at flyHold (Look around parks it in explore.parked).
let flyHold: { x: number; y: number; yaw: number } | null = null;
const walkerPose = () => explore.parked ?? flyHold ?? body;
const canPlace = (p: { x: number; y: number; yaw: number }) => (isChair() ? chairOk()(p) : canStand(p));
/** Walk: from Fly the walker lands where you were flying (nearest floor, facing your view); from Look around it is
 *  where you left it; from Follow route it is already under you. */
function goWalk() {
  const was = mode, view = { x: fly.x, y: fly.y, yaw: body.yaw }, parked = explore.on ? explore.parked : null;
  setWalk('free'); setExplore(false); headTurn.yaw = 0; chairVel.v = chairVel.w = 0;
  if (was === 'fly') {
    const at = nearestStandable(view.x, view.y, (x, y) => canPlace({ x, y, yaw: view.yaw }), 1.5, g.cell_m / 2);
    if (at) { Object.assign(body, { x: at[0], y: at[1], yaw: view.yaw }); keyHelp.toast('Walker placed where you were flying'); return; }
    if (!parked) { keyHelp.toast('No floor under the flying camera: the walker stayed where it was'); return; }
  }
  if (parked && canPlace(parked)) { Object.assign(body, parked); keyHelp.toast('Walker is back where you left it'); }
}
/** Follow route resumes where the walker is on the route (the world-model playback counts its own poses). */
function resumeS(): number {
  if (!current || routeS.length < 2) return 0;
  const gw = current.ghosts[0]?.walker, useWorld = persona.step_model === 'world' && gw && gw.length > 1;
  const playLen = useWorld ? gw.slice(1).reduce((a, q, k) => a + Math.hypot(q[0] - gw[k][0], q[1] - gw[k][1]), 0) : undefined;
  return routeResume(nearestS(...walkerPoint(body, [centreOffset, 0])), routeS[routeS.length - 1], playLen);
}
const headMismatched = () => mode === 'free' && !explore.on && !COUPLED && headingMismatch(headTurn.yaw);
// a faint arrow on the floor shows where W/S push; amber while your head is turned away from it
const headArrow = (() => {
  const sh = new THREE.Shape(); sh.moveTo(0.34, 0); sh.lineTo(0.14, 0.13); sh.lineTo(0.14, 0.05); sh.lineTo(0, 0.05); sh.lineTo(0, -0.05); sh.lineTo(0.14, -0.05); sh.lineTo(0.14, -0.13); sh.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  m.renderOrder = 3; m.visible = false; scene.add(m); return m;
})();
const parkedTag = label('walker stays here');
parkedTag.visible = false;
scene.add(parkedTag);
function movementVisuals() {
  const wb = walkerPose(), walking = mode === 'free' && !explore.on && !renderer.xr.isPresenting && !tour.on, parkedNow = (explore.on || mode === 'fly') && !renderer.xr.isPresenting;
  const mis = headMismatched();
  headArrow.visible = walking;
  if (walking) {
    const a = centreOffset + walkerCfg.depth_m / 2 + 0.12;
    headArrow.position.set(wb.x + Math.cos(wb.yaw) * a, wb.y + Math.sin(wb.yaw) * a, 0.03); headArrow.rotation.z = wb.yaw;
    const mat = headArrow.material as THREE.MeshBasicMaterial; mat.color.setHex(mis ? 0xffb347 : 0x9fd8ff); mat.opacity = mis ? 0.95 : 0.5;
  }
  parkedTag.visible = parkedNow;
  if (parkedNow) parkedTag.position.set(wb.x, wb.y, walkerCfg.handle_height_m + 0.1);
}

// ---------- motion + live checks ----------
const cellAt = (x: number, y: number) => { const [i, j] = toCell(g, [x, y]); return i * ny + j; };
const walkerPoint = (b: { x: number; y: number; yaw: number }, [px, py]: number[]): XY =>
  [b.x + Math.cos(b.yaw) * px - Math.sin(b.yaw) * py, b.y + Math.sin(b.yaw) * px + Math.cos(b.yaw) * py];
function canStand(b: { x: number; y: number; yaw: number }) {
  const c = cellAt(b.x, b.y);
  const S = live ? placeBase : L;   // with live physics the walker meets furniture as bodies, not as a wall on the grid
  if (!S.floor[c] || S.obst[c] || unseen[c]) return false;           // only where the capture actually saw floor
  return walker.probes.every(p => { const k = cellAt(...walkerPoint(b, p)); return S.floor[k] && !S.obst[k]; });
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
  dt = routePaused ? 0 : dt * routeSpeed;
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
// ---------- wheelchair driving (drive.ts): arcs about the axle, speed that builds, the whole frame swept against the walls ----------
let chairGeo: { cfg: WalkerCfg; chair: Chair } | null = null;
const chairOf = () => (chairGeo?.cfg === walkerCfg ? chairGeo : (chairGeo = { cfg: walkerCfg, chair: chairGeometry(walkerCfg, g.cell_m / 2) })).chair;
/** Where the chair may be: Explore is unfenced; otherwise the walker's own check plus its frame's outline on clear floor
 *  (with live physics furniture are bodies, so only the walls count here). */
function chairOk(): (p: { x: number; y: number; yaw: number }) => boolean {
  if (explore.on) return p => inGridXY(p.x, p.y);
  const S = live ? placeBase : L, clear = clearOf(chairOf(), (x, y) => { const c = cellAt(x, y); return !!S.floor[c] && !S.obst[c]; });
  return p => canStand(p) && clear(p);
}
function driveFree(dt: number) {
  const k = (c: string) => keys.has(c), axis = (a: string[], b: string[]) => +a.some(k) - +b.some(k);
  driveStep(body, chairVel, { throttle: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']), steer: axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']), spin: axis(['KeyQ'], ['KeyE']) }, dt, chairOf(), chairOk());
}
addEventListener('blur', () => keys.clear());   // a key released in another window must not leave the chair rolling

function freeStep(dt: number) {
  if (isChair()) return driveFree(dt);
  const k = (c: string) => keys.has(c);
  const turn = (+(k('KeyA') || k('ArrowLeft')) - +(k('KeyD') || k('ArrowRight'))) * 1.1 * dt;
  const fwd = (+(k('KeyW') || k('ArrowUp')) - +(k('KeyS') || k('ArrowDown'))) * 0.5 * dt;
  if (explore.on) {   // no fence: through walls and furniture, kept inside the scanned grid
    const [x0, y0] = g.origin_xy, x1 = x0 + g.shape[0] * g.cell_m, y1 = y0 + g.shape[1] * g.cell_m;
    body.yaw += turn;
    body.x = THREE.MathUtils.clamp(body.x + Math.cos(body.yaw) * fwd, x0, x1); body.y = THREE.MathUtils.clamp(body.y + Math.sin(body.yaw) * fwd, y0, y1);
    return;
  }
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
  const wb = walkerPose();   // the walker, wherever it stands (parked while exploring or flying)
  // measured, per frame: bump under each leg, frame clearance from the obstacle distance field
  legTags.forEach((t, n) => { if (n >= walkerCfg.legs.length) t.visible = false; });
  state.legs = walkerCfg.legs.map((p, n) => {
    const [x, y] = walkerPoint(wb, p), c = cellAt(x, y), h = L.bump[c] || 0, e = !!est[c] && h > 0, flash = h >= risk.leg_flash_m || e;
    walker.setLegRed(n, flash && Math.floor(t * 6) % 2 === 0);
    legTags[n].visible = flash;
    if (flash) { legTags[n].position.set(x, y, 0.25); legTags[n].element.textContent = e ? `cable ~${(h * 100).toFixed(1)} cm (estimated)` : `${(h * 100).toFixed(1)} cm bump`; legTags[n].element.className = 'label3d red'; }
    return { x, y, h, flash, est: e };
  });
  let gap = Infinity, at: XY = [0, 0];
  if (current?.dist_m) for (const p of walker.probes) {
    const q = walkerPoint(wb, p), d = current.dist_m[cellAt(...q)] - walkerCfg.leg_radius_m;
    if (d < gap) { gap = d; at = q; }
  }
  state.gap = gap; state.red = gap < sc.hazard_rules.clearance_margin_m;
  walker.setFrameRed(state.red);
  gapTag.visible = state.red;
  if (state.red) { gapTag.position.set(at[0], at[1], walkerCfg.handle_height_m + 0.1); gapTag.element.textContent = `${Math.max(0, gap * 100).toFixed(0)} cm gap`; }
  // upcoming hazards (next 2.5 m of the route) glow
  const sNow = mode === 'auto' ? autoS : nearestS(...walkerPoint(wb, [centreOffset, 0]));
  for (const ring of hazardGroup.children as THREE.Mesh[]) {
    const ahead = ring.userData.s - sNow, mat = ring.material as THREE.MeshBasicMaterial;
    const glow = ahead > -0.3 && ahead < 2.5;
    if (perfOn && ring.children[0]) ring.children[0].visible = glow;   // performance mode: a label only for the hazards just ahead
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
type Mannequin = { group: THREE.Object3D; head: { visible: boolean }; update: (...a: any[]) => unknown; seated: (...a: any[]) => unknown };
let mannequin: Mannequin = buildMannequin(persona.eye_height_m / 0.94);
mannequin.group.visible = false;
scene.add(mannequin.group);
let manShadows = GROUND ? footShadows(mannequin.group) : null, manPose: unknown = null;   // manPose: the rigged mannequin's last pose report (ankle / hand errors)
// the skinned model (rig.ts, CesiumMan CC BY 4.0) replaces the plain one once it has loaded; ?mannequin=basic or a failed load keeps the plain one
if (PARAMS.get('mannequin') !== 'basic') loadRigged('models/mannequin/CesiumMan.glb', persona.eye_height_m / 0.94).then(rigged => {
  renderer.localClippingEnabled = true;   // first person clips the head off at the neck
  rigged.group.visible = mannequin.group.visible;
  scene.remove(mannequin.group); scene.add(rigged.group);
  mannequin = rigged;
  manShadows = GROUND ? footShadows(rigged.group) : null;
}).catch(e => console.warn('rigged mannequin not loaded, keeping the plain one:', e));
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
// ---------- next-step cloud + future trail (third person): where the 200 trips put the mannequin's next step, and its own next steps ----------
const stepCloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: DOT, color: 0x4cc9f0, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false }));
const futureSteps = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: DOT, color: 0x9ff0ff, size: 14, sizeAttenuation: false, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false }));
stepCloud.renderOrder = futureSteps.renderOrder = 2;   // over the mannequin: the steps it is about to take sit under its body
scene.add(stepCloud, futureSteps);
let cloudK = -1, cloudFor: unknown = null;
function stepCloudUpdate(show: boolean) {
  stepCloud.visible = futureSteps.visible = show;
  const k = show ? heroSteps.findIndex(p => p.s > autoS) : -1;
  if (k < 0 || (k === cloudK && cloudFor === current) || !current) return;
  cloudK = k; cloudFor = current;
  // every trip's step k, shifted so trip 0's lands on the mannequin's own step (heels vs centre line differ per model)
  const g0 = current.ghosts[0]?.pts[k], hx = heroSteps[k].xy;
  const cloud = g0 ? current.ghosts.flatMap(gh => gh.pts[k] ? [new THREE.Vector3(gh.pts[k][0] - g0[0] + hx[0], gh.pts[k][1] - g0[1] + hx[1], 0.03)] : []) : [];
  stepCloud.geometry.dispose(); stepCloud.geometry = new THREE.BufferGeometry().setFromPoints(cloud);
  const next = heroSteps.slice(k, k + 6);
  futureSteps.geometry.dispose(); futureSteps.geometry = new THREE.BufferGeometry().setFromPoints(next.map(p => new THREE.Vector3(p.xy[0], p.xy[1], 0.035)));
}

const view = { third: false, back: 1.0, up: 0.4 };   // third person: behind, just above the user (higher looks through a real splat's low-opacity haze and hides the walker)
function placeCamera(cam: THREE.PerspectiveCamera, b: typeof body) {
  if (view.third && cam === camera) {
    cam.position.set(b.x - Math.cos(b.yaw) * view.back, b.y - Math.sin(b.yaw) * view.back, persona.eye_height_m + view.up);
    cam.lookAt(b.x + Math.cos(b.yaw) * centreOffset, b.y + Math.sin(b.yaw) * centreOffset, 0.3);
    return;
  }
  cam.position.set(b.x, b.y, persona.eye_height_m);
  const c = Math.cos(b.pitch), yaw = b.yaw + (cam === camera ? headTurn.yaw : 0);
  cam.lookAt(b.x + Math.cos(yaw) * c, b.y + Math.sin(yaw) * c, persona.eye_height_m + Math.sin(b.pitch));
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
    $('hud').textContent = `${game.fps.toFixed(0)} fps · ${mode === 'auto' ? 'autoplay' : mode === 'fly' ? 'fly (noclip)' : explore.on ? 'look around' : isChair() ? 'drive' : 'walk'} · ${RUN}${sc.scale_note ? ` · ${sc.scale_note}` : ""}`;
  }
}
function step(dt: number, t: number) {
  frontendVR?.update();
  if (xr.presenting()) return xrFrame(dt, t);
  if (mode === 'auto') autoStep(dt); else if (mode === 'fly') flyStep(dt); else freeStep(dt);
  tourStep(dt);
  const wb = walkerPose();
  walker.group.position.set(wb.x, wb.y, 0);
  walker.group.rotation.z = wb.yaw;
  reim.update(dt);
  stairs3d.update(t, $<HTMLInputElement>('night').checked);
  if (mode !== 'fly') live?.frame(dt, wb, mode === 'free' && !explore.on, walker.group);
  labelStep(); movementVisuals();
  if (mode === 'fly') {
    const c = Math.cos(body.pitch);
    camera.position.set(fly.x, fly.y, fly.z);
    camera.lookAt(fly.x + Math.cos(body.yaw) * c, fly.y + Math.sin(body.yaw) * c, fly.z + Math.sin(body.pitch));
  } else placeCamera(camera, body);
  markStep(); grabStep();
  const showMan = view.third && mode === 'auto' && heroSteps.length > 0;
  const seatedMan = isChair() && mode === 'free' && !explore.on;   // driving: the person sits in the chair; first person has no head in the way
  mannequin.group.visible = showMan || seatedMan;
  mannequin.head.visible = !seatedMan || view.third;
  stepCloudUpdate(showMan);
  if (isChair() && (showMan || seatedMan)) { manPose = mannequin.seated(body, SEAT_Z, walkerCfg.legs[0][1] + 0.025, { x: walkerCfg.legs[0][0], z: WHEEL_R, r: WHEEL_R - 0.04 }); manShadows?.hide(); }   // the chair's own blobs ground it
  else if (showMan) {
    const f = feetAt(heroSteps, autoS, persona.stride_m ?? 0.35), hy = walkerCfg.width_m / 2 - walkerCfg.leg_radius_m, gx = walkerCfg.user_gap_m + 0.05;
    manPose = mannequin.update(body, [f[1], f[0]], [[gx, hy], [gx, -hy]], walkerCfg.handle_height_m);   // sim side 1 = left
    manShadows?.(body, [f[0].pos, f[1].pos]);
  }
  pulseSpots(t);
  replayStep(dt);
  liveChecks(t);
  vision.render();
  css.render(scene, camera);
}

// ---------- VR (xr.ts): the headset is the patient's eyes; main.ts hands it the scene, the walker and the editor ----------
const inGridXY = (x: number, y: number) => x >= g.origin_xy[0] && y >= g.origin_xy[1] && x < g.origin_xy[0] + nx * g.cell_m && y < g.origin_xy[1] + ny * g.cell_m;
const standable = (x: number, y: number) => { const c = cellAt(x, y); return inGridXY(x, y) && !!L.floor[c] && !L.obst[c] && coverage[c] > 0; };
let perfBeforeXR = perfOn;
// Real layout changes are separate from a labelled, read-only comparison of the saved prior and safer rooms.
let previewVisibility: [THREE.Object3D, boolean][] | null = null, previewSide: number | null = null;
const comparison = createXRComparison({
  capture: () => ({ layout, applied }),
  context: () => JSON.stringify([personaKey, strongSide, stairs, doors, routes, init.plan]),
  search: reimagineRoom,
  async apply(snapshot) {
    layout = snapshot.layout; applied = snapshot.applied;
    syncObjects(); await replan(); reim.setT(1);
  },
  preview(from, to, t) {
    if (!previewVisibility) {
      reim.setT(1);   // stop an automatic morph before drawing this independent comparison
      previewVisibility = [routeLine, ghostDots, hazardGroup, spotGroup, reim.root].map(o => [o, o.visible]);
      for (const [o] of previewVisibility) o.visible = false;
      objLabel.set(null, [], false);
    }
    items.forEach((it, k) => {
      const a = from.poses[k], b = to.poses[k], p = layoutPoseAt(a, b, t), u = t * t * (3 - 2 * t);
      const alpha = (a.removed ? 0 : 1) * (1 - u) + (b.removed ? 0 : 1) * u;
      it.group.position.set(p.x, p.y, 0); it.group.rotation.set(0, 0, p.yaw);
      it.group.visible = alpha > 0.001; it.mesh.opacity = alpha;
      const moved = alpha < 0.999 || Math.hypot(p.x - scanned[k].x, p.y - scanned[k].y) > 0.01 || Math.abs(p.yaw - scanned[k].yaw) > 0.01;
      it.fill.visible = it.tag.visible = moved && $<HTMLInputElement>('imagfill').checked;
    });
    const side = t >= 0.5 ? 1 : 0;
    if (previewSide !== side) { const lay = side ? to : from; drawStairs(lay); drawTape(lay); previewSide = side; }
  },
  endPreview() {
    for (const [o, visible] of previewVisibility ?? []) o.visible = visible;
    previewVisibility = null; previewSide = null;
    syncObjects(); drawStairs();
  },
});
// "Night walk": the lights go down (the night shader, as the Night box does), lit only by a nightlight if the room has one
const nightOn = () => $<HTMLInputElement>('night').checked;
const nightButton = {
  text() {
    const k = objs.findIndex(o => o.kind === 'nightlight'), lit = k >= 0 && !layout.poses[k].removed;
    return nightOn() ? ['Turn the lights back on', lit ? 'a nightlight is on' : 'no nightlight in this room'] : ['Night walk', 'the lights go down, like at 3 a.m.'];
  },
  tone: () => (nightOn() ? 'plain' as const : 'go' as const),
  press: () => game.setNight(!nightOn()),
};
// "Show me the dangers": stand in front of each hazard spot (worst first, the desktop tour's order) facing it, the spot
// glowing, with what it is in plain words; each press goes to the next, at the person's pace (no timer)
const dangerVR = { k: -1, none: false };
function dangerGo(k: number) {
  comparison.endPreview();
  const s = spotList[k], at = s && current && !current.error ? tourStand(s, current.xy, standable) : null;
  if (!at) { dangerVR.k = -1; tourSpot = -1; return; }
  dangerVR.k = k; tourSpot = k;
  xr.place(at.x, at.y, at.yaw);
}
const dangersButton = {
  text() {
    const n = spotList.length;
    if (dangerVR.k >= n) { dangerVR.k = -1; tourSpot = -1; }
    if (dangerVR.k < 0) return dangerVR.none ? ['No dangers found', 'on this walk'] : ['Show me the dangers', n ? `${n} place${n === 1 ? '' : 's'} to look at` : 'none on this walk'];
    const { title, why } = plainSpot(spotList[dangerVR.k]);
    return [`${dangerVR.k + 1} of ${n}: ${title}`, why, dangerVR.k + 1 < n ? 'pinch for the next one' : 'pinch to finish'];
  },
  tone: () => (dangerVR.k >= 0 ? 'busy' as const : 'go' as const),
  press() {
    if (dangerVR.k < 0) { dangerVR.none = !spotList.length; if (!dangerVR.none) dangerGo(0); return; }
    if (dangerVR.k + 1 < spotList.length) dangerGo(dangerVR.k + 1);
    else { dangerVR.k = -1; tourSpot = -1; }
  },
};
const xr = await setupXR({
  renderer, scene, camera, params: PARAMS, body, items, names: objs.map(o => o.name), poses: () => layout.poses,
  canPlace: (k, p) => placementOk(g, placeBase, objs, layout.poses.map((q, n) => (n === k ? p : q)), k, overlapOk[k]),
  commit: commitPose, remove: removeObject, resync: syncObjects, standable, cellM: g.cell_m,
  resetObject, resetAll, editor: markerXR, readOnly: comparison.previewing, hints: () => { const h = controlHints({ ...hintBase('vr'), inspect: false }); return { lines: hintLines(h), tone: h.tone }; }, history: { undo: () => stepHistory('undo'), redo: () => stepHistory('redo') },
  startPose() {   // stay if this floor is seen as well as the route's median spot; else the first such point along the route
    if (!current || current.error) return null;
    const poses: { x: number; y: number; yaw: number }[] = [];
    for (let s = 0; s < routeS[routeS.length - 1]; s += 0.05) { const p = routePose(s, body.yaw, Infinity); if (standable(p.x, p.y)) poses.push(p); }
    const cov = (p: { x: number; y: number }) => coverage[cellAt(p.x, p.y)];
    const sorted = poses.map(cov).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (standable(body.x, body.y) && cov(body) >= median) return null;
    return poses.find(p => cov(p) >= median) ?? poses[0] ?? null;
  },
  enter(t) {   // a standalone headset turns performance mode on; hazard labels become scene cards
    select(-1); inXR = true; game.xr = true; perfBeforeXR = perfOn;
    if (t === 'quest' && PARAMS.get('perf') !== '0') applyPerf(true, false);
    if (current) drawPlan(current);
    say();
  },
  exit() { comparison.endPreview(); inXR = false; game.xr = false; dangerVR.k = -1; tourSpot = -1; applyPerf(perfBeforeXR, false); if (current) drawPlan(current); say(); },
  buttons: [dangersButton, nightButton, comparison.button, comparison.previewButton],   // the story for a family: what's risky, how night feels, the fix
  shell: {   // the planning shell (frontend.ts) over the wand; frontendVR is created after the first frame, so look it up lazily
    activate: c => !!frontendVR?.activate(c), release: c => !!frontendVR?.release(c), open: () => !!frontendVR?.isOpen(),
    follow(dt) { if (!xrFollowRoute || mode !== 'auto') return false; autoStep(dt); return true; },
    hover: k => reim.selectChange(k),
  },
});
/** One headset frame: the monitor's world updates (walker, glow, the reimagined room, stairs, live checks), but no camera
 *  placement (the headset is the camera), no DOM labels and no post pass (it can't run per eye). Live physics follows
 *  without holding the body back: in VR the body is wherever the person physically stands. */
function xrFrame(dt: number, t: number) {
  xr.step(dt);
  const wb = explore.parked ?? body;
  walker.group.position.set(wb.x, wb.y, 0);
  walker.group.rotation.z = wb.yaw;
  if (!comparison.previewing()) live?.frame(dt, wb, false, walker.group);
  pulseSpots(t);
  reim.update(dt);
  comparison.step(dt);
  stairs3d.update(t, $<HTMLInputElement>('night').checked);
  if (!comparison.previewing()) labelStep();
  liveChecks(t);
  renderer.render(scene, camera);
}
// ---------- start ----------
setWalk('auto');
await replan();
if ((current as Eval | null)?.error === undefined && current) Object.assign(body, routePose(0, 0, Infinity));
else { const [sx, sy] = routes[selRoute].start; Object.assign(body, { x: sx - centreOffset, y: sy, yaw: 0 }); }
// ---------- room light on the meshes (ground.ts) ----------
// the splat rendered into an env map from the room's middle, 1 m up, before the loop (it sorts the splats for the cube
// camera; the loop would re-sort them for the main one mid-capture). Capped wait: a slow load keeps the old flat light.
if (GROUND) {
  const ready = await Promise.race([Promise.all(splats.map(s => s.initialized)).then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 10000))]);
  if (ready) {
    await roomEnvironment(sparkR, scene, new THREE.Vector3(g.origin_xy[0] + (g.shape[0] * g.cell_m) / 2, g.origin_xy[1] + (g.shape[1] * g.cell_m) / 2, 1.0));
    updateNight();
  }
}
renderer.setAnimationLoop(frame);   // not requestAnimationFrame: in a headset session only the XR frame loop runs

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
  resume() { game.manual = false; last = performance.now(); },   // the animation loop never stopped: frame() was skipping
  autoS: () => autoS, setAuto: () => setWalk('auto'),
  /** Live profiling from DevTools (e.g. hide splats in a headset session and watch game.fps). */
  debug: { renderer, scene, camera, marker: mk3d.root, stairs: stairs3d.root, spark: sparkR, splats, main: splats[0], items, overlays: [routeLine, ghostDots, hazardGroup, tapeGroup],
    rig: xr.rig, xrDevice: xr.device, xrPlace: xr.place, wand: xr.wand, xrStrip: xr.strip, xrTier: xr.tier, xrButtons: xr.buttons, xrComparison: comparison.state, xrPress: xr.press, xrMount: xr.mount },
  /** In a headset session: where the XR camera, the user camera in its rig, and the walker actually are (floor frame). */
  xrPose: () => ({ ...xr.pose(), body: { ...body }, walker: walker.group.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)) }),
  setFree(x: number, y: number, yaw: number) { setWalk('free'); setExplore(false); headTurn.yaw = 0; chairVel.v = chairVel.w = 0; Object.assign(body, { x, y, yaw }); },
  explore: () => ({ on: explore.on, parked: explore.parked && { ...explore.parked } }),
  setFly(x: number, y: number, z: number, yawDeg: number, pitchDeg: number) { setWalk('fly'); Object.assign(fly, { x, y, z }); body.yaw = (yawDeg * Math.PI) / 180; body.pitch = (pitchDeg * Math.PI) / 180; },
  setThird(on: boolean) { const h = $<HTMLInputElement>('third'); h.checked = on; h.dispatchEvent(new Event('change')); },
  layout: () => layout, current: () => current, routes,
  spots: () => spotList, startTour, endTour, tourState: () => ({ ...tour }), replayState: () => ({ on: replay.on, t: replay.t }), startReplay, stopReplay, showPhysics,
  setPersona, physicsPass, personas: () => Object.keys(personas), persona: () => personaKey, suggest, applyOption, setFillBackend,
  /** a layout from configured fixes, in order (pre-render scenarios); one re-plan */
  applyFixes(ids: string[]) {
    layout = ids.reduce((l, id) => applyIntervention(objs, l, interventions.find(i => i.id === id)!), { poses: original.map(p => ({ ...p })), flattened: [] } as Layout);
    applied = [...ids];
    syncObjects();
    return replan().then(ms => { if (!current?.error) Object.assign(body, routePose(0, 0, Infinity)); return ms; });
  },
  setNight(on: boolean) { $<HTMLInputElement>('night').checked = on; updateNight(); },
  openReport, openFixCard, describeChanges, mannequinVisible: () => mannequin.group.visible, mannequinPose: () => manPose, heroSteps: () => heroSteps,
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

// ---------- frontend shell: existing data/actions, independent of backend and optimizer ownership ----------
let inspectReturn: { body: typeof body; fly: typeof fly; mode: 'auto' | 'free' | 'fly'; rig: ReturnType<typeof xr.rigState> } | null = null;
/** What the viewer is doing, for hints.ts: the desktop strip and pills, and the VR strip card. */
function hintBase(device: 'desktop' | 'vr'): Omit<HintCtx, 'inspect'> {
  const w = device === 'vr' ? xr.wand() : null, total = mk?.kind === 'stairs' ? 3 : 2;
  return { device, persona: personaKey, nav: mode, marking: mk ? { kind: mk.kind, step: Math.min(mk.pts.length + 1, total), total } : null, editingMarks: editing && !mk,
    grabbing: device === 'vr' ? !!w?.grab : !!grabbing, selected: device === 'vr' ? w?.hover != null : selected >= 0,
    locked: document.pointerLockElement === renderer.domElement, mounted: device === 'vr' && !!xr.mount().hand,
    parked: device === 'desktop' && mode === 'free' && explore.on, mismatch: device === 'desktop' && headMismatched() };
}
const frontendAdapter: FrontendAdapter = {
  hintContext: () => ({ ...hintBase('desktop'), thirdPerson: view.third, personaLabel: personas[personaKey]?.label ?? personaKey }),   // the controls strip and status pills (hints.ts)
  snapshot: () => ({ room: RUN, patient: personaKey, route: routes[selRoute].name, current, baseline: baseEvals[selRoute] ?? null,
    changes: reim.changes(), spots: spotList, options: suggestions, selected, selectedName: objs[selected]?.name, mode, explore: explore.on, paused: routePaused, speed: routeSpeed, comparison: reim.t(), planKey: layoutKey(objs, layout) }),
  navigate(m) {
    endTour(); select(-1);
    if (m === 'inspect') { inspectReturn ??= { body: { ...body }, fly: { ...fly }, mode, rig: xr.rigState() }; setWalk(renderer.xr.isPresenting ? 'free' : 'fly'); }
    else if (m === 'route') { xrFollowRoute = renderer.xr.isPresenting; const at = mode === 'free' && !explore.on ? resumeS() : 0; if (mode !== 'auto') { setWalk('auto'); autoS = at; } routePaused = false; }
    else if (m === 'walk' || (m === 'fly' && renderer.xr.isPresenting)) { xrFollowRoute = false; goWalk(); routePaused = false; }
    else if (m === 'fly') { xrFollowRoute = false; setWalk('fly'); routePaused = false; }
    else { xrFollowRoute = false; const view = mode === 'fly' ? { x: fly.x, y: fly.y, yaw: body.yaw } : null; setWalk('free'); routePaused = false; if (!explore.on) setExplore(true); if (view && explore.on) Object.assign(body, view); }   // from Fly: the walker parks where it was, the camera stays where you flew
  },
  focus(item) {
    const p = vantage(item.at, current?.xy ?? [item.at], 1.2, 1.1);
    if (renderer.xr.isPresenting) { if (standable(p.x, p.y)) frontendVR?.transition(() => xr.moveHead(p.x, p.y)); }
    else { setWalk('fly'); Object.assign(fly, p); body.yaw = p.yaw; body.pitch = p.pitch; }
    reim.selectChange(item.object, item.change?.iv);
  },
  leaveInspect() { if (inspectReturn) { const back = inspectReturn; Object.assign(body, back.body); Object.assign(fly, back.fly); if (renderer.xr.isPresenting) frontendVR?.transition(() => xr.restoreRig(back.rig)); setWalk(back.mode); inspectReturn = null; } },
  pause() { routePaused = !routePaused; }, restart() { autoS = 0; autoPause = 0; routePaused = false; }, speed(v) { routeSpeed = v; },
  compare(t) { reim.setT(t); }, animate() { reim.play(); },
  suggest, async apply(index) { await applyOption(index); setWalk('free'); reim.setT(1); },
  undo: undoReimagined, select,
  path(on) { routeLine.visible = on; },
  async lightPath() { const r = await lightPath(); game.setNight(true); return r; },
  highlights(on) { hazardGroup.visible = on; }, improvements(on) { reim.setParts({ rings: on, ringLabels: on }); },
};
// classic two-panel UI with ?classic (the planning drawer is the default): the shell still mounts for VR, then every control it reparented goes home
const homes = [...document.querySelectorAll('#left *, #right *')].map(n => [n, n.parentNode!, n.nextSibling] as const).reverse();
const frontend = mountFrontend(frontendAdapter);
// demo mode (?demo=1, H toggles; shot.ts records with it): debug rows, ranges and the fps line hidden (style.css .demo)
document.body.classList.toggle('demo', PARAMS.get('demo') === '1');
addEventListener('keydown', e => { if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target as HTMLElement).tagName)) document.body.classList.toggle('demo'); });
game.setDemo = (on: boolean) => document.body.classList.toggle('demo', on);
if (PARAMS.has('classic')) { for (const [n, p, s] of homes) p.insertBefore(n, s); document.body.classList.remove('frontend'); document.getElementById('frontend')!.hidden = true; document.getElementById('left')!.hidden = document.getElementById('right')!.hidden = false; }
frontendVR = createFrontendXR({ renderer, scene, camera, adapter: frontendAdapter, frontend });
game.frontend = frontend;
game.frontendXR = frontendVR;

// Where the patient's device can go in this home, and what stops it. From the scan's floor map, like the route planner
// (plan(), grid.ts), every cell gets the widest way in from the route's start: the largest half-width that gets there.
// One pass answers every device width, so the width slider never waits for the worker.
//
// The floor is painted in four colours:
// - green: reachable
// - amber: tight. It gets through, but with less room than the device plus the planner's clearance (OT to verify).
// - red: cut off
// - grey: unscanned
//
// Each cut-off part names what cuts it off: a marked doorway at its marked width, a piece of furniture, a gap in the
// scan, or a wall. A wheelchair's dead ends are flagged: no ADA 1525 mm turning circle, so it has to reverse out.
// The widest way is a geometric path over the floor map, not a simulated walk.
// Pure (worker + node): reach3d.ts draws it, main.ts asks the worker.
import { stamp, carvedPolys, edt, toCell, cellXY, polyCells, worldFootprint, type GridMeta, type Layers, type Layout, type XY, type Intervention } from './grid.ts';
import { doorFrame, openingSpan, growOf, doorFixes, needWidth, type Door } from './doors.ts';
import { ADA } from './wheelchair.ts';
import { fixCost, moveCost } from './movecost.ts';

export const REACH = {
  zone_m: 0.5,          // the start is a spot to get going from, not one cell: anywhere this close counts as the start
  region_min_m2: 0.25,  // smaller cut-off slivers (behind a chair leg) are noise, not a part of the room
  grey_min_m2: 0.1,     // an unscanned patch inside the home at least this big is a hole in the scan
  pocket_m: 1.0,        // a wheelchair reversing further than this to find turning room is a dead end
  pocket_min_m2: 0.04,  // of chair-centre positions: in a 90 cm corridor that's a strip 24 cm wide, so 0.04 m² is ~17 cm of it
  jamb_ext_m: 0.4,      // a marked doorway's jambs run this far into the wall: the scan's gap may be wider than marked
  ghost_step_m: 0.05, corner_min_m2: 1, target_snap_m: 0.6,
};
const SQ2 = Math.SQRT2;
/** who owns a blocked cell (owner[]): an object index >= 0, a doorway DOOR0 + index, or one of these */
const OWN_FREE = -3, OWN_UNSEEN = -2, OWN_WALL = -1, DOOR0 = 1 << 20;

/** What reach.ts needs from the worker's Init (evaluate.ts), so node tests can build one by hand. */
export interface ReachInit {
  g: GridMeta; base: Layers;
  objects: { name: string; kind: string; footprint: XY[]; pivot: number[]; layer: 'obstacle' | 'bump' | 'none'; height_m: number; movable?: boolean }[];
  doors?: Door[];
  /** cameras that saw each cell (stage 12 coverage.u8) and how many make it trustworthy; absent: every cell trusted */
  coverage?: Uint8Array; coverage_good?: number;
}
/** Furniture the optimizer may move (optimize.ts actions()): what "moving it opens this" may name. */
export const isMovable = (o: ReachInit['objects'][number]) => !(o.movable === false || o.layer !== 'obstacle' || o.kind === 'door' || o.kind === 'rug');

/** Min-heap over cell indices with decrease-key, in typed arrays (a whole-house grid is millions of cells). */
export class CellHeap {
  key: Float64Array; heap: Int32Array; pos: Int32Array; n = 0;
  constructor(N: number) { this.key = new Float64Array(N); this.heap = new Int32Array(N); this.pos = new Int32Array(N).fill(-1); }
  done(c: number) { return this.pos[c] === -2; }
  push(c: number, k: number) {
    const p = this.pos[c];
    if (p === -2) return;
    if (p >= 0) { if (k < this.key[c]) { this.key[c] = k; this.up(p); } return; }
    this.key[c] = k; this.heap[this.n] = c; this.pos[c] = this.n; this.up(this.n++);
  }
  pop(): number {
    const H = this.heap, top = H[0];
    this.pos[top] = -2;
    if (--this.n > 0) { H[0] = H[this.n]; this.pos[H[0]] = 0; this.down(0); }
    return top;
  }
  private up(i: number) {
    const H = this.heap, K = this.key, c = H[i], k = K[c];
    while (i > 0) { const u = (i - 1) >> 1; if (K[H[u]] <= k) break; H[i] = H[u]; this.pos[H[i]] = i; i = u; }
    H[i] = c; this.pos[c] = i;
  }
  private down(i: number) {
    const H = this.heap, K = this.key, c = H[i], k = K[c], n = this.n;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= n) break;
      if (m + 1 < n && K[H[m + 1]] < K[H[m]]) m++;
      if (K[H[m]] >= k) break;
      H[i] = H[m]; this.pos[H[i]] = i; i = m;
    }
    H[i] = c; this.pos[c] = i;
  }
}

/** The 8 neighbours of cell k (flat i*ny + j) inside the grid, with their step length in cells. */
function forNeighbours(nx: number, ny: number, k: number, f: (n: number, step: number) => void) {
  const i = (k / ny) | 0, j = k - i * ny;
  for (let di = -1; di <= 1; di++) {
    const a = i + di;
    if (a < 0 || a >= nx) continue;
    for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const b = j + dj;
      if (b < 0 || b >= ny) continue;
      f(a * ny + b, di && dj ? SQ2 : 1);
    }
  }
}

/** The opening as marked (and as widened by a carve fix in this layout): the virtual jamb cells to block beyond it, and
 *  the opening's wall band. */
export function doorCells(g: GridMeta, d: Door, lay: Layout): { jamb: number[]; band: number[]; clear_m: number } {
  const c = lay.carved?.find(x => x.target === d.name), gain = c?.by_m ?? 0;
  const grow = c ? growOf(d, c.id.split(':')[0].slice('door_'.length)) : 'both';
  const F = doorFrame(d), [s0, s1] = openingSpan(F, gain, grow), T = F.wall / 2, ext = REACH.jamb_ext_m;
  const jamb: number[] = [], band: number[] = [];
  for (const k of polyCells(g, [F.world(s0 - ext, -T), F.world(s1 + ext, -T), F.world(s1 + ext, T), F.world(s0 - ext, T)])) {
    const [x, y] = cellXY(g, k), s = (x - F.o[0]) * F.e[0] + (y - F.o[1]) * F.e[1];
    band.push(k);
    if (s < s0 || s > s1) jamb.push(k);
  }
  return { jamb, band, clear_m: s1 - s0 };
}

/** Widest way in from the start zone: need[c] = the largest min-clearance over paths to c (0: not connected), ties broken
 *  by the shorter path, so the ghost paths go straight instead of meandering. */
function widest(nx: number, ny: number, cell: number, dist: Float32Array, zone: number[]) {
  const N = nx * ny, need = new Float32Array(N), len = new Float32Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1);
  const h = new CellHeap(N);
  for (const z of zone) { need[z] = dist[z]; len[z] = 0; h.push(z, -dist[z]); }
  while (h.n) {
    const c = h.pop(), nc = need[c], lc = len[c];
    forNeighbours(nx, ny, c, (n, step) => {
      if (dist[n] <= 0 || h.done(n)) return;
      const cand = Math.min(nc, dist[n]), cl = lc + step * cell;
      if (cand > need[n] + 1e-7 || (cand > need[n] - 1e-7 && cl < len[n])) {
        need[n] = cand; len[n] = cl; parent[n] = c; h.push(n, -cand + cl * 1e-8);
      }
    });
  }
  return { need, len, parent };
}

export interface ReachField {
  g: GridMeta; start: XY; zone: number[];
  /** m to the nearest blocked cell (marked doorways at their marked width) */
  dist: Float32Array;
  /** widest way in: the largest half-width that gets here (0: not connected); its length (m) and previous cell */
  need: Float32Array; len: Float32Array; parent: Int32Array;
  /** the same with movable furniture out of the way: whether moving it would open a part */
  free: Float32Array; freeParent: Int32Array;
  /** per blocked cell: who blocks it (OWN_* / object index / DOOR0 + door index) */
  owner: Int32Array;
  /** 1: unscanned floor next to scanned floor (a hole in the scan) */
  grey: Uint8Array;
  /** 1: floor not measured directly (low coverage, under furniture as filmed, a carved opening = designed) */
  hatch: Uint8Array;
}

/** Everything about this layout that doesn't depend on the device width. The worker caches it per layout. */
export function reachField(S: ReachInit, lay: Layout, start: XY, snapHalf = 0): ReachField {
  const { g } = S, [nx, ny] = g.shape, N = nx * ny, cell = g.cell_m;
  const carved = carvedPolys(lay), L = stamp(g, S.base, S.objects, lay.poses, lay.flattened, carved);
  const owner = new Int32Array(N).fill(OWN_FREE), blocked = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (L.obst[k] || !L.floor[k]) { blocked[k] = 1; owner[k] = L.obst[k] ? OWN_WALL : OWN_UNSEEN; }
  S.objects.forEach((o, k) => {
    if (lay.poses[k].removed || o.layer !== 'obstacle') return;
    for (const c of polyCells(g, worldFootprint(o, lay.poses[k]))) owner[c] = k;
  });
  // with movable furniture out of the way (what moving it would open): the same layers minus those objects
  const away = stamp(g, S.base, S.objects, lay.poses.map((p, k) => (isMovable(S.objects[k]) ? { ...p, removed: true } : p)), lay.flattened, carved);
  const blockedFree = new Uint8Array(N);
  for (let k = 0; k < N; k++) blockedFree[k] = away.obst[k] || !away.floor[k] ? 1 : 0;
  // a marked doorway counts at its marked width, even where the scan's gap is wider (jamb stops, a hinge side)
  (S.doors ?? []).forEach((d, n) => {
    const { jamb, band } = doorCells(g, d, lay);
    for (const c of jamb) { blocked[c] = 1; blockedFree[c] = 1; owner[c] = DOOR0 + n; }
    for (const c of band) if (owner[c] === OWN_WALL) owner[c] = DOOR0 + n;
  });
  const dist = edt(blocked, nx, ny), free0 = edt(blockedFree, nx, ny);
  for (let k = 0; k < N; k++) { dist[k] *= cell; free0[k] *= cell; }
  const zone = startZone(g, dist, start, snapHalf);
  const W = widest(nx, ny, cell, dist, zone), F = widest(nx, ny, cell, free0, zone.filter(z => free0[z] > 0));

  const cov = S.coverage, good = S.coverage_good ?? 1, low = (k: number) => !!cov && cov[k] < good;
  const hatch = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (!blocked[k] && low(k)) hatch[k] = 1;
  S.objects.forEach(o => {   // floor under furniture as filmed: assumed, nobody saw it
    if (o.layer === 'none') return;
    for (const c of polyCells(g, worldFootprint(o, { x: o.pivot[0], y: o.pivot[1], yaw: 0 }))) if (!blocked[c]) hatch[c] = 1;
  });
  for (const poly of carved) for (const c of polyCells(g, poly)) hatch[c] = 1;   // designed, not built
  return { g, start, zone, dist, need: W.need, len: W.len, parent: W.parent, free: F.need, freeParent: F.parent, owner, grey: greyCells(g, L, cov, good), hatch };
}

/** The start: cells within zone_m of it (through open floor), plus the planner's own snap for this width, so a start
 *  squeezed beside the bed is where the planner would stand too. */
function startZone(g: GridMeta, dist: Float32Array, start: XY, snapHalf: number): number[] {
  const [nx, ny] = g.shape, cell = g.cell_m, [ci, cj] = toCell(g, start);
  let s = -1, bd = Infinity, snap = -1, sd = Infinity;
  for (let k = 0; k < nx * ny; k++) {
    if (dist[k] <= 0) continue;
    const d = ((k / ny) | 0) - ci, e = (k % ny) - cj, r = d * d + e * e;
    if (r < bd) { bd = r; s = k; }
    if (dist[k] > snapHalf && r < sd) { sd = r; snap = k; }
  }
  if (s < 0) return [];
  const zone = [s], seen = new Set([s]), maxR = (REACH.zone_m / cell) ** 2, [si, sj] = [(s / ny) | 0, s % ny];
  for (let q = 0; q < zone.length; q++) forNeighbours(nx, ny, zone[q], n => {
    if (seen.has(n) || dist[n] <= 0) return;
    const d = ((n / ny) | 0) - si, e = (n % ny) - sj;
    if (d * d + e * e > maxR) return;
    seen.add(n); zone.push(n);
  });
  if (snap >= 0 && !seen.has(snap)) zone.push(snap);
  return zone;
}

/** Holes in the scan: unscanned patches (no floor, no obstacle, too few cameras) of at least grey_min_m2 with scanned
 *  floor or walls all round. Unscanned space that runs off the grid is outside the home (a thin wall has gaps), not a hole. */
function greyCells(g: GridMeta, L: Layers, cov: Uint8Array | undefined, good: number): Uint8Array {
  const [nx, ny] = g.shape, out = new Uint8Array(nx * ny), minCells = REACH.grey_min_m2 / g.cell_m ** 2;
  const edge = (k: number) => { const i = (k / ny) | 0, j = k - i * ny; return i === 0 || j === 0 || i === nx - 1 || j === ny - 1; };
  for (const comp of components(nx, ny, k => !L.floor[k] && !L.obst[k] && (!cov || cov[k] < good)))
    if (comp.length >= minCells && !comp.some(edge)) for (const k of comp) out[k] = 1;
  return out;
}

/** 8-connected components of the cells where `inside` holds. */
function components(nx: number, ny: number, inside: (k: number) => boolean): number[][] {
  const seen = new Uint8Array(nx * ny), out: number[][] = [];
  for (let k = 0; k < nx * ny; k++) {
    if (seen[k] || !inside(k)) continue;
    const comp = [k];
    seen[k] = 1;
    for (let h = 0; h < comp.length; h++) forNeighbours(nx, ny, comp[h], n => { if (!seen[n] && inside(n)) { seen[n] = 1; comp.push(n); } });
    out.push(comp);
  }
  return out;
}

/** Who the device is and how much room counts as enough: the door check's numbers (doors.ts, evaluate.ts). */
export interface ReachOpts { width_m: number; clearance_m: number; margin_m: number; wheelchair: boolean }
export function thresholds(o: ReachOpts) {
  const need_w = Math.max(needWidth(o.width_m, o.clearance_m), o.wheelchair ? ADA.door_clear_m : 0), e = Math.max(o.margin_m, 0.02);
  return { half: o.width_m / 2, ok: need_w / 2 + e / 2, need_w, e };
}
export const CLS = { none: 0, ok: 1, tight: 2, cut: 3, grey: 4 } as const;

/** One class per cell for this width: where the device's centre can be, how wide the way in is. The band along every
 *  wall is narrower than the clearance by definition, so it takes the class of the open floor beside it; only a tight
 *  way IN makes a part amber. */
export function paintClasses(f: Pick<ReachField, 'g' | 'dist' | 'need' | 'grey'>, th: ReturnType<typeof thresholds>): Uint8Array {
  const [nx, ny] = f.g.shape, N = nx * ny, cls = new Uint8Array(N), depth = new Int16Array(N).fill(-1), q: number[] = [];
  for (let k = 0; k < N; k++) {
    if (f.grey[k]) cls[k] = CLS.grey;
    else if (f.dist[k] > th.half) {
      const need = f.need[k];
      cls[k] = need >= th.ok ? CLS.ok : need > th.half ? CLS.tight : CLS.cut;
      if (cls[k] === CLS.ok) { depth[k] = 0; q.push(k); }
    }
  }
  const maxD = Math.ceil((th.ok - th.half) / f.g.cell_m) + 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (depth[c] >= maxD) continue;
    forNeighbours(nx, ny, c, n => { if (depth[n] < 0 && cls[n] === CLS.tight) { cls[n] = CLS.ok; depth[n] = depth[c] + 1; q.push(n); } });
  }
  return cls;
}

export interface Cause { kind: 'door' | 'object' | 'unscanned' | 'structure'; name?: string; movable?: boolean; clear_m?: number }
export interface ReachTarget { name: string; at: XY; kind: 'goal' | 'point' | 'corner' | 'region' }
export interface TargetOut extends ReachTarget {
  status: 'ok' | 'tight' | 'cut' | 'no_room';
  /** clear width on the widest way in (2 x need), or the room at the spot itself when the device doesn't fit there */
  width_m: number;
  pinch?: { at: XY; width_m: number }; cause?: Cause;
  /** the ghost's way from the start, every ghost_step_m, up to where it stops */
  path: XY[]; path_m: number; stopped: boolean;
  /** the way exists only with movable furniture out of the way (checked: the free field gets there) */
  opens_if_moved?: boolean;
}
export interface Region { at: XY; area_m2: number; width_m: number; pinch?: { at: XY; width_m: number }; cause: Cause; opens_if_moved: boolean }
export interface Pocket { at: XY; area_m2: number; reverse_m: number; closed_by?: Cause }
export interface ReachReport {
  width_m: number; need_w_m: number; start: XY;
  areas: { ok: number; tight: number; cut: number; grey: number };
  regions: Region[]; pockets: Pocket[] | null; targets: TargetOut[];
}

/** The way to cell k, start first. */
function chain(parent: Int32Array, k: number): number[] {
  const out: number[] = [];
  for (let c = k; c >= 0 && out.length < 1e6; c = parent[c]) out.push(c);
  return out.reverse();
}

/** What blocks the cells around cell k (within its clearance + 2 cells): movable furniture first (cheapest to change,
 *  and only when moving it really opens the way), then a marked doorway, fixed furniture, a gap in the scan, a wall. */
function causeAt(S: ReachInit, f: ReachField, lay: Layout, k: number, allowMovable = true): Cause {
  const { g } = f, [nx, ny] = g.shape, i0 = (k / ny) | 0, j0 = k % ny, R = Math.ceil(f.dist[k] / g.cell_m) + 2;
  let obj = -1, objD = Infinity, fixed = -1, fixedD = Infinity, door = -1, unseen = 0, wall = 0;
  for (let i = Math.max(0, i0 - R); i <= Math.min(nx - 1, i0 + R); i++) for (let j = Math.max(0, j0 - R); j <= Math.min(ny - 1, j0 + R); j++) {
    const r = (i - i0) ** 2 + (j - j0) ** 2, o = f.owner[i * ny + j];
    if (r > R * R || o === OWN_FREE) continue;
    if (o >= DOOR0) door = o - DOOR0;
    else if (o >= 0) {
      if (isMovable(S.objects[o])) { if (r < objD) { objD = r; obj = o; } }
      else if (r < fixedD) { fixedD = r; fixed = o; }
    } else if (o === OWN_UNSEEN) unseen++;
    else wall++;
  }
  if (allowMovable && obj >= 0) return { kind: 'object', name: S.objects[obj].name, movable: true };
  if (door >= 0) { const d = S.doors![door]; return { kind: 'door', name: d.name, clear_m: doorCells(g, d, lay).clear_m }; }
  if (fixed >= 0) return { kind: 'object', name: S.objects[fixed].name, movable: false };
  return unseen > wall ? { kind: 'unscanned' } : { kind: 'structure' };
}

/** Why cell k can't be reached at this width, and the way the ghost takes until it stops. */
function explain(S: ReachInit, f: ReachField, lay: Layout, th: ReturnType<typeof thresholds>, k: number) {
  const stopAt = (cells: number[]) => { const n = cells.findIndex(c => f.dist[c] <= th.half); return n < 0 ? cells : cells.slice(0, n); };
  const narrowest = (cells: number[]) => cells.reduce((p, c) => (f.dist[c] < f.dist[p] ? c : p), cells[0]);
  if (f.need[k] > th.half) {   // it gets there: tight or not, the narrowest spot on the way names why
    const way = chain(f.parent, k), p = narrowest(way);
    return { way, pinch: p, cause: f.need[k] >= th.ok ? undefined : causeAt(S, f, lay, p), opens_if_moved: false };
  }
  if (f.free[k] > th.half) {   // only furniture closes it (checked: with it out of the way the device gets there): up to the piece
    const way = chain(f.freeParent, k), cut = stopAt(way), b = way[cut.length] ?? k;
    return { way: cut, pinch: b, cause: causeAt(S, f, lay, b), opens_if_moved: true };
  }
  if (f.need[k] > 1.5 * f.g.cell_m) {   // a way in the scan, too narrow for this device even with the furniture moved
    const way = chain(f.parent, k), p = narrowest(way);
    return { way: stopAt(way), pinch: p, cause: causeAt(S, f, lay, p, false), opens_if_moved: false };
  }
  return { way: [] as number[], pinch: -1, cause: causeAt(S, f, lay, k, false), opens_if_moved: false };   // no way in on the scan
}

/** Cells along a way, one every ghost_step_m (the ghost's dots). */
function sample(g: GridMeta, cells: number[]): { path: XY[]; path_m: number } {
  const path: XY[] = [];
  let len = 0, since = Infinity, prev: XY | null = null;
  for (const c of cells) {
    const p = cellXY(g, c);
    if (prev) { const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]); len += d; since += d; }
    if (since >= REACH.ghost_step_m) { path.push(p); since = 0; }
    prev = p;
  }
  if (prev && path[path.length - 1] !== prev) path.push(prev);
  return { path, path_m: len };
}

/** The report for one width: areas, cut-off parts and their causes, dead ends (wheelchair), every target's status and way. */
export function analyze(S: ReachInit, f: ReachField, lay: Layout, o: ReachOpts, targets: ReachTarget[], cls = paintClasses(f, thresholds(o))): ReachReport {
  const { g } = f, [nx, ny] = g.shape, N = nx * ny, a = g.cell_m ** 2, th = thresholds(o);
  const areas = { ok: 0, tight: 0, cut: 0, grey: 0 };
  for (let k = 0; k < N; k++) {
    const c = cls[k];
    if (c === CLS.ok) areas.ok += a; else if (c === CLS.tight) areas.tight += a; else if (c === CLS.cut) areas.cut += a; else if (c === CLS.grey) areas.grey += a;
  }
  const xy = (k: number) => cellXY(g, k), pinchOf = (k: number) => (k >= 0 ? { at: xy(k), width_m: 2 * f.dist[k] } : undefined);

  // cut-off parts: aim at the widest spot inside (where a way would come in), name what closes the way
  const regions: Region[] = [];
  for (const comp of components(nx, ny, k => cls[k] === CLS.cut)) {
    if (comp.length * a < REACH.region_min_m2) continue;
    let best = comp[0];
    for (const c of comp) if (f.need[c] > f.need[best] || (f.need[c] === f.need[best] && f.len[c] < f.len[best])) best = c;
    const e = explain(S, f, lay, th, best);
    regions.push({ at: xy(best), area_m2: comp.length * a, width_m: 2 * f.need[best], pinch: pinchOf(e.pinch), cause: e.cause ?? { kind: 'structure' }, opens_if_moved: e.opens_if_moved });
  }
  regions.sort((p, q) => q.area_m2 - p.area_m2);

  // corners: the far ends of each sizeable floor area (4 diagonals), so the ghosts reach into the room's corners
  const all: ReachTarget[] = [...targets, ...regions.map((r, n) => ({ name: `cut-off part ${n + 1}`, at: r.at, kind: 'region' as const }))];
  const floorComps = components(nx, ny, k => cls[k] >= CLS.ok && cls[k] <= CLS.cut).filter(c => c.length * a >= REACH.corner_min_m2)
    .sort((p, q) => q.length - p.length).slice(0, 3);
  let nc = 0;
  for (const comp of floorComps) for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let best = comp[0], bv = -Infinity;
    for (const c of comp) { const [x, y] = xy(c), v = sx * x + sy * y; if (v > bv) { bv = v; best = c; } }
    const at = xy(best);
    if (all.some(t => Math.hypot(t.at[0] - at[0], t.at[1] - at[1]) < 0.5)) continue;
    all.push({ name: `corner ${++nc}`, at, kind: 'corner' });
  }

  const out: TargetOut[] = all.map(t => {
    // the device's centre has to fit at the spot: the nearest cell with room, within target_snap_m
    const [ci, cj] = toCell(g, t.at), R = Math.round(REACH.target_snap_m / g.cell_m);
    let k = -1, bd = Infinity, room = 0;
    for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) for (let j = Math.max(0, cj - R); j <= Math.min(ny - 1, cj + R); j++) {
      const c = i * ny + j, r = (i - ci) ** 2 + (j - cj) ** 2;
      if (r > R * R) continue;
      if (r * 4 <= R * R) room = Math.max(room, f.dist[c]);
      if (f.dist[c] > th.half && cls[c] !== CLS.grey && r < bd) { bd = r; k = c; }
    }
    if (k < 0) return { ...t, status: 'no_room' as const, width_m: 2 * room, path: [], path_m: 0, stopped: true };
    const c = cls[k], status = c === CLS.ok ? 'ok' as const : c === CLS.tight ? 'tight' as const : 'cut' as const;
    const e = explain(S, f, lay, th, k), s = sample(g, e.way);
    return { ...t, status, width_m: 2 * f.need[k], pinch: status === 'ok' ? undefined : pinchOf(e.pinch), cause: status === 'ok' ? undefined : e.cause,
      path: s.path, path_m: s.path_m, stopped: status === 'cut', ...(status === 'cut' ? { opens_if_moved: e.opens_if_moved } : {}) };
  });
  return { width_m: o.width_m, need_w_m: th.need_w, start: f.start, areas, regions, pockets: o.wheelchair ? pockets(S, f, lay, cls) : null, targets: out };
}

/** A wheelchair's dead ends: reachable floor more than pocket_m from any ADA turning circle, with one way in. A hallway
 *  between two rooms has two ways out and is not one. Measured only for a wheelchair: ADA 304.3 gives its turning
 *  space; for a walker it would be a guess. */
function pockets(S: ReachInit, f: ReachField, lay: Layout, cls: Uint8Array): Pocket[] {
  const { g } = f, [nx, ny] = g.shape, N = nx * ny, a = g.cell_m ** 2, r = ADA.turn_d_m / 2;
  const reach = (k: number) => cls[k] === CLS.ok || cls[k] === CLS.tight;
  const toTurn = new Float32Array(N).fill(Infinity), h = new CellHeap(N);
  for (let k = 0; k < N; k++) if (reach(k) && f.dist[k] >= r) { toTurn[k] = 0; h.push(k, 0); }
  while (h.n) {
    const c = h.pop();
    forNeighbours(nx, ny, c, (n, step) => {
      if (!reach(n) || h.done(n)) return;
      const d = toTurn[c] + step * g.cell_m;
      if (d < toTurn[n]) { toTurn[n] = d; h.push(n, d); }
    });
  }
  const P = (k: number) => reach(k) && toTurn[k] > REACH.pocket_m, out: Pocket[] = [];
  const inComp = new Int32Array(N).fill(-1);
  components(nx, ny, P).forEach((comp, id) => {
    if (comp.length * a < REACH.pocket_min_m2) return;
    for (const c of comp) inComp[c] = id;
    // the ways out: reachable floor next to the pocket, grouped; two groups or more is a through-way
    const exit = new Set<number>();
    for (const c of comp) forNeighbours(nx, ny, c, n => { if (inComp[n] !== id && reach(n)) exit.add(n); });
    let groups = 0;
    const left = new Set(exit);
    for (const s of exit) {
      if (!left.has(s)) continue;
      groups++; left.delete(s);
      for (let q = [s], h = 0; h < q.length; h++) forNeighbours(nx, ny, q[h], n => { if (left.has(n)) { left.delete(n); q.push(n); } });
    }
    if (groups > 1) return;
    let deep = comp[0];
    for (const c of comp) if (toTurn[c] > toTurn[deep]) deep = c;
    const by = causeAt(S, f, lay, deep);
    out.push({ at: cellXY(g, deep), area_m2: comp.length * a, reverse_m: toTurn[deep], closed_by: by.kind === 'structure' ? undefined : by });
  });
  return out.sort((p, q) => q.area_m2 - p.area_m2);
}

/** "the bathroom door (61 cm clear)", "the chair (movable)", ... */
export function causeText(c: Cause | undefined): string {
  if (!c) return '';
  if (c.kind === 'door') return `the ${c.name}${c.clear_m ? ` (${Math.round(c.clear_m * 100)} cm clear)` : ''}`;
  if (c.kind === 'object') return `the ${c.name}${c.movable ? ' (movable)' : ''}`;
  return c.kind === 'unscanned' ? 'a gap in the scan (rescan to check)' : 'a wall or a fixed part of the room';
}

/** What it costs to get through this doorway at each device width: nothing if it's wide enough already, else the cheapest
 *  configured door fix that opens it to the device plus clearance (doors.ts). Prices are movecost.ts's (placeholders until
 *  the effort model lands). */
export interface CostStep { width_m: number; usd: number | null; label: string; id?: string; source: string }
export function costToReach(d: Door, widths: number[], o: Omit<ReachOpts, 'width_m'> & { gain_m?: number; leafObject?: boolean }): CostStep[] {
  const F = doorFrame(d);
  return widths.map(w => {
    const th = thresholds({ ...o, width_m: w }), need = 2 * th.ok;
    if (F.width + (o.gain_m ?? 0) >= need) return { width_m: w, usd: 0, label: 'wide enough as it is', source: 'measured' };
    const opts = doorFixes(d, need, { leafObject: o.leafObject }).filter((iv: Intervention) => F.width + (iv.by_m ?? 0) >= need)
      .map(iv => ({ iv, c: fixCost(iv) })).sort((p, q) => p.c.usd - q.c.usd);
    // one label per fix, not per width ("Widen ... to 92 cm clear" is sized to this width): the runs group on it
    return opts.length ? { width_m: w, usd: opts[0].c.usd, label: opts[0].iv.label.replace(/ to \d+ cm clear$/, ''), id: opts[0].iv.id, source: opts[0].c.source }
      : { width_m: w, usd: null, label: 'no configured fix opens it this wide', source: '' };
  });
}
/** Moving a piece of furniture out of the way (labour only): movecost.ts, a metre's move. */
export const moveOutCost = (o: { kind: string }) => moveCost(o, { x: 0, y: 0, yaw: 0 }, { x: 1, y: 0, yaw: 0 });

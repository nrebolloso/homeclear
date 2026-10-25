// Occupancy grids, live object stamping, distance field, A* and route hazards. Pure functions (node --test + worker).
// Ports of stages/06-08: same cell convention (cell (i,j) spans origin + (i,j)*cell), same planner cost, same rules.

export type XY = [number, number];
export interface GridMeta { origin_xy: XY; cell_m: number; shape: [number, number] }
export interface Layers { floor: Uint8Array; obst: Uint8Array; bump: Float32Array }
export interface Footprinted { footprint: XY[]; pivot: number[]; layer: 'obstacle' | 'bump' | 'none'; height_m: number }
export interface Pose { x: number; y: number; yaw: number; removed?: boolean }
export interface PlanParams {
  walker_width_m: number; preferred_clearance_m: number; clearance_weight: number;
  /** extra cost (metres of walking) per 90 degrees of turning: > 0 plans with heading (8 directions), e.g. freezing of
   *  gait at turns. 0 / absent = the plain planner, identical to stage 7. */
  turn_weight_m?: number;
  /** cost multiplier on cells with less than narrow_m to spare each side (doorways): freezing of gait. */
  narrow_weight?: number; narrow_m?: number;
}
export interface Plan {
  cells: number[]; xy: XY[]; side: number[]; length_m: number; error?: string;
  min_side_clearance_m?: number; dist_m: Float32Array;
}
export interface RouteHazard {
  type: 'tight_clearance' | 'floor_bump'; a: number; b: number; position: XY; length_m: number;
  min_side_clearance_m?: number; height_m?: number; comp?: number;
}

export const toCell = (g: GridMeta, p: XY): [number, number] => [
  Math.min(g.shape[0] - 1, Math.max(0, Math.floor((p[0] - g.origin_xy[0]) / g.cell_m))),
  Math.min(g.shape[1] - 1, Math.max(0, Math.floor((p[1] - g.origin_xy[1]) / g.cell_m)))];
export const cellXY = (g: GridMeta, k: number): XY => {
  const ny = g.shape[1];
  return [g.origin_xy[0] + (Math.floor(k / ny) + 0.5) * g.cell_m, g.origin_xy[1] + ((k % ny) + 0.5) * g.cell_m];
};

/** Object footprint (object-local, around its pivot) placed at a pose, in floor-frame metres. */
export function worldFootprint(o: Footprinted, p: Pose): XY[] {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return o.footprint.map(([u, v]) => [p.x + c * u - s * v, p.y + s * u + c * v] as XY);
}

function insidePoly(poly: XY[], x: number, y: number): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/** Flat indices of the cells whose centres fall inside a floor-frame polygon. */
export function polyCells(g: GridMeta, poly: XY[]): number[] {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const [i0, j0] = toCell(g, [Math.min(...xs), Math.min(...ys)]), [i1, j1] = toCell(g, [Math.max(...xs), Math.max(...ys)]);
  const out: number[] = [];
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const [x, y] = cellXY(g, i * g.shape[1] + j);
      if (insidePoly(poly, x, y)) out.push(i * g.shape[1] + j);
    }
  return out;
}

/** Base layers (movables cut out), wall carved where a doorway is widened, + movables stamped at their current poses +
 *  flattened boxes. Carving comes first: it opens the wall, not furniture standing in the new opening. */
export function stamp(g: GridMeta, base: Layers, objs: Footprinted[], poses: Pose[], flattened: [XY, XY][] = [], carved: XY[][] = []): Layers {
  const L = { floor: base.floor.slice(), obst: base.obst.slice(), bump: base.bump.slice() };
  for (const poly of carved) for (const c of polyCells(g, poly)) { L.obst[c] = 0; L.floor[c] = 1; }   // designed, not measured: doors.ts
  objs.forEach((o, k) => {
    if (poses[k].removed || o.layer === 'none') return;
    for (const c of polyCells(g, worldFootprint(o, poses[k]))) {
      if (o.layer === 'obstacle') L.obst[c] = 1;
      else L.bump[c] = Math.max(L.bump[c], o.height_m);
    }
  });
  for (const [[x0, y0], [x1, y1]] of flattened)
    for (const c of polyCells(g, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])) L.bump[c] = 0;
  return L;
}

/** Can this object sit here? Every footprint cell must be floor with no static/other obstacle (bumps may overlap). */
export function placementOk(g: GridMeta, base: Layers, objs: Footprinted[], poses: Pose[], k: number, overlapOk: Set<number> = new Set()): boolean {
  if (objs[k].layer === 'none') return polyCells(g, worldFootprint(objs[k], poses[k])).every(c => base.floor[c] && !base.obst[c]);
  const others = stamp(g, base, objs, poses.map((p, n) => (n === k || overlapOk.has(n) || objs[n].layer !== 'obstacle' ? { ...p, removed: true } : p)));
  const cells = polyCells(g, worldFootprint(objs[k], poses[k]));
  return cells.length > 0 && cells.every(c => others.floor[c] && !others.obst[c]);
}

/** Exact Euclidean distance (in cells) from each cell to the nearest blocked cell (Felzenszwalb & Huttenlocher). */
export function edt(blocked: Uint8Array, nx: number, ny: number): Float32Array {
  const INF = 1e20, f = new Float64Array(nx * ny);
  for (let k = 0; k < f.length; k++) f[k] = blocked[k] ? 0 : INF;
  const n = Math.max(nx, ny), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1), tmp = new Float64Array(n);
  const pass = (len: number, get: (q: number) => number, set: (q: number, x: number) => void) => {
    for (let q = 0; q < len; q++) tmp[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (tmp[q] + q * q - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (tmp[q] + q * q - (tmp[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + tmp[v[k]]; }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let i = 0; i < nx; i++) pass(ny, q => f[i * ny + q], (q, x) => { f[i * ny + q] = x; });
  for (let j = 0; j < ny; j++) pass(nx, q => f[q * ny + j], (q, x) => { f[q * ny + j] = x; });
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = Math.sqrt(f[k]);
  return out;
}

/** Min-heap of (priority, cell) for A*. */
class Heap {
  p: number[] = []; c: number[] = [];
  push(p: number, c: number) {
    let i = this.p.length; this.p.push(p); this.c.push(c);
    while (i > 0) { const u = (i - 1) >> 1; if (this.p[u] <= p) break; this.p[i] = this.p[u]; this.c[i] = this.c[u]; i = u; }
    this.p[i] = p; this.c[i] = c;
  }
  pop(): number {
    const top = this.c[0], lp = this.p.pop()!, lc = this.c.pop()!, n = this.p.length;
    if (n) {
      let i = 0;
      for (;;) {
        let m = 2 * i + 1; if (m >= n) break;
        if (m + 1 < n && this.p[m + 1] < this.p[m]) m++;
        if (this.p[m] >= lp) break;
        this.p[i] = this.p[m]; this.c[i] = this.c[m]; i = m;
      }
      this.p[i] = lp; this.c[i] = lc;
    }
    return top;
  }
  get size() { return this.p.length; }
}

/** Stage 7: obstacles inflated by half the walker width, cost prefers clearance; start/goal snap to the nearest free cell. */
export function plan(g: GridMeta, L: Layers, start: XY, goal: XY, pp: PlanParams): Plan {
  const [nx, ny] = g.shape, N = nx * ny, cell = g.cell_m;
  const blocked = new Uint8Array(N);
  for (let k = 0; k < N; k++) blocked[k] = L.obst[k] || !L.floor[k] ? 1 : 0;
  const dist = edt(blocked, nx, ny);
  for (let k = 0; k < N; k++) dist[k] *= cell;
  const half = pp.walker_width_m / 2, pref = pp.preferred_clearance_m;
  const free = (k: number) => dist[k] > half;
  const snap = (p: XY) => {
    const [ci, cj] = toCell(g, p);
    let best = -1, bd = Infinity;
    for (let k = 0; k < N; k++) if (free(k)) {
      const d = (Math.floor(k / ny) - ci) ** 2 + ((k % ny) - cj) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };
  const empty = { cells: [], xy: [], side: [], length_m: 0, dist_m: dist };
  const s = snap(start), t = snap(goal);
  if (s < 0) return { ...empty, error: `no cell has ${half} m clearance; walker cannot fit anywhere` };
  const narrowW = pp.narrow_weight ?? 0, narrowM = pp.narrow_m ?? 0.15;
  const stepCost = (n: number, len: number) => {
    const sd = dist[n] - half;
    return len * (1 + pp.clearance_weight * Math.max(pref - sd, 0) / pref + (narrowW && sd < narrowM ? narrowW : 0));
  };
  if (pp.turn_weight_m) return planHeading(g, dist, free, s, t, stepCost, pp.turn_weight_m / 2 / cell, half, empty);
  const ti = Math.floor(t / ny), tj = t % ny;
  const h = (k: number) => Math.hypot(Math.floor(k / ny) - ti, (k % ny) - tj);
  const gs = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap = new Heap();
  gs[s] = 0; heap.push(h(s), s);
  while (heap.size) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === t) break;
    const ci = Math.floor(c / ny), cj = c % ny;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const n = i * ny + j;
      if (!free(n) || done[n]) continue;
      const ng = gs[c] + stepCost(n, Math.hypot(di, dj));
      if (ng < gs[n]) { gs[n] = ng; prev[n] = c; heap.push(ng + h(n), n); }
    }
  }
  if (!done[t]) return { ...empty, error: 'no path: start and goal not connected for this walker width' };
  const cells: number[] = [];
  for (let c = t; c >= 0; c = prev[c]) cells.push(c);
  cells.reverse();
  return finishPlan(g, cells, dist, half);
}

function finishPlan(g: GridMeta, cells: number[], dist: Float32Array, half: number): Plan {
  const xy = cells.map(c => cellXY(g, c));
  const side = cells.map(c => dist[c] - half);
  let length_m = 0;
  for (let k = 1; k < xy.length; k++) length_m += Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]);
  return { cells, xy, side, length_m, min_side_clearance_m: Math.min(...side), dist_m: dist };
}

const DIRS: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** A* over (cell, heading): each 45 degrees of change costs turnCells. Any start heading is free. */
function planHeading(g: GridMeta, dist: Float32Array, free: (k: number) => boolean, s: number, t: number,
                     stepCost: (n: number, len: number) => number, turnCells: number, half: number, empty: Plan): Plan {
  const [nx, ny] = g.shape, N = nx * ny * 8, ti = Math.floor(t / ny), tj = t % ny;
  const h = (k: number) => Math.hypot(Math.floor(k / ny) - ti, (k % ny) - tj);
  const gs = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N), heap = new Heap();
  for (let d = 0; d < 8; d++) { gs[s * 8 + d] = 0; heap.push(h(s), s * 8 + d); }
  let goal = -1;
  while (heap.size) {
    const st = heap.pop();
    if (done[st]) continue;
    done[st] = 1;
    const c = st >> 3, d0 = st & 7;
    if (c === t) { goal = st; break; }
    const ci = Math.floor(c / ny), cj = c % ny;
    for (let d = 0; d < 8; d++) {
      const turn = Math.min((d - d0 + 8) % 8, (d0 - d + 8) % 8);
      if (turn > 2) continue;   // no turning on the spot by more than 90 degrees in one step
      const i = ci + DIRS[d][0], j = cj + DIRS[d][1];
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const n = i * ny + j, ns = n * 8 + d;
      if (!free(n) || done[ns]) continue;
      const ng = gs[st] + stepCost(n, Math.hypot(DIRS[d][0], DIRS[d][1])) + turn * turnCells;
      if (ng < gs[ns]) { gs[ns] = ng; prev[ns] = st; heap.push(ng + h(n), ns); }
    }
  }
  if (goal < 0) return { ...empty, error: 'no path: start and goal not connected for this walker width' };
  const cells: number[] = [];
  for (let st = goal; st >= 0; st = prev[st]) cells.push(st >> 3);
  cells.reverse();
  return finishPlan(g, cells, dist, half);
}

/** Connected components (8-way) of bump cells: one id per rug/threshold/cable, 0 = none. */
/** Bump patches: cells up to `link` cells apart (Chebyshev) are one patch, so a fragmented real rug is one hazard (stage 6 matches). */
export function bumpComponents(g: GridMeta, bump: Float32Array, minH: number, link = 1): Int32Array {
  const [nx, ny] = g.shape, lab = new Int32Array(nx * ny);
  let n = 0;
  for (let k0 = 0; k0 < lab.length; k0++) {
    if (bump[k0] < minH || lab[k0]) continue;
    lab[k0] = ++n;
    const stack = [k0];
    while (stack.length) {
      const c = stack.pop()!, ci = Math.floor(c / ny), cj = c % ny;
      for (let di = -link; di <= link; di++) for (let dj = -link; dj <= link; dj++) {
        const i = ci + di, j = cj + dj, k = i * ny + j;
        if (i >= 0 && j >= 0 && i < nx && j < ny && !lab[k] && bump[k] >= minH) { lab[k] = n; stack.push(k); }
      }
    }
  }
  return lab;
}

/** Stage 8 on a live plan: runs of side clearance < margin, and runs where the walker's width crosses a bump. */
export function routeHazards(g: GridMeta, L: Layers, P: Plan, walkerWidth: number, margin: number, bumpMin: number, comps: Int32Array): RouteHazard[] {
  const ny = g.shape[1], r = Math.ceil(walkerWidth / 2 / g.cell_m);
  const under = P.cells.map(c => {
    const ci = Math.floor(c / ny), cj = c % ny;
    let best = 0, comp = 0;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (di * di + dj * dj > r * r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= g.shape[0] || j >= ny) continue;
      const h = L.bump[i * ny + j];
      if (h >= bumpMin && h > best) { best = h; comp = comps[i * ny + j]; }
    }
    return [best, comp];
  });
  const out: RouteHazard[] = [];
  const runs = (key: (k: number) => number, make: (a: number, b: number) => RouteHazard) => {  // runs of equal non-zero key
    for (let a = 0; a < P.cells.length;) {
      const v = key(a);
      if (!v) { a++; continue; }
      let b = a; while (b < P.cells.length && key(b) === v) b++;
      out.push(make(a, b)); a = b;
    }
  };
  const len = (a: number, b: number) => {
    let s = 0;
    for (let k = a + 1; k <= Math.min(b, P.xy.length - 1); k++) s += Math.hypot(P.xy[k][0] - P.xy[k - 1][0], P.xy[k][1] - P.xy[k - 1][1]);
    return s;
  };
  runs(k => +(P.side[k] < margin), (a, b) => {
    let m = a; for (let k = a; k < b; k++) if (P.side[k] < P.side[m]) m = k;
    return { type: 'tight_clearance', a, b, position: P.xy[m], length_m: len(a, b), min_side_clearance_m: P.side[m] };
  });
  // one hazard per bump component crossed (a rug and a cable right after it are two hazards)
  runs(k => (under[k][0] > 0 ? under[k][1] || -1 : 0), (a, b) => {
    let m = a; for (let k = a; k < b; k++) if (under[k][0] > under[m][0]) m = k;
    return { type: 'floor_bump', a, b, position: P.xy[Math.floor((a + b) / 2)], length_m: len(a, b), height_m: under[m][0], comp: under[m][1] };
  });
  return out;
}

export interface Intervention {
  id: string; label: string; kind: 'remove' | 'move' | 'flatten' | 'raise' | 'add' | 'carve'; object?: string; to?: number[]; box_xy?: [XY, XY];
  /** carve: wall cells in poly_xy become floor (a widened doorway, doors.ts); one carve per target (the door's name) */
  poly_xy?: XY[];
  /** raise: a seat/bed/toilet surface (object or fixture name) goes up by by_m (raised toilet seat, bed risers) */
  target?: string; by_m?: number;
  /** add: a new fixture (a touch lamp on the nightstand = a switch within reach); checks treat it like a marked one */
  fixture?: { name: string; kind: string; attach?: string; xyz?: number[]; side?: 'left' | 'right'; yaw?: number; surface_m?: number;
    /** a light source: the simulation counts floor within this radius as lit (lights.ts) */
    light_r?: number };
  /** what it takes (fix card, optimizer effort): dollars, minutes, 1 (anyone) .. 5 (two people, heavy furniture) */
  cost_usd?: number; minutes?: number; effort?: number; product?: string;
}
export interface Layout {
  poses: Pose[]; flattened: [XY, XY][];
  /** surface raises by object/fixture name (m), and ids of 'add' fixes in place: no footprint, checks only */
  raised?: Record<string, number>; added?: string[];
  /** carve fixes in place: which fix, on which door (target), the wall it opens, and how much wider the opening gets */
  carved?: { id: string; target: string; poly: XY[]; by_m: number }[];
  /** added fixtures moved by hand (the second walker on the landing), by fix id; else they stand where the fix puts them */
  placed?: Record<string, Pose>;
  /** rug corners folded by a walker pass (rugcascade.ts): a taller bump than the flat rug, until the layout changes */
  folds?: Fold[];
  /** glide caps / tennis balls on the walker's rear legs (planner fix): scales the rug's slide / fold events (evaluate.ts) */
  walker_caps?: boolean;
}
/** A folded rug corner: lifted lift_m within size_m of the corner (the same shape the futures fan draws). */
export interface Fold { corner: XY; lift_m: number; size_m: number }
/** The folds raise the bump map in place; returns the cells they cover. */
export function stampFolds(g: GridMeta, bump: Float32Array, folds: Fold[] = []): number[] {
  const out: number[] = [];
  for (const f of folds) {
    const r = f.size_m, [x, y] = f.corner;
    for (const c of polyCells(g, [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]])) {
      const [cx, cy] = cellXY(g, c);
      if (Math.hypot(cx - x, cy - y) <= r) { bump[c] = Math.max(bump[c], f.lift_m); out.push(c); }
    }
  }
  return out;
}
/** The added fixtures in place, each at its hand-placed pose if it has one (x, y, yaw; z stays the fix's). */
export function placedFixtures(ivs: Intervention[], lay: Layout) {
  return ivs.filter(iv => iv.kind === 'add' && lay.added?.includes(iv.id)).map(iv => {
    const f = { ...iv.fixture!, note: iv.label }, p = lay.placed?.[iv.id];
    return p ? { ...f, xyz: [p.x, p.y, f.xyz?.[2] ?? 0], yaw: p.yaw } : f;
  });
}
export const carvedPolys = (lay: Layout): XY[][] => (lay.carved ?? []).map(c => c.poly);

/** A fix applied to a layout (new object, the input is untouched). Move targets are [x, y, yaw_deg]. */
export function applyIntervention(objs: { name: string }[], lay: Layout, iv: Intervention): Layout {
  const poses = lay.poses.map(p => ({ ...p })), flattened = [...lay.flattened], raised = { ...lay.raised }, added = [...(lay.added ?? [])];
  let carved = [...(lay.carved ?? [])];
  const k = objs.findIndex(o => o.name === iv.object);
  if (iv.kind === 'remove') poses[k].removed = true;
  else if (iv.kind === 'move') poses[k] = { x: iv.to![0], y: iv.to![1], yaw: (iv.to![2] * Math.PI) / 180 };
  else if (iv.kind === 'raise') raised[iv.target!] = (raised[iv.target!] ?? 0) + iv.by_m!;
  else if (iv.kind === 'add') { if (!added.includes(iv.id)) added.push(iv.id); }
  else if (iv.kind === 'carve') carved = [...carved.filter(c => c.target !== iv.target), { id: iv.id, target: iv.target!, poly: iv.poly_xy!, by_m: iv.by_m ?? 0 }];   // a door gets one option at a time
  else flattened.push(iv.box_xy!);
  return { poses, flattened, raised, added, ...(carved.length ? { carved } : {}), ...(lay.placed ? { placed: { ...lay.placed } } : {}) };
}

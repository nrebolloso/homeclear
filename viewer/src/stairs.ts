// Stairs: measured against residential code (US IRC) and against this patient, plus three cheap additions around them.
// A ramp can't replace a flight (1:12 needs ~12 m of run per metre of rise), so the questions are: are the steps even
// and deep enough, is there a rail for the STRONGER hand both going up and coming down, is there room to park and turn
// the walker at the bottom, is it lit at both ends, and what happens to the walker at the top. Pure (worker + node).
//
// Where a stair comes from: config `game.stairs` (tape-measured, exported by stage 12 into scene.json `stairs`), or
// marked in the viewer (three clicks) and measured from the splat by measureStair(). Finding stairs automatically is
// the detection lane's (AGENTS.md).
import type { CheckOut, Fixture, Verdict } from './checks.ts';
import type { GridMeta, Intervention, Layers, XY } from './grid.ts';

/** 'seen': a rail is in the scan (or the tape says there is one); 'wall': dense at every height, a wall-mounted rail
 *  can't be told apart; 'none': open side, nothing at rail height; 'unseen': the scan barely saw that side */
export type RailSeen = 'seen' | 'wall' | 'none' | 'unseen';
export interface Stair {
  name: string;
  /** the bottom step's front edge (floor frame, m), either order; stairFrame() sorts left/right facing up */
  bottom: [XY, XY];
  /** a point on the top edge: gives the run direction and length */
  top: XY;
  top_z?: number | null;
  /** tread top heights, bottom to top (m above the floor), and each tread's front edge (m from the bottom edge) */
  treads_z?: number[]; tread_fronts_m?: number[]; tread_depth_m?: number | null; width_m?: number;
  rails?: { left: RailSeen; right: RailSeen; height_m?: { left?: number; right?: number } };
  measured?: 'splat' | 'tape';
  trips_per_day?: number;
}
export type Side = 'left' | 'right';

/** IRC R311.7 (riser max 7 3/4 in, variation 3/8 in, tread min 10 in, width 36 in, rail 34-38 in); check local code */
export const CODE = { riser_max_m: 0.197, riser_var_m: 0.0095, tread_min_m: 0.254, width_min_m: 0.91, rail_m: [0.86, 0.97] as [number, number] };
const DEFAULT_PITCH = 0.18 / 0.27;

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];

/** Run direction u (up the stairs), left v (facing up), the bottom edge's midpoint, run length and width. */
export function stairFrame(st: Stair) {
  const [a, b] = st.bottom, o: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], e = sub(b, a), width = Math.hypot(...e) || 1;
  let u: XY = [-e[1] / width, e[0] / width];
  if (dot(u, sub(st.top, o)) < 0) u = [-u[0], -u[1]];
  const v: XY = [-u[1], u[0]], run = Math.max(0.05, dot(sub(st.top, o), u));
  const [left, right] = dot(sub(a, o), v) >= 0 ? [a, b] : [b, a];
  const local = (p: XY) => ({ s: dot(sub(p, o), u), t: dot(sub(p, o), v) });
  const world = (s: number, t: number): XY => [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t];
  return { o, u, v, run, width, left, right, local, world };
}

const pct = (xs: number[], q: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };
const median = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Nosing line height at s: through the measured treads (least squares on front, height), else a typical pitch. */
export function pitchAt(st: Stair) {
  const z = st.treads_z ?? [], f = st.tread_fronts_m ?? [];
  if (z.length >= 2 && f.length === z.length) {
    const n = z.length, ms = f.reduce((a, x) => a + x, 0) / n, mz = z.reduce((a, x) => a + x, 0) / n;
    const k = f.reduce((a, x, i) => a + (x - ms) * (z[i] - mz), 0) / (f.reduce((a, x) => a + (x - ms) ** 2, 0) || 1);
    return (s: number) => mz + k * (s - ms);
  }
  const z0 = z[0] ?? 0.18;
  return (s: number) => z0 + DEFAULT_PITCH * s;
}

/** Measure a marked stair from splat points: `pts` is x, y, z, |nz| (z of the Gaussian's normal, i.e. its shortest
 *  axis; flat surfaces have |nz| near 1). Treads = peaks of the flat points' heights; rails = what stands 0.7-1.1 m
 *  over the nosing line along each side. Sparse scans give fewer treads, never invented ones. */
export function measureStair(pts: Float32Array, st: Stair): Stair & { flat_points: number } {
  const F = stairFrame(st), half = F.width / 2;
  const H = new Float32Array(320), flat: { s: number; z: number }[] = [];
  for (let i = 0; i < pts.length; i += 4) {
    if (pts[i + 3] < 0.8) continue;
    const { s, t } = F.local([pts[i], pts[i + 1]]), z = pts[i + 2];
    if (s < -0.03 || s > F.run + 0.05 || Math.abs(t) > half - 0.03 || z < 0.06 || z > 3.1) continue;
    H[Math.round(z * 100)]++; flat.push({ s, z });
  }
  const S = H.map((_, k) => { let a = 0; for (let d = -2; d <= 2; d++) a += H[k + d] ?? 0; return a; });
  const maxS = Math.max(...S), minCount = Math.max(6, 0.2 * maxS);
  const cand = [...S.keys()].filter(k => S[k] >= minCount && S[k] >= (S[k - 1] ?? 0) && S[k] > (S[k + 1] ?? 0)).sort((a, b) => S[b] - S[a]);
  const keep: number[] = [];
  for (const k of cand) if (keep.every(q => Math.abs(q - k) >= 8)) keep.push(k);
  const levels = keep.sort((a, b) => a - b).map(k => {
    let w = 0, m = 0;
    for (let d = -2; d <= 2; d++) { w += H[k + d] ?? 0; m += (H[k + d] ?? 0) * (k + d); }
    const z = m / w / 100, on = flat.filter(p => Math.abs(p.z - z) <= 0.025).map(p => p.s);
    return { z, front: pct(on, 0.05) };
  });
  const treads_z = levels.map(l => +l.z.toFixed(3)), tread_fronts_m = levels.map(l => +Math.max(0, l.front).toFixed(3));
  const gaps = tread_fronts_m.slice(1).map((f, i) => f - tread_fronts_m[i]).filter(d => d > 0.1 && d < 0.6);
  const out: Stair = { ...st, treads_z, tread_fronts_m, tread_depth_m: gaps.length ? +median(gaps).toFixed(3) : null, width_m: +F.width.toFixed(3), measured: 'splat' };
  const pitch = pitchAt(out), bins = Math.max(1, Math.ceil(F.run / 0.1));
  const rail = (side: Side) => {
    const tS = side === 'left' ? half : -half, any = new Set<number>(), at = new Set<number>(), hs: number[] = [];
    let hi = 0, mid = 0;
    for (let i = 0; i < pts.length; i += 4) {
      const { s, t } = F.local([pts[i], pts[i + 1]]);
      if (s < 0 || s > F.run || Math.abs(t - tS) > 0.2) continue;
      const h = pts[i + 2] - pitch(s), b = Math.min(bins - 1, Math.floor(s / 0.1));
      if (h > 0.2 && h < 1.2) any.add(b);
      if (h >= 0.7 && h <= 1.1) { at.add(b); hs.push(h); }
      if (h >= 0.8 && h <= 1.0) hi++;
      if (h >= 0.35 && h <= 0.6) mid++;
    }
    const seen: RailSeen = any.size < 0.3 * bins ? 'unseen' : at.size < 0.4 * bins ? 'none' : hi >= 2 * mid ? 'seen' : 'wall';
    return { seen, h: seen === 'seen' ? +median(hs).toFixed(3) : undefined };
  };
  const L = rail('left'), R = rail('right');
  out.rails = { left: L.seen, right: R.seen, height_m: { ...(L.h ? { left: L.h } : {}), ...(R.h ? { right: R.h } : {}) } };
  return { ...out, flat_points: flat.length };
}

export interface StairCtx {
  g: GridMeta; L: Layers; fixtures: Fixture[]; strong_side?: Side | null; device: string;
  margin: { width: number; height: number };
}
const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

/** The stair checks, on the current layout and fixtures (added rails, lights and the parked walker count). */
export function stairChecks(st: Stair, c: StairCtx): CheckOut[] {
  const F = stairFrame(st), out: CheckOut[] = [], id = (w: string) => `stairs:${st.name}:${w}`, position = F.o;
  const e = Math.max(c.margin.height, 0.01), src = st.measured === 'tape' ? 'tape-measured' : 'measured from the splat';
  const add = (w: string, label: string, verdict: Verdict, note: string, extra: Partial<CheckOut> = {}) =>
    out.push({ id: id(w), kind: 'stairs', label, verdict, note, position, ...extra });
  const mine = c.fixtures.filter(f => f.attach === st.name);
  const z = st.treads_z ?? [];
  // 1-2. risers: each one, and how much they differ (uneven risers trip people who learned the first step)
  if (z.length) {
    const risers = z.map((v, k) => v - (k ? z[k - 1] : 0)), hi = Math.max(...risers), lo = Math.min(...risers);
    add('risers', `${st.name}: risers ${cm(lo)}–${cm(hi)} (code max ${(CODE.riser_max_m * 100).toFixed(1)} cm)`,
      hi > CODE.riser_max_m + e ? 'fail' : hi > CODE.riser_max_m - e ? 'borderline, OT to verify' : 'ok',
      `${z.length} tread${z.length === 1 ? '' : 's'} ${src}${st.measured === 'splat' ? ' (treads the scan missed are not counted)' : ''}`, { value_m: hi, limit_m: [0, CODE.riser_max_m] });
    if (risers.length >= 2)
      add('riser_var', `${st.name}: risers differ by ${((hi - lo) * 100).toFixed(1)} cm (code max ${(CODE.riser_var_m * 100).toFixed(2)} cm)`,
        hi - lo > CODE.riser_var_m + e ? 'fail' : hi - lo > CODE.riser_var_m - e ? 'borderline, OT to verify' : 'ok',
        'an uneven step catches a foot that expects the same height', { value_m: hi - lo, limit_m: [0, CODE.riser_var_m] });
  } else add('risers', `${st.name}: steps not captured`, 'OT to verify', 'the scan saw no treads: film the stairs from the bottom, or tape-measure them');
  // 3-4. tread depth and width
  if (st.tread_depth_m) add('tread', `${st.name}: treads ${cm(st.tread_depth_m)} deep (code min ${(CODE.tread_min_m * 100).toFixed(1)} cm)`,
    st.tread_depth_m < CODE.tread_min_m - e ? 'fail' : st.tread_depth_m < CODE.tread_min_m + e ? 'borderline, OT to verify' : 'ok',
    'a short tread leaves the heel hanging, worse coming down', { value_m: st.tread_depth_m, limit_m: [CODE.tread_min_m, 1] });
  const w = st.width_m ?? F.width, ew = Math.max(c.margin.width, 0.03);   // marked by clicks: a few cm
  add('width', `${st.name}: ${cm(w)} wide (code min ${cm(CODE.width_min_m)})`, w < CODE.width_min_m - ew ? 'fail' : w < CODE.width_min_m + ew ? 'borderline, OT to verify' : 'ok',
    'room for a person and a rail on each side', { value_m: w, limit_m: [CODE.width_min_m, 9] });
  // 5. a rail for the stronger hand both ways: going up it is on the strong side, coming down on the other side
  const has = (s: Side) => st.rails?.[s] === 'seen' || mine.some(f => f.kind === 'handrail' && f.side === s);
  const unsure = (s: Side) => !has(s) && (st.rails?.[s] === 'wall' || st.rails?.[s] === 'unseen' || !st.rails);
  const S = c.strong_side, both = has('left') && has('right'), one = has('left') ? 'left' : has('right') ? 'right' : null;
  const railNote = (st.rails ? `scan: left ${st.rails.left}, right ${st.rails.right}` : 'rails not recorded') +
    (mine.some(f => f.kind === 'handrail') ? '; designed rail added' : '');
  if (both) add('rails', `${st.name}: rails on both sides`, 'ok', `the stronger hand has a rail going up and coming down (${railNote})`);
  else if (one && S) {
    const missing: Side = one === S ? other(S) : S;   // the side the strong hand needs in the other direction
    const dir = one === S ? 'coming down' : 'going up';
    add('rails', `${st.name}: ${dir}, the stronger (${S}) hand has no rail`, unsure(missing) ? 'borderline, OT to verify' : 'fail',
      `rail only on the ${one}; a rail on the ${missing} gives the ${S} hand one ${dir} (${railNote})`);
  } else if (one) add('rails', `${st.name}: rail on the ${one} only`, 'OT to verify',
    `fine only if the ${one} hand is the stronger one going up; set the stronger side, or add a second rail (${railNote})`);
  else add('rails', `${st.name}: no handrail seen`, unsure('left') || unsure('right') ? 'OT to verify' : 'fail', railNote);
  const hm = st.rails?.height_m ?? {};
  for (const s of ['left', 'right'] as Side[]) {
    const h = hm[s];
    if (h === undefined) continue;
    const [a, b] = CODE.rail_m;
    add(`rail_h_${s}`, `${st.name}: ${s} rail ${cm(h)} above the nosings (code ${cm(a)}–${cm(b)})`,
      h < a - e || h > b + e ? 'fail' : h < a + e || h > b - e ? 'borderline, OT to verify' : 'ok', 'measured from the splat', { value_m: h, limit_m: [a, b] });
  }
  // 6. room at the bottom to park the walker and turn: free floor in 1 m x 1 m in front of the first step
  {
    const ny = c.g.shape[1];
    let free = 0, blocked = 0, n = 0;
    for (let s = -1.05; s <= -0.05; s += 0.1) for (let t = -0.45; t <= 0.45; t += 0.1) {
      const [x, y] = F.world(s, t), i = Math.floor((x - c.g.origin_xy[0]) / c.g.cell_m), j = Math.floor((y - c.g.origin_xy[1]) / c.g.cell_m);
      n++;
      const inside = i >= 0 && j >= 0 && i < c.g.shape[0] && j < ny, k = i * ny + j;
      if (inside && c.L.obst[k]) blocked++;
      else if (inside && c.L.floor[k]) free++;
    }
    const seen = free + blocked, share = seen ? free / seen : 0;
    if (seen < 0.5 * n) add('landing', `${st.name}: floor in front of the first step not captured`, 'OT to verify',
      `only ${Math.round((100 * seen) / n)}% of the 1 m × 1 m in front was seen: check there is room to park the walker and turn`);
    else add('landing', `${st.name}: ${Math.round(share * 100)}% of a 1 m × 1 m landing free at the bottom`,
      share >= 0.8 ? 'ok' : share >= 0.6 ? 'borderline, OT to verify' : 'fail', 'room to stand, park the walker and turn before the first step; moving furniture changes it', { value_m: share });
  }
  // 7. light at both ends: a switch near the bottom and the top, or motion step lights
  const lights = mine.some(f => f.kind === 'stair_light');
  const near = (p: XY) => c.fixtures.some(f => f.kind === 'switch' && f.xyz && Math.hypot(f.xyz[0] - p[0], f.xyz[1] - p[1]) <= 1.5);
  const switches = c.fixtures.some(f => f.kind === 'switch');
  if (lights) add('light', `${st.name}: motion lights on every step`, 'ok', 'they come on before the first step, at either end');
  else if (near(F.o) && near(st.top)) add('light', `${st.name}: light switch at the top and the bottom`, 'ok', 'switch positions placed by hand');
  else add('light', `${st.name}: no light switch marked at ${near(F.o) ? 'the top' : near(st.top) ? 'the bottom' : 'either end'}`, switches ? 'fail' : 'OT to verify',
    switches ? 'climbing to reach a switch in the dark is the classic night fall' : 'no switches are marked in this home: check both ends');
  // 8. the walker can't climb: with only one, the patient is unaided at the top
  if (c.device === 'walker') {
    const parked = mine.some(f => f.kind === 'walker_parked');
    add('walker', parked ? `${st.name}: second walker waiting at the top` : `${st.name}: the walker stays at the bottom`, parked ? 'ok' : 'fail',
      parked ? 'up holding the rail, then straight onto the second walker' : `${z.length ? `${z.length}+ steps` : 'the flight'} holding the rail, then walking unaided at the top`);
  }
  return out;
}

/** The three additions, as configured-fix-style interventions (so Plan fixes, the optimizer, Reimagine, the receipt,
 *  fix card and OT report all see them). Costs are rough US placeholders until the fix catalog has them. */
export function stairFixes(st: Stair): Intervention[] {
  const F = stairFrame(st), pitch = pitchAt(st), mid = F.run / 2, top = st.top_z ?? pitch(F.run);
  const at = (s: number, t: number, z: number) => [...F.world(s, t), z];
  const out: Intervention[] = [];
  for (const side of ['left', 'right'] as Side[]) {
    if (st.rails?.[side] === 'seen') continue;
    out.push({ id: `stair_rail:${st.name}:${side}`, kind: 'add', label: `Handrail on the ${side} of the ${st.name}, 30 cm past both ends`,
      fixture: { name: `${st.name} ${side} rail`, kind: 'handrail', attach: st.name, side, xyz: at(mid, (side === 'left' ? 1 : -1) * F.width / 2, pitch(mid) + 0.9) },
      cost_usd: 250, minutes: 120, effort: 3, product: 'handrail with returns, brackets into the studs' });
  }
  out.push({ id: `stair_lights:${st.name}`, kind: 'add', label: `Motion-sensor lights on each step of the ${st.name}`,
    fixture: { name: `${st.name} step lights`, kind: 'stair_light', attach: st.name, xyz: at(mid, 0, pitch(mid)) },
    cost_usd: 60, minutes: 30, effort: 1, product: 'battery motion-sensor LED step lights' });
  out.push({ id: `stair_walker:${st.name}`, kind: 'add', label: `Second walker kept at the top of the ${st.name}`,
    fixture: { name: `${st.name} top walker`, kind: 'walker_parked', attach: st.name, xyz: at(F.run + 0.4, 0, top) },
    cost_usd: 70, minutes: 5, effort: 1, product: 'folding walker' });
  return out;
}

/** The stair as a config `game.stairs` entry (YAML), to keep it: paste into config.<scene>.yaml, stage 12 exports it. */
export function stairYaml(st: Stair): string {
  const r = (x: number) => +x.toFixed(3), xy = (p: XY) => `[${r(p[0])}, ${r(p[1])}]`;
  const lines = [`- name: ${st.name}`, `  bottom: [${xy(st.bottom[0])}, ${xy(st.bottom[1])}]`, `  top: ${xy(st.top)}`];
  if (st.top_z != null) lines.push(`  top_z: ${r(st.top_z)}`);
  if (st.treads_z?.length) lines.push(`  treads_z: [${st.treads_z.map(r).join(', ')}]`);
  if (st.tread_fronts_m?.length) lines.push(`  tread_fronts_m: [${st.tread_fronts_m.map(r).join(', ')}]`);
  if (st.tread_depth_m) lines.push(`  tread_depth_m: ${r(st.tread_depth_m)}`);
  if (st.width_m) lines.push(`  width_m: ${r(st.width_m)}`);
  if (st.rails) lines.push(`  rails: {left: ${st.rails.left}, right: ${st.rails.right}}`);
  lines.push(`  measured: ${st.measured ?? 'tape'}`);
  return lines.join('\n');
}

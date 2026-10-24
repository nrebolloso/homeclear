// Transfers, reach and emergency access, on the current layout. Pure functions (worker + node --test).
// Heights come from the splat (stage 12 surface_m), positions from the layout; the limits are config, the persona says
// whose knees and arms. Everything near a limit (within the measured map error) is "borderline, OT to verify", and the
// rules that are judgement calls (grab bars, the phone after a fall, the stretcher) are always marked for the OT.
import { plan, worldFootprint, type GridMeta, type Layers, type Pose, type XY, type Footprinted, type PlanParams } from './grid.ts';

export interface Fixture { name: string; kind: string; xyz?: number[] | null; surface_m?: number | null; measured: boolean; attach?: string; poly_xy?: XY[]; note?: string; side?: 'left' | 'right'; yaw?: number }
export interface TransferRules { min_above_knee_m: number; max_above_knee_m: number; reach_height_m: [number, number] }
export interface EmsRules { stretcher_width_m: number; phone_reach_m: number; entry?: XY | null }
export interface BodyFacts { knee_height_m?: number; reach_m?: number; hip_precautions?: boolean }
export type Verdict = 'ok' | 'fail' | 'borderline, OT to verify' | 'OT to verify';
export interface CheckOut {
  /** Door checks: whether a planned route uses this opening. Off-route doors have no suggested renovation. */
  on_route?: boolean;
  id: string; kind: 'transfer' | 'reach' | 'grab_bar' | 'ems' | 'phone' | 'stairs' | 'door' | 'wheelchair'; label: string; verdict: Verdict; note: string;
  value_m?: number; limit_m?: [number, number]; position?: XY;
}
type Obj = Footprinted & { name: string; kind: string; surface_m?: number | null };

/** Where the patient sits up and stands: the middle of the bed's long side nearest the route start, 10 cm out. */
export function bedExit(bed: Obj, pose: Pose, routeStart: XY): XY {
  const fp = worldFootprint(bed, pose);
  let best: XY = [pose.x, pose.y], bd = Infinity, longest = 0;
  const sides = fp.map((a, k) => [a, fp[(k + 1) % fp.length]] as [XY, XY]);
  for (const [a, b] of sides) longest = Math.max(longest, Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (const [a, b] of sides) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.8 * longest) continue;   // long sides only: nobody gets out over the foot or the headboard
    const m: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], out = [m[0] - pose.x, m[1] - pose.y], n = Math.hypot(out[0], out[1]) || 1;
    const p: XY = [m[0] + (0.1 * out[0]) / n, m[1] + (0.1 * out[1]) / n];
    const d = Math.hypot(p[0] - routeStart[0], p[1] - routeStart[1]);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

const verdict = (v: number, lo: number, hi: number, e: number): Verdict =>
  v < lo - e || v > hi + e ? 'fail' : Math.abs(v - lo) <= e || Math.abs(v - hi) <= e ? 'borderline, OT to verify' : 'ok';
const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;

export interface CheckInput {
  g: GridMeta; L: Layers; objects: Obj[]; poses: Pose[]; fixtures: Fixture[]; body: BodyFacts; transfer: TransferRules;
  /** seat raises from fixes (raised toilet seat, bed risers), by object/fixture name */
  raised?: Record<string, number>;
  ems: EmsRules; routeStart: XY; plan: PlanParams; margin: { width: number; height: number }; hazards: { position: XY; name: string }[];
}

export function runChecks(c: CheckInput): CheckOut[] {
  const out: CheckOut[] = [];
  const knee = c.body.knee_height_m ?? 0.5, reach = c.body.reach_m ?? 0.6;
  const lo = knee + (c.body.hip_precautions ? c.transfer.min_above_knee_m : -0.03), hi = knee + c.transfer.max_above_knee_m;
  const bedK = c.objects.findIndex(o => o.kind === 'bed' && !c.poses[c.objects.indexOf(o)].removed);
  const exit = bedK >= 0 ? bedExit(c.objects[bedK], c.poses[bedK], c.routeStart) : null;
  const eh = (v: number) => Math.max(c.margin.height, 0.01, 0.02 * v);   // map error, or 2% scale error on a tall thing

  // 1. sit-to-stand heights: bed, toilet, chairs
  const seats: { name: string; h: number; at: XY }[] = [];
  const up = (name: string) => c.raised?.[name] ?? 0;
  if (bedK >= 0 && c.objects[bedK].surface_m) seats.push({ name: c.objects[bedK].name, h: c.objects[bedK].surface_m! + up(c.objects[bedK].name), at: exit! });
  c.objects.forEach((o, k) => { if (o.kind === 'chair' && o.surface_m && !c.poses[k].removed) seats.push({ name: o.name, h: o.surface_m + up(o.name), at: [c.poses[k].x, c.poses[k].y] }); });
  for (const f of c.fixtures) if ((f.kind === 'toilet' || f.kind === 'chair') && f.surface_m) seats.push({ name: f.name, h: f.surface_m + up(f.name), at: [f.xyz![0], f.xyz![1]] });
  for (const s of seats) {
    const v = verdict(s.h, lo, hi, eh(s.h));
    const why = s.h < lo ? (c.body.hip_precautions ? 'hips would sink below the knees (hip precautions)' : 'low: hard to stand up')
      : s.h > hi ? 'high: feet may not reach the floor' : 'within the range';
    out.push({ id: `transfer:${s.name}`, kind: 'transfer', label: `${s.name} height ${cm(s.h)}`, value_m: s.h, limit_m: [lo, hi], position: s.at,
      verdict: v, note: `measured from the splat${up(s.name) ? ` + ${cm(up(s.name))} raise` : ''}; for knees at ${cm(knee)} the seat should be ${cm(lo)}–${cm(hi)}: ${why}` });
  }

  // 2. reach from the bed edge: the nearest light switch (a touch lamp counts) and the nearest phone; a phone or lamp
  //    on furniture rides with it
  if (exit) for (const kind of ['switch', 'phone'] as const) {
    const cands = c.fixtures.filter(f => f.kind === kind).map(f => {
      if (!f.attach) return f.xyz ? { f, p: f.xyz } : null;
      const k = c.objects.findIndex(o => o.name === f.attach);
      return k < 0 || c.poses[k].removed ? null : { f, p: [c.poses[k].x, c.poses[k].y, c.objects[k].height_m] };
    }).filter((x): x is { f: Fixture; p: number[] } => !!x);
    const what = kind === 'switch' ? 'light switch' : 'phone';
    if (!cands.length) {
      if (c.fixtures.some(f => f.kind === kind)) out.push({ id: `reach:${kind}`, kind: 'reach', label: `no ${what} left near the bed`, verdict: 'fail', note: 'the furniture it was on was removed' });
      continue;
    }
    const dist = (q: number[]) => Math.hypot(q[0] - exit[0], q[1] - exit[1]);
    const { f, p } = cands.reduce((a, b) => (dist(b.p) < dist(a.p) ? b : a));
    const d = dist(p), [zlo, zhi] = c.transfer.reach_height_m;
    const zOk = p[2] >= zlo && p[2] <= zhi;
    const v = !zOk ? 'fail' : verdict(d, 0, reach, c.margin.width) === 'fail' ? 'fail' : d > reach - c.margin.width ? 'borderline, OT to verify' : 'ok';
    out.push({ id: `reach:${kind}`, kind: 'reach', label: `${what}${f.name === what ? '' : ` (${f.name})`} ${cm(d)} from the bed edge`, value_m: d, limit_m: [0, reach], position: [p[0], p[1]],
      verdict: v, note: `seated reach ${cm(reach)}; at ${cm(p[2])} high${zOk ? '' : ` (outside ${cm(zlo)}–${cm(zhi)})`}${f.measured ? '' : '; position placed by hand'}` });
  }

  // 3. grab bars next to each toilet: the splat can't tell a towel rail from a grab bar
  for (const t of c.fixtures.filter(f => f.kind === 'toilet' && f.xyz)) {
    const bar = c.fixtures.find(f => f.kind === 'grab_bar_wall' && f.xyz && Math.hypot(f.xyz[0] - t.xyz![0], f.xyz[1] - t.xyz![1]) < 1.0);
    out.push({ id: `grab_bar:${t.name}`, kind: 'grab_bar', position: [t.xyz![0], t.xyz![1]], verdict: 'OT to verify',
      label: bar ? `grab bar wall marked next to the ${t.name}` : `no grab bar marked next to the ${t.name}`,
      note: bar ? 'check it is a real, anchored grab bar' : 'a wall within 1 m could take one; not measurable from video' });
  }

  // 4. emergency access: can a stretcher get from the entry to the bed edge? (heuristic: width only, no turning radius)
  if (c.ems.entry && exit) {
    const P = plan(c.g, c.L, c.ems.entry, exit, { ...c.plan, walker_width_m: c.ems.stretcher_width_m });
    // plan() snaps the goal to the nearest cell the stretcher fits in: ending far from the bed edge is not reaching it
    const end = P.xy.at(-1), short = end ? Math.hypot(end[0] - exit[0], end[1] - exit[1]) - c.ems.stretcher_width_m / 2 : Infinity;
    const fails = !!P.error || short > 0.5;
    // the bottleneck on the way, not at the two ends (they are snapped to the tightest cell that fits by construction)
    const ends = [P.xy[0], end], mid = P.side.filter((_, k) => ends.every(e => e && Math.hypot(P.xy[k][0] - e[0], P.xy[k][1] - e[1]) > 0.5));
    const spare = mid.length ? Math.min(...mid) : P.min_side_clearance_m ?? 0;
    out.push({ id: 'ems:stretcher', kind: 'ems', position: c.ems.entry,
      label: P.error ? 'stretcher cannot reach the bed' : fails ? `stretcher stops ${short.toFixed(1)} m short of the bed`
        : `stretcher path to the bed: ${P.length_m.toFixed(1)} m, ${cm(spare)} to spare each side at the tightest point`,
      verdict: fails ? 'fail' : 'OT to verify', note: `${cm(c.ems.stretcher_width_m)} wide, straight-line clearance only (turning a stretcher needs more)` });
  }

  // 5. after a fall at a hazard: how far is the nearest phone?
  const phones = c.fixtures.filter(f => f.kind === 'phone').flatMap(f => {
    if (!f.attach) return f.xyz ? [[f.xyz[0], f.xyz[1]] as XY] : [];
    const k = c.objects.findIndex(o => o.name === f.attach);
    return k >= 0 && !c.poses[k].removed ? [[c.poses[k].x, c.poses[k].y] as XY] : [];
  });
  for (const h of c.hazards) {
    const d = phones.length ? Math.min(...phones.map(p => Math.hypot(p[0] - h.position[0], p[1] - h.position[1]))) : Infinity;
    if (d <= c.ems.phone_reach_m) continue;
    out.push({ id: `phone:${h.name}:${h.position.map(x => x.toFixed(1)).join(',')}`, kind: 'phone', position: h.position, verdict: 'OT to verify',
      label: `fall at the ${h.name}: ${Number.isFinite(d) ? `phone ${d.toFixed(1)} m away` : 'no phone marked'}`,
      note: `farther than ${c.ems.phone_reach_m} m to crawl; consider a wearable alert` });
  }
  return out;
}

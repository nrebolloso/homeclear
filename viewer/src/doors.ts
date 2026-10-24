// Doorways: the clear width a walker gets through, against code and this walker, and three ways to widen it (swing-clear
// hinges, the door off its hinges, a wider opening). Each option is a 'carve' fix: the floor map opens that much wall,
// so the route and the tight-passage hazard update like for any other fix; doors3d.ts widens the scan to match. The
// widened opening is DESIGNED, not measured. Pure (worker + node).
//
// Where a door comes from: config `game.doors` (exported by stage 12 into scene.json `doors`), or marked in the viewer
// with two clicks on the jambs. Finding doors automatically is the detection lane's (AGENTS.md).
import type { CheckOut, Verdict } from './checks.ts';
import type { Intervention, Layout, XY } from './grid.ts';

export interface Door {
  name: string;
  /** the two jambs' inner faces at the opening (floor frame, m): their distance is the clear width */
  a: XY; b: XY;
  height_m?: number; wall_m?: number;
  measured?: 'clicks' | 'tape';
  /** the jamb the door hangs on, if known (hingeSide finds it from a door-leaf object): widening grows the other side */
  hinge?: 'a' | 'b' | null;
}
/** Which side of the opening a change grows: one jamb ('a' or 'b') or both. */
export type Grow = 'a' | 'b' | 'both';
/** ADA 404.2.3 clear width 32 in; a widened opening aims for 36 in (or what this walker needs, if more). Frame: the
 *  jamb + casing band that moves with the opening. */
export const DOOR = { clear_min_m: 0.813, widen_to_m: 0.915, frame_m: 0.08, height_m: 2.03, wall_m: 0.15 };

const cm = (m: number) => `${(m * 100).toFixed(0)} cm`;

/** o: the opening's middle; e: along the opening (a -> b); n: through the wall; s along e, t along n. */
export function doorFrame(d: Door) {
  const o: XY = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2], dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1], width = Math.hypot(dx, dy) || 1e-6;
  const e: XY = [dx / width, dy / width], n: XY = [-e[1], e[0]];
  const world = (s: number, t: number): XY => [o[0] + e[0] * s + n[0] * t, o[1] + e[1] * s + n[1] * t];
  return { o, e, n, width, wall: d.wall_m ?? DOOR.wall_m, height: d.height_m ?? DOOR.height_m, world };
}

/** The walker's width plus the planner's clearance on both sides: what it takes to get through without scraping. */
export const needWidth = (walker_width_m: number, clearance_margin_m: number) => walker_width_m + 2 * clearance_margin_m;

/** The opening's extent along e after growing by `gain` on `grow`: [from, to] in s. */
export function openingSpan(F: ReturnType<typeof doorFrame>, gain: number, grow: Grow): [number, number] {
  const w2 = F.width / 2;
  return grow === 'a' ? [-w2 - gain, w2] : grow === 'b' ? [-w2, w2 + gain] : [-w2 - gain / 2, w2 + gain / 2];
}
/** The wall the floor map opens for `gain` more clear width on `grow` (a rotated rectangle across the wall). */
export function carvePoly(d: Door, gain: number, grow: Grow = 'both'): XY[] {
  const F = doorFrame(d), [s0, s1] = openingSpan(F, gain, grow), t = F.wall / 2 + 0.05;
  return [F.world(s0 - 0.01, -t), F.world(s1 + 0.01, -t), F.world(s1 + 0.01, t), F.world(s0 - 0.01, t)];
}
/** A wider opening grows away from the hinge (the door leaf stays where it hangs); hinges and a door taken off gain at it. */
export const growOf = (d: Door, key: string): Grow =>
  !d.hinge ? 'both' : key === 'widen' ? (d.hinge === 'a' ? 'b' : 'a') : d.hinge;
/** The hinge jamb: the one a door-leaf object (its footprint corners, floor frame) stands next to, within 25 cm. */
export function hingeSide(d: Door, leaves: XY[][]): 'a' | 'b' | null {
  let best: 'a' | 'b' | null = null, bd = 0.25;
  for (const fp of leaves) for (const p of fp) for (const [side, j] of [['a', d.a], ['b', d.b]] as const) {
    const dist = Math.hypot(p[0] - j[0], p[1] - j[1]);
    if (dist < bd) { bd = dist; best = side; }
  }
  return best;
}

/** The options, as carve fixes on this door (one at a time). Swing-clear hinges and taking the door off only when the
 *  leaf is part of the scan (a door-leaf object has its own fixes, which move or remove it). Costs: rough US placeholders. */
export function doorFixes(d: Door, need_m: number, opts: { leafObject?: boolean } = {}): Intervention[] {
  const F = doorFrame(d), target = Math.max(DOOR.widen_to_m, need_m), widen = Math.max(0.1, target - F.width);
  const noun = /door/i.test(d.name) ? d.name : `${d.name} door`;
  const opt = (key: string, gain: number, label: string, cost_usd: number, minutes: number, effort: number, product: string): Intervention =>
    ({ id: `door_${key}:${d.name}`, kind: 'carve', target: d.name, poly_xy: carvePoly(d, gain, growOf(d, key)), by_m: gain, label, cost_usd, minutes, effort, product });
  return [
    ...(opts.leafObject ? [] : [
      opt('offset', 0.045, `Swing-clear hinges on the ${noun}: the open door clears the frame (+4.5 cm)`, 25, 30, 2, 'swing-clear (offset) hinges, pair'),
      opt('remove', 0.06, `Take the ${noun} off its hinges, a curtain instead (+6 cm)`, 30, 20, 2, 'tension-rod curtain')]),
    opt('widen', widen, `Widen the ${d.name} opening to ${cm(F.width + widen)} clear`, 1500, 480, 5, 'contractor: new frame and header (about $800–2,500)'),
  ];
}

/** How much wider the layout on screen makes this door. */
export const doorGain = (lay: Layout, name: string) => lay.carved?.find(c => c.target === name)?.by_m ?? 0;

export function doorChecks(d: Door, c: { gain: number; need_m: number; margin: { width: number } }): CheckOut[] {
  const F = doorFrame(d), w = F.width + c.gain, limit = Math.max(c.need_m, DOOR.clear_min_m);
  const e = Math.max(c.margin.width, 0.02);   // marked by clicks: a couple of cm
  const verdict: Verdict = w < limit - e ? 'fail' : w < limit + e ? 'borderline, OT to verify' : 'ok';
  return [{ id: `door:${d.name}`, kind: 'door', position: F.o, value_m: w, limit_m: [limit, 9], verdict,
    label: `${d.name}: ${cm(w)} clear${c.gain ? ` (was ${cm(F.width)})` : ''}; the walker needs ${cm(c.need_m)}, code ${cm(DOOR.clear_min_m)}`,
    note: `${d.measured === 'tape' ? 'tape-measured' : 'between the two marked jambs'}${c.gain ? '; the wider opening is designed, not built' : ''}` }];
}

export interface EditBox { center: [number, number, number]; half: [number, number, number]; yaw: number }
/** Where doors3d.ts edits the scan for `gain` more width on `grow`: on each growing side, the wall strip the jamb moves
 *  into (hidden) and the jamb band itself (shifted out, tinted). Hide first: edits see positions already moved. */
export function doorEditBoxes(d: Door, gain: number, grow: Grow = 'both'): { hide: EditBox[]; shift: (EditBox & { displace: XY })[] } {
  const F = doorFrame(d), yaw = Math.atan2(F.e[1], F.e[0]), fr = DOOR.frame_m, ht = F.wall / 2 + 0.06, z0 = 0.02, hz = (F.height - z0) / 2;
  const hide: EditBox[] = [], shift: (EditBox & { displace: XY })[] = [];
  const sides = grow === 'a' ? [-1] : grow === 'b' ? [1] : [-1, 1];
  for (const side of sides) {
    const w2 = F.width / 2, g2 = grow === 'both' ? gain / 2 : gain;
    const [hx, hy] = F.world(side * (w2 + fr + g2 / 2), 0), [jx, jy] = F.world(side * (w2 + fr / 2), 0);
    hide.push({ center: [hx, hy, z0 + hz], half: [g2 / 2, ht, hz], yaw });
    shift.push({ center: [jx, jy, z0 + hz], half: [fr / 2 + 0.005, ht, hz], yaw, displace: [F.e[0] * side * g2, F.e[1] * side * g2] });
  }
  return { hide, shift };
}

/** The door as a config `game.doors` entry (YAML). */
export function doorYaml(d: Door): string {
  const r = (x: number) => +x.toFixed(3), xy = (p: XY) => `[${r(p[0])}, ${r(p[1])}]`;
  return [`- name: ${d.name}`, `  a: ${xy(d.a)}`, `  b: ${xy(d.b)}`, `  measured: ${d.measured ?? 'tape'}`].join('\n');
}

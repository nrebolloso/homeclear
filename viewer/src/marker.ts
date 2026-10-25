// Marking the scan by pointing: a stair (3 points) or a doorway (2), the same on the desktop and in the headset. A
// pointer rides the splat surface; a click (trigger) places a point, right click (B / Y) takes the last one back, Esc
// (wand grip) cancels. Previews say what each point means (LEFT / RIGHT on the step edge, the width against the
// walker, the rise of the flight), and points that can't be right are refused with the reason, so a mistake shows
// before anything is measured. After measuring, each point stays a handle to drag. Pure (node-tested): marker3d.ts
// draws it, main.ts feeds it pointer, key and controller input.
import type { XY } from './grid.ts';
import type { Stair } from './stairs.ts';
import type { Door } from './doors.ts';

export type P3 = [number, number, number];
export type MarkKind = 'stairs' | 'door' | 'point';
export const MARK_STEPS: Record<MarkKind, string[]> = {
  stairs: ['the front edge of the BOTTOM step, at one end', 'the same edge, at its other end', 'the TOP: on the landing, just past the last step'],
  door: ['the inside face of one jamb', 'the inside face of the other jamb'],
  point: ['a spot to check, on the floor: can the device get there from the route\'s start?'],   // the reach map (reach.ts)
};
export interface Marking { kind: MarkKind; pts: P3[] }
export const startMarking = (kind: MarkKind): Marking => ({ kind, pts: [] });
export const isComplete = (m: Marking) => m.pts.length >= MARK_STEPS[m.kind].length;
export const prompt = (m: Marking) => isComplete(m) ? 'measuring…' : `${m.pts.length + 1} / ${MARK_STEPS[m.kind].length}: ${MARK_STEPS[m.kind][m.pts.length]}`;

const cm = (m: number) => `${Math.round(m * 100)} cm`;
const flat = (a: P3 | XY, b: P3 | XY) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** Typical riser, only to say "about N steps" in the preview (never a measurement). */
const RISER = 0.18;

/** Why p can't be the next point (null: it can). Generous: it only catches clicks that are certainly wrong. */
export function placeError(m: Marking, p: P3): string | null {
  const k = m.pts.length;
  if (m.kind === 'point') return p[2] > 0.3 ? `that is ${cm(p[2])} up: click the floor` : null;
  if (m.kind === 'stairs') {
    if (k === 0 && p[2] > 0.6) return `that is ${cm(p[2])} up: the bottom step's front edge is near the floor`;
    if (k === 1) {
      const d = flat(m.pts[0], p), dz = p[2] - m.pts[0][2];
      if (d < 0.4) return `only ${cm(d)} from the first end: click the step's other end`;
      if (d > 2.5) return `${cm(d)} from the first end: wider than a stair`;
      if (Math.abs(dz) > 0.15) return `${cm(Math.abs(dz))} ${dz > 0 ? 'higher' : 'lower'} than the first end: both ends are on the same step`;
    }
    if (k === 2) {
      const E = edgeFrame(m.pts[0], m.pts[1], [p[0], p[1]]), rise = p[2] - Math.min(m.pts[0][2], m.pts[1][2]);
      const run = (p[0] - E.o[0]) * E.u[0] + (p[1] - E.o[1]) * E.u[1];
      if (run < 0.25) return 'that is on the bottom edge: click the top of the flight';
      if (rise < 0.25) return `only ${cm(Math.max(0, rise))} above the bottom step: click the top of the flight, on the landing`;
      if (run > 6) return `${run.toFixed(1)} m along: a flight is rarely that long`;
    }
  } else if (k === 1) {
    const d = flat(m.pts[0], p);
    if (d < 0.4) return `${cm(d)} apart: click the inside face of the OTHER jamb`;
    if (d > 2) return `${cm(d)} apart: wider than a doorway`;
  }
  return null;
}
export function place(m: Marking, p: P3): { m: Marking; error: string | null } {
  if (isComplete(m)) return { m, error: 'all points placed' };
  const error = placeError(m, p);
  return error ? { m, error } : { m: { ...m, pts: [...m.pts, p] }, error: null };
}
export const undo = (m: Marking): Marking => ({ ...m, pts: m.pts.slice(0, -1) });
/** The first point that would be refused if the points were placed in this order (a handle dragged after measuring). */
export function checkAll(kind: MarkKind, pts: P3[]): string | null {
  for (let k = 0; k < pts.length; k++) { const e = placeError({ kind, pts: pts.slice(0, k) }, pts[k]); if (e) return e; }
  return null;
}

/** The bottom edge a-b with "up the flight" toward `toward` (the top point, or ahead of the viewer); v = left facing up. */
export function edgeFrame(a: P3 | XY, b: P3 | XY, toward: XY) {
  const o: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w = flat(a, b) || 1;
  let u: XY = [-(b[1] - a[1]) / w, (b[0] - a[0]) / w];
  if ((toward[0] - o[0]) * u[0] + (toward[1] - o[1]) * u[1] < 0) u = [-u[0], -u[1]];
  const v: XY = [-u[1], u[0]], aLeft = (a[0] - o[0]) * v[0] + (a[1] - o[1]) * v[1] >= 0;
  return { o, u, v, width: w, left: aLeft ? a : b, right: aLeft ? b : a };
}

export type Tone = 'info' | 'ok' | 'bad' | 'side';
export interface Preview { lines: { a: P3; b: P3; tone: Tone }[]; tags: { at: P3; text: string; tone: Tone }[] }
/** What to draw for the marking so far with the pointer at `hover` (null: off the scan). eye: where the viewer stands
 *  (before the top is placed, "up" is away from them); need_m: what the walker needs through a doorway. */
export function preview(m: Marking, hover: P3 | null, ctx: { eye: XY; need_m: number }): Preview {
  const out: Preview = { lines: [], tags: [] }, pts = hover && !isComplete(m) ? [...m.pts, hover] : m.pts;
  const mid = (a: P3, b: P3, dz = 0): P3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + dz];
  if (pts.length < 2) return out;
  const [a, b] = pts, w = flat(a, b);
  if (m.kind === 'door') {
    const ok = w >= ctx.need_m, z = Math.max(a[2], b[2], 0.9);
    const A: P3 = [a[0], a[1], z], B: P3 = [b[0], b[1], z];
    out.lines.push({ a: A, b: B, tone: ok ? 'ok' : 'bad' });
    out.tags.push({ at: mid(A, B, 0.2), text: `${cm(w)} clear · the walker needs ${cm(ctx.need_m)}`, tone: ok ? 'ok' : 'bad' });
    return out;
  }
  const z0 = Math.min(a[2], b[2]);
  out.lines.push({ a, b, tone: 'info' });
  out.tags.push({ at: mid(a, b, 0.12), text: `${cm(w)} wide`, tone: w < 0.91 ? 'bad' : 'info' });
  const top = pts[2], toward: XY = top ? [top[0], top[1]] : (() => {   // no top yet: up the flight is away from the viewer
    const o: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [2 * o[0] - ctx.eye[0], 2 * o[1] - ctx.eye[1]] as XY;
  })();
  const E = edgeFrame(a, b, toward);
  for (const [p, name] of [[E.left, 'LEFT'], [E.right, 'RIGHT']] as const) out.tags.push({ at: [p[0], p[1], z0 + 0.45], text: name, tone: 'side' });
  if (top) {
    const rise = top[2] - z0, run = (top[0] - E.o[0]) * E.u[0] + (top[1] - E.o[1]) * E.u[1], bad = !!placeError({ kind: 'stairs', pts: [a, b] }, top);
    const foot: P3 = [E.o[0], E.o[1], z0];
    out.lines.push({ a: foot, b: top, tone: bad ? 'bad' : 'info' });
    out.tags.push({ at: [top[0], top[1], top[2] + 0.25], tone: bad ? 'bad' : 'info',
      text: rise > 0 ? `+${cm(rise)} · about ${Math.max(1, Math.round(rise / RISER))} steps · ${Math.max(0, run).toFixed(1)} m run` : 'below the bottom step' });
  }
  return out;
}

/** Flat-surface heights near each spot of the scan (floor, treads, landings), for the pointer to snap to. */
export interface Levels { cell: number; at: Map<number, number[]> }
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
/** pts: x, y, z, |nz| (z of the Gaussian's normal). Per 10 cm cell, heights of flat splats grouped within 2 cm, kept
 *  where at least 3 agree. */
export function buildLevels(pts: Float32Array, cell = 0.1): Levels {
  const raw = new Map<number, number[]>();
  for (let n = 0; n < pts.length; n += 4) {
    if (pts[n + 3] < 0.8) continue;
    const k = key(Math.floor(pts[n] / cell), Math.floor(pts[n + 1] / cell));
    let zs = raw.get(k);
    if (!zs) raw.set(k, (zs = []));
    zs.push(pts[n + 2]);
  }
  const at = new Map<number, number[]>();
  for (const [k, zs] of raw) {
    zs.sort((x, y) => x - y);
    const lv: number[] = [];
    for (let s = 0; s < zs.length;) {
      let e = s;
      while (e + 1 < zs.length && zs[e + 1] - zs[s] <= 0.02) e++;
      if (e - s + 1 >= 3) lv.push(zs[(s + e) >> 1]);
      s = e + 1;
    }
    if (lv.length) at.set(k, lv);
  }
  return { cell, at };
}
/** The flat level within `tol` of z around (x, y) (this cell and its neighbours), or null: nothing flat there. */
export function snapZ(L: Levels, x: number, y: number, z: number, tol = 0.06): number | null {
  const i = Math.floor(x / L.cell), j = Math.floor(y / L.cell);
  let best: number | null = null;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
    for (const h of L.at.get(key(i + di, j + dj)) ?? []) if (Math.abs(h - z) <= tol && (best === null || Math.abs(h - z) < Math.abs(best - z))) best = h;
  return best;
}

/** Handles on a measured stair or doorway: drag one to fix a point without marking again. */
export interface Handle { key: string; at: P3; label: string }
export function stairHandles(st: Stair): Handle[] {
  const zb = st.treads_z?.[0] ?? RISER, top = st.top_z ?? st.treads_z?.at(-1) ?? 0.5;
  return [{ key: 'b0', at: [...st.bottom[0], zb], label: 'bottom step, one end' }, { key: 'b1', at: [...st.bottom[1], zb], label: 'bottom step, other end' },
    { key: 'top', at: [...st.top, top], label: 'top (the landing)' }];
}
/** The stair with one handle moved: the geometry changes, so what was measured from it goes (the caller re-measures).
 *  What was set by hand (rails, the device at the top) stays. */
export function moveStairHandle(st: Stair, k: string, p: P3): Stair {
  const { treads_z: _z, tread_fronts_m: _f, tread_depth_m: _d, width_m: _w, rails: _r, ...keep } = st;
  const bottom: [XY, XY] = [k === 'b0' ? [p[0], p[1]] : st.bottom[0], k === 'b1' ? [p[0], p[1]] : st.bottom[1]];
  return { ...keep, bottom, ...(k === 'top' ? { top: [p[0], p[1]] as XY, top_z: p[2] } : {}), measured: 'splat' };
}
export const stairPoints = (st: Stair): P3[] => stairHandles(st).map(h => h.at);
export function doorHandles(d: Door): Handle[] {
  return [{ key: 'a', at: [...d.a, 1.0], label: 'one jamb' }, { key: 'b', at: [...d.b, 1.0], label: 'the other jamb' }];
}
export const moveDoorHandle = (d: Door, k: string, p: P3): Door => ({ ...d, [k === 'a' ? 'a' : 'b']: [p[0], p[1]] as XY, hinge: undefined, measured: 'clicks' });

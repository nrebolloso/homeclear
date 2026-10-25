// Designed additions drawn as splats, so they sit in the scan's own light instead of as flat teal geometry: a bar is a
// dense run of small gaussians along a polyline, in the colour of the real rail (or a neutral metal where nothing was
// scanned). Pure (no three, no GPU), so it is tested. DESIGNED, not built: the card next to it says so; nothing is measured from it.
import { stairFrame, pitchAt, matToQuat, SPLAT_STRIDE, type Stair } from './stairs.ts';

export type RGB = [number, number, number];
export type XYZ = [number, number, number];
/** brushed metal, for a rail where the scan has none to copy */
export const NEUTRAL_RAIL: RGB = [0.46, 0.47, 0.5];

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const cross = (a: XYZ, b: XYZ): XYZ => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: XYZ): XYZ => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The scanned rail's own colour: the median of each channel over its splat records (SPLAT_STRIDE floats each). */
export function toneOf(src: Float32Array): RGB {
  const n = Math.floor(src.length / SPLAT_STRIDE);
  if (!n) return NEUTRAL_RAIL;
  const ch = (k: number) => med(Array.from({ length: n }, (_, i) => src[i * SPLAT_STRIDE + k]));
  return [ch(11), ch(12), ch(13)];
}

/** Splat records for a round bar of `radius` along the polyline `pts`: a ring of four gaussians per station, lit from above
 *  (the top a touch lighter, the underside darker) so it reads as a cylinder, each stretched along the bar. */
export function barSplats(pts: XYZ[], radius: number, tone: RGB, opacity = 0.95): Float32Array {
  const out: number[] = [], step = Math.max(0.006, radius * 0.7), sp = radius * 0.5, sa = step * 0.9;
  const shade = (k: number): RGB => tone.map(c => Math.min(1, Math.max(0, c * k))) as RGB;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 1e-6) continue;
    const d = unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const y = unit(cross(Math.abs(d[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1], d)), z = cross(d, y);   // d x y = z: a right-handed frame, x along the bar
    const q = matToQuat([[d[0], y[0], z[0]], [d[1], y[1], z[1]], [d[2], y[2], z[2]]]);
    const n = Math.max(1, Math.round(len / step));
    for (let j = 0; j <= n; j++) {
      const f = j / n, c: XYZ = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      for (let r = 0; r < 4; r++) {
        const an = r * Math.PI / 2 + Math.PI / 4, oy = Math.cos(an) * radius * 0.45, oz = Math.sin(an) * radius * 0.45;
        const p: XYZ = [c[0] + y[0] * oy + z[0] * oz, c[1] + y[1] * oy + z[1] * oz, c[2] + y[2] * oy + z[2] * oz];
        const up = (y[2] * oy + z[2] * oz) / (radius * 0.45) || 0;   // -1 underneath .. 1 on top
        out.push(...p, sa, sp, sp, ...q, opacity, ...shade(0.9 + 0.2 * up));
      }
    }
  }
  return new Float32Array(out);
}

/** The scanned (mirrored) rail's centre line: its signed side offset t and a straight fit of its height over the run. */
export function fitRail(src: Float32Array, st: Stair): { t: number; z: (s: number) => number } {
  const F = stairFrame(st), n = Math.floor(src.length / SPLAT_STRIDE), S: number[] = [], Z: number[] = [], T: number[] = [];
  for (let i = 0; i < n; i++) { const o = i * SPLAT_STRIDE, { s, t } = F.local([src[o], src[o + 1]]); S.push(s); T.push(t); Z.push(src[o + 2]); }
  const t = n ? med(T) : 0, ms = n ? S.reduce((a, x) => a + x, 0) / n : 0, mz = n ? Z.reduce((a, x) => a + x, 0) / n : 0;
  const vs = S.reduce((a, x) => a + (x - ms) ** 2, 0), k = vs > 1e-6 ? S.reduce((a, x, i) => a + (x - ms) * (Z[i] - mz), 0) / vs : 0;
  return { t, z: (s: number) => mz + k * (s - ms) };
}

export interface RailOpts {
  /** signed offset of the rail's centre line from the stair's centre (+ left), and its height at s along the flight */
  t: number; z: (s: number) => number; tone: RGB;
  /** the sloped bar over the flight (default true) and the level returns 30 cm past each end (default true) */
  flight?: boolean; returns?: boolean; radius?: number;
}
/** A wall-mounted handrail as splat records: the flight bar, level returns, and a bracket to the wall every 90 cm. */
export function railSplats(st: Stair, o: RailOpts): Float32Array {
  const F = stairFrame(st), r = o.radius ?? 0.02, P = (s: number, h: number): XYZ => { const [x, y] = F.world(s, o.t); return [x, y, h]; };
  const parts: Float32Array[] = [], wall = Math.sign(o.t) * F.width / 2, zb = o.z(0), zt = o.z(F.run), bracket = (s: number, h: number) => {
    const [x0, y0] = F.world(s, o.t), [x1, y1] = F.world(s, wall);
    if (Math.hypot(x1 - x0, y1 - y0) > 0.01) parts.push(barSplats([[x0, y0, h - 0.03], [x1, y1, h - 0.03]], 0.008, o.tone));
  };
  if (o.flight !== false) {
    parts.push(barSplats([P(0, zb), P(F.run, zt)], r, o.tone));
    for (let s = 0.2; s < F.run; s += 0.9) bracket(s, o.z(s));
  }
  if (o.returns !== false) {
    parts.push(barSplats([P(-0.3, zb), P(0, zb)], r, o.tone), barSplats([P(F.run, zt), P(F.run + 0.3, zt)], r, o.tone));
    bracket(-0.25, zb); bracket(F.run + 0.25, zt);
  }
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}
/** The flight's sloped line at `h` above the nosing, as a height function (a designed rail where nothing was scanned). */
export const overNosing = (st: Stair, h: number) => { const p = pitchAt(st); return (s: number) => p(s) + h; };

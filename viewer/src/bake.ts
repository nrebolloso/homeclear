// Drawn fixtures (a tube, a flat strip) sampled into Gaussians, so a committed addition becomes part of the scan: it takes the
// room's own light (the night shader) and sits in the same depth-less splat pass instead of floating on top as a flat mesh.
// Pure math, no three.js, so it runs in node. The output is main.ts's splat layout: x y z, sx sy sz, qx qy qz qw, opacity, r g b
// (stairs.ts SPLAT_STRIDE). Visual only, like the mirrored rail: tinted "designed, not built", never measured.
export type V3 = [number, number, number];
export type RGB = [number, number, number];
export interface BakeTube { kind: 'tube'; a: V3; b: V3; r: number; color: RGB }
/** a box turned by `yaw` about z; its top and four sides are sampled (a fixture stuck to a tread has no underside) */
export interface BakeBox { kind: 'box'; c: V3; half: V3; yaw: number; color: RGB }
export type BakeShape = BakeTube | BakeBox;

const STRIDE = 14;
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qaxis = (x: number, y: number, z: number, ang: number): Q => { const s = Math.sin(ang / 2); return [x * s, y * s, z * s, Math.cos(ang / 2)]; };
/** the turn that takes the unit vector `from` to `to` */
function qfrom(from: V3, to: V3): Q {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (d < -0.999999) { const ax: V3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const c: V3 = [from[1] * ax[2] - from[2] * ax[1], from[2] * ax[0] - from[0] * ax[2], from[0] * ax[1] - from[1] * ax[0]]; const l = Math.hypot(...c); return [c[0] / l, c[1] / l, c[2] / l, 0]; }
  const c: V3 = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]];
  const w = 1 + d, l = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
}
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
// the splats carry their light baked in, so the form is faked once here: lit from above, a side a little darker
const topLight = (nz: number) => 0.62 + 0.38 * Math.max(0, nz);

function push(out: number[], p: V3, s: V3, q: Q, op: number, c: RGB) { out.push(p[0], p[1], p[2], s[0], s[1], s[2], q[0], q[1], q[2], q[3], op, c[0], c[1], c[2]); }

export function sampleTube(t: BakeTube, spacing = 0.012, out: number[] = []): number[] {
  const d: V3 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], L = Math.hypot(...d);
  if (L < 1e-6) return out;
  const u: V3 = [d[0] / L, d[1] / L, d[2] / L], q = qfrom([1, 0, 0], u);   // each Gaussian is long along its local x: along the tube
  // two vectors across the tube
  const ref: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let n1: V3 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]; const l1 = Math.hypot(...n1); n1 = [n1[0] / l1, n1[1] / l1, n1[2] / l1];
  const n2: V3 = [u[1] * n1[2] - u[2] * n1[1], u[2] * n1[0] - u[0] * n1[2], u[0] * n1[1] - u[1] * n1[0]];
  const steps = Math.max(1, Math.ceil(L / spacing)), around = Math.max(6, Math.ceil((2 * Math.PI * t.r) / spacing));
  for (let i = 0; i <= steps; i++) {
    const s = (i / steps) * L;
    for (let k = 0; k < around; k++) {
      const a = (k / around) * 2 * Math.PI, nx = Math.cos(a) * n1[0] + Math.sin(a) * n2[0], ny = Math.cos(a) * n1[1] + Math.sin(a) * n2[1], nz = Math.cos(a) * n1[2] + Math.sin(a) * n2[2];
      const rr = t.r * 0.72;
      push(out, [t.a[0] + u[0] * s + nx * rr, t.a[1] + u[1] * s + ny * rr, t.a[2] + u[2] * s + nz * rr], [spacing * 0.7, t.r * 0.5, t.r * 0.5], q, 0.97, shade(t.color, topLight(nz)));
    }
  }
  return out;
}

export function sampleBox(b: BakeBox, spacing = 0.012, out: number[] = []): number[] {
  const yawQ = qaxis(0, 0, 1, b.yaw), [hx, hy, hz] = b.half, cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
  const world = (x: number, y: number, z: number): V3 => [b.c[0] + x * cs - y * sn, b.c[1] + x * sn + y * cs, b.c[2] + z];
  // face: its local normal axis, sign, the two tangent half sizes, and the turn that takes a Gaussian's local z to that normal
  const faces: [number, number, number, number, Q, number][] = [
    [2, 1, hx, hy, qaxis(0, 0, 1, 0), 1], [0, 1, hy, hz, qaxis(0, 1, 0, Math.PI / 2), 0.78], [0, -1, hy, hz, qaxis(0, 1, 0, -Math.PI / 2), 0.7],
    [1, 1, hx, hz, qaxis(1, 0, 0, -Math.PI / 2), 0.84], [1, -1, hx, hz, qaxis(1, 0, 0, Math.PI / 2), 0.74]];
  for (const [axis, sign, ta, tb, q0, light] of faces) {
    const na = Math.max(1, Math.ceil((2 * ta) / spacing)), nb = Math.max(1, Math.ceil((2 * tb) / spacing)), qq = qmul(yawQ, q0);
    for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
      const u = -ta + ((i + 0.5) / na) * 2 * ta, v = -tb + ((j + 0.5) / nb) * 2 * tb;
      const l: V3 = axis === 2 ? [u, v, sign * hz] : axis === 0 ? [sign * hx, u, v] : [u, sign * hy, v];
      push(out, world(...l), [spacing * 0.62, spacing * 0.62, 0.0015], qq, 0.97, shade(b.color, light));
    }
  }
  return out;
}

/** every shape of one build, as one flat array (a Float32Array of STRIDE floats per Gaussian) */
export function sampleShapes(shapes: BakeShape[], spacing = 0.012): Float32Array {
  const out: number[] = [];
  for (const s of shapes) (s.kind === 'tube' ? sampleTube : sampleBox)(s as never, spacing, out);
  return new Float32Array(out);
}
export const BAKE_STRIDE = STRIDE;

// Hazard spotlights: which things to point at, and how to colour the measured bump heights. Pure data (tested in
// tests/spotlight.test.ts); main.ts turns these into outlines, pins, labels and the camera tour.
// Measured and proposed are never mixed: a spot is `measured` (splat geometry), `reason-confirmed` (a Cosmos Reason
// proposal that the measured grids back up) or `reason-ot` (a proposal nothing measured can check: "OT should check").
import type { GridMeta, XY } from './grid.ts';

export type SpotKind = 'measured' | 'reason-confirmed' | 'reason-ot';
export interface Spot {
  id: string; kind: SpotKind; xy: XY;
  /** headline on the label and in the tour caption */
  label: string; detail: string;
  /** 0..1, the order of the tour and the strength of the glow */
  severity: number;
  /** the movable object that makes this hazard (an index into the scene's objects), when there is one */
  object: number;
  /** the bump's measured height (m), when it is a bump */
  measured_height_m?: number;
}

interface HazardIn { type: string; name: string; position: XY; height_m?: number; min_side_clearance_m?: number; per_month?: number; estimated?: boolean; ot_check?: boolean }
interface ReasonIn { source?: string; type?: string; position_m?: number[]; verdict?: string; measured?: string | null; note?: string }

const CLEAR_M = 0.3;   // a gap this wide per side is no hazard; narrower glows harder
const MERGE_M = 0.3;   // a Reason proposal this close to a measured spot is the same thing

/** The spots for the current route: every measured hazard, then Cosmos Reason proposals that are not dismissed.
 *  `margin_m` is the stage 6b height error, shown with the measured heights as the range the number could be in. */
export function spots(hazards: HazardIn[], objects: { name: string }[], reason: ReasonIn[], margin_m = 0): Spot[] {
  const worstMonth = Math.max(1e-9, ...hazards.map(h => h.per_month ?? 0));
  const out: Spot[] = hazards.map((h, n) => {
    const bump = h.type === 'floor_bump';
    const obj = objects.findIndex(o => o.name === h.name);
    const sev = bump ? Math.min(1, 0.25 + 0.75 * ((h.per_month ?? 0) / worstMonth)) : Math.min(1, Math.max(0.2, (CLEAR_M - (h.min_side_clearance_m ?? CLEAR_M)) / (CLEAR_M / 2)));
    const cm = (x: number) => (100 * x).toFixed(1);
    return {
      id: `m${n}`, kind: 'measured' as const, xy: h.position, object: bump ? obj : -1, severity: sev, measured_height_m: bump ? h.height_m : undefined,
      label: bump ? `${h.name} ${h.estimated ? '~' : ''}${cm(h.height_m!)} cm${h.estimated ? ' (est.)' : margin_m ? ` ±${cm(margin_m)}` : ''}` : `${(100 * h.min_side_clearance_m!).toFixed(0)} cm/side`,
      detail: bump ? `${h.name}: ${h.estimated ? 'thin cord, height is a typical value' : `${cm(h.height_m!)} cm edge`}${h.per_month ? `, ${h.per_month.toFixed(2)} toe catches/month` : ''}`
        : `tight gap: ${(100 * h.min_side_clearance_m!).toFixed(0)} cm each side of the walker`,
    };
  });
  for (const [n, r] of reason.entries()) {
    if (r.source !== 'cosmos_reason' || r.verdict === 'dismissed' || !r.position_m) continue;
    const xy: XY = [r.position_m[0], r.position_m[1]], confirmed = (r.verdict ?? '').startsWith('confirmed');
    const near = out.find(s => s.kind === 'measured' && Math.hypot(s.xy[0] - xy[0], s.xy[1] - xy[1]) < MERGE_M);
    if (confirmed && near) { near.detail += ` · Cosmos Reason also flagged it: ${r.note ?? ''}`; continue; }
    out.push({ id: `r${n}`, kind: confirmed ? 'reason-confirmed' : 'reason-ot', xy, object: -1, severity: confirmed ? 0.6 : 0.4,
      label: confirmed ? `proposed, geometry agrees` : `proposed: OT should check`,
      detail: `${r.note ?? r.type ?? 'hazard'} · proposed by Cosmos Reason${confirmed ? `; ${r.measured ?? 'geometry agrees'}` : ', not measurable from the splat'}` });
  }
  return out.sort((a, b) => b.severity - a.severity);
}

/** Camera spot for a tour stop: back along the route from the hazard, eye height, looking at it. */
export function vantage(xy: XY, routeXY: XY[], back = 1.5, eye = 0.9): { x: number; y: number; z: number; yaw: number; pitch: number } {
  let k = 0, best = Infinity;
  routeXY.forEach((p, i) => { const d = Math.hypot(p[0] - xy[0], p[1] - xy[1]); if (d < best) { best = d; k = i; } });
  const a = routeXY[Math.max(0, k - 1)], b = routeXY[Math.min(routeXY.length - 1, k + 1)];
  let dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) { dx = 1; dy = 0; } else { dx /= l; dy /= l; }
  const x = xy[0] - dx * back, y = xy[1] - dy * back;
  return { x, y, z: eye, yaw: Math.atan2(xy[1] - y, xy[0] - x), pitch: Math.atan2(-eye + 0.05, back) };
}

/** Bump height (m) -> colour 0..255 for the height overlay: cool under a few mm, amber near the 1 cm trip range, red above. */
export function heightRGB(h: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, h / 0.02));
  return t < 0.5 ? [Math.round(60 + 390 * t), Math.round(170 + 40 * t), Math.round(255 - 360 * t)] : [255, Math.round(215 - 330 * (t - 0.5)), 40];
}

/** RGBA texels for a grid-sized floor overlay (index = j * nx + i, array[i, j] covers x0 + i c, y0 + j c): bump cells
 *  coloured by height, 0 alpha elsewhere; cells whose height is only a typical value (`est`) are hatched. */
export function heightTexels(g: GridMeta, bump: Float32Array, est: Uint8Array, minH = 0.003): Uint8Array {
  const [nx, ny] = g.shape, out = new Uint8Array(nx * ny * 4);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const h = bump[i * ny + j];
      if (!(h >= minH)) continue;
      const o = (j * nx + i) * 4;
      if (est[i * ny + j] && (i + j) % 2) { out.set([200, 90, 255, 150], o); continue; }   // hatch: estimated, not measured
      out.set([...heightRGB(h), 170], o);
    }
  return out;
}

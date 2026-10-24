// Performance mode: what the viewer thins out when frames matter more than detail (the headset, a weak laptop), and the
// pure helpers behind it. Visual only: the numbers, checks and layouts never change. Tested in node.
import type { XY } from './grid.ts';

export interface PerfCfg {
  /** device pixel ratio cap on the monitor (the headset sets its own framebuffer scale) */
  pixel_ratio: number;
  /** Spark: how far out (standard deviations) and how big (px) a splat is drawn; the defaults are sqrt(8) and 512 */
  max_std_dev: number; max_pixel_radius: number;
}
export const PERF: PerfCfg = { pixel_ratio: 1, max_std_dev: 2.2, max_pixel_radius: 128 };
export const FULL: PerfCfg = { pixel_ratio: 1.5, max_std_dev: Math.sqrt(8), max_pixel_radius: 512 };

/** Where it runs: on the monitor, in a standalone headset (a Quest 2 renders a thinned scene by itself), or over
 *  Link / Air Link (a PC graphics card renders the full scene and streams it). */
export type Tier = 'flat' | 'quest' | 'link';

/** `?link=1` says Link outright. The Link guide's URL also asks for Spark's full-quality splats (`stddev` at least 2.8
 *  and `maxpx` at least 512, the defaults), which no standalone headset can afford: that counts as Link too. */
export function tierAtLoad(search: string, xr: boolean): Tier {
  if (!xr) return 'flat';
  const q = new URLSearchParams(search), num = (k: string) => (q.has(k) ? Number(q.get(k)) : NaN);
  const full = num('stddev') >= 2.8 && num('maxpx') >= 512;
  return q.get('link') === '1' || full ? 'link' : 'quest';
}

/** Performance mode at load: `?perf=1|0` wins; a standalone headset is on; otherwise what the person chose last time
 *  (so Link and the monitor start at full quality). */
export function perfAtLoad(search: string, tier: Tier, stored: string | null): boolean {
  const q = new URLSearchParams(search).get('perf');
  if (q !== null) return q !== '0';
  return tier === 'quest' || stored === '1';
}

/** Splat limits. `?stddev=` and `?maxpx=` always win (the VR team's names), performance mode only supplies the default. */
export function splatCfg(search: string, perf: boolean): Pick<PerfCfg, 'max_std_dev' | 'max_pixel_radius'> {
  const q = new URLSearchParams(search), dflt = perf ? PERF : FULL;
  const num = (k: string, d: number) => { const v = Number(q.get(k)); return q.has(k) && v > 0 ? v : d; };
  return { max_std_dev: num('stddev', dflt.max_std_dev), max_pixel_radius: num('maxpx', dflt.max_pixel_radius) };
}

export interface XrCfg {
  /** render-resolution multiplier (1 = the headset's recommended size) */
  scale: number;
  /** 0 off .. 1 strongest fixed foveation */
  foveation: number;
  /** target refresh rate to request, 0 = leave it (Link takes its rate from the Link app, so `hz` does nothing there) */
  hz: number;
}
/** Headset settings: a standalone Quest gets a little less resolution, full foveation and 72 Hz; Link and the monitor keep
 *  full resolution and no foveation, since the PC can afford it. `?xrscale=`, `?foveation=` and `?hz=` override. */
export function xrCfg(search: string, tier: Tier): XrCfg {
  const q = new URLSearchParams(search), quest = tier === 'quest';
  const num = (k: string, d: number) => { const v = Number(q.get(k)); return q.has(k) && Number.isFinite(v) && v >= 0 ? v : d; };
  return { scale: Math.max(0.25, num('xrscale', quest ? 0.85 : 1)), foveation: Math.min(1, num('foveation', quest ? 1 : 0)), hz: num('hz', quest ? 72 : 0) };
}

export interface HzIn { type: string; name?: string; position: XY; height_m?: number; min_side_clearance_m?: number; estimated?: boolean }
export interface HzCluster<H extends HzIn> { rep: H; n: number; label: string }
const cm = (x: number, d = 1) => (100 * x).toFixed(d);

/** One word for the label of a single hazard (what drawPlan always said). */
export function hazardLabel(h: HzIn): string {
  return h.type === 'floor_bump' ? `${h.name} ${h.estimated ? '~' : ''}${cm(h.height_m!)} cm${h.estimated ? ' (est.)' : ''}` : `${cm(h.min_side_clearance_m!, 0)} cm/side`;
}

/** Hazards of one type within `tol` metres of each other drawn as one ring with one label ("×4 bumps, worst 1.9 cm"),
 *  so a row of bumps along a threshold is not a pile of overlapping labels. The ring sits on the worst one (tallest
 *  bump, narrowest gap). Input order is kept for the clusters' first members. */
export function clusterHazards<H extends HzIn>(hs: H[], tol = 0.3): HzCluster<H>[] {
  const groups: { anchor: XY; members: H[] }[] = [];
  for (const h of hs) {
    const g = groups.find(q => q.members[0].type === h.type && Math.hypot(q.anchor[0] - h.position[0], q.anchor[1] - h.position[1]) <= tol);
    if (g) g.members.push(h); else groups.push({ anchor: h.position, members: [h] });
  }
  return groups.map(({ members }) => {
    const bump = members[0].type === 'floor_bump';
    const rep = members.reduce((w, h) => (bump ? (h.height_m ?? 0) > (w.height_m ?? 0) : (h.min_side_clearance_m ?? Infinity) < (w.min_side_clearance_m ?? Infinity)) ? h : w);
    const n = members.length;
    return { rep, n, label: n === 1 ? hazardLabel(rep) : bump ? `×${n} bumps, worst ${cm(rep.height_m!)} cm` : `×${n} tight spots, down to ${cm(rep.min_side_clearance_m!, 0)} cm/side` };
  });
}

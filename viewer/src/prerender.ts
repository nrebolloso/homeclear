// Pre-rendered Cosmos clips are made for a layout. layoutKey() names a layout canonically, so a clip made for "rug
// removed + nightstand beside the bed" is found again whenever the viewer is in that layout, however it got there.
import type { Layout } from './grid.ts';

const r5 = (x: number) => (Math.round(x * 20) / 20).toFixed(2);   // 5 cm: a nudge below that is the same layout

/** Canonical name of a layout: only what differs from the capture (moved/removed objects, taped boxes, raises, adds). */
export function layoutKey(objs: { name: string; pivot: number[] }[], lay: Layout): string {
  const parts: string[] = [];
  objs.forEach((o, k) => {
    const p = lay.poses[k];
    if (p.taped && !p.removed) parts.push(`${o.name}:taped`);
    if (p.removed) parts.push(`${o.name}:removed`);
    else {
      const yaw = ((Math.round((p.yaw * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
      if (Math.hypot(p.x - o.pivot[0], p.y - o.pivot[1]) > 0.025 || yaw) parts.push(`${o.name}:${r5(p.x)},${r5(p.y)},${yaw}`);
    }
  });
  for (const [[x0, y0], [x1, y1]] of lay.flattened) parts.push(`flat:${r5(x0)},${r5(y0)},${r5(x1)},${r5(y1)}`);
  for (const [k, v] of Object.entries(lay.raised ?? {})) if (v) parts.push(`raise:${k}:${r5(v)}`);
  for (const a of lay.added ?? []) parts.push(`add:${a}`);
  return parts.sort().join('|') || 'original';
}

export interface ClipMeta { file: string; layout_key?: string; route?: string; condition?: string; mode?: string; title?: string; layout?: string; prompt?: string }

/** Clips for this layout and route first (exact), then the rest; each flagged. */
export function rankClips(clips: ClipMeta[], key: string, route: string): (ClipMeta & { exact: boolean })[] {
  return clips.map(c => ({ ...c, exact: c.layout_key === key && (!c.route || c.route === route) }))
    .sort((a, b) => +b.exact - +a.exact);
}

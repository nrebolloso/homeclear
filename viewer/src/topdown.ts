// Top-down map of a layout for paper and phones (OT report, family fix card): floor, walls, fog, route, hazards,
// furniture where it is now (moved: blue; removed: dashed where it was), numbered pins for the fixes.
import { worldFootprint, type GridMeta, type Layers, type Layout, type XY, type Footprinted } from './grid.ts';

export interface TopdownInput {
  g: GridMeta; L: Layers; coverage?: Uint8Array; coverageGood?: number;
  objs: (Footprinted & { name: string })[];
  layout: Layout; original: Layout; route?: XY[]; hazards?: { position: XY; type: string; label?: string }[];
  pins?: { at: XY; n: number }[]; pxPerM?: number;
}

export function drawTopdown(cv: HTMLCanvasElement, t: TopdownInput) {
  const { g, L } = t, [nx, ny] = g.shape, s = t.pxPerM ?? 80, c = cv.getContext('2d')!;
  cv.width = Math.ceil(nx * g.cell_m * s); cv.height = Math.ceil(ny * g.cell_m * s);
  const X = (x: number) => (x - g.origin_xy[0]) * s, Y = (y: number) => cv.height - (y - g.origin_xy[1]) * s;
  const img = c.createImageData(nx, ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const k = i * ny + j, p = ((ny - 1 - j) * nx + i) * 4;
    const col = L.obst[k] ? [60, 64, 70] : L.bump[k] > 0.003 ? [240, 150, 60] : L.floor[k]
      ? (t.coverage && t.coverage[k] < (t.coverageGood ?? 3) ? [200, 202, 206] : [236, 230, 218]) : [255, 255, 255];
    img.data.set([...col, 255], p);
  }
  const tmp = document.createElement('canvas');
  tmp.width = nx; tmp.height = ny;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = false;
  c.drawImage(tmp, 0, 0, cv.width, cv.height);
  const poly = (pts: XY[]) => { c.beginPath(); pts.forEach(([x, y], n) => (n ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)))); c.closePath(); };
  t.objs.forEach((o, k) => {
    const now = t.layout.poses[k], then = t.original.poses[k];
    const moved = now.removed || Math.hypot(now.x - then.x, now.y - then.y) > 0.01 || Math.abs(now.yaw - then.yaw) > 0.01;
    if (moved) {   // where it was: dashed outline
      c.setLineDash([6, 4]); c.strokeStyle = '#a05cc0'; c.lineWidth = 2;
      poly(worldFootprint(o, then)); c.stroke(); c.setLineDash([]);
    }
    if (now.removed) return;
    poly(worldFootprint(o, now));
    c.fillStyle = o.layer === 'bump' ? 'rgba(240,150,60,0.55)' : moved ? 'rgba(70,130,230,0.75)' : 'rgba(120,110,100,0.75)';
    c.fill();
    c.fillStyle = '#111'; c.font = '600 12px system-ui';
    c.fillText(o.name, X(now.x) - 18, Y(now.y) + 4);
  });
  if (t.route?.length) {
    c.strokeStyle = '#1b8fd8'; c.lineWidth = 3; c.beginPath();
    t.route.forEach(([x, y], n) => (n ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)))); c.stroke();
  }
  for (const h of t.hazards ?? []) {
    c.strokeStyle = h.type === 'floor_bump' ? '#e0621a' : '#d4a800'; c.lineWidth = 3;
    c.beginPath(); c.arc(X(h.position[0]), Y(h.position[1]), 12, 0, 7); c.stroke();
  }
  for (const p of t.pins ?? []) {
    c.fillStyle = '#0a7d3b'; c.beginPath(); c.arc(X(p.at[0]), Y(p.at[1]), 11, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.font = '700 13px system-ui'; c.textAlign = 'center'; c.fillText(String(p.n), X(p.at[0]), Y(p.at[1]) + 5); c.textAlign = 'start';
  }
  // scale bar: 1 m
  c.fillStyle = '#111'; c.fillRect(10, cv.height - 14, s, 4); c.font = '11px system-ui'; c.fillText('1 m', 14 + s, cv.height - 9);
  return cv;
}

// The family's fix card on a phone: opened from the QR code in the walker game. The URL hash carries the layout and
// the numbered fixes (share.ts cardState); the map is redrawn here from the scene's own grids.
import { stamp, type GridMeta, type Layers, type Layout, type Pose } from './grid.ts';
import { drawTopdown } from './topdown.ts';
import { decodeCard } from './share.ts';

const $ = (id: string) => document.getElementById(id)!;
const card = decodeCard(location.hash.slice(1));
const base = `scene/${card.s}/`;
const get = (f: string) => fetch(base + f).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
const sc = await get('scene.json').then(r => r.json());
const bin = (f: string) => get(f).then(r => r.arrayBuffer());
const g: GridMeta = sc.grid;
const L0: Layers = { floor: new Uint8Array(await bin(sc.grid.floor)), obst: new Uint8Array(await bin(sc.grid.obstacles)),
  bump: new Float32Array(await bin(sc.grid.bump_height_m)) };
const coverage = new Uint8Array(await bin(sc.grid.coverage));
const original: Layout = { poses: sc.objects.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })), flattened: [] };
const changed = new Map(card.p.map(([n, x, y, yaw, rm]) => [n, { x, y, yaw, removed: !!(rm & 1), taped: !!(rm & 2) } as Pose]));
const layout: Layout = { poses: sc.objects.map((o: any, k: number) => changed.get(o.name) ?? original.poses[k]), flattened: card.f };
const L = stamp(g, L0, sc.objects, layout.poses, layout.flattened);
drawTopdown($('map') as HTMLCanvasElement, { g, L, coverage, coverageGood: sc.grid.coverage_good, objs: sc.objects, layout, original,
  pins: card.a.flatMap(([, , , , x, y], n) => (Number.isFinite(x) && Number.isFinite(y) ? [{ at: [x, y] as [number, number], n: n + 1 }] : [])), pxPerM: 70 });

const key = `fixcard:${card.s}:${location.hash.length}:${card.a.map(a => a[0]).join('|')}`;
const done: Record<number, boolean> = (() => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem(key, JSON.stringify(done)); } catch { /* private mode: ticks just aren't kept */ } };
$('sub').textContent = `${card.a.length} change${card.a.length === 1 ? '' : 's'} for ${card.s.replace(/_/g, ' ')} · numbers match the map`;
card.a.forEach(([label, cost, min, product], n) => {
  const li = document.createElement('li'), num = document.createElement('div'), body = document.createElement('div');
  num.className = 'n'; num.textContent = String(n + 1);
  const t = document.createElement('div'); t.textContent = label; t.style.fontWeight = '600';
  const meta = document.createElement('div'); meta.className = 'dim';
  meta.textContent = [cost !== null ? `about $${cost}` : '', min ? `${min} min` : '', product].filter(Boolean).join(' · ');
  const lab = document.createElement('label'), box = document.createElement('input');
  box.type = 'checkbox'; box.checked = !!done[n];
  box.onchange = () => { done[n] = box.checked; save(); total(); };
  lab.append(box, 'done');
  body.append(t, meta, lab);
  li.append(num, body);
  $('list').appendChild(li);
});
function total() {
  const cost = card.a.reduce((s, a) => s + (a[1] ?? 0), 0), min = card.a.reduce((s, a) => s + (a[2] ?? 0), 0);
  $('total').textContent = `${Object.values(done).filter(Boolean).length} of ${card.a.length} done · about $${cost} and ${min} minutes in all`;
}
total();

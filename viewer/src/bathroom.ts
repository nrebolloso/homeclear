// The bathroom package: a grab bar beside each toilet (the best-evidenced home change for falls there), placed from what
// is measured and drawn as DESIGNED, not built. The toilet's box comes from config fixtures (stage 12); the floor map
// says where the walls are: the bar goes on the side wall (ADA 604.5: 42 in long, 33-36 in high), the back is the end
// nearer a wall. Seated, the person faces away from the back, so the bar is on their left or right: if that is the weak
// side, the fix says so (a fold-down bar on the strong side is the OT's call). Pure placement (tested); the mesh below.
import * as THREE from 'three';
import type { Fixture } from './checks.ts';
import type { GridMeta, Layers, XY, Intervention } from './grid.ts';
import { card } from './reimagine.ts';

/** ADA 604.5.1 side-wall bar: 1065 mm long, top 840-915 mm above the floor (centre of that range here) */
export const GRAB_BAR = { len_m: 1.065, z_m: 0.875, wall_search_m: 0.6 };
type Side = 'left' | 'right';

/** How far from p, stepping along dir, the first wall cell is (null: none within `max`). */
function wallDist(g: GridMeta, L: Layers, p: XY, dir: XY, max: number): number | null {
  const ny = g.shape[1];
  for (let d = 0; d <= max; d += g.cell_m / 2) {
    const i = Math.floor((p[0] + dir[0] * d - g.origin_xy[0]) / g.cell_m), j = Math.floor((p[1] + dir[1] * d - g.origin_xy[1]) / g.cell_m);
    if (i < 0 || j < 0 || i >= g.shape[0] || j >= ny) return null;
    if (L.obst[i * ny + j]) return d;
  }
  return null;
}

/** For one toilet box: its middle, the axis from the back to the front, which side wall is nearer, and that side as the
 *  seated person's left or right. null: no side wall within reach (a free-standing bar or a frame instead). */
export function toiletSides(g: GridMeta, L: Layers, poly: XY[]) {
  const c: XY = [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
  const e = (k: number): XY => [poly[(k + 1) % 4][0] - poly[k][0], poly[(k + 1) % 4][1] - poly[k][1]];
  const [a, b] = [e(0), e(1)], la = Math.hypot(...a), lb = Math.hypot(...b);
  // the toilet is longer front to back than it is wide
  const long: XY = la >= lb ? [a[0] / la, a[1] / la] : [b[0] / lb, b[1] / lb], half = Math.max(la, lb) / 2, halfW = Math.min(la, lb) / 2;
  const ahead = wallDist(g, L, c, long, half + 0.5), behind = wallDist(g, L, c, [-long[0], -long[1]], half + 0.5);
  const back: XY = (behind ?? 9) <= (ahead ?? 9) ? [-long[0], -long[1]] : long, front: XY = [-back[0], -back[1]];
  const leftDir: XY = [-front[1], front[0]];   // seated, facing front: left is 90 deg counter-clockwise (z up)
  const dl = wallDist(g, L, c, leftDir, halfW + GRAB_BAR.wall_search_m), dr = wallDist(g, L, c, [-leftDir[0], -leftDir[1]], halfW + GRAB_BAR.wall_search_m);
  if (dl === null && dr === null) return { c, front, wall: null as Side | null, d: 0, leftDir };
  const wall: Side = dr === null || (dl !== null && dl <= dr) ? 'left' : 'right';
  return { c, front, wall, d: (wall === 'left' ? dl : dr)!, leftDir };
}

/** One grab-bar fix per toilet fixture, on its side wall; `strong`: the patient's stronger side, if known. */
export function bathroomFixes(fixtures: Fixture[], g: GridMeta, L: Layers, strong: Side | null): Intervention[] {
  const out: Intervention[] = [];
  for (const t of fixtures.filter(f => f.kind === 'toilet' && f.poly_xy?.length === 4)) {
    const s = toiletSides(g, L, t.poly_xy as XY[]);
    if (!s.wall) continue;
    const sg = s.wall === 'left' ? 1 : -1, x = s.c[0] + s.leftDir[0] * sg * s.d, y = s.c[1] + s.leftDir[1] * sg * s.d;
    const weak = strong && strong !== s.wall;
    out.push({ id: `grab_bar_toilet:${t.name}`, kind: 'add',
      label: `Grab bar on the wall beside the ${t.name} (the patient's ${s.wall} when seated)${weak ? `: that is the weak side, OT to check a fold-down bar on the ${strong}` : ''}`,
      fixture: { name: `${t.name} grab bar`, kind: 'grab_bar', attach: t.name, side: s.wall, xyz: [+x.toFixed(3), +y.toFixed(3), GRAB_BAR.z_m], yaw: Math.atan2(s.front[1], s.front[0]) },
      cost_usd: 60, minutes: 45, effort: 2, product: '42 in (107 cm) grab bar into the studs, top 84-91 cm above the floor (ADA 604.5)' });
  }
  return out;
}

/** The added toilet grab bars: a teal bar along the wall at its height, and a tag. */
export function createBathroom3d(scene: THREE.Scene) {
  const root = new THREE.Group();
  scene.add(root);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2fd6c8, metalness: 0.5, roughness: 0.35, transparent: true });   // sorts after the splats (lights.ts)
  function build(bars: { name: string; xyz?: number[] | null; yaw?: number; side?: string }[]) {
    for (const c of [...root.children]) { root.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    for (const b of bars) {
      if (!b.xyz) continue;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, GRAB_BAR.len_m, 12), mat);
      bar.position.set(b.xyz[0], b.xyz[1], b.xyz[2]);
      bar.rotation.z = (b.yaw ?? 0) - Math.PI / 2;   // the cylinder's axis (y) along the toilet, back to front
      const tag = card(['designed, not built', `${b.name} (${b.side}), 107 cm at ${Math.round(b.xyz[2] * 100)} cm`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.035);
      tag.position.set(b.xyz[0], b.xyz[1], b.xyz[2] + 0.35);
      bar.renderOrder = 3; tag.renderOrder = 3;   // after the splats, like the stair fixtures (the wall would paint over the bar)
      root.add(bar, tag);
    }
  }
  return { root, build };
}

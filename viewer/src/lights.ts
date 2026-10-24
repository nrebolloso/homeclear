// Path lights: plug-in motion nightlights where a route leaves every light, offered as 'add' fixes ("Light the path").
// Each one is a light for the simulation (within its radius the dark multiplier stops applying: that multiplier is an
// ASSUMED number, labelled as such) and, at night, for the scan (night.ts), for the meshes (a point light) and for the
// eye (a warm bulb and a halo). Designed, not built: teal tags like every other addition. Placement is pure (tested).
import * as THREE from 'three';
import type { GridMeta, Layers, XY, Intervention } from './grid.ts';
import { card } from './reimagine.ts';

/** A typical plug-in motion nightlight (ASSUMED reach of its light on the floor), on a wall outlet. */
export const PATH_LIGHT = { r_m: 1.5, z_m: 0.3, max: 4, usd: 15, wall_search_m: 1.3, aside_m: 0.5 };
export interface Light { x: number; y: number; r: number }

const STEP = 0.25;
/** Free floor PATH_LIGHT.aside_m to one side of the route at `at` (the direction from a to b), else the point itself. */
function aside(g: GridMeta, L: Layers, at: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, ny = g.shape[1];
  for (const s of [1, -1]) {
    const p: XY = [at[0] - (dy / l) * PATH_LIGHT.aside_m * s, at[1] + (dx / l) * PATH_LIGHT.aside_m * s];
    const i = Math.floor((p[0] - g.origin_xy[0]) / g.cell_m), j = Math.floor((p[1] - g.origin_xy[1]) / g.cell_m), k = i * ny + j;
    if (i >= 0 && j >= 0 && i < g.shape[0] && j < ny && L.floor[k] && !L.obst[k]) return p;
  }
  return at;
}
/** The route at even steps along its length. */
function resample(route: XY[]): XY[] {
  const out: XY[] = route.length ? [route[0]] : [];
  let carry = 0;
  for (let k = 1; k < route.length; k++) {
    const [ax, ay] = route[k - 1], [bx, by] = route[k], len = Math.hypot(bx - ax, by - ay);
    let s = STEP - carry;
    for (; s <= len; s += STEP) out.push([ax + ((bx - ax) * s) / len, ay + ((by - ay) * s) / len]);
    carry = len - (s - STEP);
  }
  return out;
}

/** The nearest wall spot to p within `within` m: an obstacle cell with floor beside it (where an outlet would be),
 *  returned on the floor side of that wall face. null: no wall that close. */
export function wallSpot(g: GridMeta, L: Layers, p: XY, within = PATH_LIGHT.wall_search_m): XY | null {
  const [nx, ny] = g.shape, n = Math.ceil(within / g.cell_m), ci = Math.floor((p[0] - g.origin_xy[0]) / g.cell_m), cj = Math.floor((p[1] - g.origin_xy[1]) / g.cell_m);
  let best: XY | null = null, bd = Infinity;
  for (let i = Math.max(0, ci - n); i <= Math.min(nx - 1, ci + n); i++) for (let j = Math.max(0, cj - n); j <= Math.min(ny - 1, cj + n); j++) {
    const k = i * ny + j;
    if (!L.obst[k]) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (i + di < 0 || j + dj < 0 || i + di >= nx || j + dj >= ny) continue;
      const f = (i + di) * ny + (j + dj);
      if (!L.floor[f] || L.obst[f]) continue;
      const x = g.origin_xy[0] + (i + 0.5 + 0.5 * di) * g.cell_m, y = g.origin_xy[1] + (j + 0.5 + 0.5 * dj) * g.cell_m, d = Math.hypot(x - p[0], y - p[1]);
      if (d < bd && d <= within) { bd = d; best = [x, y]; }
    }
  }
  return best;
}

/** Nightlights for the dark stretches of one route. Walking it in 25 cm steps, a run more than `gap_m` long outside every
 *  light gets a nightlight on the nearest wall to the point 1 m into that run (within 1.3 m, so it still lights that
 *  point), else a battery one 50 cm beside the route on free floor (never on the walking line: it would trip someone),
 *  which then lights it from there; up to PATH_LIGHT.max. */
export function pathLights(g: GridMeta, L: Layers, route: XY[], lights: Light[], routeName = 'route', gap_m = 0.75, first = 1): Intervention[] {
  const pts = resample(route), lit: Light[] = [...lights], out: Intervention[] = [], r = PATH_LIGHT.r_m;
  const covered = (p: XY) => lit.some(l => Math.hypot(p[0] - l.x, p[1] - l.y) <= l.r * 0.9);   // a little inside the rim
  let dark = 0;
  for (let k = 0; k < pts.length && out.length < PATH_LIGHT.max; k++) {
    if (covered(pts[k])) { dark = 0; continue; }
    if (++dark * STEP < gap_m) continue;   // a short dark stretch (or tail) stays as it is
    const m = Math.min(pts.length - 1, k - dark + 1 + Math.round(1 / STEP)), at = pts[m], wall = wallSpot(g, L, at), n = first + out.length;
    const [x, y] = wall ?? aside(g, L, at, pts[Math.max(0, m - 1)], pts[Math.min(pts.length - 1, m + 1)]);
    lit.push({ x, y, r });
    dark = 0;
    out.push({ id: `path_light:${n}`, kind: 'add', label: `Motion nightlight ${n} along the ${routeName}${wall ? ', on the wall' : ' (no wall near: a battery one beside the path)'}`,
      fixture: { name: `path light ${n}`, kind: 'nightlight', xyz: [+x.toFixed(3), +y.toFixed(3), PATH_LIGHT.z_m], light_r: r },
      cost_usd: PATH_LIGHT.usd, minutes: 5, effort: 1, product: wall ? 'plug-in motion-sensor LED nightlight, warm white' : 'battery motion-sensor LED nightlight, warm white' });
  }
  return out;
}

const WARM = 0xffc37a;
let haloTex: THREE.CanvasTexture | null = null;
function halo() {
  if (!haloTex) {
    const c = document.createElement('canvas'), n = 64;
    c.width = c.height = n;
    const x = c.getContext('2d')!, gr = x.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(255,214,150,1)'); gr.addColorStop(0.25, 'rgba(255,190,110,0.55)'); gr.addColorStop(1, 'rgba(255,170,80,0)');
    x.fillStyle = gr; x.fillRect(0, 0, n, n);
    haloTex = new THREE.CanvasTexture(c);
  }
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
}

/** The added nightlights in the scene: a bulb on the wall, and at night a point light (the walker and mannequin catch
 *  it) and a halo. The scan's own glow is night.ts's (main.ts feeds it these positions). */
export function createLights3d(scene: THREE.Scene) {
  const root = new THREE.Group();
  scene.add(root);
  let items: { bulb: THREE.Mesh; glow: THREE.Sprite; lamp: THREE.PointLight }[] = [];
  // transparent (fully opaque) so it sorts with the splats: an opaque mesh draws first whatever its renderOrder, and the
  // dimmed haze in front of a wall would then paint over the bulb
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xf4efe6, emissive: WARM, emissiveIntensity: 0, roughness: 0.4, transparent: true });
  let night = false;
  function build(fixtures: { name: string; xyz?: number[] | null; light_r?: number }[]) {
    for (const c of [...root.children]) { root.remove(c); c.traverse(o => { (o as THREE.Mesh).geometry?.dispose(); }); }
    items = fixtures.filter(f => f.xyz).map(f => {
      const [x, y, z] = f.xyz!, bulb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.09), bulbMat);
      bulb.position.set(x, y, z);
      const glow = halo();
      glow.position.set(x, y, z); glow.scale.setScalar(0.5); glow.renderOrder = 3;
      const lamp = new THREE.PointLight(WARM, 0, f.light_r ?? PATH_LIGHT.r_m, 2);
      lamp.position.set(x, y, z + 0.05);
      const tag = card(['designed, not built', `${f.name}: motion nightlight`], '#7ff5e8', 'rgba(14,20,28,0.75)', 0.035);
      tag.position.set(x, y, z + 0.4);
      bulb.renderOrder = 3; tag.renderOrder = 3;   // after the splats (they don't write depth: the dimmed wall would paint over the bulb)
      root.add(bulb, glow, lamp, tag);
      return { bulb, glow, lamp };
    });
    setNight(night);
  }
  function setNight(on: boolean) {
    night = on;
    bulbMat.emissiveIntensity = on ? 1.5 : 0.15;
    for (const it of items) { it.glow.visible = on; it.lamp.intensity = on ? 1.2 : 0; }
  }
  return { root, build, setNight, count: () => items.length };
}

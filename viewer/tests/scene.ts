// Load an exported scene (viewer/public/scene/<run>/) the way main.ts does, for node --test.
import { readFileSync, existsSync } from 'node:fs';
import type { GridMeta, Layers, Pose } from '../src/grid.ts';
import type { Init } from '../src/evaluate.ts';

export function loadScene(run: string) {
  const d = new URL(`../public/scene/${run}/`, import.meta.url);
  const buf = (f: string) => readFileSync(new URL(f, d));
  const js = (f: string) => JSON.parse(buf(f).toString());
  const sc = js('scene.json');
  const b = buf(sc.grid.bump_height_m);
  const base: Layers = { floor: new Uint8Array(buf(sc.grid.floor)), obst: new Uint8Array(buf(sc.grid.obstacles)),
    bump: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  const est = sc.grid.bump_estimated ? new Uint8Array(buf(sc.grid.bump_estimated)) : new Uint8Array(base.floor.length);
  const route = js('route.json'), persona = js('persona.json'), walker = js('walker.json');
  const routes = sc.routes && existsSync(new URL(sc.routes, d)) ? js(sc.routes)
    : [{ name: 'route', ...route, trips_per_night: sc.risk.trips_per_night, night: true }];
  const poses: Pose[] = sc.objects.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 }));
  const init: Init = { g: sc.grid as GridMeta, base, est, objects: sc.objects, routes, persona, risk: sc.risk,
    interventions: sc.interventions, plan: { walker_width_m: walker.width_m, ...sc.plan }, rules: sc.hazard_rules,
    fixtures: sc.fixtures, transfer: sc.transfer, ems: sc.ems };
  return { sc, g: sc.grid as GridMeta, base, route, routes, persona, walker, poses, init, js };
}

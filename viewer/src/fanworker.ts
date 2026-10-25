// The futures fan off the main thread (futuresfan.ts): the main eval worker can be busy for ~30 s (optimize), and the fan
// must keep updating every 0.5 s. Restamps only when the layout (or the folded corner) changes; re-plans the candidate
// routes (a few A* runs) only when that or the walker's position (to ~25 cm) changes.
import { prepare, fan, routeOptions, horizonS, type FanScene, type Fold, type RouteOption, type Stamped } from './futures.ts';
import type { Layout, XY } from './grid.ts';
import type { WorldModel } from './worldmodel.ts';

let S: FanScene, wm: WorldModel | null = null, st: Stamped | null = null, key = '', rkey = '', routes: RouteOption[] = [];
self.onmessage = ({ data: m }: MessageEvent) => {
  try {
    if (m.type === 'init') { S = m.scene; st = null; key = rkey = ''; return; }
    if (m.type === 'model') { wm = m.wm; return; }
    const t = performance.now(), { layout, fold } = m as { layout: Layout; fold: Fold | null }, k = JSON.stringify([layout, fold]);
    if (k !== key || !st) { st = prepare(S, layout, fold); key = k; }
    const route = m.route as XY[] | null, rk = [k, route?.length, route?.at(-1), Math.round(m.state.x * 4), Math.round(m.state.y * 4)].join('|');
    if (rk !== rkey) { routes = route && route.length > 1 ? routeOptions(S, st, layout, m.state, route, 5 * (S.speed_mps ?? S.persona.speed_mps ?? 0.45)) : []; rkey = rk; }
    const F = fan(S, st, wm, m.state, route, m.n, m.seed, { night: m.night, ahead_s: m.ahead_s ?? horizonS(S, routes, m.state), routes, lift: m.lift });
    self.postMessage({ type: 'fan', id: m.id, F, ms: performance.now() - t });
  } catch (e) { self.postMessage({ type: 'error', id: m.id, msg: String((e as Error).stack ?? e) }); }
};

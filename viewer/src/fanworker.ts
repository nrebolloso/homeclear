// The futures fan off the main thread (futuresfan.ts): the main eval worker can be busy for ~30 s (optimize), and the fan
// must keep updating every 0.5 s. Restamps only when the layout (or the folded corner) changes.
import { prepare, fan, type FanScene, type Fold, type Stamped } from './futures.ts';
import type { Layout, XY } from './grid.ts';
import type { WorldModel } from './worldmodel.ts';

let S: FanScene, wm: WorldModel | null = null, st: Stamped | null = null, key = '';
self.onmessage = ({ data: m }: MessageEvent) => {
  try {
    if (m.type === 'init') { S = m.scene; st = null; key = ''; return; }
    if (m.type === 'model') { wm = m.wm; return; }
    const t = performance.now(), { layout, fold } = m as { layout: Layout; fold: Fold | null }, k = JSON.stringify([layout, fold]);
    if (k !== key || !st) { st = prepare(S, layout, fold); key = k; }
    const F = fan(S, st, wm, m.state, m.route as XY[] | null, m.n, m.seed, { night: m.night, ahead_s: m.ahead_s });
    self.postMessage({ type: 'fan', id: m.id, F, ms: performance.now() - t });
  } catch (e) { self.postMessage({ type: 'error', id: m.id, msg: String((e as Error).stack ?? e) }); }
};

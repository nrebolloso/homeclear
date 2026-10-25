// node planner/ts_score.ts <scene> layouts.json [rollouts] > scores.json : the viewer's own planner score (planner.ts) of
// each layout, to cross-check planner/engine.py (tests/test_planner.py) and re-score the search output for the viewer.
import { readFileSync } from 'node:fs';
import { loadScene } from '../viewer/tests/scene.ts';
import { check, score } from '../viewer/src/planner.ts';
const [run, file, roll] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(new URL(`../configs/planner/${run}.json`, import.meta.url), 'utf8'));
const s = loadScene(run);
const wm = JSON.parse(readFileSync(new URL('../viewer/public/models/world_model.json', import.meta.url), 'utf8'));
wm.shift = s.walker.user_gap_m + s.walker.depth_m / 2 - wm.mean_gap_m; s.init.worldModel = wm;
const base = s.sc.objects.map((o: any) => ({ x: (o.start ?? o.pivot)[0], y: (o.start ?? o.pivot)[1], yaw: ((o.start?.[2] ?? 0) * Math.PI) / 180 }));
if (roll) s.init.risk.rollouts = +roll;
const pls = JSON.parse(readFileSync(file, 'utf8'));
console.log(JSON.stringify(pls.map((pl: any) => {
  const bad = check(s.init, cfg, base, pl);
  if (bad.length) return { check: bad };
  const r = score(s.init, cfg, base, pl, s.walker);
  return { check: bad, risk: r.risk, contacts: r.contacts, snags: r.snags, brushes: r.brushes, lo: r.lo, hi: r.hi, snag_by: r.snag_by, brush_by: r.brush_by, error: r.error };
})));

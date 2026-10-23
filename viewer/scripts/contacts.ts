// Toe contacts per month on a scene, per step model, over several seeds: node scripts/contacts.ts [scene] [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { rollouts } from '../src/sim.ts';
import { bumpComponents, plan, stamp, type GridMeta, type Layers } from '../src/grid.ts';

const scene = process.argv[2] ?? 'game_synth', pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
const buf = (f: string) => readFileSync(pub(`scene/${scene}/${f}`));
const sc = JSON.parse(buf('scene.json').toString()), g = sc.grid as GridMeta, b = buf(sc.grid.bump_height_m);
const base: Layers = { floor: new Uint8Array(buf(sc.grid.floor)), obst: new Uint8Array(buf(sc.grid.obstacles)), bump: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
const persona = JSON.parse(buf('persona.json').toString()), route = JSON.parse(buf('route.json').toString());
if (process.env.ROUTE) { const r = process.env.ROUTE.split(',').map(Number); route.start = r.slice(0, 2); route.goal = r.slice(2, 4); }   // ROUTE=x0,y0,x1,y1 (floor frame, m)
const model = JSON.parse(readFileSync(pub('models/step_model.json'), 'utf8'));
const objs = (sc.objects ?? []).filter((o: any) => !(process.env.REMOVE ?? '').split(',').includes(o.name));   // REMOVE=rug: the fix, object taken out
const L = stamp(g, base, objs, objs.map((o: any) => ({ x: o.pivot[0], y: o.pivot[1], yaw: 0 })));
const P = plan(g, L, route.start, route.goal, { walker_width_m: 0.66, ...sc.plan });
if (!P.xy || P.xy.length < 2) throw new Error(`no walker route from ${route.start} to ${route.goal} on ${scene}`);
const comps = bumpComponents(g, L.bump, sc.hazard_rules.bump_min_m), fit = model.hand_rule_fit;
const variants: Record<string, any> = {
  hand_persona: persona,                                                                          // configured older-adult hand rule
  hand_dataset_fit: { ...persona, stride_m: fit.stride_m, foot_sep_m: fit.foot_sep_m },           // same rule, Multi-Gait-Posture train fit
  learned: { ...persona, step_model: 'learned' },
};
const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], out: Record<string, any> = { scene, removed: process.env.REMOVE ?? null, start: route.start, goal: route.goal, route_m: P.length_m ?? null, rollouts_per_seed: sc.risk.rollouts, seeds };
for (const [k, p] of Object.entries(variants)) {
  const v = seeds.map(s => rollouts(g, L.bump, comps, P.xy, p, sc.risk, [], s, model).per_month);
  const m = v.reduce((a, x) => a + x) / v.length, sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1));
  out[k] = { mean_per_month: +m.toFixed(2), sd_across_seeds: +sd.toFixed(2), per_seed: v.map(x => +x.toFixed(2)) };
  console.log(`${k.padEnd(18)} ${m.toFixed(2)} ± ${sd.toFixed(2)} contacts/month`);
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out, null, 1));

// Physics debug views: the trace the pass records, the summary, the replay pose, and the stuck-walker report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPhysics, pushAlong } from '../src/physics.ts';
import { summarize, poseAt, pushColor, sampleText } from '../src/physdebug.ts';
import { bumpComponents, type GridMeta, type XY } from '../src/grid.ts';

const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.02, shape: [200, 100] };
const ny = g.shape[1];
const walker = { width_m: 0.66, depth_m: 0.5, handle_height_m: 0.85, user_gap_m: 0.25, leg_radius_m: 0.015,
  legs: [[0.75, 0.315], [0.75, -0.315], [0.25, 0.315], [0.25, -0.315]] as [number, number][] };
const short: XY[] = [[1.2, 1.0], [2.8, 1.0]];
function layer(fill: (i: number, j: number) => number) {
  const bump = new Float32Array(g.shape[0] * ny);
  for (let i = 0; i < g.shape[0]; i++) for (let j = 0; j < ny; j++) bump[i * ny + j] = fill(i, j);
  return { bump, comps: bumpComponents(g, bump, 0.003, 1) };
}
const rug = layer(i => (i >= 100 && i < 130 ? 0.015 : 0));

test('trace: sampled at trace_dt_s, ordered, one height per leg, ends at the goal', async () => {
  await initPhysics();
  const r = pushAlong(g, rug.bump, rug.comps, short, walker);
  assert.ok(r.done && r.trace.length > 20, `${r.trace.length} samples`);
  for (let k = 1; k < r.trace.length; k++) assert.ok(r.trace[k].t >= r.trace[k - 1].t && r.trace[k].s >= r.trace[k - 1].s - 1e-6);
  assert.equal(r.trace[0].legs.length, 4);
  assert.deepEqual(r.leg_names, ['front wheel', 'front wheel', 'rear glide', 'rear glide']);
  assert.ok(Math.abs(r.trace.at(-1)!.s - 1.6) < 0.05, `ends at ${r.trace.at(-1)!.s}`);
  // the front legs stand on the 15 mm rug before the rear ones do
  const firstOn = (k: number) => r.trace.findIndex(p => p.legs[k] > 0.01);
  assert.ok(firstOn(0) >= 0 && firstOn(2) > firstOn(0), `front ${firstOn(0)} rear ${firstOn(2)}`);
  assert.ok(Math.abs(r.leg_local[0][0] - (0.75 - (0.25 + 0.25))) < 1e-9 && Math.abs(r.frame_off_m - 0.5) < 1e-9);
  const off = pushAlong(g, rug.bump, rug.comps, short, walker, { trace_dt_s: 0 });
  assert.equal(off.trace.length, 0, 'trace_dt_s 0 records nothing');
});

test('summary: the rug edge drives the push to the limit; flat floor never does', async () => {
  await initPhysics();
  const flat = layer(() => 0), a = summarize(pushAlong(g, flat.bump, flat.comps, short, walker)), b = summarize(pushAlong(g, rug.bump, rug.comps, short, walker));
  assert.ok(a.done && a.snags === 0 && a.at_limit_s === 0 && a.max_leg_height_m === 0, JSON.stringify(a));
  assert.ok(a.peak_push_n < 20, `flat floor: the start-up push is not counted, peak ${a.peak_push_n} N`);
  assert.ok(b.snags >= 1 && b.at_limit_s > 0 && b.peak_push_n >= b.limit_n - 1e-6 && Math.abs(b.max_leg_height_m - 0.015) < 1e-6, JSON.stringify(b));
  assert.ok(b.peak_at_s > 0.4 && b.peak_at_s < 0.65, `the front wheels meet the edge at x = 2.0 when the frame centre is ~0.3 m short of it (s = 0.5), peak at ${b.peak_at_s}`);
  assert.ok(b.mean_speed_mps < a.mean_speed_mps, 'the snag slows the run');
});

test('a stuck walker is reported as stuck, not as no snags', async () => {
  await initPhysics();
  const r = pushAlong(g, rug.bump, rug.comps, short, walker, { stall_s: 60 });
  assert.equal(r.done, false);
  assert.equal(r.snags.length, 0);
  assert.ok(r.stuck, 'stuck is set when done is false');
  assert.ok(r.stuck.s_m > 0.4 && r.stuck.s_m < 0.65 && r.stuck.push_n > 30, JSON.stringify(r.stuck));
  assert.ok(Math.abs(r.stuck.position[0] - 1.7) < 0.15 && Math.abs(r.stuck.position[1] - 1.0) < 0.2, 'sat just short of the rug edge at x = 2.0');
  assert.equal(summarize(r).stuck_at_s, r.stuck.s_m);
  assert.equal(pushAlong(g, rug.bump, rug.comps, short, walker).stuck, null, 'a finished run is not stuck');
});

test('poseAt interpolates, clamps and turns the short way round', () => {
  const mk = (t: number, x: number, yaw: number) => ({ t, x, y: 0, yaw, s: x, v: 0.3, push: 10, tilt_deg: 0, legs: [0, 0.01] });
  const tr = [mk(0, 0, 3.0), mk(1, 1, -3.0)];
  assert.equal(poseAt([], 0), null);
  assert.equal(poseAt(tr, -1)!.x, 0);
  assert.equal(poseAt(tr, 9)!.x, 1);
  const m = poseAt(tr, 0.5)!;
  assert.ok(Math.abs(m.x - 0.5) < 1e-9 && Math.abs(m.legs[1] - 0.01) < 1e-9);
  assert.ok(Math.abs(Math.abs(m.yaw) - Math.PI) < 0.2, `yaw ${m.yaw}: through pi, not through 0`);
});

test('pushColor runs blue to red and the caption reads', () => {
  const [r0, , b0] = pushColor(0, 40), [r1, , b1] = pushColor(40, 40);
  assert.ok(r1 > r0 && b1 < b0);
  assert.deepEqual(pushColor(99, 40), pushColor(40, 40));
  assert.match(sampleText({ t: 1.25, x: 0, y: 0, yaw: 0, s: 0.44, v: 0.35, push: 31, tilt_deg: 2.2, legs: [] }, 40), /1\.3 s · 0\.44 m · 35 cm\/s · push 31\/40 N · tilt 2\.2°/);
});

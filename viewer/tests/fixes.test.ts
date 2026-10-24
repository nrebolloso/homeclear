// Fixes against hazards on the SYNTHETIC sample scene (tests/make_sample_objects.py): each fix must lower the hazard it
// claims to, and ranking the fixes by risk reduction must not change with the random seed. Risk numbers come from the
// Monte Carlo over the scene's synthetic bump layer; the physics numbers are ASSUMED (see physics.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { stamp, plan, bumpComponents, applyIntervention, toCell, type Layout, type Intervention } from '../src/grid.ts';
import { evaluate, routeStart, type Init } from '../src/evaluate.ts';
import { rollouts } from '../src/sim.ts';
import { initPhysics, pushAlong } from '../src/physics.ts';
import { loadScene } from './scene.ts';

const skip = existsSync(new URL('../public/scene/sample_objects/scene.json', import.meta.url)) ? false
  : 'scene not generated: .venv/Scripts/python.exe tests/make_sample_objects.py';
const SEEDS = [1, 2, 3, 4, 5];
// Seeds are common across layouts, but a toe contact consumes extra random draws, so removing a tiny hazard can move later draws
// and show a few thousandths of a contact per month the other way. That is Monte Carlo noise (against effects of 0.3 to 2.9),
// not a fix adding risk: 'never worse' means worse by no more than NOISE.
const NOISE = 0.02;

/** Expected toe contacts per month over every route, as evaluate() computes it but with a chosen seed (evaluate fixes seed 1). */
function perMonth(S: Init, lay: Layout, seed: number) {
  const L = stamp(S.g, S.base, S.objects, lay.poses, lay.flattened), comps = bumpComponents(S.g, L.bump, S.rules.bump_min_m, S.rules.bump_link_cells);
  const lights = S.objects.flatMap((o, k) => (o.kind === 'nightlight' && !lay.poses[k].removed ? [{ x: lay.poses[k].x, y: lay.poses[k].y, r: o.light_radius_m ?? 1.5 }] : []));
  let total = 0;
  for (const rd of S.routes) {
    const P = plan(S.g, L, routeStart(rd, S.objects, lay.poses), rd.goal, S.plan);
    if (P.error) continue;
    const risk = { ...S.risk, trips_per_night: rd.trips_per_night, dark_contact_multiplier: rd.night ? S.risk.dark_contact_multiplier : 1, ghosts: 0 };
    total += rollouts(S.g, L.bump, comps, P.xy, S.persona, risk, rd.night ? lights : [], seed, S.stepModel, { height_err_m: S.rules.margin_m.height }).per_month;
  }
  return total;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function setup() {
  const S = loadScene('sample_objects'), { init, poses } = S;
  const home: Layout = { poses, flattened: [] };
  const fix = (id: string) => init.interventions.find(i => i.id === id) as Intervention;
  const apply = (lay: Layout, ...ids: string[]) => ids.reduce((l, id) => applyIntervention(init.objects, l, fix(id)), lay);
  const patch = (lay: Layout, x: number, y: number) => {   // the bump patch id at a spot, 0 = none
    const L = stamp(init.g, init.base, init.objects, lay.poses, lay.flattened);
    const c = bumpComponents(init.g, L.bump, init.rules.bump_min_m, init.rules.bump_link_cells), [i, j] = toCell(init.g, [x, y]);
    return { id: c[i * init.g.shape[1] + j], h: L.bump[i * init.g.shape[1] + j] };
  };
  return { S, init, home, fix, apply, patch };
}

test('remove_rug: the rug patch is gone and the risk drops a lot, whatever the seed', { skip }, () => {
  const { init, home, apply, patch } = setup(), after = apply(home, 'remove_rug');
  assert.ok(patch(home, 3.0, 1.5).id > 0 && patch(after, 3.0, 1.5).id === 0);
  for (const s of SEEDS) assert.ok(perMonth(init, home, s) - perMonth(init, after, s) > 1.0, `seed ${s}`);
});

test('threshold_ramp: the 12 mm sill patch is gone, risk drops in every seed, and the pushed walker no longer snags there', { skip }, async () => {
  const { S, init, home, apply, patch } = setup(), after = apply(home, 'threshold_ramp');
  assert.ok(patch(home, 4.0, 1.5).id > 0 && patch(after, 4.0, 1.5).id === 0);
  for (const s of SEEDS) assert.ok(perMonth(init, after, s) < perMonth(init, home, s), `seed ${s}`);
  // ASSUMED physics: the default person's front wheel catches a 12 mm sill (physics.test.ts: it catches from 8 mm)
  await initPhysics();
  const snagsAtSill = (lay: Layout) => {
    const L = stamp(init.g, init.base, init.objects, lay.poses, lay.flattened), comps = bumpComponents(init.g, L.bump, init.rules.bump_min_m, init.rules.bump_link_cells);
    const e = evaluate(init, lay, { ghosts: false });
    return pushAlong(init.g, L.bump, comps, e.xy, S.walker).snags.filter(s => s.position[0] > 3.9 && s.position[0] < 4.2);
  };
  assert.ok(snagsAtSill(home).length >= 1, 'a 12 mm sill catches the walker');
  assert.equal(snagsAtSill(after).length, 0);
});

test('cord_cover: the cable patch is gone and it never adds risk; once the rug is out of the way it removes real risk', { skip }, () => {
  const { init, home, apply, patch } = setup(), norug = apply(home, 'remove_rug'), both = apply(home, 'remove_rug', 'cord_cover');
  assert.ok(patch(home, 3.64, 1.5).id > 0 && patch(apply(home, 'cord_cover'), 3.64, 1.5).id === 0);
  // with the rug in place a 6 mm cable is a very small share of the risk (the contact table: ~0.0002 per stride) and the
  // route's walker disc is dominated by the rug: the fix may not move the number at all, but must never raise it
  for (const s of SEEDS) assert.ok(perMonth(init, apply(home, 'cord_cover'), s) <= perMonth(init, home, s) + NOISE, `seed ${s}`);
  // rug removed: the planner now crosses the cable, so covering it lowers the risk
  assert.ok(mean(SEEDS.map(s => perMonth(init, norug, s))) > mean(SEEDS.map(s => perMonth(init, both, s))));
});

test('tape_rug_corner: the curl no longer makes the rug patch taller than the rug', { skip }, () => {
  const { init, home, apply, patch } = setup(), after = apply(home, 'tape_rug_corner');
  assert.ok(Math.abs(patch(home, 3.43, 2.22).h - 0.023) < 0.003, 'the curled corner stands 2.3 cm');
  assert.ok(patch(after, 3.43, 2.22).h < 0.005, 'taped: flat (the flatten fix sets the corner to floor level, rug under it included)');
  for (const s of SEEDS) assert.ok(perMonth(init, after, s) <= perMonth(init, home, s) + NOISE, `seed ${s}`);
});

test('raised_toilet_seat: the toilet transfer check stops failing; it moves no toe-contact risk', { skip }, () => {
  const { init, home, apply } = setup(), after = apply(home, 'raised_toilet_seat');
  const verdict = (lay: Layout) => evaluate(init, lay, { ghosts: false }).checks.find(c => c.id === 'transfer:toilet')!;
  assert.equal(verdict(home).verdict, 'fail');
  assert.notEqual(verdict(after).verdict, 'fail');
  assert.ok(Math.abs(verdict(after).value_m! - verdict(home).value_m!) > 0.05, 'the seat height the check reads went up');
  assert.equal(perMonth(init, after, 1), perMonth(init, home, 1));
});

test('chair and table moves never add risk and keep every route', { skip }, () => {
  const { init, home, apply } = setup();
  for (const id of ['move_chair', 'move_table']) {
    const lay = apply(home, id), e = evaluate(init, lay, { ghosts: false });
    assert.equal(e.error, undefined, id);
    for (const s of SEEDS) assert.ok(perMonth(init, lay, s) <= perMonth(init, home, s) + NOISE, `${id} seed ${s}`);
  }
});

test('ranking by risk reduction is the same in every seed; check-only fixes are ranked apart; ties go to the cheaper fix', { skip }, () => {
  const { init, home, apply } = setup();
  const fixes = init.interventions.filter(iv => iv.kind !== 'raise');   // 'raise' fixes change checks, not toe contacts
  const rank = (seed: number) => {
    const base = perMonth(init, home, seed);
    return fixes.map(iv => ({ id: iv.id, cost: iv.cost_usd ?? 0, cut: base - perMonth(init, apply(home, iv.id), seed) }))
      .sort((a, b) => b.cut - a.cut || a.cost - b.cost);
  };
  const per = SEEDS.map(rank);
  console.log('# ranking by seed (SYNTHETIC): ' + per.map(r => r.map(x => `${x.id} ${x.cut.toFixed(2)}`).join(' > ')).join('\n#   '));
  for (const r of per) {
    assert.deepEqual(r.slice(0, 3).map(x => x.id), ['remove_rug', 'threshold_ramp', 'move_chair'], 'the fixes with real separation lead, in order, in every seed');
    for (const x of r) assert.ok(x.cut > -NOISE, `${x.id} never makes it worse (beyond noise)`);
    assert.ok(r[0].cut > 5 * r[1].cut && r[1].cut > 0.1, 'the rug dwarfs the ramp, which is clearly above noise');
    // the rest sit within noise of zero (their hazards are off the walked routes, or a 6 mm cable): their order is NOT stable
    // and is not claimed. They are only required to stay small.
    assert.ok(r.slice(3).every(x => x.cut < 0.1), 'the rest are small');
  }
  // check-only fixes: counted by the failed checks they clear, not by per_month
  const failed = (lay: Layout) => evaluate(init, lay, { ghosts: false }).checks.filter(c => c.verdict === 'fail').length;
  const seat = failed(home) - failed(apply(home, 'raised_toilet_seat'));
  assert.ok(seat >= 1, `the raised seat clears ${seat} failed check(s)`);
  assert.ok(fixes.every(iv => failed(home) - failed(apply(home, iv.id)) <= 1), 'no other fix is claimed to clear a check here');
});

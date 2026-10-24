import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wheelchairChecks, wheelchairPersona, ZERO_CONTACTS, WHEELCHAIR, ADA } from '../src/wheelchair.ts';
import { stairChecks, stairFixes, STAIRLIFT, type Stair } from '../src/stairs.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyIntervention, type GridMeta, type XY } from '../src/grid.ts';
import { loadScene } from './scene.ts';

// a 4 m x 3 m room on 5 cm cells; dist = metres to the nearest wall (what the planner hands the checks)
const g: GridMeta = { origin_xy: [0, 0], cell_m: 0.05, shape: [80, 60] };
function roomDist(blockX = Infinity) {
  const [nx, ny] = g.shape, d = new Float32Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x = (i + 0.5) * 0.05, y = (j + 0.5) * 0.05;
    d[i * ny + j] = Math.max(0, Math.min(x, 4 - x, y, 3 - y, Math.abs(x - blockX) - 0.05));
  }
  return d;
}

test('turning space: a 1.5 m circle fits in an open room, not in a 1.2 m alcove', () => {
  const open = wheelchairChecks(g, roomDist(), [{ name: 'sink', at: [2, 1.5] }], [], 0.02)[0];
  assert.equal(open.verdict, 'ok');
  assert.ok(open.value_m! >= ADA.turn_d_m);
  // a wall at x = 1.2: the corner at the far side of it only has 1.2 m across
  const tight = wheelchairChecks(g, roomDist(1.25), [{ name: 'corner', at: [0.4, 1.5] }], [], 0.02)[0];
  assert.equal(tight.verdict, 'fail');
  assert.match(tight.label, /no room to turn/);
});

test('changes in level: under 6 mm passes silently, a bevel up to 13 mm is borderline, taller fails', () => {
  const bump = (h: number) => ({ type: 'floor_bump', name: 'rug', position: [1, 1] as XY, height_m: h });
  const out = wheelchairChecks(g, roomDist(), [], [bump(0.004), bump(0.01), bump(0.02)], 0.02);
  assert.deepEqual(out.map(c => c.verdict), ['borderline, OT to verify', 'fail']);
  assert.match(out[1].label, /stops the casters/);
});

test('the wheelchair persona has no trip model: its contact table is zero at every height', () => {
  const p = wheelchairPersona({ gait: { eye_height_m: 1.55, gait_profile: 'older_adult_walker' } });
  assert.equal(p.walker.device, 'wheelchair');
  assert.equal(p.gait.gait_profile, 'wheelchair');
  assert.ok(ZERO_CONTACTS.p_per_stride.every(v => v === 0));
  // the planned path is the chair's middle: from the push handles to the footplates
  assert.ok(Math.abs(WHEELCHAIR.user_gap_m + WHEELCHAIR.depth_m / 2 - 0.12) < 1e-9);
});

const flight: Stair = { name: 'stairs', bottom: [[0.9, 0], [0, 0]], top: [0.45, 2.7], treads_z: [0.18, 0.36, 0.54], tread_fronts_m: [0, 0.27, 0.54],
  tread_depth_m: 0.27, width_m: 0.9, rails: { left: 'wall', right: 'seen' }, measured: 'tape' };

test('stairs in a wheelchair: fail without a lift; with one, the transfer is the OT\'s call', () => {
  const lift = stairFixes(flight).find(f => f.id === 'stair_lift:stairs')!;
  assert.equal(lift.fixture!.side, 'left');   // away from the seen rail
  const { init, poses } = loadScene('game_synth');
  const S = { ...init, interventions: [...init.interventions, lift], stairs: [flight], device: 'wheelchair' };
  const chair = (lay: any) => evaluate(S, lay, { ghosts: false }).checks.find(c => c.id === 'stairs:stairs:chair')!;
  let lay = { poses, flattened: [] as [XY, XY][] };
  assert.equal(chair(lay).verdict, 'fail');
  lay = applyIntervention(init.objects, lay, lift);
  const after = chair(lay);
  assert.equal(after.verdict, 'borderline, OT to verify');
  assert.match(after.label, new RegExp(`${Math.round((0.9 - STAIRLIFT.folded_m) * 100)} cm`));
  // a walker persona never gets the chair check
  assert.equal(stairChecks(flight, { g: init.g, L: init.base, fixtures: [], margin: init.rules.margin_m, device: 'walker' }).some(c => c.id.endsWith(':chair')), false);
});

test('through evaluate(): a wheelchair gets a turning-space check at each route end, and zero trips', () => {
  const { init, poses } = loadScene('game_synth');
  const S = { ...init, device: 'wheelchair', persona: { ...init.persona, gait_profile: 'wheelchair' }, risk: { ...init.risk, contact_table: { ...init.risk.contact_table, wheelchair: ZERO_CONTACTS } } };
  const r = evaluate(S, { poses, flattened: [] }, { ghosts: false });
  const turns = r.checks.filter(c => c.kind === 'wheelchair' && c.id.includes(':turn:'));
  assert.equal(turns.length, 2 * init.routes.length);
  assert.equal(r.per_month, 0);
});

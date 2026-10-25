import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, catalogFor, usdRange, priceText, timeText, planText } from '../src/catalog.ts';
import { fixCost } from '../src/movecost.ts';

// every fix id prefix the viewer emits (doors.ts, stairs.ts, bathroom.ts, lights.ts) and the demo scene's interventions
const KEYS = ['door_widen', 'door_offset', 'door_remove', 'stair_rail', 'stair_rail_up', 'stair_rail_ext', 'stair_grab', 'stair_lights', 'stair_nosing',
  'stair_walker', 'stair_rollator', 'stair_lift', 'grab_bar_toilet', 'path_light', 'remove_mat', 'tape_cord', 'push_in_chair', 'add_nightlight',
  'mat_tape', 'cord_reroute', 'nightlight_off', 'walker_caps'];

test('every fix the viewer can offer has a catalog entry with a time and a price shape', () => {
  for (const k of KEYS) {
    const e = CATALOG[k];
    assert.ok(e, `missing ${k}`);
    assert.ok(e.install_min[0] <= e.install_min[1], k);
    assert.ok(e.diy_usd || e.pro_usd || e.usd_per_ft, `${k} has no price`);
    const [lo, typ, hi] = usdRange(e, k === 'stair_rail' ? 4 : undefined);
    assert.ok(lo <= typ && typ <= hi, `${k} range ${lo} ${typ} ${hi}`);
    assert.ok(e.provenance.usd === 'guess' || !hi || e.sources.length, `${k} claims a source but lists none`);
  }
});

test('fixCost prices a catalogued fix from the catalog, else keeps its own numbers', () => {
  const c = fixCost({ id: 'door_widen:bath_door', label: 'widen', cost_usd: 1, minutes: 1 } as any);
  assert.equal(c.source, 'catalog');
  assert.equal(c.usd, usdRange(CATALOG.door_widen)[1]);
  assert.notEqual(c.minutes, 1);
  const r = fixCost({ id: 'stair_walker:s', catalog: 'stair_rollator', label: 'r' } as any);
  assert.equal(r.catalog, CATALOG.stair_rollator);
  const u = fixCost({ id: 'not_listed:x', label: 'x', cost_usd: 7, minutes: 3 } as any);
  assert.deepEqual([u.source, u.usd, u.minutes], ['placeholder', 7, 3]);
});

test('a handrail is priced by its length', () => {
  const e = catalogFor({ id: 'stair_rail:s:left' })!;
  if (!e.usd_per_ft) return;
  assert.ok(usdRange(e, 6)[1] > usdRange(e, 3)[1]);
  assert.match(priceText(e, 3), /installed/);
});

test('plan line adds ranges and names the most skilled trade needed', () => {
  const t = planText([{ usd: 0, catalog: CATALOG.mat_tape }, { usd: 0, catalog: CATALOG.door_widen }, { usd: 0 }]);
  assert.match(t, /^\$[\d,]+–\$[\d,]+ · about .+ · needs a contractor$/);
  assert.equal(planText([{ usd: 0 }]), 'free · you can do it');
  assert.match(timeText({ ...CATALOG.mat_tape, install_min: [5, 10] }), /^about \d+ min$/);
});

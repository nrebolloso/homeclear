import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.ts';
import { bedExit } from '../src/checks.ts';
import { loadScene } from './scene.ts';

test('transfer heights: toilet too low for hip precautions, bed at the edge of the range', () => {
  const { init, poses } = loadScene('game_synth');   // knees 0.50 m, hip precautions: seats 0.55-0.70 m
  const c = evaluate(init, { poses, flattened: [] }, { ghosts: false }).checks;
  const toilet = c.find(x => x.id === 'transfer:toilet')!, bed = c.find(x => x.id === 'transfer:bed')!;
  assert.equal(toilet.verdict, 'fail');
  assert.ok(Math.abs(toilet.value_m! - 0.40) < 0.01 && /hip precautions/.test(toilet.note), toilet.note);
  assert.equal(bed.verdict, 'borderline, OT to verify');   // 0.55 m mattress = exactly knee + 5 cm
  assert.ok(c.some(x => x.kind === 'grab_bar' && x.verdict === 'OT to verify'));
  assert.ok(c.some(x => x.id === 'ems:stretcher' && x.verdict === 'OT to verify'), 'stretcher fits from the entry to the bed');
});

test('reach follows the furniture: the phone rides on the nightstand', () => {
  const { init, poses, sc } = loadScene('game_synth');
  const bed = sc.objects.findIndex((o: any) => o.kind === 'bed'), ns = sc.objects.findIndex((o: any) => o.name === 'nightstand');
  const exit = bedExit(sc.objects[bed], poses[bed], init.routes[0].start);
  assert.ok(Math.abs(exit[0] - 1.8) < 0.05, `exit on the side facing the route start: ${exit}`);
  const far = evaluate(init, { poses, flattened: [] }, { ghosts: false }).checks.find(x => x.id === 'reach:phone')!;
  assert.equal(far.verdict, 'fail');
  const near = poses.map((p, k) => (k === ns ? { x: exit[0] + 0.3, y: exit[1] + 0.2, yaw: 0 } : p));
  assert.equal(evaluate(init, { poses: near, flattened: [] }, { ghosts: false }).checks.find(x => x.id === 'reach:phone')!.verdict, 'ok');
  const gone = poses.map((p, k) => (k === ns ? { ...p, removed: true } : p));
  assert.match(evaluate(init, { poses: gone, flattened: [] }, { ghosts: false }).checks.find(x => x.id === 'reach:phone')!.label, /no phone left/);
  assert.equal(evaluate(init, { poses, flattened: [] }, { ghosts: false }).checks.find(x => x.id === 'reach:switch')!.verdict, 'fail');
});

test('stretcher: fits through the bedroom at 60 cm, not at 2.5 m; spare room is the bottleneck on the way', () => {
  const { init, poses } = loadScene('game_synth');
  const at = (w: number) => evaluate({ ...init, ems: { ...init.ems!, stretcher_width_m: w } }, { poses, flattened: [] }, { ghosts: false })
    .checks.find(x => x.id === 'ems:stretcher')!;
  const ok = at(0.6);
  assert.equal(ok.verdict, 'OT to verify');
  assert.ok(+/(\d+) cm to spare/.exec(ok.label)![1] > 10, ok.label);
  assert.equal(at(2.5).verdict, 'fail');
});

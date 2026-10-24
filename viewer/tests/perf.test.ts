import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterHazards, hazardLabel, perfAtLoad, tierAtLoad, splatCfg, xrCfg, PERF, FULL, type HzIn } from '../src/perf.ts';

const bump = (x: number, y: number, h: number, name = 'threshold') => ({ type: 'floor_bump', name, position: [x, y] as [number, number], height_m: h });
const squeeze = (x: number, y: number, c: number) => ({ type: 'tight_passage', position: [x, y] as [number, number], min_side_clearance_m: c });

test('clusterHazards: a row of bumps becomes one ring on the tallest, labelled with the count', () => {
  const cs = clusterHazards([bump(1, 1, 0.009), bump(1.1, 1.05, 0.019), bump(1.2, 1, 0.007), bump(3, 3, 0.012)]);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].n, 3);
  assert.equal(cs[0].rep.height_m, 0.019);
  assert.equal(cs[0].label, '×3 bumps, worst 1.9 cm');
  assert.equal(cs[1].label, 'threshold 1.2 cm');   // alone: the label it always had
});

test('clusterHazards: different types never merge; squeezes keep the narrowest', () => {
  const cs = clusterHazards<HzIn>([bump(1, 1, 0.01), squeeze(1.05, 1, 0.09), squeeze(1.1, 1, 0.03)]);
  assert.equal(cs.length, 2);
  assert.equal(cs[1].n, 2);
  assert.equal(cs[1].rep.min_side_clearance_m, 0.03);
  assert.equal(cs[1].label, '×2 tight spots, down to 3 cm/side');
  assert.equal(hazardLabel(squeeze(0, 0, 0.09)), '9 cm/side');
});

test('clusterHazards: nothing is dropped', () => {
  const hs = Array.from({ length: 12 }, (_, k) => bump(k * 0.1, 0, 0.005 + k * 0.001));
  assert.equal(clusterHazards(hs).reduce((s, c) => s + c.n, 0), hs.length);
  assert.deepEqual(clusterHazards([]), []);
});

test('tierAtLoad: flat unless in a headset; Link by ?link=1 or by asking for full-quality splats', () => {
  assert.equal(tierAtLoad('?stddev=2.83&maxpx=512', false), 'flat');
  assert.equal(tierAtLoad('?xr=1', true), 'quest');
  assert.equal(tierAtLoad('?xr=1&link=1', true), 'link');
  assert.equal(tierAtLoad('?xr=1&stddev=2.83&maxpx=512', true), 'link');   // the Link guide's URL
  assert.equal(tierAtLoad('?xr=1&stddev=2.83', true), 'quest');            // half of it is not enough
  assert.equal(tierAtLoad('?xr=1&stddev=2&maxpx=128', true), 'quest');
});

test('perfAtLoad: the query wins; a standalone headset is on; Link and the monitor follow the last choice', () => {
  assert.equal(perfAtLoad('?perf=0', 'quest', '1'), false);
  assert.equal(perfAtLoad('?perf=1', 'link', null), true);
  assert.equal(perfAtLoad('', 'quest', null), true);
  assert.equal(perfAtLoad('', 'link', null), false);
  assert.equal(perfAtLoad('', 'link', '1'), true);
  assert.equal(perfAtLoad('', 'flat', null), false);
});

test('splatCfg: ?stddev and ?maxpx win, performance mode only supplies the default', () => {
  assert.deepEqual(splatCfg('', true), { max_std_dev: PERF.max_std_dev, max_pixel_radius: PERF.max_pixel_radius });
  assert.deepEqual(splatCfg('', false), { max_std_dev: FULL.max_std_dev, max_pixel_radius: FULL.max_pixel_radius });
  assert.deepEqual(splatCfg('?stddev=2.83&maxpx=512', true), { max_std_dev: 2.83, max_pixel_radius: 512 });
  assert.deepEqual(splatCfg('?maxpx=256', false), { max_std_dev: FULL.max_std_dev, max_pixel_radius: 256 });
  assert.equal(splatCfg('?stddev=abc&maxpx=0', true).max_std_dev, PERF.max_std_dev);   // junk falls back
});

test('xrCfg: a Quest trades resolution for frames, Link keeps full quality, the query overrides both', () => {
  assert.deepEqual(xrCfg('', 'quest'), { scale: 0.5, foveation: 1, hz: 72 });
  assert.deepEqual(xrCfg('', 'link'), { scale: 1, foveation: 0, hz: 0 });
  assert.deepEqual(xrCfg('?xrscale=1&foveation=0&hz=90', 'quest'), { scale: 1, foveation: 0, hz: 90 });
  assert.deepEqual(xrCfg('?foveation=0.5&xrscale=0.9', 'link'), { scale: 0.9, foveation: 0.5, hz: 0 });
  assert.equal(xrCfg('?foveation=7', 'link').foveation, 1);
});

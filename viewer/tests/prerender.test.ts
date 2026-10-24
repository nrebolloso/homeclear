import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutKey, rankClips } from '../src/prerender.ts';
import { applyIntervention } from '../src/grid.ts';
import { loadScene } from './scene.ts';

test('layout keys: the capture is "original"; the same fixes give the same key in any order; a 1 cm nudge is the same layout', () => {
  const { sc, poses } = loadScene('game_synth');
  const start = { poses, flattened: [] };
  assert.equal(layoutKey(sc.objects, start), 'original');
  const fix = (ids: string[]) => ids.reduce((l, id) => applyIntervention(sc.objects, l, sc.interventions.find((i: any) => i.id === id)), start as any);
  const a = layoutKey(sc.objects, fix(['remove_rug', 'tape_cable', 'raised_toilet_seat']));
  assert.equal(a, layoutKey(sc.objects, fix(['raised_toilet_seat', 'tape_cable', 'remove_rug'])));
  assert.match(a, /rug:removed/);
  const bed = sc.objects.findIndex((o: any) => o.name === 'bed');
  const nudged = { ...start, poses: poses.map((p, k) => (k === bed ? { ...p, x: p.x + 0.01 } : p)) };
  assert.equal(layoutKey(sc.objects, nudged), 'original');
  const clips = [{ file: 'a.mp4', layout_key: 'original', route: 'bed to bathroom' }, { file: 'b.mp4', layout_key: a }];
  assert.deepEqual(rankClips(clips, a, 'bed to bathroom').map(c => [c.file, c.exact]), [['b.mp4', true], ['a.mp4', false]]);
});

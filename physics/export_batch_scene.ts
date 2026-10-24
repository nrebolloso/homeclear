// Geometry for the offline batch (physics/batch_mujoco.py), taken from the same code the live viewer uses (objphys.ts):
// chair colliders = the chairs' own splats voxelised into columns, the mat = its footprint slab, the curled corner = the
// mat's own splat points. Writes physics/batch_scene_<run>.json. Usage: node physics/export_batch_scene.ts [run]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadScene } from '../viewer/tests/scene.ts';
import { columns, curledCorner, plyPoints } from '../viewer/src/objphys.ts';

const run = process.argv[2] ?? 'kitchen4_lighter';
const { sc, walker } = loadScene(run);
const ranges = JSON.parse(readFileSync(new URL('../physics_ranges.json', import.meta.url), 'utf8'));
const dir = new URL(`../viewer/public/scene/${run}/`, import.meta.url);
const pts = (o: any) => { const b = readFileSync(new URL(o.splat, dir)); return plyPoints(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };

const chairs = sc.objects.filter((o: any) => o.kind === 'chair').map((o: any) => ({ name: o.name, footprint: o.footprint, height_m: o.height_m, columns: columns(pts(o)) }));
const rug = sc.objects.find((o: any) => o.kind === 'rug');
const mat = rug && (() => {
  return { name: rug.name, footprint: rug.footprint, height_m: rug.height_m, curl: curledCorner(pts(rug), rug.footprint, ranges.mat.curl_min_m) };
})();
const out = { run, note: 'geometry from the splat (measured); masses/frictions are sampled in the batch from physics_ranges.json', walker, chairs, mat };
writeFileSync(new URL(`batch_scene_${run}.json`, import.meta.url), JSON.stringify(out));
console.log(`${run}: ${chairs.length} chairs (${chairs.map((c: any) => c.columns.length).join('/')} columns), mat ${mat ? `curl ${JSON.stringify(mat.curl)}` : 'none'}`);

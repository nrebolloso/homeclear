// Test helper: the node tree of a .glb as three.js objects (joints as Bones), without a DOM, textures or a loader, so the
// rig can be posed and measured under node:test. Not the viewer's loader: the viewer uses GLTFLoader.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

export function glbNodes(path: string) {
  const b = readFileSync(path), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + view.getUint32(12, true))));
  const joints = new Set<number>(json.skins.flatMap((s: any) => s.joints));
  const objs: THREE.Object3D[] = json.nodes.map((n: any, i: number) => {
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = n.name ?? `node${i}`;
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => objs[i].add(objs[c])));
  const scene = new THREE.Group();
  for (const r of json.scenes[json.scene].nodes) scene.add(objs[r]);
  scene.updateMatrixWorld(true);
  return { scene, json };
}

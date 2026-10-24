// The walker, built from primitives at walker.json's exact dimensions (x forward from the user's body centre, y left).
import * as THREE from 'three';

export interface WalkerCfg {
  width_m: number; depth_m: number; handle_height_m: number; user_gap_m: number; leg_radius_m: number; legs: [number, number][];
  device?: 'walker' | 'cane';
}

const METAL = 0xb8bec6, RED = 0xff3030;

/** The mobility aid for a persona: the walker frame, or a cane (tip = its one "leg"). Same interface either way. */
export function buildDevice(w: WalkerCfg) { return w.device === 'cane' ? buildCane(w) : buildWalker(w); }

/** A cane: one shaft from the hand to the tip (walker.json legs[0]). Clearance probes ring the body (width_m across),
 *  since with a cane the person's own shoulders and hips are what brushes the door frame. */
export function buildCane(w: WalkerCfg) {
  const group = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: METAL, metalness: 0.6, roughness: 0.35 });
  const [tx, ty] = w.legs[0], h = w.handle_height_m, r = w.leg_radius_m;
  const top = new THREE.Vector3(tx - 0.05, ty, h), tip = new THREE.Vector3(tx, ty, 0);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, top.distanceTo(tip), 10), mat);
  shaft.position.copy(top).add(tip).multiplyScalar(0.5);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(tip).normalize());
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.4, r * 1.4, 0.12, 10), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }));
  handle.position.copy(top).add(new THREE.Vector3(-0.05, 0, 0));
  handle.rotation.z = Math.PI / 2;
  const foot = new THREE.Mesh(new THREE.SphereGeometry(r * 1.8, 10, 8), mat);
  foot.position.set(tx, ty, r);
  group.add(shaft, handle, foot);
  const R = w.width_m / 2, probes: [number, number][] = [[tx, ty]];
  for (let a = 0; a < 8; a++) probes.push([R * Math.cos((a * Math.PI) / 4), R * Math.sin((a * Math.PI) / 4)]);
  return { group, legs: [shaft], probes, setFrameRed: (on: boolean) => mat.color.setHex(on ? RED : METAL),
    setLegRed: (_k: number, on: boolean) => mat.color.setHex(on ? RED : METAL) };
}

export function buildWalker(w: WalkerCfg) {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: METAL, metalness: 0.6, roughness: 0.35 });
  const tube = w.leg_radius_m, hy = w.width_m / 2 - tube, x0 = w.user_gap_m, x1 = x0 + w.depth_m, h = w.handle_height_m;
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r = tube) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 10), frameMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(m);
    return m;
  };
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // legs get their own material so a single leg can flash red
  const legs = w.legs.map(([x, y]) => {
    const m = bar(v(x, y, 0), v(x, y, h));
    m.material = frameMat.clone();
    const foot = new THREE.Mesh(new THREE.SphereGeometry(tube * 1.6, 10, 8), m.material);
    foot.position.set(x, y, tube);
    group.add(foot);
    return m;
  });
  for (const s of [1, -1]) {
    bar(v(x0, s * hy, h), v(x1, s * hy, h));                 // side rail
    bar(v(x0, s * hy, 0.3), v(x1, s * hy, 0.3));             // lower side brace
    const grip = bar(v(x0 - 0.02, s * hy, h + 0.01), v(x0 + 0.12, s * hy, h + 0.01), tube * 1.8);
    grip.material = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  }
  bar(v(x1, hy, 0.45), v(x1, -hy, 0.45));                    // front cross brace (open at the back for the user)
  // points on the frame that clearance is measured from
  const probes: [number, number][] = [...w.legs, [(x0 + x1) / 2, hy], [(x0 + x1) / 2, -hy], [x1, 0]];
  const setFrameRed = (on: boolean) => frameMat.color.setHex(on ? RED : METAL);
  const setLegRed = (k: number, on: boolean) => (legs[k].material as THREE.MeshStandardMaterial).color.setHex(on ? RED : METAL);
  return { group, legs, probes, setFrameRed, setLegRed };
}

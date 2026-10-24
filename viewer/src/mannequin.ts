// A plain mannequin behind the walker, for the third-person view: its feet land exactly on the footsteps the motion
// model / hand rule placed in the simulation (rollouts' first trip), its hands stay on the grips. Visual only.
import * as THREE from 'three';
import type { XY } from './grid.ts';

const SKIN = 0xd9c2a7, CLOTH = 0x5b6f8a;

export interface Step { xy: XY; side: number; hit: boolean; s: number }

/** Footsteps -> where each foot is at route arc length s: planted on its last step, swinging (with lift) toward the next. */
export function feetAt(steps: Step[], s: number, stride: number): { pos: [number, number, number]; red: boolean }[] {
  return [0, 1].map(side => {
    const mine = steps.filter(p => p.side === side);
    if (!mine.length) return { pos: [0, 0, 0] as [number, number, number], red: false };
    let k = mine.findIndex(p => p.s > s);
    if (k < 0) k = mine.length;
    const prev = mine[Math.max(0, k - 1)], next = mine[Math.min(mine.length - 1, k)];
    if (k === 0 || prev === next) return { pos: [prev.xy[0], prev.xy[1], 0], red: prev.hit };
    // a foot swings during the half stride before it lands
    const f = THREE.MathUtils.clamp((s - (next.s - stride / 2)) / (stride / 2), 0, 1);
    const lift = Math.sin(Math.PI * f) * 0.05;
    return { pos: [prev.xy[0] + (next.xy[0] - prev.xy[0]) * f, prev.xy[1] + (next.xy[1] - prev.xy[1]) * f, lift], red: next.hit && f > 0.8 };
  });
}

export function buildMannequin(heightM = 1.65) {
  const g = new THREE.Group(), skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: CLOTH, roughness: 0.9 });
  const k = heightM / 1.65, hipZ = 0.88 * k, shoulderZ = 1.38 * k, thigh = 0.44 * k, shin = 0.44 * k;
  const limb = (r: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 10), mat);
    g.add(m);
    return m;
  };
  const place = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.scale.set(1, a.distanceTo(b), 1);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  };
  const torso = limb(0.15 * k, cloth), hips = new THREE.Mesh(new THREE.SphereGeometry(0.15 * k, 14, 10), cloth);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * k, 16, 12), skin);
  g.add(hips, head);
  const legs = [0, 1].map(() => ({ thigh: limb(0.06 * k, cloth), shin: limb(0.05 * k, cloth), foot: new THREE.Mesh(new THREE.BoxGeometry(0.24 * k, 0.09 * k, 0.06 * k), skin.clone()) }));
  legs.forEach(l => g.add(l.foot));
  const arms = [0, 1].map(() => ({ upper: limb(0.04 * k, cloth), lower: limb(0.035 * k, skin) }));
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  /** body: user frame (x forward, y left) in the floor frame; feet in the floor frame; grips in the user frame. */
  function update(body: { x: number; y: number; yaw: number }, feet: { pos: [number, number, number]; red: boolean }[], grips: [XY, XY], gripZ: number) {
    const c = Math.cos(body.yaw), s = Math.sin(body.yaw);
    const W = (px: number, py: number, pz: number) => v(body.x + c * px - s * py, body.y + s * px + c * py, pz);
    const lean = 0.08;   // a walker user leans forward a little
    place(torso, W(0, 0, hipZ), W(lean, 0, shoulderZ));   // leaning forward a little, over the walker
    hips.position.copy(W(0, 0, hipZ));
    head.position.copy(W(lean + 0.03, 0, shoulderZ + 0.16 * k));
    [1, -1].forEach((side, n) => {
      const hip = W(0, side * 0.1 * k, hipZ), foot = v(...feet[n].pos).setZ(feet[n].pos[2] + 0.03 * k);
      // two-bone IK in the vertical plane through hip and foot, knee pushed forward
      const d = Math.min(hip.distanceTo(foot), thigh + shin - 1e-3), a = (thigh * thigh - shin * shin + d * d) / (2 * d), h = Math.sqrt(Math.max(thigh * thigh - a * a, 0));
      const dir = foot.clone().sub(hip).normalize(), fwd = W(1, 0, 0).sub(W(0, 0, 0)).normalize();
      const bend = fwd.clone().sub(dir.clone().multiplyScalar(fwd.dot(dir))).normalize();
      const knee = hip.clone().add(dir.clone().multiplyScalar(a)).add(bend.multiplyScalar(h));
      place(legs[n].thigh, hip, knee); place(legs[n].shin, knee, foot);
      legs[n].foot.position.copy(foot).add(W(0.06, 0, 0).sub(W(0, 0, 0)));
      legs[n].foot.rotation.set(0, 0, body.yaw);
      (legs[n].foot.material as THREE.MeshStandardMaterial).color.setHex(feet[n].red ? 0xff3030 : SKIN);
      const sh = W(lean, side * 0.19 * k, shoulderZ - 0.04), grip = W(grips[n][0], grips[n][1], gripZ + 0.03);
      const elbow = sh.clone().lerp(grip, 0.5).add(v(0, 0, -0.08)).add(W(0, side * 0.06, 0).sub(W(0, 0, 0)));
      place(arms[n].upper, sh, elbow); place(arms[n].lower, elbow, grip);
    });
  }
  return { group: g, update };
}

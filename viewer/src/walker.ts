// The walker, built from primitives at walker.json's exact dimensions (x forward from the user's body centre, y left).
import * as THREE from 'three';
import { buildWheelchair } from './wheelchair.ts';

export interface WalkerCfg {
  width_m: number; depth_m: number; handle_height_m: number; user_gap_m: number; leg_radius_m: number; legs: [number, number][];
  device?: 'walker' | 'cane' | 'wheelchair';
}

/** The front end of the left foam grip (x forward from the body centre, y left): the zip-tied controller sits just ahead of it */
export const gripFront = (w: WalkerCfg): [number, number] => [w.user_gap_m + w.depth_m - 0.1, w.width_m / 2 - w.leg_radius_m];

const METAL = 0xd4d8dd, RED = 0xff3030, GREY = 0x8a8f96, RUBBER = 0x5a5e64;
const WHEEL_R = 0.0635;   // 5" front wheels

/** The mobility aid for a persona: the walker frame, a cane (tip = its one "leg") or a wheelchair (wheels = legs). Same interface. */
export function buildDevice(w: WalkerCfg) { return w.device === 'cane' ? buildCane(w) : w.device === 'wheelchair' ? buildWheelchair(w) : buildWalker(w); }

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

/** A two-button folding walker (Drive Medical style): two inverted-U side frames with foam grips, a grey front cross bar
 *  with an arch under it, 5" wheels on the front legs and glide caps on the back ones. */
export function buildWalker(w: WalkerCfg) {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: METAL, metalness: 0.6, roughness: 0.35 });
  const greyMat = new THREE.MeshStandardMaterial({ color: GREY, metalness: 0.3, roughness: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ color: RUBBER, roughness: 0.9 });
  const tube = w.leg_radius_m, hy = w.width_m / 2 - tube, x0 = w.user_gap_m, x1 = x0 + w.depth_m, h = w.handle_height_m;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r = tube, mat: THREE.Material = frameMat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 10), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(m);
    return m;
  };
  const bent = (pts: THREE.Vector3[], r = tube, mat: THREE.Material = frameMat) =>
    group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, r, 8), mat));
  const BEND = 0.05;   // the top corners of each side frame are bent, not welded
  // legs get their own material so a single leg can flash red
  const legs = w.legs.map(([x, y]) => {
    const front = x > x0 + w.depth_m / 2, s = Math.sign(y) || 1;
    const m = bar(v(x, y, front ? WHEEL_R : 0.03), v(x, y, h - BEND));
    m.material = frameMat.clone();
    for (const z of [0.3, 0.46]) bar(v(x, y, z - 0.012), v(x, y, z + 0.012), tube * 1.25, greyMat);   // height-adjust collars
    if (front) {
      const wy = y - s * (tube + 0.016);   // wheel sits just inboard of the leg, axle along y
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.026, 24), rubber);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R * 0.55, WHEEL_R * 0.55, 0.03, 16), greyMat);
      tire.position.set(x, wy, WHEEL_R); hub.position.copy(tire.position);
      group.add(tire, hub);
      bar(v(x, y, WHEEL_R), v(x, wy, WHEEL_R), tube * 0.5, m.material);   // axle
    } else bar(v(x, y, 0), v(x, y, 0.035), tube * 1.3, greyMat);           // glide cap
    return m;
  });
  for (const s of [1, -1]) {
    const y = s * hy;
    bent([v(x0, y, h - BEND), v(x0 + 0.012, y, h - 0.012), v(x0 + BEND, y, h), v(x1 - BEND, y, h), v(x1 - 0.012, y, h - 0.012), v(x1, y, h - BEND)]);
    bar(v(x0 + 0.07, y, h + 0.004), v(gripFront(w)[0], y, h + 0.004), tube * 2, rubber);   // foam grip
    bar(v(x0, y, h - 0.13), v(x1, y, h - 0.17));                                      // upper side brace
    bent([v(x0, y, 0.4), v(x0 + 0.06, y, 0.47), v((x0 + x1) / 2, y, 0.5), v(x1, y, 0.52)]);   // lower side brace
    bar(v(x1, y, h - 0.4), v(x1, y, h - 0.17), tube * 1.3, greyMat);                 // grey sleeve on the front leg
    const button = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.012), new THREE.MeshStandardMaterial({ color: 0xe8505b }));
    button.position.set(x1 - 0.01, y * 0.55, h - 0.17 + tube * 1.4);   // fold release
    group.add(button);
  }
  bar(v(x1, hy, h - 0.17), v(x1, -hy, h - 0.17), tube * 1.3, greyMat);   // front cross bar (open at the back for the user)
  bent([v(x1, hy, h - 0.38), v(x1, hy * 0.5, h - 0.25), v(x1, 0, h - 0.22), v(x1, -hy * 0.5, h - 0.25), v(x1, -hy, h - 0.38)], tube * 0.8, greyMat);
  // points on the frame that clearance is measured from
  const probes: [number, number][] = [...w.legs, [(x0 + x1) / 2, hy], [(x0 + x1) / 2, -hy], [x1, 0]];
  const setFrameRed = (on: boolean) => { frameMat.color.setHex(on ? RED : METAL); greyMat.color.setHex(on ? RED : GREY); };
  const setLegRed = (k: number, on: boolean) => (legs[k].material as THREE.MeshStandardMaterial).color.setHex(on ? RED : METAL);
  return { group, legs, probes, setFrameRed, setLegRed };
}

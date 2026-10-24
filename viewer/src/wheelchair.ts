// The wheelchair persona: a typical manual chair built at its configured size, and what the 2010 ADA Standards ask of
// a route for it (turning space, level changes; door clear width is doors.ts with ADA's 815 mm floor). Code checks
// only: there is no calibrated fall model for a wheelchair, so its trip numbers are zero by construction (an all-zero
// contact table) and these verdicts carry the result. Sizes are typical, ASSUMED until the patient's chair is measured.
import * as THREE from 'three';
import type { WalkerCfg } from './walker.ts';
import type { CheckOut } from './checks.ts';
import type { GridMeta, XY } from './grid.ts';

/** 2010 ADA Standards: 304.3.1 turning circle, 404.2.3 door clear width, 303.2-303.3 changes in level */
export const ADA = { turn_d_m: 1.525, door_clear_m: 0.815, level_vertical_m: 0.0064, level_bevel_m: 0.013 };

/** x forward from the user's body centre (the hips), y left; the frame runs from the push handles to the footplates.
 *  "legs" are where it touches the floor: the two drive wheels, then the two casters. */
export const WHEELCHAIR: WalkerCfg = {
  width_m: 0.66, depth_m: 1.0, handle_height_m: 0.9, user_gap_m: -0.38, leg_radius_m: 0.02, device: 'wheelchair',
  legs: [[-0.05, 0.31], [-0.05, -0.31], [0.42, 0.24], [0.42, -0.24]],
};
export const SEAT_Z = 0.48, WHEEL_R = 0.3;

/** The persona for the selector: the patient's own body facts, seated eyes, and the zero contact table's profile. */
export function wheelchairPersona(patient: { gait: any }) {
  return { label: 'Wheelchair (typical manual chair, assumed)', walker: WHEELCHAIR,
    gait: { ...patient.gait, gait_profile: 'wheelchair', eye_height_m: 1.2, stride_m: 0.35, stride_cv: 0.05 }, plan: {}, vision: 'normal' };
}
/** No fall model for a chair: no contact at any height. The checks below say what matters for it. */
export const ZERO_CONTACTS = { height_m: [0, 1], p_per_stride: [0, 0] };

const METAL = 0xb8bec6, RED = 0xff3030, TYRE = 0x1c1c1c;

export function buildWheelchair(w: WalkerCfg) {
  const group = new THREE.Group(), frameMat = new THREE.MeshStandardMaterial({ color: METAL, metalness: 0.6, roughness: 0.35 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.95 });
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const bar = (a: THREE.Vector3, b: THREE.Vector3, r = 0.012, mat: THREE.Material = frameMat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(m);
    return m;
  };
  const ring = (x: number, y: number, z: number, R: number, tube: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 8, 40), mat);
    m.position.set(x, y, z);
    m.rotation.x = Math.PI / 2;   // the wheel stands upright, rolling along x
    group.add(m);
    return m;
  };
  // the floor contacts, each with its own tyre material so one can flash red over a bump
  const legs = w.legs.map(([x, y], k) => {
    const drive = k < 2, R = drive ? WHEEL_R : 0.075, tyre = new THREE.MeshStandardMaterial({ color: TYRE, roughness: 0.9 });
    const m = ring(x, y, R, R - 0.012, drive ? 0.014 : 0.018, tyre);
    if (drive) {
      ring(x, y + Math.sign(y) * 0.025, R, R - 0.04, 0.007, frameMat);   // hand rim
      for (let a = 0; a < 6; a++) {   // spokes
        const c = Math.cos((a * Math.PI) / 3) * (R - 0.03), s = Math.sin((a * Math.PI) / 3) * (R - 0.03);
        bar(v(x - c, y, R - s), v(x + c, y, R + s), 0.003);
      }
    } else bar(v(x, y, R), v(x, y, SEAT_Z - 0.02), 0.01);   // caster fork up to the frame
    return m;
  });
  const hy = 0.23;
  for (const s of [1, -1]) {
    bar(v(-0.08, s * hy, SEAT_Z - 0.02), v(0.42, s * hy, SEAT_Z - 0.02));                  // seat rail
    bar(v(-0.08, s * hy, SEAT_Z - 0.02), v(-0.05, s * (w.legs[0][1] - 0.02), WHEEL_R), 0.01);   // axle plate
    bar(v(-0.1, s * hy, SEAT_Z - 0.02), v(-0.16, s * hy, w.handle_height_m));               // back post
    bar(v(-0.16, s * hy, w.handle_height_m), v(-0.3, s * hy, w.handle_height_m), 0.016, new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }));   // push handle
    bar(v(-0.06, s * (hy + 0.02), 0.7), v(0.24, s * (hy + 0.02), 0.7), 0.018, fabric);      // armrest
    bar(v(0.22, s * (hy + 0.02), 0.7), v(0.22, s * hy, SEAT_Z - 0.02), 0.01);
    bar(v(0.38, s * 0.18, SEAT_Z - 0.04), v(0.55, s * 0.14, 0.12), 0.01);                    // footrest hanger
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.012), frameMat);
    plate.position.set(0.56, s * 0.09, 0.11);
    group.add(plate);
  }
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 2 * hy, 0.04), fabric);
  seat.position.set(0.15, 0, SEAT_Z);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2 * hy, 0.38), fabric);
  back.position.set(-0.13, 0, SEAT_Z + 0.24);
  back.rotation.y = -0.12;
  group.add(seat, back);
  // clearance probes: the wheels' outsides, the push handles and the footplates' front corners
  const R = w.width_m / 2;
  const probes: [number, number][] = [...w.legs, [-0.05, R], [-0.05, -R], [-0.3, hy], [-0.3, -hy], [0.62, 0.16], [0.62, -0.16]];
  const setFrameRed = (on: boolean) => frameMat.color.setHex(on ? RED : METAL);
  const setLegRed = (k: number, on: boolean) => (legs[k].material as THREE.MeshStandardMaterial).color.setHex(on ? RED : TYRE);
  return { group, legs, probes, setFrameRed, setLegRed };
}

interface Bump { position: XY; height_m?: number; type: string; name: string }

/** The chair's code checks on one layout. dist: the planner's distance field (m to the nearest obstacle or unseen
 *  floor); ends: where each route starts and stops (the spots the person must turn around in). */
export function wheelchairChecks(g: GridMeta, dist: Float32Array, ends: { name: string; at: XY }[], bumps: Bump[], margin_m: number): CheckOut[] {
  const out: CheckOut[] = [], ny = g.shape[1], r = ADA.turn_d_m / 2;
  // 1. turning space: a 1525 mm circle of clear floor whose centre is within 1 m of the spot
  for (const e of ends) {
    let best = 0, at: XY = e.at;
    const [ci, cj] = [Math.floor((e.at[0] - g.origin_xy[0]) / g.cell_m), Math.floor((e.at[1] - g.origin_xy[1]) / g.cell_m)], n = Math.ceil(1 / g.cell_m);
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) {
      if (i < 0 || j < 0 || i >= g.shape[0] || j >= ny || (i - ci) ** 2 + (j - cj) ** 2 > n * n) continue;
      const d = dist[i * ny + j];
      if (d > best) { best = d; at = [g.origin_xy[0] + (i + 0.5) * g.cell_m, g.origin_xy[1] + (j + 0.5) * g.cell_m]; }
    }
    const fits = 2 * best, cmD = (m: number) => `${(m * 100).toFixed(0)} cm`;
    out.push({ id: `wheelchair:turn:${e.name}`, kind: 'wheelchair', position: at, value_m: fits, limit_m: [ADA.turn_d_m, 99],
      label: `${e.name}: ${fits >= ADA.turn_d_m ? 'room' : 'no room'} to turn a wheelchair around (${cmD(fits)} clear, ADA ${cmD(ADA.turn_d_m)} circle)`,
      verdict: fits < ADA.turn_d_m - margin_m ? 'fail' : fits < ADA.turn_d_m + margin_m ? 'borderline, OT to verify' : 'ok',
      note: fits >= ADA.turn_d_m ? 'a full 1.5 m circle of clear floor within 1 m of here' : 'move furniture to clear a 1.5 m circle, or check a T-shaped turn (ADA 304.3.2) with the OT' });
  }
  // 2. changes in level: up to 6.4 mm may be square, up to 13 mm bevelled 1:2, anything taller needs a ramp
  for (const b of bumps) {
    if (b.type !== 'floor_bump' || !b.height_m || b.height_m <= ADA.level_vertical_m) continue;
    const mm = (b.height_m * 1000).toFixed(0), ramp = b.height_m > ADA.level_bevel_m;
    out.push({ id: `wheelchair:level:${b.position.map(v => v.toFixed(2)).join(',')}`, kind: 'wheelchair', position: b.position, value_m: b.height_m, limit_m: [0, ADA.level_bevel_m],
      label: `${b.name}: ${mm} mm edge ${ramp ? 'stops the casters' : 'needs a bevel'} (ADA: 6 mm square, 13 mm bevelled)`,
      verdict: ramp ? 'fail' : 'borderline, OT to verify', note: ramp ? 'a threshold ramp, or remove it (a rug or a cord comes out)' : 'bevelled at 1:2 or less, the casters roll over it' });
  }
  return out;
}

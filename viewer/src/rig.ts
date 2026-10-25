// A skinned, rigged mannequin (CesiumMan.glb, CC BY 4.0, see public/models/mannequin/CREDITS.md) posed by the same two-bone
// IK mannequin.ts uses: each foot's ankle is put exactly on the footstep the simulation placed (the pelvis drops just far enough that
// both legs reach, so a planted foot neither skates nor floats), the hands go to the grips, the spine leans. Visual only.
// Same interface as buildMannequin ({group, head, update, seated}), so main.ts swaps one for the other.
//
// How the pose is made: every joint keeps its rest orientation carried along by its parent (so twist stays consistent), then
// swings the smallest angle to point at the next joint's target. It is all done in the model's own space (Y up, the figure's
// left +x, forward +z); the group around it turns that into the viewer's floor frame (z up) and scales it to the persona.
// Written for this one model: the joint names, and that it stands on y = 0, come from CesiumMan.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const ROLES = ['sh', 'el', 'wr', 'hip', 'kn', 'an', 'toe'] as const;
const NAMES: Record<string, string> = {
  pelvis: 'Skeleton_torso_joint_1', spine: 'Skeleton_torso_joint_2', chest: 'torso_joint_3', neck: 'Skeleton_neck_joint_1', head: 'Skeleton_neck_joint_2',
  'L.sh': 'Skeleton_arm_joint_L__4_', 'L.el': 'Skeleton_arm_joint_L__3_', 'L.wr': 'Skeleton_arm_joint_L__2_',
  'L.hip': 'leg_joint_L_1', 'L.kn': 'leg_joint_L_2', 'L.an': 'leg_joint_L_3', 'L.toe': 'leg_joint_L_5',
  'R.sh': 'Skeleton_arm_joint_R', 'R.el': 'Skeleton_arm_joint_R__2_', 'R.wr': 'Skeleton_arm_joint_R__3_',
  'R.hip': 'leg_joint_R_1', 'R.kn': 'leg_joint_R_2', 'R.an': 'leg_joint_R_3', 'R.toe': 'leg_joint_R_5',
};
/** [parent joint, the joint it points at when aimed]; the pelvis hangs off a plain node, leaves point at nothing */
const TREE: Record<string, [string | null, string | null]> = {
  pelvis: [null, 'spine'], spine: ['pelvis', 'chest'], chest: ['spine', 'neck'], neck: ['chest', 'head'], head: ['neck', null],
  ...Object.fromEntries(['L', 'R'].flatMap(s => [[`${s}.sh`, ['chest', `${s}.el`]], [`${s}.el`, [`${s}.sh`, `${s}.wr`]], [`${s}.wr`, [`${s}.el`, null]],
    [`${s}.hip`, ['pelvis', `${s}.kn`]], [`${s}.kn`, [`${s}.hip`, `${s}.an`]], [`${s}.an`, [`${s}.kn`, `${s}.toe`]], [`${s}.toe`, [`${s}.an`, null]]])),
};
export const RIG_HEIGHT_M = 1.5065;   // the model's standing height; the persona's height scales it

const V3 = THREE.Vector3, Q4 = THREE.Quaternion;

interface Joint { bone: THREE.Object3D; parent: string | null; child: string | null; P0: THREE.Vector3; Q0: THREE.Quaternion; d0: THREE.Vector3 | null }
export interface Rig {
  holder: THREE.Group; joints: Record<string, Joint>; scale: number
  fwd0: THREE.Vector3; up0: THREE.Vector3; leftIsL: boolean
  len: Record<string, number>   // bone lengths, model units, joint to its child
  ankleH: number; hipDrop: number; restHipY: number   // model units: ankle above the floor, pelvis above the hips, the hips' standing height
  pelvisMat0: THREE.Matrix4; pelvisQ0: THREE.Quaternion; mesh: THREE.SkinnedMesh | null; plane: THREE.Plane; headVisible: boolean
}
/** how far each end joint ended from its target (m): [left, right] ankles and wrists, and the pelvis height reached */
export interface PoseReport { ankleErr_m: [number, number]; handErr_m: [number, number]; hipZ: number }

const basis = (f: THREE.Vector3, u: THREE.Vector3) => {
  const l = new V3().crossVectors(u, f).normalize();   // right-handed (forward, left, up)
  return new Q4().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.clone().normalize(), l, new V3().crossVectors(f, l).normalize()));
};

/** Find the joints in a loaded (or hand-built) model, record the rest pose in the model's space, and wrap it for the viewer.
 *  `root` is the glTF scene: nothing above the joints is changed, so the skin's inverse bind matrices still fit. */
export function bindRig(root: THREE.Object3D, heightM: number): Rig {
  const holder = new THREE.Group(), scale = heightM / RIG_HEIGHT_M;
  holder.rotation.x = Math.PI / 2;   // the model is Y up; the viewer is Z up
  holder.scale.setScalar(scale);
  holder.add(root);
  holder.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();   // holder-local = model space
  const joints: Record<string, Joint> = {};
  for (const [k, n] of Object.entries(NAMES)) {
    const bone = root.getObjectByName(n);
    if (!bone) throw new Error(`rig: no joint ${n}`);
    const P0 = new V3(), Q0 = new Q4();
    new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld).decompose(P0, Q0, new V3());
    joints[k] = { bone, parent: TREE[k][0], child: TREE[k][1], P0, Q0, d0: null };
  }
  const len: Record<string, number> = {};
  for (const [k, j] of Object.entries(joints)) if (j.child) { const c = joints[j.child]; j.d0 = c.P0.clone().sub(j.P0).normalize(); len[k] = c.P0.distanceTo(j.P0); }
  // the figure's axes from its rest pose: up = pelvis to neck, forward = ankle to the foot's end (made horizontal), left = up x forward
  const up0 = joints.neck.P0.clone().sub(joints.pelvis.P0).normalize();
  const foot = joints['L.toe'].P0.clone().sub(joints['L.an'].P0);
  const fwd0 = foot.sub(up0.clone().multiplyScalar(foot.dot(up0))).normalize();
  const leftIsL = joints['L.hip'].P0.clone().sub(joints['R.hip'].P0).dot(new V3().crossVectors(up0, fwd0)) > 0;
  const pm = new THREE.Matrix4().multiplyMatrices(inv, joints.pelvis.bone.parent!.matrixWorld);
  let mesh: THREE.SkinnedMesh | null = null;
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) { mesh = o as THREE.SkinnedMesh; mesh.frustumCulled = false; } });   // the bind-pose bounds don't follow the pose
  const y = (k: string) => joints[k].P0.dot(up0);
  return { holder, joints, scale, fwd0, up0, leftIsL, len, ankleH: y('L.an'), hipDrop: y('pelvis') - y('L.hip'), restHipY: y('L.hip'),
    pelvisMat0: pm, pelvisQ0: new Q4().setFromRotationMatrix(new THREE.Matrix4().extractRotation(pm)), mesh, plane: new THREE.Plane(), headVisible: true };
}

/** Two-bone IK: the middle joint (knee, elbow) and the end reached, for a chain from `root` with bone lengths l1, l2, bending
 *  toward `pole`. A target out of reach is reached as far as the straight chain goes; one too close is held at the shortest fold. */
export function twoBone(root: THREE.Vector3, target: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3) {
  const d = target.clone().sub(root), raw = d.length();
  const dist = THREE.MathUtils.clamp(raw, Math.abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6);
  const dir = raw > 1e-9 ? d.divideScalar(raw) : pole.clone().normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  let bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir)));
  if (bend.lengthSq() < 1e-12) bend = new V3(1, 0, 0).sub(dir.clone().multiplyScalar(dir.x));   // pole along the chain: any perpendicular
  return { mid: root.clone().add(dir.clone().multiplyScalar(a)).add(bend.normalize().multiplyScalar(h)), end: root.clone().add(dir.clone().multiplyScalar(dist)) };
}

/** Everything in the model's space. ankles / hands: [the figure's left, right]. */
interface Targets {
  pelvis: THREE.Vector3; fwd: THREE.Vector3; up: THREE.Vector3; lean: number   // lean: spine forward lean (rad)
  ankles: [THREE.Vector3, THREE.Vector3]; hands: [THREE.Vector3, THREE.Vector3]
  kneePole: THREE.Vector3; elbowPole: [THREE.Vector3, THREE.Vector3]
  lowerPelvisToReach: boolean
}

function pose(r: Rig, t: Targets): PoseReport {
  const J = r.joints, W: Record<string, THREE.Quaternion> = {}, P: Record<string, THREE.Vector3> = {};
  const delta = basis(t.fwd, t.up).multiply(basis(r.fwd0, r.up0).invert());   // rest frame -> the heading, level: applied at the pelvis
  const jname = (i: number, role: string) => `${(i === 0) === r.leftIsL ? 'L' : 'R'}.${role}`;   // the figure's left = joint set L, or R when the rig is mirrored
  const pel = t.pelvis.clone();
  const lLeg = r.len['L.hip'] + r.len['L.kn'];
  if (t.lowerPelvisToReach) {   // as tall as it stands, but no higher than lets both legs reach their ankles
    let hz = pel.dot(t.up);
    for (const i of [0, 1]) {
      const off = J[jname(i, 'hip')].P0.clone().sub(J.pelvis.P0).applyQuaternion(delta);   // where the hip hangs off the pelvis, in this heading
      const d = t.ankles[i].clone().sub(pel).sub(off);
      d.addScaledVector(t.up, -d.dot(t.up));
      hz = Math.min(hz, t.ankles[i].dot(t.up) + Math.sqrt(Math.max(0, (0.985 * lLeg) ** 2 - d.lengthSq())) + r.hipDrop);
    }
    pel.addScaledVector(t.up, hz - pel.dot(t.up));
  }
  const parentDelta = (k: string) => { const p = J[k].parent; return p ? W[p].clone().multiply(J[p].Q0.clone().invert()) : delta; };
  /** orient joint k: its rest pose carried by its parent, then (aim) swung to point along `aim`; (override) or set outright */
  const place = (k: string, aim: THREE.Vector3 | null, override?: THREE.Quaternion) => {
    const j = J[k], pd = parentDelta(k);
    let w = pd.clone().multiply(j.Q0);
    if (aim && j.d0) w = new Q4().setFromUnitVectors(j.d0.clone().applyQuaternion(pd).normalize(), aim.clone().normalize()).multiply(w);
    if (override) w = override;
    W[k] = w;
    if (j.parent) {
      P[k] = P[j.parent].clone().add(j.bone.position.clone().applyQuaternion(W[j.parent]));
      j.bone.quaternion.copy(W[j.parent].clone().invert().multiply(w));
    } else {
      P[k] = pel.clone();
      j.bone.quaternion.copy(r.pelvisQ0.clone().invert().multiply(w));
      j.bone.position.copy(pel).applyMatrix4(new THREE.Matrix4().copy(r.pelvisMat0).invert());
    }
  };
  const spineDir = t.up.clone().multiplyScalar(Math.cos(t.lean)).addScaledVector(t.fwd, Math.sin(t.lean));
  const neckDir = t.up.clone().addScaledVector(t.fwd, 0.12 + 0.2 * Math.sin(t.lean));   // the head stays nearly upright
  place('pelvis', null); place('spine', spineDir); place('chest', spineDir); place('neck', neckDir); place('head', null);
  const err = [0, 0, 0, 0];
  for (const i of [0, 1]) {
    // leg: the knee from the IK (re-aiming the hip once it is known), the foot flat in the heading's frame
    const [hip, kn, an, toe] = ['hip', 'kn', 'an', 'toe'].map(r_ => jname(i, r_));
    place(hip, null);
    const leg = twoBone(P[hip], t.ankles[i], r.len[hip], r.len[kn], t.kneePole);
    place(hip, leg.mid.clone().sub(P[hip])); place(kn, leg.end.clone().sub(leg.mid));
    place(an, null, delta.clone().multiply(J[an].Q0)); place(toe, null);
    err[i] = P[an].distanceTo(t.ankles[i]);
    // arm: the wrist on its target, the elbow toward its pole
    const [sh, el, wr] = ['sh', 'el', 'wr'].map(r_ => jname(i, r_));
    place(sh, null);
    const arm = twoBone(P[sh], t.hands[i], r.len[sh], r.len[el], t.elbowPole[i]);
    place(sh, arm.mid.clone().sub(P[sh])); place(el, arm.end.clone().sub(arm.mid));
    place(wr, null);
    err[2 + i] = P[wr].distanceTo(t.hands[i]);
  }
  // first person hides the head: a clip plane at the top of the neck, drawn below it only
  r.holder.updateMatrixWorld(true);
  const headW = P.head.clone().applyMatrix4(r.holder.matrixWorld), dirW = P.head.clone().sub(P.neck).transformDirection(r.holder.matrixWorld);
  r.plane.setFromNormalAndCoplanarPoint(dirW.negate(), headW);
  const mats = r.mesh ? ([] as THREE.Material[]).concat(r.mesh.material) : [];
  for (const m of mats) m.clippingPlanes = r.headVisible ? null : [r.plane];
  return { ankleErr_m: [err[0] * r.scale, err[1] * r.scale], handErr_m: [err[2] * r.scale, err[3] * r.scale], hipZ: pel.dot(t.up) * r.scale };
}

type Body = { x: number; y: number; yaw: number };
const toModel = (r: Rig) => {   // viewer floor frame (z up) -> the model's space, as a point or a direction
  const q = new Q4().setFromAxisAngle(new V3(1, 0, 0), -Math.PI / 2);
  return (p: THREE.Vector3, point = true) => { const v = p.clone().applyQuaternion(q); return point ? v.divideScalar(r.scale) : v; };
};
const heading = (b: Body) => ({ f: new V3(Math.cos(b.yaw), Math.sin(b.yaw), 0), l: new V3(-Math.sin(b.yaw), Math.cos(b.yaw), 0) });
const WORLD_UP = new V3(0, 0, 1);

/** The walking user behind the walker. feet: [left, right], heel positions [x, y, lift]; grips: [left, right] as [x, y] in the body frame. */
export function poseWalking(r: Rig, body: Body, feet: { pos: [number, number, number] }[], grips: [number, number][], gripZ: number, lean = 0.2): PoseReport {
  const m = toModel(r), { f, l } = heading(body), s = r.scale;
  const ankles = feet.map(ft => m(new V3(ft.pos[0], ft.pos[1], ft.pos[2] + r.ankleH * s).addScaledVector(f, 0.07 * s))) as Targets['ankles'];   // the ankle sits just ahead of the heel
  const hands = grips.map(g => m(new V3(body.x, body.y, gripZ).addScaledVector(f, g[0]).addScaledVector(l, g[1]))) as Targets['hands'];
  const pelvis = m(new V3(body.x, body.y, (r.restHipY + r.hipDrop) * s));
  const elbow = (sgn: number) => m(new V3(0, 0, -1).addScaledVector(l, 0.8 * sgn), false);
  return pose(r, { pelvis, fwd: m(f, false), up: m(WORLD_UP, false), lean, ankles, hands, kneePole: m(f, false), elbowPole: [elbow(1), elbow(-1)], lowerPelvisToReach: true });
}

/** Seated in the wheelchair (wheelchair.ts frame): hips on the seat, feet toward the footplates (as far as these short legs reach), and
 *  the hands on the hand rims at the point of the wheel nearest the shoulders (wheel: axle x, axle height, rim radius, in the body frame). */
export function poseSeated(r: Rig, body: Body, seatZ: number, rimY: number, wheel = { x: -0.05, z: 0.3, r: 0.26 }): PoseReport {
  const m = toModel(r), { f, l } = heading(body), s = r.scale, y = (k: string) => r.joints[k].P0.dot(r.up0);
  const at = (x: number, y: number, z: number) => new V3(body.x, body.y, z).addScaledVector(f, x).addScaledVector(l, y);
  const pelvisZ = seatZ + 0.04 + r.hipDrop * s, shoulderZ = pelvisZ + (y('L.sh') - y('pelvis')) * s;
  const dx = -wheel.x, dz = shoulderZ - wheel.z, dn = Math.hypot(dx, dz) || 1;   // from the axle toward the shoulders, in the wheel's plane
  const pelvis = m(at(0, 0, pelvisZ));
  const ankles = [1, -1].map(sg => m(at(0.5, sg * 0.09, 0.15 + r.ankleH * s))) as Targets['ankles'];
  const hands = [1, -1].map(sg => m(at(wheel.x + (wheel.r * dx) / dn, sg * rimY, wheel.z + (wheel.r * dz) / dn))) as Targets['hands'];
  const elbow = (sgn: number) => m(new V3(0, 0, -0.5).addScaledVector(f, -0.6).addScaledVector(l, 0.5 * sgn), false);
  return pose(r, { pelvis, fwd: m(f, false), up: m(WORLD_UP, false), lean: 0.05, ankles, hands, kneePole: m(WORLD_UP, false), elbowPole: [elbow(1), elbow(-1)], lowerPelvisToReach: false });
}

/** The mannequin as main.ts uses it (the same four members as buildMannequin's). */
export function riggedMannequin(root: THREE.Object3D, heightM: number) {
  const r = bindRig(root, heightM);
  r.holder.visible = false;
  const head = { get visible() { return r.headVisible; }, set visible(v: boolean) { r.headVisible = v; } };
  return {
    group: r.holder, head, rig: r,
    update: (body: Body, feet: { pos: [number, number, number]; red: boolean }[], grips: [number, number][], gripZ: number) => poseWalking(r, body, feet, grips, gripZ),
    seated: (body: Body, seatZ: number, rimY: number, wheel?: { x: number; z: number; r: number }) => poseSeated(r, body, seatZ, rimY, wheel),
  };
}

export async function loadRigged(url: string, heightM: number) {
  const gltf = await new GLTFLoader().loadAsync(url);
  return riggedMannequin(gltf.scene, heightM);
}

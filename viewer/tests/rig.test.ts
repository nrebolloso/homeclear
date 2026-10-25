import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { bindRig, twoBone, poseWalking, poseSeated, RIG_HEIGHT_M } from '../src/rig.ts';
import { feetAt, type Step } from '../src/mannequin.ts';
import { glbNodes } from './glb.ts';
import { loadScene } from './scene.ts';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const model = () => bindRig(glbNodes(fileURLToPath(new URL('../public/models/mannequin/CesiumMan.glb', import.meta.url))).scene, 1.65);
const world = (r: ReturnType<typeof model>, name: string) => { r.holder.updateMatrixWorld(true); return r.joints[name].bone.getWorldPosition(new THREE.Vector3()); };
const WALKER = loadScene('game_synth').walker;
const hy = WALKER.width_m / 2 - WALKER.leg_radius_m, gx = WALKER.user_gap_m + 0.05;
const GRIPS: [number, number][] = [[gx, hy], [gx, -hy]];

test('two-bone IK: keeps both bone lengths, reaches what is in reach, stretches straight at what is not, bends toward the pole', () => {
  const root = V(0, 0, 1), l1 = 0.45, l2 = 0.4;
  for (const t of [V(0.3, 0.1, 0.4), V(0.6, 0, 0.6), V(-0.2, 0.3, 0.5)]) {
    const { mid, end } = twoBone(root, t, l1, l2, V(1, 0, 0));
    assert.ok(Math.abs(mid.distanceTo(root) - l1) < 1e-9 && Math.abs(end.distanceTo(mid) - l2) < 1e-9);
    assert.ok(end.distanceTo(t) < 1e-9, 'reached');
  }
  const far = twoBone(root, V(0, 0, -3), l1, l2, V(1, 0, 0));
  assert.ok(Math.abs(far.end.distanceTo(root) - (l1 + l2)) < 1e-4 && far.end.x === 0 && far.end.z < 1 - 0.8, 'straight toward the target');
  assert.ok(twoBone(root, V(0, 0, 0.3), l1, l2, V(1, 0, 0)).mid.x > 0 && twoBone(root, V(0, 0, 0.3), l1, l2, V(-1, 0, 0)).mid.x < 0, 'the pole picks the side');
  assert.ok(Number.isFinite(twoBone(root, V(0, 0, 0.3), l1, l2, V(0, 0, 1)).mid.x), 'pole along the chain is not a NaN');
});

test('the rig: every joint found, axes from the rest pose, scaled to the persona', () => {
  const r = model();
  assert.equal(Object.keys(r.joints).length, 19);
  assert.ok(r.leftIsL, 'CesiumMan: the L joints are the figure\'s left');
  assert.ok(Math.abs(r.scale - 1.65 / RIG_HEIGHT_M) < 1e-12);
  assert.ok(Math.abs(r.fwd0.dot(r.up0)) < 1e-9 && r.fwd0.z > 0.99, 'forward is +z in the model, level');
  assert.ok(r.len['L.hip'] > 0.2 && r.len['L.hip'] < 0.35 && Math.abs(r.len['L.hip'] - r.len['R.hip']) < 0.01);
});

/** the rig's joint spacing is rigid: posing never stretches a bone */
function boneLengthsHold(r: ReturnType<typeof model>) {
  for (const [k, j] of Object.entries(r.joints)) if (j.child) {
    const d = world(r, k).distanceTo(world(r, j.child)) / r.scale;
    assert.ok(Math.abs(d - r.len[k]) < 1e-3, `${k} -> ${j.child}: ${d} vs ${r.len[k]}`);
  }
}

test('walking: each ankle on its footstep to within 1 cm, planted feet do not skate, soles never below the floor, bones stay rigid', () => {
  const r = model(), s = r.scale;
  const steps: Step[] = [0, 1, 2, 3, 4, 5, 6, 7].map(k => ({ xy: [k * 0.35, k % 2 ? 0.09 : -0.09], side: k % 2, hit: false, s: k * 0.35 }));
  let prev: THREE.Vector3[] | null = null, prevPos: number[][] | null = null, worst = 0, planted = 0, lowest = 0, minHip = 9;
  for (let t = 0.2; t < 2.2; t += 0.02) {
    const f = feetAt(steps, t, 0.7), feet = [f[1], f[0]];   // [left, right], as main.ts hands them over
    const body = { x: t - 0.1, y: 0, yaw: 0 };
    const rep = poseWalking(r, body, feet, GRIPS, WALKER.handle_height_m);
    const ank = [world(r, 'L.an'), world(r, 'R.an')];
    feet.forEach((ft, i) => {
      const want = V(ft.pos[0] + 0.07 * s, ft.pos[1], ft.pos[2] + r.ankleH * s);
      worst = Math.max(worst, ank[i].distanceTo(want));
      if (prev && prevPos![i].every((v, c) => v === ft.pos[c])) { planted++; assert.ok(ank[i].distanceTo(prev[i]) < 0.01, `foot ${i} skated ${ank[i].distanceTo(prev[i])} while planted`); }
      lowest = Math.min(lowest, world(r, i ? 'R.toe' : 'L.toe').z - ft.pos[2]);
    });
    minHip = Math.min(minHip, rep.hipZ);
    prev = ank.map(a => a.clone()); prevPos = feet.map(ft => [...ft.pos]);
    boneLengthsHold(r);
  }
  assert.ok(worst < 0.01, `ankle off its footstep by ${worst * 100} cm`);
  assert.ok(planted > 20, `only ${planted} planted frames compared`);
  assert.ok(lowest > -0.01, `a toe went ${lowest} below the floor`);
  assert.ok(minHip > 0.5 * r.restHipY * s, 'the pelvis does not collapse to reach');
});

test('walking: the figure faces its heading, its left is the heading\'s left, and the head is above the hips', () => {
  const r = model();
  for (const yaw of [0, 1.2, -2.5]) {
    const f = V(Math.cos(yaw), Math.sin(yaw), 0), l = V(-Math.sin(yaw), Math.cos(yaw), 0);
    const feet = [{ pos: [0.2 * f.x + 0.09 * l.x, 0.2 * f.y + 0.09 * l.y, 0] as [number, number, number] }, { pos: [-0.1 * f.x - 0.09 * l.x, -0.1 * f.y - 0.09 * l.y, 0] as [number, number, number] }];
    poseWalking(r, { x: 0, y: 0, yaw }, feet, GRIPS, WALKER.handle_height_m);
    const toe = world(r, 'L.toe').sub(world(r, 'L.an')); toe.z = 0;
    assert.ok(toe.dot(f) > 0, `foot points along the heading at yaw ${yaw}`);
    assert.ok(world(r, 'L.hip').sub(world(r, 'R.hip')).dot(l) > 0.1, 'left hip is on the left');
    const head = world(r, 'head'), pel = world(r, 'pelvis');
    assert.ok(head.z - pel.z > 0.4 && Math.hypot(head.x - pel.x, head.y - pel.y) < 0.25, `head ${head.z - pel.z} m above the pelvis, ${Math.hypot(head.x - pel.x, head.y - pel.y)} m off`);
    assert.ok(world(r, 'head').sub(pel).dot(f) > 0, 'leaning forward, not back');
  }
});

test('walking: both hands reach the walker\'s grips', () => {
  const r = model();
  const feet = [{ pos: [0.05, 0.09, 0] as [number, number, number] }, { pos: [-0.25, -0.09, 0] as [number, number, number] }];
  const rep = poseWalking(r, { x: 0, y: 0, yaw: 0 }, feet, GRIPS, WALKER.handle_height_m);
  assert.ok(Math.max(...rep.handErr_m) < 0.03, `hands ${rep.handErr_m.map(e => (e * 100).toFixed(1))} cm short of the grips`);
});

test('seated: hips on the seat, bones rigid, hands on the rims; the short legs get as far toward the footplates as they reach', () => {
  const r = model();
  const rep = poseSeated(r, { x: 1, y: 2, yaw: 0.7 }, 0.48, 0.34);
  boneLengthsHold(r);
  const hips = world(r, 'L.hip').add(world(r, 'R.hip')).multiplyScalar(0.5);
  assert.ok(Math.abs(hips.z - (0.48 + 0.04)) < 0.02, `hips at ${hips.z}`);
  assert.ok(Math.max(...rep.handErr_m) < 0.08, `hands ${rep.handErr_m.map(e => (e * 100).toFixed(1))} cm off the rims`);
  assert.ok(rep.ankleErr_m.every(e => Number.isFinite(e) && e < 0.3), `ankles ${rep.ankleErr_m}`);
});

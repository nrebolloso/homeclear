import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { floorHit, rayPlaneHit, pushPull, confirmProgress, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S, CONFIRM_S, PUSH_MAX_M } from '../src/wand.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('floorHit: 45 deg down from 1 m lands 1 m ahead; level, upward and too-far rays miss', () => {
  const o = new THREE.Vector3(2, 3, 1);
  const p = floorHit(o, new THREE.Vector3(1, 0, -1).normalize())!;
  close(p.x, 3); close(p.y, 3); close(p.z, 0);
  assert.equal(floorHit(o, new THREE.Vector3(1, 0, 0)), null);
  assert.equal(floorHit(o, new THREE.Vector3(0, 0, 1)), null);
  assert.equal(floorHit(o, new THREE.Vector3(1, 0, -0.01).normalize(), 15), null);   // ~100 m away
});

test('twistAngle: roll about the ray, signed; turning the ray itself is not a twist', () => {
  const q0 = new THREE.Quaternion();                                                    // ray along -z
  const roll = (a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), a);
  close(twistAngle(q0, roll(0.5)), 0.5);
  close(twistAngle(q0, roll(-1.2)), -1.2);
  close(twistAngle(q0, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8)), 0);   // pointing elsewhere
});

test('snapQuarter: a twist counts past 45 deg', () => {
  close(snapQuarter(0.7), 0);
  close(snapQuarter(0.9), Math.PI / 2);
  close(snapQuarter(-2.5), -Math.PI);
});

test('holdProgress: still holds count up to delete, any real drag cancels', () => {
  close(holdProgress(DELETE_HOLD_S / 2, 0.01), 0.5);
  assert.equal(holdProgress(DELETE_HOLD_S * 2, 0), 1);
  assert.equal(holdProgress(DELETE_HOLD_S * 2, 0.2), -1);
});

test('rayPlaneHit: meets the plane at z from above or below; level, away and too-far rays miss', () => {
  const o = new THREE.Vector3(2, 3, 1.2), down = new THREE.Vector3(1, 0, -1).normalize();
  const p = rayPlaneHit(o, down, 0.4)!;
  close(p.x, 2.8); close(p.y, 3); close(p.z, 0.4);
  const q = rayPlaneHit(new THREE.Vector3(0, 0, 0.1), new THREE.Vector3(1, 0, 1).normalize(), 0.6)!;   // controller below the plane, pointing up
  close(q.x, 0.5); close(q.z, 0.6);
  assert.equal(rayPlaneHit(o, new THREE.Vector3(1, 0, 0), 0.4), null);
  assert.equal(rayPlaneHit(o, new THREE.Vector3(0, 0, 1), 0.4), null);                                  // away from the plane
  assert.equal(rayPlaneHit(o, new THREE.Vector3(1, 0, -0.01).normalize(), 0.4, 15), null);
  const f = floorHit(o, down)!, g = rayPlaneHit(o, down, 0)!;
  close(f.x, g.x); close(f.y, g.y);
});

test('pushPull: stick up pushes away, down pulls in, a rest stick does nothing, and it is clamped', () => {
  assert.equal(pushPull(0.5, 0.1, 1), 0.5);
  assert.ok(pushPull(0, -1, 0.5) > 0.5);
  assert.ok(pushPull(0, 1, 0.5) < -0.5);
  assert.equal(pushPull(PUSH_MAX_M - 0.01, -1, 10), PUSH_MAX_M);
  assert.equal(pushPull(-PUSH_MAX_M, 1, 10), -PUSH_MAX_M);
});

test('confirmProgress: A held CONFIRM_S fills the ring; a tap does not', () => {
  close(confirmProgress(CONFIRM_S / 2), 0.5);
  assert.equal(confirmProgress(CONFIRM_S * 3), 1);
  assert.ok(confirmProgress(0.05) < 1);
  assert.equal(confirmProgress(-1), 0);
});

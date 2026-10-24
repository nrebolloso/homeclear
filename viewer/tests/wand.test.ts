import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { floorHit, twistAngle, snapQuarter, holdProgress, DELETE_HOLD_S } from '../src/wand.ts';

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

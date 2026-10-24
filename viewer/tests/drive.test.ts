import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIR_DRIVE as D, chairGeometry, clearOf, driveStep, spinBy, canSpinAround, type Pose, type Vel, type DriveInput } from '../src/drive.ts';
import { WHEELCHAIR, buildWheelchair, ADA } from '../src/wheelchair.ts';

const CELL = 0.05, chair = chairGeometry(WHEELCHAIR, CELL / 2);
// floor is the open rectangles; everything else is wall, read on 5 cm cells like the viewer's grid
const cellClear = (rects: [number, number, number, number][], posts: [number, number][] = []) => (x: number, y: number) => {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  if (posts.some(([px, py]) => Math.floor(px / CELL) === cx && Math.floor(py / CELL) === cy)) return false;
  return rects.some(([x0, y0, x1, y1]) => cx * CELL >= x0 - 1e-9 && cy * CELL >= y0 - 1e-9 && (cx + 1) * CELL <= x1 + 1e-9 && (cy + 1) * CELL <= y1 + 1e-9);
};
const room = clearOf(chair, cellClear([[0, 0, 8, 6]]));
const pivotAt = (p: Pose) => [p.x + Math.cos(p.yaw) * chair.pivot, p.y + Math.sin(p.yaw) * chair.pivot];
const run = (body: Pose, vel: Vel, input: DriveInput, secs: number, ok = room, dt = 1 / 60) => { for (let t = 0; t < secs; t += dt) driveStep(body, vel, input, dt, chair, ok); };
const fwd: DriveInput = { throttle: 1, steer: 0, spin: 0 }, idle: DriveInput = { throttle: 0, steer: 0, spin: 0 };

test('speed builds to the chair\'s top speed, coasts to a stop, and backs up slower', () => {
  const b: Pose = { x: 1, y: 3, yaw: 0 }, v: Vel = { v: 0, w: 0 };
  run(b, v, fwd, 0.5);
  assert.ok(v.v > 0.3 && v.v < D.v_max, `still accelerating at ${v.v}`);
  run(b, v, fwd, 2);
  assert.ok(Math.abs(v.v - D.v_max) < 1e-9);
  run(b, v, idle, 0.5);
  assert.ok(v.v > 0 && v.v < D.v_max, 'coasts rather than stopping dead');
  run(b, v, idle, 3);
  assert.equal(v.v, 0);
  run(b, v, { ...fwd, throttle: -1 }, 3);
  assert.ok(Math.abs(v.v + D.v_rev) < 1e-9);
});

test('A/D only steer while rolling: at rest the chair does not turn, rolling it follows an arc about the axle', () => {
  const b: Pose = { x: 1, y: 3, yaw: 0 }, v: Vel = { v: 0, w: 0 };
  run(b, v, { throttle: 0, steer: 1, spin: 0 }, 1);
  assert.equal(b.yaw, 0);
  run(b, v, fwd, 3);
  const yaw0 = b.yaw;
  run(b, v, { throttle: 1, steer: 1, spin: 0 }, 1);
  assert.ok(b.yaw > yaw0 + 0.3, 'steering left while rolling turns left');
  const back: Pose = { x: 5, y: 3, yaw: 0 }, w: Vel = { v: 0, w: 0 };
  run(back, w, { throttle: -1, steer: 1, spin: 0 }, 2);
  assert.ok(back.yaw < 0, 'backing with left steer swings the other way, as a car does');
});

test('Q/E spin the chair about its axle without moving it', () => {
  const b: Pose = { x: 4, y: 3, yaw: 0 }, v: Vel = { v: 0, w: 0 }, [px, py] = pivotAt(b);
  run(b, v, { throttle: 0, steer: 0, spin: 1 }, 1);
  assert.ok(b.yaw > 1, `spun ${b.yaw} rad`);
  const [qx, qy] = pivotAt(b);
  assert.ok(Math.hypot(qx - px, qy - py) < 1e-6, 'the axle stays put');
  assert.ok(Math.hypot(b.x - 4, b.y - 3) > 0.02, 'while the hips swing round it');
});

test('a full turn on the spot needs about the chair\'s swept circle: fits in a 1.6 m corridor, not a 1.4 m one', () => {
  const at: Pose = { x: 4, y: 3, yaw: 0 };
  const corridor = (w: number) => clearOf(chair, cellClear([[0, 0, 8, w]]));
  const mid = (w: number): Pose => ({ x: 3 - chair.pivot, y: w / 2, yaw: 0 });
  assert.equal(canSpinAround(mid(1.6), chair, corridor(1.6)), true);
  assert.equal(canSpinAround(mid(1.4), chair, corridor(1.4)), false);
  assert.ok(2 * chair.rmax > 1.4 && 2 * chair.rmax < ADA.turn_d_m + 0.05, `swept circle ${(2 * chair.rmax).toFixed(2)} m vs ADA ${ADA.turn_d_m} m`);
  assert.equal(canSpinAround(at, chair, room), true);   // the middle of an open room
});

test('the swept outline catches a post the point probes spin straight past', () => {
  const probes = buildWheelchair(WHEELCHAIR).probes;
  const b: Pose = { x: 3, y: 3, yaw: 0 }, [px, py] = pivotAt(b);
  const posts: [number, number][] = [[px + 0.01, py + 0.46]];   // beside the wheel, inside the swept circle of the frame's side
  const clear = cellClear([[0, 0, 8, 6]], posts);
  const probesOk = (p: Pose) => probes.every(q => clear(p.x + Math.cos(p.yaw) * q[0] - Math.sin(p.yaw) * q[1], p.y + Math.sin(p.yaw) * q[0] + Math.cos(p.yaw) * q[1]));
  const turned: Pose[] = [];
  for (let a = 0; a < 2 * Math.PI; a += 0.02) { const c = { ...b }; spinBy(c, a, chair, () => true); turned.push(c); }
  assert.ok(turned.every(probesOk), 'the old ten points never touch it');
  const ok = clearOf(chair, clear), p = { ...b };
  assert.ok(Math.abs(spinBy(p, 2 * Math.PI, chair, ok)) < 2 * Math.PI - 0.1, 'the frame stops at the post');
  assert.equal(canSpinAround(b, chair, ok), false);
});

test('a blocked chair stops against the wall instead of passing it, even in a slow frame', () => {
  const wall = clearOf(chair, cellClear([[0, 0, 4, 6]]));   // the room ends at x = 4
  const b: Pose = { x: 1, y: 3, yaw: 0 }, v: Vel = { v: 0, w: 0 };
  run(b, v, fwd, 8, wall, 0.1);   // the viewer clamps dt to 0.1 s
  assert.ok(wall(b));
  assert.ok(b.x + WHEELCHAIR.user_gap_m + WHEELCHAIR.depth_m <= 4 + 1e-9, 'the footplates stop at the wall');
  assert.equal(v.v, 0);
});

test('driving at random in a walled room never leaves the chair in a pose that was not clear', () => {
  const walls = clearOf(chair, cellClear([[0, 0, 3, 2.5]]));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const b: Pose = { x: 1.2, y: 1.2, yaw: 0 }, v: Vel = { v: 0, w: 0 };
  assert.ok(walls(b));
  let key: DriveInput = idle;
  for (let t = 0; t < 600; t++) {
    if (t % 30 === 0) key = { throttle: Math.round(rnd() * 2 - 1), steer: Math.round(rnd() * 2 - 1), spin: Math.round(rnd() * 2 - 1) };
    driveStep(b, v, key, t % 7 ? 1 / 60 : 0.1, chair, walls);
    assert.ok(walls(b), `blocked pose at step ${t}`);
  }
});

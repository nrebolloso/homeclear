// Live object physics off the main thread (objphys.ts). Ping-pong: one 'step' in, one reply out, so a slow frame never
// queues up steps. Object colliders come from the objects' own splats (objects/<name>.ply).
import { initPhysics } from './physics.ts';
import { createWorld, plyPoints, type WorldInit, type PhysObject } from './objphys.ts';

export type PhysInit = Omit<WorldInit, 'objects'> & { base: string; objects: (Omit<PhysObject, 'points'> & { splat: string })[] };

let W: ReturnType<typeof createWorld> | null = null;
const cloud = new Map<string, Float32Array>();   // splat -> points, so a resample doesn't fetch again

async function build(I: PhysInit) {
  await initPhysics();
  const objects = await Promise.all(I.objects.map(async o => {
    if (!cloud.has(o.splat)) cloud.set(o.splat, plyPoints(await (await fetch(I.base + o.splat)).arrayBuffer()));
    return { ...o, points: cloud.get(o.splat)! };
  }));
  W?.free();
  W = createWorld({ ...I, objects });
  return { type: 'ready', sampled: W.sampled, flap: W.flapInfo(), seed: I.seed };
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') return self.postMessage(await build(m.init));
    if (!W) return self.postMessage({ type: 'step', none: true });
    if (m.type === 'poses') { W.setPoses(m.poses); return; }
    if (m.type === 'place') { W.placeWalker(m.body); return; }
    if (m.type === 'step') return self.postMessage({ type: 'step', ...W.step(m.dt, m.target), flapInfo: W.flapInfo() });
  } catch (err) {
    self.postMessage({ type: 'error', msg: String((err as Error)?.stack ?? err) });
  }
};

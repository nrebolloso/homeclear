// Deterministic demo autoplay (?demo=1, or ?seed[=n] for e2e): one seed per scene (configs/demo.json) for the live physics
// and the futures fan, and a lockstep clock for autoplay: the walk, the physics and the fan advance in fixed 1/60 s ticks,
// and a tick waits while the physics or a due fan is still in its worker or a replan is pending. Ticks run between frames as
// fast as the workers answer, so a slow GPU renders fewer frames of the same walk; a stalled machine plays the same round
// trip slower instead of a different one (the walker pushing the mat onto the cord on some runs).
// Free walk, fly, VR and hand edits keep the wall clock and stay non-deterministic.
import demo from '../../configs/demo.json' with { type: 'json' };

export const TICK_S = 1 / 60;

/** this page's fixed seed, or null (wall clock, a random physics seed per run) */
export function demoSeed(params: URLSearchParams, run: string): number | null {
  if (params.get('demo') !== '1' && !params.has('seed')) return null;
  return Number(params.get('seed')) || (demo as unknown as Record<string, { seed?: number }>)[run]?.seed || 1;
}

/** the seed the gait ghosts' route draw starts on (configs/demo.json gait_seed): one where the average walker goes over the mat and the shuffler around it */
export const gaitSeed = (run: string): number => (demo as unknown as Record<string, { gait_seed?: number }>)[run]?.gait_seed ?? 1;

export const MAX_LAG_S = 0.25;   // a stall longer than this (a slow fan, a hidden tab) slows the demo instead of fast-forwarding it

export function createLockstep(idle: () => boolean, on: () => boolean) {
  let wall = 0, ticks = 0, pumping = false;
  const untilIdle = async () => { while (!idle()) await new Promise(r => setTimeout(r, 1)); };
  return {
    idle, ticks: () => ticks,
    /** the live clock: bank `real` s of wall time and tick it off between frames (the frame only renders), so a 20 fps
     *  machine still walks in real time and in the same 1/60 s ticks as the recorder */
    frame(real: number, step: (dt: number) => void) {
      wall = Math.min(wall + real, MAX_LAG_S);
      if (pumping) return;
      pumping = true;
      void (async () => {
        while (wall >= TICK_S && on()) { await untilIdle(); if (!on()) break; wall -= TICK_S; step(TICK_S); ticks++; }
      })().finally(() => { pumping = false; });
    },
    /** the recorder's clock (game.tick): `secs` of ticks, each once the workers have answered */
    async advance(secs: number, step: (dt: number) => void) {
      for (let k = Math.round(secs / TICK_S); k > 0; k--) { await untilIdle(); step(TICK_S); ticks++; }
    },
    reset() { wall = 0; ticks = 0; },
  };
}

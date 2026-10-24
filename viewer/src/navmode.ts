// Desktop movement modes as one small table: which toolbar mode the viewer's state means, when the walker and the view
// disagree, where to put the walker when you leave Fly, and where to resume the route. Pure (no DOM, no three) so
// tests/navmode.test.ts can run it; main.ts owns the state and calls these from one hook block.

export type WalkMode = 'auto' | 'free' | 'fly';
export type Nav = 'explore' | 'route' | 'walk' | 'fly' | 'inspect';

/** The toolbar mode for the viewer's state: 'explore' is Look around (free walk with the walker parked, nothing collides). */
export function navOf(mode: WalkMode, exploreOn: boolean, inspect = false): Nav {
  return inspect ? 'inspect' : mode === 'auto' ? 'route' : mode === 'fly' ? 'fly' : exploreOn ? 'explore' : 'walk';
}

/** The head is turned far enough from the walker's heading that W/S would push it somewhere you are not looking. */
export const headingMismatch = (headYaw: number, tol = 0.5) => Math.abs(headYaw) > tol;

/** The closest spot to (x, y) that `ok` accepts, searched in rings of `step` out to `maxR`; null when none. */
export function nearestStandable(x: number, y: number, ok: (x: number, y: number) => boolean, maxR = 1, step = 0.1): [number, number] | null {
  if (ok(x, y)) return [x, y];
  for (let r = step; r <= maxR + 1e-9; r += step) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
    let best: [number, number] | null = null, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n, px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (ok(px, py) && (px - x) ** 2 + (py - y) ** 2 < bd) { best = [px, py]; bd = (px - x) ** 2 + (py - y) ** 2; }
    }
    if (best) return best;
  }
  return null;
}

/** Route progress to resume from: the walker's nearest route arc length `s`, as a fraction of the route, applied to the
 *  length the player counts in (the world-model playback measures its own poses, which differ a little from the route). */
export function routeResume(s: number, routeLen: number, playLen = routeLen): number {
  if (!(routeLen > 0)) return 0;
  return Math.min(1, Math.max(0, s / routeLen)) * playLen;
}

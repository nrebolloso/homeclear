// Round-trip autoplay (the scripted demo): the planned route walked backwards (goal -> start: entrance -> fridge in the
// kitchen), a turn at the start, then the route as planned (start -> goal). The evaluator only simulates the planned
// direction, so the inbound leg just follows the line (no world-model replay, mannequin or step cloud for it), but live
// physics runs under it: a mat fold made on the way in is still there on the way out, and the futures fan sees it.
import type { XY } from './grid.ts';

export type Leg = 'in' | 'out';

export function createRoundTrip() {
  let on = false, leg: Leg = 'out', revFor: XY[] | null = null, rev: { xy: XY[]; s: number[] } = { xy: [], s: [] };
  return {
    on: () => on, leg: () => leg,
    /** round trip on/off; either way autoplay starts the first leg */
    set(v: boolean) { on = v; leg = v ? 'in' : 'out'; },
    /** a leg ended: inbound -> outbound, outbound -> inbound again (round trip) or the same outbound lap (one way) */
    next() { leg = on && leg === 'out' ? 'in' : 'out'; },
    /** restart from the first leg (autoplay pressed, route changed) */
    reset() { leg = on ? 'in' : 'out'; },
    /** the planned route the way this leg walks it */
    route: (xy: XY[]) => (leg === 'in' ? reversed(xy).xy : xy),
    /** the inbound path with its own arc lengths (cached per plan) */
    inbound: (xy: XY[]) => reversed(xy),
  };
  function reversed(xy: XY[]) {
    if (revFor !== xy) {
      revFor = xy;
      const r = [...xy].reverse(), s = [0];
      for (let k = 1; k < r.length; k++) s.push(s[k - 1] + Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]));
      rev = { xy: r, s };
    }
    return rev;
  }
}

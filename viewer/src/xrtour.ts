// "Show me the dangers" in the headset: the walker game's hazard spots (spotlight.ts) as stops you stand at, in words for
// the patient and family. Pure, tested in node (tests/xrtour.test.ts). Measured and proposed stay apart: a Cosmos Reason
// proposal is "something to check (not measured)", never a number.
import type { XY } from './grid.ts';
import { vantage, type Spot } from './spotlight.ts';

/** A headline and one plain sentence for a spot. */
export function plainSpot(s: Spot): { title: string; why: string } {
  if (s.kind !== 'measured') return { title: 'Something to check (not measured)', why: 'Ask your therapist to look at this' };
  if (s.measured_height_m !== undefined) {
    const name = s.detail.split(':')[0].trim() || 'Floor edge';
    const Name = name[0].toUpperCase() + name.slice(1);
    if (s.detail.includes('thin cord')) return { title: `${Name}: a cord on the floor`, why: 'Easy to trip on: tape it down or move it' };
    return { title: `${Name}, ${(100 * s.measured_height_m).toFixed(1)} cm`, why: 'A walker wheel or a toe can catch on it' };
  }
  const gap = /(\d+) cm each side/.exec(s.detail);
  return { title: gap ? `Tight squeeze, ${gap[1]} cm each side` : 'Tight squeeze', why: 'The walker can bump the sides here' };
}

/** Where to stand for a stop: 0.9 m back along the route from the hazard, looking at it (the desktop tour's vantage), on floor
 *  someone could stand on; else the nearest such spot 0.7-2 m around it. Null if there is none. */
export function tourStand(s: Spot, routeXY: XY[], standable: (x: number, y: number) => boolean): { x: number; y: number; yaw: number } | null {
  const face = (x: number, y: number) => ({ x, y, yaw: Math.atan2(s.xy[1] - y, s.xy[0] - x) });
  // 0.9 m first: closer shows less of the room, so less to draw. Quest 2, kitchen4 doorway: 61 fps at 0.9 m vs 54 at 1.2 and
  // 72 at 0.6, but at 0.6 a floor hazard is nearly underfoot (~70 deg down); at 0.9 it's ~60 deg
  if (routeXY.length) for (const back of [0.9, 1.2, 0.7, 1.5, 2.0]) {
    const v = vantage(s.xy, routeXY, back);
    if (standable(v.x, v.y)) return face(v.x, v.y);
  }
  for (const r of [0.8, 1.0, 1.3, 1.6, 2.0]) for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 2 * Math.PI, x = s.xy[0] + r * Math.cos(a), y = s.xy[1] + r * Math.sin(a);
    if (standable(x, y)) return face(x, y);
  }
  return null;
}

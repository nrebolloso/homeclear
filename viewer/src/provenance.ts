// What the room is built from, cell by cell: the floor overlay behind the Evidence layers. A floor cell the camera saw
// well is measured; one it saw thinly is partly measured; one it never saw is inferred (the floor plane carried on, the
// imagined fill). Pure data (tests/provenance.test.ts); main.ts turns the texels into a plane under the room.
import type { GridMeta } from './grid.ts';

export type Provenance = 'measured' | 'thin' | 'inferred';
export interface LegendEntry { key: string; label: string; detail: string; css: string }
/** One legend for every layer that says where a thing comes from; the colours are the ones the viewer already uses. */
export const PROVENANCE_LEGEND: LegendEntry[] = [
  { key: 'measured', label: 'Measured', detail: 'filmed floor and the scan geometry', css: '#49d4c7' },
  { key: 'thin', label: 'Thinly filmed', detail: 'seen from few frames: the number is less certain', css: '#ffb347' },
  { key: 'inferred', label: 'Inferred', detail: 'never filmed: floor carried on from around it, imagined fills', css: '#cca8ef' },
  { key: 'estimated', label: 'Estimated', detail: 'a typical value, not a measurement (hatched heights, thin cords)', css: '#c85aff' },
  { key: 'proposed', label: 'Proposed', detail: 'Cosmos Reason pins: teal when the scan agrees, violet when only an OT can check', css: '#2fd6a8' },
  { key: 'designed', label: 'Designed, not built', detail: 'the reimagined room: changes nobody has made', css: '#5fd0ff' },
  { key: 'simulated', label: 'Simulated', detail: 'footsteps and toe contacts from the walking model', css: '#8fe3ff' },
];

/** Where one floor cell sits: well seen (`good` or more), thinly seen, or never seen. */
export function provenanceOf(coverage: number, good: number): Provenance { return coverage >= good ? 'measured' : coverage > 0 ? 'thin' : 'inferred'; }

/** Count floor cells by provenance, for the legend's numbers ("38 % of the floor was never filmed"). */
export function provenanceShare(floor: ArrayLike<number>, coverage: ArrayLike<number>, good: number): Record<Provenance, number> & { total: number } {
  const out = { measured: 0, thin: 0, inferred: 0, total: 0 };
  for (let k = 0; k < floor.length; k++) if (floor[k]) { out[provenanceOf(coverage[k], good)]++; out.total++; }
  return out;
}

/** RGBA texels for a grid-sized floor overlay (index = j * nx + i, array[i, j] covers x0 + i c, y0 + j c): faint teal where
 *  measured, amber where thin, hatched violet where inferred; nothing off the floor. */
export function provenanceTexels(g: GridMeta, floor: ArrayLike<number>, coverage: ArrayLike<number>, good: number): Uint8Array {
  const [nx, ny] = g.shape, out = new Uint8Array(nx * ny * 4);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const k = i * ny + j;
      if (!floor[k]) continue;
      const o = (j * nx + i) * 4, p = provenanceOf(coverage[k], good);
      if (p === 'measured') out.set([73, 212, 199, 46], o);
      else if (p === 'thin') out.set([255, 179, 71, 120], o);
      else out.set([204, 168, 239, (i + j) % 2 ? 175 : 95], o);   // hatch: nothing here was measured
    }
  return out;
}

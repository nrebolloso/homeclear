// How hard it is to move a piece of furniture: effort (on optimize.ts's effort scale), helpers, and plain-English
// reasons for the pill and the OT report. Pure: no DOM, no worker. movecost.ts and optimize.ts both call moveEffort.
// VERSION 1. v1 assumes solid, one-piece objects: no disassembly, no emptying drawers, no mattress coming off. Effort
// depends only on mass, distance and turn. Mass comes from the object's measured box (estimateMass) when the scan has
// one, else a team guess by kind. `minutes` is kept for the optimizer's old score only; it is never displayed.

export interface MoveInput {
  kind: string;          // 'bed' | 'nightstand' | 'chair' | 'table' | 'rug' | ...
  mass_kg?: number;      // default by kind (DEFAULT_MASS_KG)
  distance_m: number;
  turn_deg: number;      // any angle; 270° counts as 90° the other way
}
export interface MoveEffort { effort: number; minutes: number; people: 1 | 2; explain: string[] }

/** Team guesses (not measured), kg. bed = frame + mattress. Used when the scan gives no usable size. */
export const DEFAULT_MASS_KG: Record<string, number> = {
  rug: 5, nightlight: 0.5, chair: 7, nightstand: 20, table: 25, bed: 70, dresser: 50, sofa: 45, other: 15,
};

/** Kinds the suggestions never move (team call): too heavy, plumbed in, or the patient's own setup. A config or label
 *  can still set movable: true on one object. */
export const NEVER_MOVE = new Set(['bed', 'refrigerator', 'counter', 'wardrobe', 'toilet', 'sofa']);

/** Mass from the measured box: kg per m³ of bounding box (mostly air: legs, a hollow frame) and the plausible range
 *  per kind. Team guesses, not measured; a mass outside the range is clamped and flagged for the OT. */
export const KIND_MASS: Record<string, { kg_per_m3: number; min: number; max: number }> = {
  bed: { kg_per_m3: 60, min: 30, max: 150 }, nightstand: { kg_per_m3: 120, min: 5, max: 40 },
  chair: { kg_per_m3: 15, min: 3, max: 20 }, table: { kg_per_m3: 40, min: 10, max: 45 },
  dresser: { kg_per_m3: 150, min: 20, max: 100 }, sofa: { kg_per_m3: 50, min: 25, max: 100 },
  other: { kg_per_m3: 50, min: 1, max: 60 },
};
export interface MassEstimate { mass_kg: number; from_size: boolean; flagged: boolean; explain: string }

/** Footprint area (shoelace) × measured height × kg/m³ for the kind, clamped to its range. No size: the kind's guess. */
export function estimateMass(o: { kind: string; footprint?: number[][]; height_m?: number }): MassEstimate {
  const guess = DEFAULT_MASS_KG[o.kind] ?? DEFAULT_MASS_KG.other;
  const f = o.footprint ?? [];
  if (f.length < 3 || !(o.height_m! > 0) || !(o.kind in KIND_MASS))
    return { mass_kg: guess, from_size: false, flagged: false, explain: `about ${guess} kg (guess by kind)` };
  let a = 0;
  for (let i = 0, j = f.length - 1; i < f.length; j = i++) a += f[j][0] * f[i][1] - f[i][0] * f[j][1];
  const { kg_per_m3, min, max } = KIND_MASS[o.kind], raw = (Math.abs(a) / 2) * o.height_m! * kg_per_m3;
  const kg = Math.min(max, Math.max(min, raw)), flagged = kg !== raw;
  return { mass_kg: Math.round(kg), from_size: true, flagged,
    explain: flagged ? `measured size gave ${Math.round(raw)} kg, outside ${min}–${max} kg for a ${o.kind}: set to ${Math.round(kg)}, check in person`
      : `about ${Math.round(kg)} kg (from measured size)` };
}

const KG_PER_BASE = 20;       // base = 1 + kg/20: nightstand 2, bed 4.5 (the old move_effort table had 2 and 5)
const PER_M = 0.3;            // effort grows 30% per metre carried (the old effort_per_m)
const TURN_PER_180 = 0.5;     // turning it half way round costs half its base again
export const TWO_PERSON_KG = 25;   // above this, two people (one-person carry guidance is about 23-25 kg)
const MIN_SETUP = 10, MIN_PER_BASE = 10;   // minutes (optimizer only): setup, plus per base unit
const TWO_PERSON_MIN = 30;

export function moveEffort(m: MoveInput): MoveEffort {
  const kg = Math.max(0, m.mass_kg ?? DEFAULT_MASS_KG[m.kind] ?? DEFAULT_MASS_KG.other);
  const base = 1 + kg / KG_PER_BASE, d = Math.max(0, m.distance_m || 0);
  const r = (((m.turn_deg || 0) % 360) + 360) % 360, turn = r > 180 ? 360 - r : r;
  const two = kg > TWO_PERSON_KG;
  const effort = base * (1 + PER_M * d) + TURN_PER_180 * base * (turn / 180);
  const minutes = Math.max(MIN_SETUP + MIN_PER_BASE * base * (1 + d / 2), two ? TWO_PERSON_MIN : 0);
  const explain = [`about ${Math.round(kg)} kg${m.mass_kg === undefined ? ' (guess)' : ''}`];
  if (two) explain.push('needs two people: heavy');
  if (d > 0) explain.push(`carried ${d.toFixed(1)} m`);
  if (turn >= 1) explain.push(`turned ${Math.round(turn)}°`);
  return { effort, minutes: Math.round(minutes), people: two ? 2 : 1, explain };
}

export type Difficulty = 'Easy' | 'Moderate' | 'Hard';
/** Tier of an effort value: a 1 m carry of a chair is Easy, a nightstand Moderate, a bed Hard. */
export const difficulty = (effort: number): Difficulty => (effort < 2 ? 'Easy' : effort <= 3.5 ? 'Moderate' : 'Hard');

/** Kinds that are not carried (a rug is rolled up, a nightlight unplugged): mass only, no difficulty. */
const NOT_CARRIED = new Set(['rug', 'nightlight', 'door']);

export interface ObjectEffort extends MassEstimate { movable: boolean; carried: boolean; difficulty?: Difficulty; people: 1 | 2; tag: string }

/** Everything the pill, the log and the report say about one object, from its measured box. movable: a config or label
 *  value wins, else never-move kinds stay put. */
export function objectEffort(o: { kind: string; footprint?: number[][]; height_m?: number; mass_kg?: number; movable?: boolean }): ObjectEffort {
  const m: MassEstimate = o.mass_kg !== undefined ? { mass_kg: o.mass_kg, from_size: true, flagged: false, explain: `${o.mass_kg} kg (config)` } : estimateMass(o);
  const movable = o.movable ?? !NEVER_MOVE.has(o.kind), carried = !NOT_CARRIED.has(o.kind);
  const ref = moveEffort({ kind: o.kind, mass_kg: m.mass_kg, distance_m: 1, turn_deg: 0 });
  const dif = movable && carried ? difficulty(ref.effort) : undefined;
  const kg = `≈ ${m.mass_kg} kg${m.from_size ? '' : ' (guess)'}`;
  const tag = !carried ? kg : !movable ? `${kg} · stays put`
    : `${kg} · ${dif} · ${ref.people} ${ref.people > 1 ? 'people' : 'person'}${m.flagged ? ' · check in person' : ''}`;
  return { ...m, movable, carried, difficulty: dif, people: ref.people, tag };
}

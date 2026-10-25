// What a change to the room takes: money, minutes, people, and who might pay. The seam between the reimagined room
// (reimagine.ts, fix card, OT report) and the move-effort / insurance model: the signatures stay, the numbers come
// from TM2's effort.ts (moveEffort), the same call optimize.ts actions() makes; tests/reimagine.test.ts checks the
// two agree.
import { moveEffort } from './effort.ts';
import type { OptimizerCfg } from './optimize.ts';
import type { Intervention, Pose } from './grid.ts';

/** Who might pay. Traditional Medicare Part B covers almost none of the environmental fixes (convenience items). */
export type Funding = 'self_pay' | 'part_b_dme' | 'ma_ssbci' | 'medicaid_hcbs' | 'va_hisa' | 'unclassified';
/** source: the model that priced it ('effort.ts v1'; 'placeholder' for configured fixes until products are classified) */
export interface MoveCost { usd: number; minutes: number; helpers: number; effort: number; funding: Funding; source: string }

/** a removed object is carried out of the room: counted as a move this far */
const REMOVE_CARRY_M = 3;
const helpersFor = (effort: number) => (effort >= 4 ? 2 : 1);
const turnDeg = (from: Pose, to: Pose) => Math.round(((((to.yaw - from.yaw) * 180) / Math.PI) % 360 + 360) % 360);

/** Moving (or turning) an object by hand: free, labour only. Same effort, minutes and helpers as an optimizer move.
 *  The last argument is unused since the effort model landed; kept so the signature stays (AGENTS.md). */
export function moveCost(o: { kind: string; mass_kg?: number }, from: Pose, to: Pose, _cfg: Partial<OptimizerCfg> = {}): MoveCost {
  const m = moveEffort({ kind: o.kind, mass_kg: o.mass_kg, distance_m: Math.hypot(to.x - from.x, to.y - from.y), turn_deg: turnDeg(from, to) });
  return { usd: 0, minutes: m.minutes, helpers: m.people, effort: m.effort, funding: 'self_pay', source: 'effort.ts v1' };
}

/** Taking an object out of the room. */
export function removeCost(o: { kind: string; mass_kg?: number }, cfgIn: Partial<OptimizerCfg> = {}): MoveCost {
  const at: Pose = { x: 0, y: 0, yaw: 0 };
  return moveCost(o, at, { ...at, x: REMOVE_CARRY_M }, cfgIn);
}

/** A configured fix (stage 12 interventions): its own dollars, minutes and effort; a product's funding is not classified yet. */
export function fixCost(iv: Intervention): MoveCost {
  const effort = iv.effort ?? 1;
  return { usd: iv.cost_usd ?? 0, minutes: iv.minutes ?? 10, helpers: helpersFor(effort), effort,
    funding: iv.product ? 'unclassified' : 'self_pay', source: 'placeholder' };
}

/** Totals for a list of changes: effort adds up; helpers is the most any one change needs (the same people do them all). */
export function sumCosts(cs: MoveCost[]): { usd: number; minutes: number; helpers: number; effort: number } {
  return { usd: cs.reduce((a, c) => a + c.usd, 0), minutes: cs.reduce((a, c) => a + c.minutes, 0), helpers: Math.max(1, ...cs.map(c => c.helpers)),
    effort: cs.reduce((a, c) => a + c.effort, 0) };
}

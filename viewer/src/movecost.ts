// What a change to the room takes: money, minutes, people, and who might pay. The seam between the reimagined room
// (reimagine.ts, fix card, OT report) and the move-effort / insurance model: the signatures stay, the numbers come
// from TM2's effort.ts (moveEffort) once it lands (AGENTS.md). Until then this is a PLACEHOLDER that mirrors the
// optimizer's effort (optimize.ts DEFAULTS and actions()); tests/reimagine.test.ts checks the two agree.
import { DEFAULTS, type OptimizerCfg } from './optimize.ts';
import type { Intervention, Pose } from './grid.ts';

/** Who might pay. Traditional Medicare Part B covers almost none of the environmental fixes (convenience items). */
export type Funding = 'self_pay' | 'part_b_dme' | 'ma_ssbci' | 'medicaid_hcbs' | 'va_hisa' | 'unclassified';
/** source: 'placeholder' until the effort model lands, then the model's name */
export interface MoveCost { usd: number; minutes: number; helpers: number; effort: number; funding: Funding; source: string }

/** a removed object is carried out of the room: counted as a move this far */
const REMOVE_CARRY_M = 3;
const kindEffort = (kind: string, cfg: OptimizerCfg) => cfg.move_effort[kind] ?? cfg.move_effort.other;
const helpersFor = (effort: number) => (effort >= 4 ? 2 : 1);

/** Moving (or turning) an object by hand: free, labour only. Same effort and minutes as an optimizer move. */
export function moveCost(o: { kind: string }, from: Pose, to: Pose, cfgIn: Partial<OptimizerCfg> = {}): MoveCost {
  const cfg = { ...DEFAULTS, ...cfgIn }, d = Math.hypot(to.x - from.x, to.y - from.y), e = kindEffort(o.kind, cfg);
  return { usd: 0, minutes: Math.round(10 + 10 * e * (1 + d / 2)), helpers: helpersFor(e), effort: e * (1 + cfg.effort_per_m * d),
    funding: 'self_pay', source: 'placeholder' };
}

/** Taking an object out of the room. */
export function removeCost(o: { kind: string }, cfgIn: Partial<OptimizerCfg> = {}): MoveCost {
  const at: Pose = { x: 0, y: 0, yaw: 0 };
  return moveCost(o, at, { ...at, x: REMOVE_CARRY_M }, cfgIn);
}

/** A configured fix (stage 12 interventions): its own dollars, minutes and effort; a product's funding is not classified yet. */
export function fixCost(iv: Intervention): MoveCost {
  const effort = iv.effort ?? 1;
  return { usd: iv.cost_usd ?? 0, minutes: iv.minutes ?? 10, helpers: helpersFor(effort), effort,
    funding: iv.product ? 'unclassified' : 'self_pay', source: 'placeholder' };
}

/** Totals for a list of changes. */
export function sumCosts(cs: MoveCost[]): { usd: number; minutes: number; helpers: number } {
  return { usd: cs.reduce((a, c) => a + c.usd, 0), minutes: cs.reduce((a, c) => a + c.minutes, 0), helpers: Math.max(1, ...cs.map(c => c.helpers)) };
}

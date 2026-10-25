// What a proposed layout does, next to the room as it is: contacts, hazards, checks, routes and how much of the trouble it covers.
// Pure (two Evals in, numbers out), so the panel, the layout cards and the OT report all read the same figures.
// Every number is either measured from the scan (hazards, checks, clearances) or simulated (contacts), never a mix: the
// simulated ones carry the 10-90% range. There is deliberately no "falls prevented" here: a contact is a toe catching a
// bump, not a fall, and turning one into the other needs a published rate we have not cited yet (SPEC.md: nothing faked).
import type { Eval, HazardOut } from './evaluate.ts';
import type { CheckOut } from './checks.ts';
import { hazardDiff } from './reimagine.ts';

export const passes = (c: CheckOut) => c.verdict === 'ok';
export const fails = (c: CheckOut) => c.verdict === 'fail';

export interface Count { cleared: number; remaining: number; added: number; before: number }
export interface Analytics {
  /** simulated toe contacts / month over all routes; lo..hi is the 10-90% range, of the proposed layout */
  contacts: { before: number; after: number; delta: number; pct: number | null; lo: number; hi: number; avoided_per_year: number };
  /** hazards on the selected route (that is all an Eval lists): same type within 0.4 m is the same hazard */
  hazards: Count & { cleared_list: HazardOut[]; added_list: HazardOut[] };
  /** checks matched by id: open = not ok before */
  checks: { fixed: CheckOut[]; regressed: CheckOut[]; still_failing: CheckOut[]; needs_review: CheckOut[]; open_before: number };
  /** per route: contacts before and after, and whether the plan opened or closed it */
  routes: { name: string; before: number; after: number; change: 'opened' | 'closed' | null }[];
  /** share of each kind of trouble the layout clears (routes_open: the share of routes that can be walked after); null where there is nothing to divide */
  coverage: { hazards: number | null; checks: number | null; routes_open: number | null };
}

const share = (num: number, den: number) => (den > 0 ? num / den : null);

export function compare(before: Eval, after: Eval): Analytics {
  const d = after.per_month - before.per_month;
  const hz = hazardDiff(before.hazards, after.hazards);
  const was = new Map(before.checks.map(c => [c.id, c]));
  const fixed = after.checks.filter(c => passes(c) && was.has(c.id) && !passes(was.get(c.id)!));
  const regressed = after.checks.filter(c => !passes(c) && was.has(c.id) && passes(was.get(c.id)!));
  const still = after.checks.filter(c => fails(c) && was.has(c.id) && fails(was.get(c.id)!));
  const review = after.checks.filter(c => !passes(c) && !fails(c));
  const open = before.checks.filter(c => !passes(c)).length;
  const routes = before.routes.map((b, k) => {
    const a = after.routes[k] ?? b;
    return { name: b.name, before: b.per_month, after: a.per_month, change: b.error && !a.error ? 'opened' as const : !b.error && a.error ? 'closed' as const : null };
  });
  const open1 = after.routes.filter(r => !r.error).length;
  return {
    contacts: { before: before.per_month, after: after.per_month, delta: d, pct: before.per_month > 0 ? d / before.per_month : null,
      lo: after.per_month_lo, hi: after.per_month_hi, avoided_per_year: Math.max(0, -d) * 12 },
    hazards: { cleared: hz.resolved.length, remaining: hz.remaining.length, added: hz.added.length, before: before.hazards.length,
      cleared_list: hz.resolved, added_list: hz.added },
    checks: { fixed, regressed, still_failing: still, needs_review: review, open_before: open },
    routes,
    coverage: { hazards: share(hz.resolved.length, before.hazards.length), checks: share(fixed.length, open),
      routes_open: before.routes.length ? share(open1, before.routes.length) : null },
  };
}

/** One line for a card: what changed, in the words an OT would say it. */
export function headline(a: Analytics): string {
  const bits: string[] = [];
  if (a.hazards.before) bits.push(`${a.hazards.cleared} of ${a.hazards.before} hazard${a.hazards.before === 1 ? '' : 's'} cleared`);
  if (a.checks.open_before) bits.push(`${a.checks.fixed.length} of ${a.checks.open_before} flagged checks now pass`);
  const c = a.contacts;
  bits.push(`simulated toe contacts ${c.before.toFixed(1)} → ${c.after.toFixed(1)} / month`);
  if (a.hazards.added) bits.push(`${a.hazards.added} new hazard${a.hazards.added === 1 ? '' : 's'}`);
  if (a.checks.regressed.length) bits.push(`${a.checks.regressed.length} check${a.checks.regressed.length === 1 ? '' : 's'} got worse`);
  return bits.join(' · ');
}

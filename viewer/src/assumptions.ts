// Every number the walking gait ghosts (gaitghosts.ts) lean on, with where it comes from: measured, published, simulated or
// ASSUMED. The panel lists them all and each ghost card says how many of its inputs are assumed. Pure (tests/assumptions.test.ts).
import calib from '../../physics/rug_calib.json' with { type: 'json' };
import { LIFTS, ROUTE_RISK_M, ROUTE_TAU_M } from './futures.ts';
import { CAPS_FACTOR, FOLD_LIFT_M, FOLD_SIZE_M, P_FOLD, TAPE_FACTOR } from './rugcascade.ts';

export type Kind = 'measured' | 'published' | 'simulated' | 'assumed';
export interface Assumption { key: string; label: string; value: string; kind: Kind; note: string }
/** one colour per kind, the viewer's provenance colours (provenance.ts) */
export const KIND_CSS: Record<Kind, string> = { measured: '#49d4c7', published: '#8fe3ff', simulated: '#c85aff', assumed: '#ffb347' };

const passes = Object.values(calib.real as Record<string, { n: number }>).reduce((s, r) => s + r.n, 0);

export function assumptions(risk?: { dark_contact_multiplier?: number }, speed_mps = 0.45): Assumption[] {
  return [
    { key: 'p_fold', label: 'Rug fold chance per edge crossing', value: P_FOLD.toFixed(2), kind: 'measured',
      note: `${passes} real walker passes over a loose rug (small n); the same for every gait, because the walker, not the feet, moves the cloth` },
    { key: 'mtc', label: 'Toe clearance of an average walker', value: '14.1 ± 8.3 mm', kind: 'published', note: 'older-adult minimum toe clearance (Frontiers 2014), the curve the contact table is fitted to' },
    { key: 'contact_table', label: 'Height to catch probability', value: '1 in 578 strides at 1 cm', kind: 'published', note: 'the contact table, fitted to that curve (tools/contact_table.py); it is not a fall probability' },
    { key: 'fold_lift', label: 'Folded corner height', value: `${(FOLD_LIFT_M * 100).toFixed(1)} cm`, kind: 'simulated', note: 'median of the cloth-rug simulation\'s folded passes' },
    { key: 'fold_size', label: 'Folded flap size', value: `${(FOLD_SIZE_M * 100).toFixed(0)} cm`, kind: 'assumed', note: 'read off the real clips by eye' },
    { key: 'shuffler', label: 'Shuffler foot lift', value: `${(LIFTS.shuffler.scale * 100).toFixed(0)}% of average`, kind: 'assumed', note: '16th percentile of the published curve, not a measured shuffling group' },
    { key: 'route_tau', label: 'Route choice: length sensitivity', value: `${ROUTE_TAU_M} m per e-fold`, kind: 'assumed', note: 'softmax on path length, not fitted to people\'s choices' },
    { key: 'route_risk', label: 'Route choice: risk aversion', value: `${ROUTE_RISK_M / 100} m of detour per 1% catch chance`, kind: 'assumed', note: 'what makes the shuffler\'s ghost take the way around the mat more often' },
    { key: 'drawn_lift', label: 'Foot lift as drawn on the ghosts', value: `8 cm average, ${Math.round(8 * LIFTS.shuffler.scale)} cm shuffler`, kind: 'assumed',
      note: 'about 6x the real clearance so the difference shows at room scale; display only, no number is computed from it' },
    { key: 'speed', label: 'Walking speed', value: `${speed_mps} m/s, all gaits`, kind: 'assumed', note: 'the model predicts where the feet land, not how fast; every ghost walks at one speed' },
    { key: 'caps', label: 'Glide caps on the walker', value: `x${CAPS_FACTOR.toFixed(2)} fold or drag`, kind: 'assumed', note: 'cap friction is an assumed number (rug_calib glide_caps_mu_assumed); only applies when the layout has them' },
    { key: 'tape', label: 'Taped rug edge', value: `x${TAPE_FACTOR.toFixed(2)} fold or drag; edge 1.5 mm`, kind: 'simulated', note: 'a taped rug cannot fold in the ghosts' },
    ...(risk?.dark_contact_multiplier ? [{ key: 'dark', label: 'Darkness', value: `x${risk.dark_contact_multiplier} catch chance unlit`, kind: 'assumed' as Kind, note: 'applies to night routes outside a light radius' }] : []),
  ];
}
export const countAssumed = (a: Assumption[]) => a.filter(x => x.kind === 'assumed').length;

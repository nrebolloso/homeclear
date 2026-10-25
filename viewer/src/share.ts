// What leaves the walker game: the OT report snapshot (same browser, sessionStorage) and the family fix card
// (any phone on the LAN: everything it needs is in the URL hash, it re-reads the scene files itself).
import type { Eval } from './evaluate.ts';
import type { Layout, XY } from './grid.ts';

export interface ActionOut { label: string; cost_usd?: number; minutes?: number; product?: string; at?: XY }
export interface ReportPayload {
  scene: string; created: string; synthetic: boolean; scale_note?: string; route: string;
  persona: { key: string; label: string; knee_height_m: number; reach_m: number; hip_precautions: boolean };
  current: Eval; baseline: number; rollouts: number; gait: string; calibration: string; dark_multiplier: number;
  margins: { width: number; height: number }; actions: ActionOut[]; suggestions: any[];
  reason: { note: string }[]; clips: string[]; topdown: string; view: string;
  ranked_fixes?: { label: string; error?: string; reduction: number; share: number; clearance_gain_m: number; cost_usd?: number; minutes?: number; effort?: number; product?: string }[];
  ranked_by?: string;   // set when the ranking comes from the kitchen planner (planfix.ts): ranked by toe catches saved, objective as tiebreak
}

/** The card's state, small enough for a QR code: the layout delta and the numbered actions. */
export interface CardState {
  s: string;                                         // scene
  p: [string, number, number, number, number][];     // changed objects: name, x, y, yaw, flags (1 removed, 2 taped)
  f: [XY, XY][];                                     // taped strips
  a: [string, number | null, number | null, string, number, number][];   // label, $, min, product, pin x, pin y
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function cardState(scene: string, objs: { name: string; pivot: number[] }[], lay: Layout, actions: ActionOut[]): CardState {
  return {
    s: scene,
    p: objs.flatMap((o, k) => {
      const q = lay.poses[k], moved = q.removed || q.taped || Math.hypot(q.x - o.pivot[0], q.y - o.pivot[1]) > 0.01 || Math.abs(q.yaw) > 0.01;
      return moved ? [[o.name, r2(q.x), r2(q.y), r2(q.yaw), (q.removed ? 1 : 0) | (q.taped ? 2 : 0)] as [string, number, number, number, number]] : [];
    }),
    f: lay.flattened.map(([a, b]) => [[r2(a[0]), r2(a[1])], [r2(b[0]), r2(b[1])]] as [XY, XY]),
    a: actions.map(a => [a.label, a.cost_usd ?? null, a.minutes ?? null, a.product ?? '', r2(a.at?.[0] ?? NaN), r2(a.at?.[1] ?? NaN)]),
  };
}

const toB64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (h: string) => new TextDecoder().decode(Uint8Array.from(atob(h.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
export const encodeCard = (c: CardState) => toB64url(JSON.stringify(c));
export const decodeCard = (h: string): CardState => JSON.parse(fromB64url(h));

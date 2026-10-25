// The fix catalog: price ranges, install time and who does it, per kind of fix, from published cost guides and retail
// listings (data/fixes/costs.json; every entry lists its sources, and a number no source gave is marked 'guess').
// Keyed by the fix id's prefix (door_widen:bath_door -> door_widen) or the fix's own `catalog` key. Pure: no DOM.
// US national ranges, not quotes: no regional adjustment, and the scan can't see what is inside a wall.
import costs from '../../data/fixes/costs.json' with { type: 'json' };

export type Who = 'you' | 'handyperson' | 'contractor' | 'dealer' | 'none';
export interface CatalogEntry {
  label: string; who: Who;
  diy_usd: [number, number] | null;            // materials, done yourself
  pro_usd: [number, number, number] | null;    // installed: low, typical, high
  usd_per_ft?: [number, number, number];       // installed per linear foot (handrails): priced by the fix's length_m
  install_min: [number, number];
  permit?: boolean; note?: string;
  provenance: { usd: 'catalog' | 'guess'; minutes: 'catalog' | 'guess' };
  sources: string[];
}
export const CATALOG = costs.fixes as unknown as Record<string, CatalogEntry>;
export const HANDYPERSON_USD_PER_H = costs.handyperson_usd_per_h as unknown as { range: [number, number]; sources: string[] };

export const catalogKey = (iv: { id: string; catalog?: string }) => iv.catalog ?? iv.id.split(':')[0];
export const catalogFor = (iv: { id: string; catalog?: string }): CatalogEntry | undefined => CATALOG[catalogKey(iv)];

const FT = 3.2808;
/** [low, typical, high] dollars for this fix: installed when a pro does it, else the materials; per-foot entries by length. */
export function usdRange(e: CatalogEntry, length_m?: number): [number, number, number] {
  if (e.usd_per_ft && length_m) { const ft = length_m * FT; return e.usd_per_ft.map(x => Math.round(x * ft)) as [number, number, number]; }
  if (e.who !== 'you' && e.who !== 'none' && e.pro_usd) return e.pro_usd;
  const d = e.diy_usd ?? [0, 0];
  return [d[0], Math.round((d[0] + d[1]) / 2), d[1]];
}
export const typicalMinutes = (e: CatalogEntry) => Math.round((e.install_min[0] + e.install_min[1]) / 2);

const usd = (x: number) => `$${x.toLocaleString('en-US')}`;
const span = (lo: number, hi: number) => (lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`);
/** "$8–15 DIY · $150–300 installed", "free" */
export function priceText(e: CatalogEntry, length_m?: number): string {
  if (e.usd_per_ft && length_m) { const [lo, , hi] = usdRange(e, length_m); return `${span(lo, hi)} installed`; }
  const parts = [e.diy_usd && (e.diy_usd[1] ? `${span(...e.diy_usd)} DIY` : 'free'), e.pro_usd && `${span(e.pro_usd[0], e.pro_usd[2])} installed`];
  return parts.filter(Boolean).join(' · ') || 'price needed';
}
/** "about 5 min", "1–2 h", "1–3 days" (an 8-hour working day) */
export function timeText(e: CatalogEntry): string {
  const [lo, hi] = e.install_min, f = (m: number, u: number) => +(m / u).toFixed(m / u < 2 ? 1 : 0);
  if (hi <= 15) return `about ${Math.max(1, Math.round((lo + hi) / 2))} min`;
  if (hi < 90) return `${lo}–${hi} min`;
  if (hi <= 8 * 60) return `${f(lo, 60)}–${f(hi, 60)} h`;
  return `${f(lo, 480)}–${f(hi, 480)} days`;
}
export const WHO_TEXT: Record<Who, string> = { you: 'you can do it', handyperson: 'a handyperson', contractor: 'a contractor', dealer: 'the dealer installs it', none: 'nothing to install' };
/** "$8–15 DIY · about 10 min · you can do it" */
export const summaryText = (e: CatalogEntry, length_m?: number) => `${priceText(e, length_m)} · ${timeText(e)} · ${WHO_TEXT[e.who]}${e.permit ? ' · permit likely' : ''}`;

const WHO_RANK: Who[] = ['none', 'you', 'handyperson', 'dealer', 'contractor'];
const minText = (m: number) => (m < 90 ? `${Math.max(1, Math.round(m))} min` : m <= 8 * 60 ? `${+(m / 60).toFixed(1)} h` : `${+(m / 480).toFixed(1)} days`);
/** A whole plan in one line: "$18–30 · about 15 min · you can do it". Price adds each change's range (a move or an
 *  unlisted fix at its own dollars); time adds the catalog's install times only (move minutes are the optimizer's, not shown). */
export function planText(cs: { usd: number; catalog?: CatalogEntry; length_m?: number }[]): string {
  let lo = 0, hi = 0, min = 0, who: Who = 'none';
  for (const c of cs) {
    const r = c.catalog ? usdRange(c.catalog, c.length_m) : [c.usd, c.usd, c.usd];
    lo += r[0]; hi += r[2];
    if (c.catalog) { min += typicalMinutes(c.catalog); if (WHO_RANK.indexOf(c.catalog.who) > WHO_RANK.indexOf(who)) who = c.catalog.who; }
    else if (who === 'none') who = 'you';
  }
  return [hi ? span(lo, hi) : 'free', min && `about ${minText(min)}`, who === 'none' || who === 'you' ? 'you can do it' : `needs ${WHO_TEXT[who]}`].filter(Boolean).join(' · ');
}
/** What the OT report prints for one catalogued fix (share.ts payload). */
export const catalogOut = (e: CatalogEntry, length_m?: number) =>
  ({ price: priceText(e, length_m), time: timeText(e) + (e.provenance.minutes === 'guess' ? ' (estimate)' : ''), who: WHO_TEXT[e.who] + (e.permit ? ', permit likely' : ''), sources: e.sources });

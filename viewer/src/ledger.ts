// The run's log: append-only entries from the pipeline (log.jsonl, written by common.py log_event) and the viewer. The
// OT report is built by retrieving from it, so every number on paper has a source and a provenance. Pure: no DOM.

export type Provenance = 'measured' | 'simulated' | 'imagined' | 'catalog' | 'computed' | 'guess';
export interface Entry { t: string; source: string; kind: string; key?: string; values: any; provenance: Provenance }

export function logEvent(log: Entry[], source: string, kind: string, values: any, provenance: Provenance, key?: string): Entry {
  const e: Entry = { t: new Date().toISOString(), source, kind, ...(key !== undefined ? { key } : {}), values, provenance };
  log.push(e);
  return e;
}

/** JSON lines -> entries; blank or broken lines are skipped (a stage killed mid-write leaves half a line). */
export function parseLog(text: string): Entry[] {
  return text.split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l) as Entry] : []; } catch { return []; } });
}
export const toJSONL = (log: Entry[]) => log.map(e => JSON.stringify(e)).join('\n') + (log.length ? '\n' : '');

/** Filter; `latest` keeps only the newest entry per kind + key (a re-run supersedes, nothing is deleted). */
export function retrieve(log: Entry[], q: { source?: string; kind?: string; key?: string; latest?: boolean } = {}): Entry[] {
  const hit = log.filter(e => (q.source === undefined || e.source === q.source) && (q.kind === undefined || e.kind === q.kind)
    && (q.key === undefined || e.key === q.key));
  if (!q.latest) return hit;
  const last = new Map<string, Entry>();
  for (const e of hit) last.set(`${e.kind}\u0000${e.key ?? ''}`, e);   // later in the log wins, even with equal timestamps
  return [...last.values()];
}

// Shared desktop/headset catalog. Versions belong to rooms, not separate homes.
export interface ScanEntry {
  id: string; room: string; title: string; version: string; sample: boolean;
  objects: number; routes: boolean; fixes: boolean; scaleNote: string; bytes: number;
}
export function describeScan(id: string, sc: any, bytes = 0): ScanEntry {
  const sample = /^(game_synth|sample_|synthetic)/.test(id);
  const room = id.startsWith('kitchen4') ? 'Kitchen' : id.startsWith('juan_') ? 'Bedroom & Bathroom' : id.startsWith('gator_') ? 'Gator Lounge' : 'Sample scenes';
  const version = id.replace(/^(kitchen4|juan_bedroom_bathroom|gator_lounge)/, '').replace(/^_/, '').replaceAll('_', ' ') || 'Original';
  return { id, room, title: sample ? id.replaceAll('_', ' ') : room, version, sample,
    objects: (sc.objects ?? []).filter((o: any) => o.movable !== false).length,
    routes: !!(sc.routes || sc.route), fixes: !!sc.interventions?.length,
    scaleNote: sc.scale_note ?? 'Check scan calibration', bytes };
}
export function groupScans(entries: ScanEntry[]) {
  return [...new Set(entries.map(e => e.room))].map(room => ({ room, scans: entries.filter(e => e.room === room) }));
}
export function validScanId(id: string) { return /^[\w-]+$/.test(id); }

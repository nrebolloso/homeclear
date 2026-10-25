// Shared desktop/headset catalog. Versions belong to rooms, not separate homes.
export interface ScanEntry {
  id: string; room: string; title: string; version: string; sample: boolean;
  map?: string; objects: number; routes: boolean; fixes: boolean; scaleNote: string; bytes: number;
}
export function describeScan(id: string, sc: any, bytes = 0): ScanEntry {
  const sample = /^(game_synth|sample_|synthetic)/.test(id);
  const room = sample ? 'Sample scenes' : id.startsWith('kitchen4') ? 'Kitchen' : id.startsWith('juan_') ? 'Bedroom & Bathroom' : id.startsWith('nicoroom') ? 'Nico Room' : id.startsWith('aleroom') ? 'Ale Room' : id.startsWith('newell_lounge') ? 'Newell Lounge' : id.startsWith('century_tower') ? 'Century Tower' : id.startsWith('newell_stair') ? 'Newell Stairs' : id.startsWith('turlington') ? 'Turlington' : id.replaceAll('_', ' ');
  const version = id.replace(/^(kitchen4|juan_bedroom_bathroom|nicoroom\d*|aleroom\d*|newell_lounge\d*|century_tower|newell_stair|turlington)/, '').replace(/^_/, '').replaceAll('_', ' ') || 'Original';
  return { id, room, title: sample ? id.replaceAll('_', ' ') : room, version, sample,
    objects: (sc.objects ?? []).filter((o: any) => o.movable !== false).length,
    routes: !!(sc.routes || sc.route), fixes: !!sc.interventions?.length,
    scaleNote: sc.scale_note ?? 'Check scan calibration', bytes };
}
export function groupScans(entries: ScanEntry[]) {
  const order = ['Kitchen', 'Bedroom & Bathroom', 'Nico Room', 'Ale Room', 'Newell Lounge', 'Century Tower', 'Newell Stairs', 'Turlington', 'Sample scenes'];
  return [...new Set(entries.map(e => e.room))].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(room => ({ room, scans: entries.filter(e => e.room === room) }));
}
export function validScanId(id: string) { return /^[A-Za-z0-9][\w.-]*$/.test(id) && !id.includes('..'); }

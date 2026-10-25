export interface Viewpoint { id: string; label: string; position: number[]; quaternion: number[] }
export function parseBookmarks(raw: string | null): Viewpoint[] {
  try { const data = JSON.parse(raw ?? '[]'); return Array.isArray(data) ? data.filter(b => typeof b?.id === 'string' && typeof b.label === 'string' && Array.isArray(b.position) && b.position.length === 3 && b.position.every(Number.isFinite) && Array.isArray(b.quaternion) && b.quaternion.length === 4 && b.quaternion.every(Number.isFinite)).slice(-20) : []; } catch { return []; }
}
export function createBookmarks(scan: string, capture: () => { position: number[]; quaternion: number[] }, restore: (point: Viewpoint) => void) {
  const key = `homeclear.viewpoints.${scan}`;
  let points: Viewpoint[] = []; try { points = parseBookmarks(localStorage.getItem(key)); } catch { /* in-memory fallback */ }
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(points)); } catch { /* in-memory fallback */ } };
  return {
    list: () => points,
    save(label = `Viewpoint ${points.length + 1}`, pose = capture()) { const point = { ...pose, id: crypto.randomUUID(), label: label.slice(0, 80) }; points = [...points, point].slice(-20); persist(); return point; },
    restore(id: string) { const point = points.find(p => p.id === id); if (point) restore(point); },
    remove(id: string) { points = points.filter(p => p.id !== id); persist(); },
  };
}

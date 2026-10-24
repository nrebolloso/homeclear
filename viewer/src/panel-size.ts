// How wide the planning panel may be dragged. Pure (no DOM) so tests/panel-size.test.ts can run it. The panel overlaps the
// scene as it widens (the camera framing doesn't move); it snaps to a few widths and goes back to its normal width when the
// person moves, looks or presses Esc, unless it is pinned (frontend.ts).

export const WIDE_STEPS = [480, 640];   // px, after the normal width
export const MAX_FRACTION = 0.55;       // of the window

export const panelMax = (vw: number) => Math.floor(vw * MAX_FRACTION);

/** The widths it can rest at: its normal width, then each wider step that still fits. */
export function panelSnaps(base: number, vw: number): number[] {
  return [base, ...WIDE_STEPS.filter(w => w > base + 40 && w <= panelMax(vw))];
}

/** Keep a dragged width between the normal width and the largest allowed. */
export const clampPanel = (px: number, base: number, vw: number) => Math.min(Math.max(px, base), Math.max(base, panelMax(vw)));

/** The nearest resting width to a dragged one. */
export function snapPanel(px: number, base: number, vw: number): number {
  const c = clampPanel(px, base, vw);
  return panelSnaps(base, vw).reduce((best, w) => (Math.abs(w - c) < Math.abs(best - c) ? w : best));
}

/** One keyboard step wider (dir 1) or narrower (dir -1) from the current width. */
export function stepPanel(cur: number, base: number, vw: number, dir: 1 | -1): number {
  const snaps = panelSnaps(base, vw), i = snaps.indexOf(snapPanel(cur, base, vw));
  return snaps[Math.min(snaps.length - 1, Math.max(0, i + dir))];
}

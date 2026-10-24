// Active layouts and visual comparisons are separate. Restoring a snapshot always goes through the host's replan;
// previewing never does. Pure state machine so the headset cannot silently show one layout and report another.
import type { Layout } from './grid.ts';

export interface LayoutSnapshot { layout: Layout; applied: string[] }
interface ComparisonHost {
  capture(): LayoutSnapshot;
  context(): string;
  search(): Promise<unknown>;
  apply(snapshot: LayoutSnapshot): Promise<unknown>;
  preview(from: Layout, to: Layout, t: number): void;
  endPreview(): void;
}
export function createXRComparison(host: ComparisonHost) {
  let prior: LayoutSnapshot | null = null, safer: LayoutSnapshot | null = null;
  let active: 'prior' | 'safer' | null = null, busy = false, none = false, error = false, stamp = '';
  let previewing = false, previewT = 1, goal: number | null = null, ending = false;
  const copy = (s: LayoutSnapshot): LayoutSnapshot => structuredClone(s);
  const key = () => JSON.stringify([host.context(), host.capture()]);
  function endPreview() {
    if (previewing) host.endPreview();
    previewing = false; goal = null; ending = false;
  }
  function fresh() {
    if (!busy && stamp && stamp !== key()) {
      endPreview(); prior = safer = null; active = null; none = error = false; stamp = '';
    }
  }
  const button = {
    text() {
      fresh();
      if (busy) return ['Updating the room…', 'routes and checks are recalculating'];
      if (error) return ['Retry safer layout', 'the last update failed'];
      if (none) return ['No suggested changes', 'the scan and checks still need review'];
      if (!safer) return ['See a safer room'];
      return [active === 'safer' ? 'Restore my room' : 'Use safer layout', 'changes the layout, routes and checks'];
    },
    tone: () => busy ? 'busy' as const : active === 'safer' ? 'plain' as const : 'go' as const,
    async press() {
      fresh();
      if (busy) return;
      endPreview(); busy = true; error = false;
      try {
        if (!safer) {
          const before = copy(host.capture());
          await host.search();
          const after = copy(host.capture());
          none = JSON.stringify(before) === JSON.stringify(after);
          if (!none) { prior = before; safer = after; active = 'safer'; }
        } else {
          const next = active === 'safer' ? 'prior' : 'safer';
          await host.apply(copy(next === 'prior' ? prior! : safer));
          active = next;
        }
        stamp = key();
      } catch { error = true; prior = safer = null; active = null; stamp = ''; }
      finally { busy = false; }
    },
  };
  const previewButton = {
    text() {
      fresh();
      if (!safer) return ['Compare before/after', 'choose a safer layout first'];
      const checks = `Checks and walking: ${active === 'safer' ? 'safer layout' : 'prior layout'}`;
      if (!previewing) return ['Compare before/after', 'visual only', checks];
      return [`Preview: ${previewT > 0.5 ? 'safer room' : 'prior room'}`, 'press to return to the active room', checks];
    },
    tone: () => previewing ? 'busy' as const : 'plain' as const,
    press() {
      fresh();
      if (busy || !prior || !safer) return;
      if (!previewing) { previewT = active === 'safer' ? 1 : 0; goal = 1 - previewT; previewing = true; ending = false; }
      else { goal = active === 'safer' ? 1 : 0; ending = true; }
    },
  };
  return {
    button, previewButton, endPreview,
    previewing: () => previewing,
    state: () => ({ busy, active, previewing, previewT: previewing ? previewT : null, hasComparison: !!safer }),
    step(dt: number) {
      fresh();
      if (!previewing || !prior || !safer) return;
      if (goal !== null) {
        const d = goal - previewT, amount = dt / 2.5;
        previewT = Math.abs(d) <= amount ? goal : previewT + Math.sign(d) * amount;
        if (Math.abs(d) <= amount) { goal = null; if (ending) { endPreview(); return; } }
      }
      host.preview(prior.layout, safer.layout, previewT);
    },
  };
}

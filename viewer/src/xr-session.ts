import { SparkXr } from '@sparkjsdev/spark';
import type { SparkXrOptions } from '@sparkjsdev/spark';
// Keep the entry button and XR manager across rooms; only the host callbacks change.
let session: SparkXr | undefined;
let enter: (() => void | Promise<void>) | undefined, exit: (() => void | Promise<void>) | undefined;
export function bindXR(options: SparkXrOptions) {
  enter = options.onEnterXr; exit = options.onExitXr;
  session ??= new SparkXr({ ...options, onEnterXr: () => enter?.(), onExitXr: () => exit?.() });
  queueMicrotask(() => session?.element?.setAttribute('data-xr-persistent', 'true'));
  if (options.renderer.xr.isPresenting) enter?.();
}

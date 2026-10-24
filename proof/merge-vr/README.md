# VR merge verification — October 24, 2026

Merge of `origin/diego/vr` (`b5dc2dd`) into `feat/renovations` (`cc2263a`). See
[`../../MERGE_VR_REVIEW.md`](../../MERGE_VR_REVIEW.md) for the resolved overlaps and user-confirmed behavior.

- `unit-tests.log`: 123 passed, zero failed/skipped, including snapshot restore, independent preview, stale-state
  invalidation, error recovery, and the incoming VR tour tests.
- `build.log`: successful type check and production build; the existing large-chunk warning remains.
- `xr-results.json` / `xr.log`: 22 passed. Includes trigger walking, disabled thumbsticks, night/tour buttons,
  actual prior-layout restoration with recalculated routes/receipts/numbers, preview from either active layout,
  furniture editing, and restoration of desktop labels/performance settings on leaving VR.
- `renovations-results.json` / `renovations.log`: 23 passed. Includes guided desktop marking, real-scan stair
  integration, controller marking/undo/cancel, handle dragging, rail/device controls and parked-device dragging.
- `desktop-results.json` / `desktop.log`: full desktop browser suite, recorded after completion.
- `desktop-first-results.json` / `desktop-first.log`: initial run exposed a fixed-delay race in the last reset check.
  `reset-regression.json` confirms that reset completed correctly after 1,379 ms, with the old 800 ms read still showing
  the preceding evaluation. The permanent test now waits for a completed evaluation and keeps its original assertions.

Browser checks use SYNTHETIC scenes, the local REAL kitchen export for stair integration, and an IWER Quest 2.
No physical headset was used in this verification. The original renovation evidence remains in the adjacent
`proof/renovations` directory.

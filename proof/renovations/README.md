# Renovation verification — October 24, 2026

Generated from local runs on `feat/renovations`. The suite combines SYNTHETIC scenes, a REAL kitchen scan for
measurement integration, and an IWER Quest 2 for controller events. No physical headset was used.

- `unit-tests.log`: 117 passed, zero failures/skips. `sample-generation.log` records fixture generation.
- `build.log`: successful production build; the existing large-chunk warning remains.
- `desktop-results.json` / `desktop.log`: 38 existing browser checks passed.
- `xr-results.json` / `xr.log`: 12 existing emulated-headset checks passed.
- `renovations-results.json` / `browser.log`: 22 guided-marking and renovation checks passed.
- `renovation_marks.png`: inspected desktop edit mode on the REAL kitchen scan. The 0.72 m top mark is explicit
  test input used to verify that the parked device follows `top_z`; it does not validate the real landing height.

See [`../../HANDOFF_RENOVATIONS.md`](../../HANDOFF_RENOVATIONS.md) for controls, APIs, reproduction steps and limits.

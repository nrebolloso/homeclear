# Layers, Compare, Evidence, cost card, hazard review

The dock at the bottom of the viewer (above the walk-mode bar) is the one place for "what does the room show".

- **Presets** (`viewer/src/layers.ts`): Clean (room only), Hazards, Compare (proposed layout in blue over the room as it is, with a
  hazards cleared / remaining / new strip and toe contacts before → after), Evidence (floor by how well it was filmed, imagined
  floor/ceiling, estimated heights, legend). A preset writes only the layers it names and only where they differ; in performance mode it
  leaves heat, the imagined ceiling and all-cost-labels alone. "Custom" shows when the toggles match none.
- **Layers ▴** lists every layer by group. Each row is one of the existing controls (`spot`, `heights`, `heat`, `reimghosts`, ...): the
  dock sets `.checked`/`.value` and dispatches `change`, so `main.ts`, `reimagine.ts` and the View-tab filters stay the owners and stay in sync.
- **Hide UI / V** removes the panels, status pills, strip and HUD (`body.clean`); a "Show UI" chip stays. V is ignored while typing or
  marking/editing/grabbing.
- **Compare** (`reimagine.ts` `setOverlay`, `deltaOf`): visual only, like the morph. Fixes that edit the scan (rails, carved doors) still
  show in their proposed, tinted state because the layout draws them; objects and the strip are what the overlay changes.
- **Evidence** (`provenance.ts`): teal = measured (`coverage >= coverage_good`), amber = thinly filmed, hatched violet = never filmed. The
  legend also names estimated, proposed, designed and simulated, with the colours the viewer already uses.
- **Cost card** (`costcard.ts`): pick a changed object on the desktop. Placeholder numbers say "placeholder", missing ones "pending", and
  funding is "a classification to verify". When `effort.ts` lands only `movecost.ts` changes.
- **Review** (`hazardreview.ts`): confirm / dismiss / note on flagged hazards, saved in the browser (`homeclear.review.<scene>`), exported as
  `hazard_review_<scene>.json`. Dismissing hides the highlight, pin and tour stop; the measured findings list and the simulated risk are
  unchanged. **It is not the answer key**: `tools/label_hazards` is labelled blind, before looking at what was flagged, so these
  verdicts must never feed `cosmos/reason_eval.py`.
- Hazard object glow is now red; floor rings keep the orange-to-red bump palette.

Hooks: one import block and one hook block at the end of `main.ts` (`// ---------- layers (layers.ts) ----------`), plus
`allSpots` / `spotFilter` beside `spotList`. `window.game.layers` (`apply(name)`, `active()`, `state()`, `setChrome(on)`),
`game.review`, `game.costcard`, `game.provenance` are there for the VR team; none of the DOM panels render in a headset (the in-room cost
tags still do). Tests: `npm test` (layers, provenance, costcard, hazardreview, reimagine) and `node e2e/layers.ts <url>` (software GL).

# Guided marking and room renovations

The subsequent merge with Diego's VR refactor is documented in `MERGE_VR_REVIEW.md`. VR now routes marking through
`xr.ts`'s `XrEditor` adapter; its room restore and comparison buttons use `xrcompare.ts`.

Continuation of the October 24 session transcript in the parent directory. Work stays on the existing
`feat/renovations` branch. The session started with unfinished edits on top of `790c030`, including the new
`marker.ts` and `marker3d.ts` files. This continuation completes those edits on the same branch.

## What is implemented

- A surface pointer, height snapping, live width/rise previews, left/right stair labels, validation before placing,
  per-point undo, and handles for correcting an existing annotation. Stairs take three points; doorways take two.
  The last point measures immediately and enters editing. Enter or Escape finishes editing.
- Desktop click versus drag handling, right-click/Backspace undo, Escape cancellation, Shift to bypass snapping,
  and Space to place at the centre crosshair. Editing no longer selects or drags furniture accidentally.
- Equivalent VR marking through the existing wand, with scene sprites for prompts and controls. Annotation
  gestures consume the trigger, so they do not teleport, remove furniture, or start ordinary furniture drags.
- The clicked top height is retained as `top_z`. A partial-flight annotation can warn that the scan continues
  higher; move its top handle to remeasure. Unknown stronger hand with one rail and missing switch information
  contribute borderline checks to optimization.
- Rail refitting, level extensions, a top grab bar, contrasting step-edge strips, and step lights are configured
  interventions. Their geometry follows the tread edges. Designed additions remain tinted and labelled.
- A second walker or a rollator can wait on the landing. Drag it in the landing plane; its position/yaw enters
  `Layout.placed`, the receipt, fix card, and OT report. Adding, undoing, and resetting preserve consistent state.
- Door checks record whether a route uses the opening. Off-route door renovations are excluded from both the
  ranked fix list and optimizer actions. For a blocked route, evaluation tries widening the individual marked
  door to recover a route before deciding whether that opening is relevant.
- Renovation and stair visual updates now run in the XR frame loop as well as on desktop.

## Controls

Desktop: **Mark stairs** / **Mark doorway** starts a guided annotation. Click releases place points; dragging looks
around. Right click or Backspace undoes one point; Escape cancels. Shift disables snapping; Space places at screen
centre. **Edit marks** shows saved handles and clickable rail sides. Enter/Escape ends editing. Drag a parked device,
press R to turn it by 90 degrees, and right click its body to restore the suggested position.

VR uses the configured wand hand (`?wand=left` switches it):

| Input | Action |
| --- | --- |
| Off-hand A/X, idle | Start a doorway |
| Off-hand B/Y, idle | Start stairs |
| Wand B/Y, idle | Edit saved marks |
| Wand trigger/pinch | Place on release; hold and drag a handle or parked device |
| Wand B/Y, marking | Undo the last point |
| Wand grip | Cancel marking/drag, or finish editing |
| Wand A/X, editing | Finish editing |
| Off-hand grip | Temporarily disable snapping |
| Off-hand A/X, editing | Switch the first stair's top device between walker and rollator |
| Wrist twist, holding parked device | Turn the device in 90-degree steps |

The off-hand controller carries a small entry-control hint. Active prompts follow the surface pointer or stay in
front of the viewer if the ray misses. With tracked hands alone, start marking through the desktop panel or API;
pinching then places/drags using the same wand path. Face-button mode entry requires controllers.

## Files and integration seams

| File | Responsibility |
| --- | --- |
| `viewer/src/marker.ts` | Pure placement, validation, preview, snapping and handle transformations |
| `viewer/src/marker3d.ts` | Pointer, preview lines, labels, pickable handles and rail toggles |
| `viewer/src/main.ts` | Shared state, panel wiring, desktop/controller gestures, persistence, report positions |
| `viewer/src/stairs.ts`, `stairs3d.ts` | Stair measurements/checks/fixes and their scene geometry |
| `viewer/src/doors.ts`, `evaluate.ts` | Door relevance and recovery of blocked routes |
| `viewer/src/worker.ts`, `optimize.ts` | Shared candidate filtering for the fix list and optimizer |
| `viewer/src/grid.ts`, `checks.ts` | Additive fixture yaw/height fields, placed fixture resolution, check metadata |
| `viewer/src/reimagine.ts` | Receipt position/description for placed fixtures and cleanup on undo |
| `viewer/index.html`, `src/style.css` | Panels, editing buttons, device choice, crosshair and desktop prompt |
| `viewer/tests/marker.test.ts`, `stairs.test.ts`, `doors.test.ts` | Logic regressions |
| `viewer/e2e/renovations.ts` | Desktop gestures, real-scan stair integration, emulated Quest controller gestures |

`window.game.marker` exposes `begin('stairs' | 'door')`, `place([x,y,z])`, `undo()`, `cancel()`, `edit(on)`, `done()`,
`state()`, `dragHandle(owner,key,[x,y,z])`, `toggleRail(name,side)`, `moveWalker(name,poseOrNull)`, and `setTopDevice()`.
Await `place`, `dragHandle`, `moveWalker`, or device changes when they trigger a measurement/replan. `state()` includes
the prompt, pointer, handles, editing flag, preview, active drag, and validation message. Keep controller bindings in
the existing wand hook; do not duplicate placement/measurement logic in `xr.ts`.

Coordinates are metres in the existing floor frame, with **+z up**. Pose yaw is **radians**. The parked fixture's x/y/yaw
override uses its intervention ID (`stair_walker:<name>`); z always comes from the landing height. An invalid drop over
the flight or too far from its top restores the committed position. Right-click reset preserves the addition;
receipt Undo removes the addition and its placement override together. Reset all clears renovations and keeps scan
annotations. Annotations and their explicit rail/device choices persist per scene in local storage.

## Verification and reproduction

Run from the repository root, using a Python environment with the README dependencies:

```powershell
python tests/make_sample_objects.py
cd viewer
npm test
npm run build
npm run dev -- --host 127.0.0.1 --port 5181
# In a second terminal:
node e2e/run.ts http://127.0.0.1:5181
node e2e/xr.ts http://127.0.0.1:5181
npm run e2e:renovations -- http://127.0.0.1:5181
```

`e2e/env.ts` now accepts a `PYTHON` environment override for the clip-generation check; otherwise it uses this repo's
`.venv`. Verification here used the existing sibling checkout's Python environment read-only, with all generated
scenes and exports written into **this** checkout. The synthetic table fixture now includes the lower legs above
the floor plane; previously the cut omitted them, misclassified the table as raised, and left phantom obstacles.

Confirmed during this continuation: **117 unit tests pass, zero skips**, production build succeeds, and the new
renovation browser checks pass on desktop and the emulated Quest. The real-kitchen integration uses the local
`kitchen4_lighter_objects` export; its clicked 0.72 m landing height is test input, not independent tape validation.

| Check | Result |
| --- | --- |
| `npm test` | 117 passed, 0 failed, 0 skipped |
| `npm run build` | Passed; existing large-bundle warning |
| `node e2e/run.ts` | 38 passed, 0 failed |
| `node e2e/xr.ts` | 12 passed, 0 failed |
| `node e2e/renovations.ts` | 22 passed, 0 failed |
| `git diff --check` | Passed |

Generated logs, JSON results and the inspected desktop screenshot are in [`proof/renovations/`](proof/renovations/).
YAML export also retains rail-height metadata, explicit rail overrides, and the top-device selection.

## Practical limits

- No physical headset was worn for verification. IWER checks input dispatch and scene behavior, not headset
  readability, comfort, tracking noise, or standalone GPU performance.
- Upstairs turning clearance has no measured occupancy layer. Even a reachable, correctly facing parked device
  remains **borderline, OT to verify**. No designed geometry is fed back into scan measurements.
- Costs remain the existing placeholder catalog and `movecost.ts` adapter. The effort/funding teammate owns the
  authoritative numbers. The current top-device choices are walker and rollator.
- Rail detection cannot reliably distinguish a wall or another flight's railing. The explicit rail-side controls
  remain available; editing a measured handle intentionally discards derived tread/rail measurements and rebuilds them.
- The blocked-route door retry tests one opening at a time. If multiple independent blockers prevent every retry,
  route relevance cannot establish which doors belong to the intended path; inspect that plan manually.
- Keep changes additive at shared integration points. Detection/export ownership and the existing VR locomotion
  remain as described in `AGENTS.md` and `HANDOFF_VR.md`. Leave `config.myhome_bedbath_a.yaml` to its original author.

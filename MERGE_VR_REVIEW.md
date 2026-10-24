# VR and renovations merge review

Merge: `origin/diego/vr` (`b5dc2dd`) into `feat/renovations` (`cc2263a`). The two textual conflicts were
`viewer/src/main.ts` and `viewer/e2e/xr.ts`. Both features and both sets of browser checks are retained.

## Confirmed behavior choices

| Choice | Result |
| --- | --- |
| Locomotion | Trigger/pinch walking only. Thumbsticks do not move or snap-turn. Physical tracking remains 1:1; wand teleport remains available. |
| Restore my room | Restore the exact layout active before the safer-room search, including existing manual edits, removed objects, placed fixtures and applied fixes. Recalculate routes and checks. |
| Compare before/after | A separate visual-only button. It previews the saved layouts and explicitly names which active layout supplies the checks. |

The former “Back to my room” label is now **Restore my room**. After restoring, **Use safer layout** reapplies the
saved suggested layout and recalculates it. A manual layout edit, changed persona, or changed annotation invalidates
the saved comparison so it cannot overwrite newer edits. These choices were confirmed in this chat.

## Overlaps resolved

| Overlap | Resolution |
| --- | --- |
| VR implementation in `main.ts` versus Diego's `xr.ts` refactor | Keep `xr.ts` as the tracking/input/render-session owner. Renovations provide an `XrEditor` adapter, with no second rig or wand loop. |
| Story-card buttons versus marking/dragging | Editing hides the story card. Annotation gestures are consumed before furniture or teleport actions. Enter **Edit marks** with wand B/Y to grab a parked device obscured by the card. |
| Read-only preview versus editing/locomotion | Card buttons remain usable. Furniture edits, annotation shortcuts, teleport and trigger glide are disabled until the preview ends. |
| New family “safer room” flow versus desktop Reimagine | Both use the same optimizer and layout. `xrcompare.ts` owns snapshot restore and independent visual comparison, rather than duplicating the optimizer. |
| Frame updates on desktop versus headset | Each frame path updates renovation animation, stairs and labels once. Headset frames use scene labels and plain rendering. |
| Object labels after moving the wand out of `main.ts` | Labels use `xr.wand()` state, retaining names, movement summaries and reset hints. |
| Grip/A/reset controls versus the refactored wand | Keep single-object reset, A removal and both-grip reset. A consumed edit gesture cannot become a global reset without releasing both grips. |
| Headset performance mode versus explicit URL settings | Keep Diego's measured 2.0 splat trim and Quest settings. An explicit `?perf=0` still takes precedence; leaving VR restores the prior performance mode. |
| Hazard tour and Night walk | Retain the desktop timed tour and the headset's press-for-next tour. Both night controls use the existing night shader. |
| No search changes versus safety claims | The card says “No suggested changes”; absence of suggestions does not establish that a room is safe. Search failures offer retry. |
| Model text escaping | Preserve the incoming escaping of Cosmos Reason notes and tour descriptions. |
| Reset test versus queued optimizer work | Wait for the reset evaluation to complete. A fixed 800 ms raced fix ranking; the focused reproduction completed correctly after 1.38 seconds. The correctness assertions are unchanged. |

The comparison interpolates furniture poses and removal opacity without modifying the active layout. Saved fixes,
door edits, floor patches and parked-device positions switch visually halfway through. Active route/hazard overlays
are hidden during preview to avoid drawing active-layout measurements over the alternate appearance. On exit or
invalidation, the actual active geometry and overlays return. Designed additions remain labelled and separate from
measured scan data.

## Files and ownership

- `viewer/src/xr.ts`: VR tracking, controller gestures, story-card meshes, input priority and preview read-only gate.
- `viewer/src/main.ts`: scene/optimizer integration, the renovation adapter, visual comparison drawing and recalculation.
- `viewer/src/xrcompare.ts`: tested snapshot and preview state machine.
- `viewer/src/xrtour.ts`: incoming plain-language tour text and standable viewpoints.
- `viewer/e2e/xr.ts`: combined VR story, restore/preview, locomotion and object-edit regressions.
- `viewer/e2e/renovations.ts`: marking, rail and parked-device regressions with the refactored input path.

No further product decision is required to complete this merge. Physical headset readability, tracking noise and
comfort still need a hardware check; browser verification uses IWER emulation. Existing large-bundle build warnings
remain. The unrelated `config.myhome_bedbath_a.yaml` is excluded.

Verification results are recorded after the final test runs in `proof/merge-vr/`.

# Viewer features from Juan's branch, with the world model

Ported from `origin/juan` of the old repo (26 commits, merged against the world-model branch) on 2026-10-23.

What came over: Rapier walker physics pass, multiple routes (night/day) with a risk range, personas (cane,
Parkinson's), vision filters, heatmap, a month of nights, transfer / reach / emergency checks, suggested layouts
(optimizer), OT report, fix card with QR, third-person mannequin on the simulated footsteps, room shell, fill
backends, WebXR. Python side: stage 12 exports routes / personas / fixtures / transfer and EMS rules, stage 5c
room shell, stage 12b fills (CPU backends), estimated ground truth in stages 4 and 6b, and `tools/contact_table.py`.
Juan's PR #1 (`feat/rapier-physics`) was merged on top later the same day; it brought object detection (06c), re-scan diff (14) and Cosmos Reason / fill / prerender.

`?step=world` works with all of it: world-model rollouts take the batches, height-error bias, heatmap and
persona clearance scale, and the mannequin walks the world model's heels at the walker's own pace.

## Contact table (changes every risk number)

The placeholder table is replaced in every config by `tools/contact_table.py`: minimum toe clearance 14.1 ± 8.3 mm
(lognormal) and ~1 contact in 578 strides over a 1 cm obstacle (Frontiers 2014), trip-averaged with
`toe_clearance_cv`. p(1 cm) went from 0.005 to 0.00168 per stride, p(5 cm) from 0.20 to 0.0046.
Risk numbers from before this change are not comparable. The darkness multiplier is still a labelled assumption.

## Checks

| Check | Result | File |
|---|---|---|
| viewer unit tests (`npm test`) | 52 / 52 pass | `viewer_tests.txt` |
| Python self-checks (`tests/run_py.sh`) | all OK | `python_selfchecks.txt` |
| headless end-to-end (`node e2e/run.ts`, Intel Arc, ANGLE GL) | 24 / 24 pass, 60 fps autoplay | `e2e_results.json` |
| `kitchen4_lighter?step=world`, third person (REAL scene) | loads, no page errors, mannequin on the world-model heels | `kitchen4_lighter_world_thirdperson.png` |

The e2e checks run on the SYNTHETIC scenes (`game_synth`, `game_synth_narrow`, `sample_objects`). The real scenes
were re-exported with the new stage 12; kitchen4's route has no floor bump, so it reads 0.0 contacts/month and its
one hazard is a 9 cm/side tight passage.

## After merging PR #1 (live test on `kitchen4_lighter?step=world`, REAL scene)

Physics pass, heatmap, night, all three personas, suggested layouts (6 in 4.3 s), OT report, fix card + QR, vision
filters, third-person mannequin, moving the table (along x; up/down is refused by the placement check, measured
obstacles touch it) and removing it (fill shows): all ran with no page errors. Fixes found on the way:
- `physics.ts`: the route follower ran ahead of the walker (searched from the steering look-ahead), giving false
  "0.0 cm edge" tips on flat floor (3 on kitchen4_lighter) and cut corners. Now 0 snags; new unit test.
- stage 14: `layers()` returns 5 values since the floor-fill fix.
- stage 12: the default route was called "bed to bathroom" in the kitchen scenes; now `plan.name` or "main route".
`npm test` 53 / 53, `tests/run_py.sh` all OK.

## LaMa fills on `kitchen4_lighter` (REAL scene, imagined floor)
Stage 12b with `--backends telea,ns,lama --run kitchen4_lighter` on a B200 (28 s wall for the 18
detected objects; env `homeclear-extras`, weights cached under `$HPG_ROOT/cache/torch`, `SSL_CERT_FILE` set or the
download fails). LaMa is the default fill for every object (`kitchen4_lighter_fills.json`). Stage 12b changes: the
model loads once instead of per object, and LaMa's padded output is cropped instead of resized (the resize shifted the
texture by up to 7 px = 7 cm). Only 10–42% of the 40 cm ring around each footprint has real floor in the splat, so most
of what LaMa continues is itself unseen: it gives a streaky wood-like texture with dark smears
(`kitchen4_lighter_table_fill_lama.png`); `ns` is smoother but flat. No wall patches: kitchen4 has no stage 5c shell.

## Removed objects left leftovers (fixed)
A Gaussian went with a detected object only if it was within 3 cm of a stage 6c labelled point, so faint Gaussians 6c
never labelled stayed behind: on `kitchen4_lighter` 33% of the table (legs, haze), 42% of chair7, 18% of chair4, and
the cup and other things on the table floated in the air after removing it. Stage 12 now also gives an object everything
inside its footprint, from its lowest labelled point to 30 cm above its band, whose nearest labelled point (within
10 cm) is its own or no object's. Room Gaussians left inside the footprint: table 4739 -> 48, chair4 660 -> 39, chair7
1116 -> 172, basket 1684 -> 167, trash can 74 -> 0. Still left: the bedside tables (9-23%; their outlines overlap the
chairs, so the leftovers are nearer the chair labels) and the counter under the basket (never filmed, shows as a blur).
The boxes on the cabinet do not take the cabinet (the zone starts at their lowest labelled point). Re-ran the LaMa fills
afterwards (job 47386024, 33 s). Live: `kitchen4_lighter_table_removed_clean.jpg` (table, chair4, chair7 removed).
Follow-up: chair legs were still left (user screenshot). chair7's labelled points start 22 cm up, so its zone missed its
runners, and one of chair4's runners was detected as its own "chair6". Now an object labelled from below 30 cm takes
its footprint down to the floor, and a low detection inside another of its kind is merged into it (chair6 -> chair4).
Left inside footprints: chair7 172 -> 0, chair4 39 -> 4, bedside tables 112 / 47 -> 7 / 6. Fills re-run (job 47389772).

## Removed-objects inventory
The Fixes panel lists every removed object ("Removed") with a Put back button; put back returns it where it stood if
that spot passes the placement check. `game.inventory()` / `game.restoreObject(name)` for tests. Live-checked on
`kitchen4_lighter`: remove chair4 + chair7 -> both listed; Put back chair7 -> back in the room, list shows chair4 only.
Second follow-up: chair8's runners were still left (user screenshot). They were labelled chair8 but lie 0-4 mm up, under
the 4 mm floor band every cut started at. An object's own labelled points now go with it below the floor band (the zone
of unlabelled Gaussians still starts at it). Yellow Gaussians on the floor inside chair8's footprint: 391 -> 0
(`kitchen4_lighter_chair8_removed.png`). Still left: ~60 runner Gaussians shared by the chair4 / chair7 footprints,
more than 10 cm from any label and at floor height (a short yellow bar under the table). Fills re-run (job 47391130).
The Removed list is now icon tiles (an icon per kind, name under it); click a tile to put it back.

## chair7 back left against the wall (fixed), and every object checked
User screenshot: a pale chair back stayed against the wall behind the table after removing chair7. ~360 grey Gaussians
(the backrest's back face, which 6c never labelled) were nearest to chair7's labels but 5-12 cm away and outside its
slanted outline, so neither rule took them. An object now also takes what is nearest to its own labels up to 10 cm past
its outline, above 30 cm (so floor and runners of other objects stay put). Room Gaussians left in chair7's old box:
468 -> 177 (opacity sum 36 -> 15); from the user's camera the wall shows plain. Fills re-run (job 47397124, 17 LaMa fills).
Live check of all 17 objects on `kitchen4_lighter`, removed one at a time: no object parts left behind. What remains is
room, not object: the counter under the basket (never filmed, a blur), and a dark smudge on the wall corner behind the
trash can (every Gaussian there is 15-33 cm from any trash-can label: the unseen wall behind it). Close up (< 1 m) the
table top and seats render patchy and see-through with or without removals; from normal distance they are solid.
`npm test` 74 / 74, `tests/run_py.sh` all OK.
Third follow-up: two yellow bars stayed in chair7's box after removing the table and chair7 (user screenshot). They were
chair7's runners, lying flat at 0-3 mm (under the 4 mm floor band) and 14-28 cm from any label, so no rule took them.
An object labelled from below 30 cm now takes everything unlabelled in its outline from 3 cm below the floor (the fill
replaces that floor anyway). Yellow Gaussians left on the floor in chair7's box: ~183 -> 0
(`kitchen4_lighter_chair7_runners_gone.jpg`; the leg still standing there is chair4's and goes with chair4). Cost: a moved
chair carries a thin dark strip of floor under its runners. Fills re-run (job 47409131).
Fourth follow-up: two legs still stood in chair7's box after removing it (user screenshot). They were chair7's leg bottoms:
6c labels chair7 only from 22 cm up, so they were nearest to no label, and unlabelled points inside overlapping outlines
went to whichever object came first (chair4, then the table). An unlabelled point now goes only to the object whose labels
it stands under (nearest with height counted at 30%). Low points in chair7's box: table 159 -> 1, chair4 44 yellow -> 2
(the rest of chair4's 29 there are faint wall-edge Gaussians), chair7 209 -> 721. Room Gaussians left per footprint
barely change (largest: bedside tables +20 each, chair7 +16). Fills re-run (job 47411688). Not live-checked in the
browser (extension disconnected).
Fifth follow-up: the trash can carried part of the white wall behind and above its lid (user report). 6c's mask spilt onto
the wall, and the grow and on-top rules took the rest (1290 Gaussians, a sheet up to 98 cm). Stage 12 now cuts each
object against stage 5c's walls (fitted in memory when the run has no shell.json, so nothing else reads them): only walls
the object's labels lie wholly on one side of (5c finds 30 lines here, some running through the trash and basket), and
everything on or past the line goes back to the room: within 2 cm up to the object's top, within 10 cm above it. Trash
can 26977 -> 25687 Gaussians, height 0.768 -> 0.664 m; boxes lose 10-86 stray Gaussians from behind the wall; basket and
all chairs/tables unchanged. Fills re-run (job 47413830). Not live-checked in the browser (extension disconnected).

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

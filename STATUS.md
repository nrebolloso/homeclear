# Status

## While you were out (rug-calibration)
- **Done:** rug physics calibrated against 8 real flat-rug passes; fold cascade in autoplay (folds the mat on pass 2 in kitchen4_lighter); glide caps as a planner fix next to "tape the mat edge"; `proof/demo/real_vs_sim_rug.mp4` and `proof/demo/broll/` (16 clips).
- **In progress:** nothing running. The branch passes `npm test` (166) and `npm run build`; a trial merge with wm-planner passes 172/172 and the build.
- **Needs me:** BLOCKERS 13-17: a real tennis-ball pass, the 8-vs-9 rug count, IMG_6800, the effort numbers, and the main.ts/planfix.ts merge with wm-planner.
- **Risks:** the sim drags where the real rug folds (disturbance matches, fold shape doesn't); the caps value is assumed and friction-only, so "caps barely help" is a sim result to test, not a finding.
- **Overlap with futures fan:** main.ts and planfix.ts conflict (resolution in BLOCKERS 17); grid.ts, planner.ts, engine.py and the kitchen4_lighter config auto-merge. No futures-fan files touched.

## Rug calibration (branch `rug-calibration`, not merged to demo-safe)
- **Data:** `data/walker_rug/pairs.csv` (floor/wide pairs, synced by audio cross-correlation, visual fallback), `data/recording_notes.csv` (tracked). 1000101382 / IMG_6801 syncs at -1.64 s (sure). The 6798 pair rechecked: audio -1.21 s, bracketed by the walker start/stop (-1.6 / -0.9 s), kept at -1.21 ±0.3 s.
- **Physics** (`physics/rug_calib.py`, MuJoCo cloth rug, 30 paired trials per direction; ranges in `physics_ranges.json`: glide-rug friction 0.35-0.9, rug-floor 0.1-0.3):

  | | off: fold / drag / disturbed | onto: fold / drag / disturbed |
  |---|---|---|
  | REAL | 0.86 / 0.14 / 1.00 (n=7) | 0 / 1.00 / 1.00 (n=1) |
  | sim, uncalibrated | 0.03 / 0.37 / 0.40 | 0.40 / 0.23 / 0.63 |
  | sim, fitted | 0 / 0.70 / 0.70 | 0 / 0.80 / 0.80 |
  | sim, fitted + glide caps (μ 0.10-0.20, ASSUMED) | 0.20 / 0.47 / 0.67 | 0.73 / 0.07 / 0.80 |
  | sim, fitted + taped edge | 0 / 0.03 / 0.03 | 0 / 0 / 0 |
  | sim, front wheels only | 0 | 0 / 0.03 / 0.03 |

  Rear glides are what disturb the rug (wheels only: ~0); bare floor is clean in both. The fit was not tuned to the single onto-rug take.
- **Cascade** (`viewer/src/rugcascade.ts`, `?rugfold` or `game.rugFolds.set(true)`, off by default so e2e numbers hold): each edge crossing folds the nearest corner with P 0.75 (6/8, MEASURED); the fold is a 4.2 cm bump (sim median of folded passes, SIMULATED) reaching 15 cm (ASSUMED). It applies to whichever rug the route crosses, and clears when that rug moves, is removed or taped. In a trial merge with wm-planner, the mat folded on pass 2: toe contacts/month 1.21 → 1.72, and the futures fan logged 270 "folded corner" futures over 41 samples (0 before).
- **Glide caps vs tape** (planner, kitchen4_lighter as scanned, 400 trips, seed 2; caps scale snags by the sim's 0.978):

  | Layout | Risk/month | Snags | Cost |
  |---|---|---|---|
  | As scanned | 216.66 [206.0, 228.4] | 66.57 | |
  | Tape the mat edge | 175.56 | 25.47 (-41.1) | $10, 10 min, effort 1 |
  | Glide caps / tennis balls | 215.74 | 65.66 (-0.9) | $8, 5 min, effort 1 |

  Both are in the planner's fix list and the OT report's ranked fixes.
- **Proof:** `proof/demo/real_vs_sim_rug.mp4` (take 1000101382 floor + wide, the fitted sim pass dragging the edge 14 cm, and an empty slot for a tennis-ball pass; `tools/rug_video.py --caps` fills it). `proof/demo/broll/`: four fold takes' last 5 s, floor and wide, at speed and 0.5x (75 MB).

## Kitchen planner + gait personalization (branch `wm-planner`, 2026-10-24, not merged to demo-safe)
- **Planner** (`planner/`, `viewer/src/planner.ts`, `planfix.ts`, `planworker.ts`). A layout is chair x/y on a 5 cm grid with yaw in 90° steps, plus the mat, cord and nightlight states. It is checked for overlaps, chairs within 0.8 m of the table, clear fridge-swing/sink/entrance zones, and a walker-feasible route. Scoring uses world-model rollouts with common seeds, snags from the MuJoCo tables, and contacts + snags + brushes per month with a CI; effort is tracked separately. B200 job 47465023 (Slurm): 65,528 layouts (63,354 valid), 102,528 evaluations, 12.76 M imagined trips, 1,233 s wall time (46.5 s GPU rollout, ~0.35 GPU-h). Risk across the search was 214 (197–233); the chosen option is 60.9 at effort 3.3. Outputs are in `out/planner/kitchen4_lighter/` (replay, Pareto front, job stats).
- **Critic** (`planner/critic.py`, ONNX, inputs and outputs clamped to the training range). Held-out 20% (n = 12,670): MAE 1.38, RMSE 4.2 events/month, R² 0.987, Spearman 0.80. In the browser it searches thousands of layouts from the judge's layout and confirms the top 5 with real rollouts, so the AI's answer is never worse than the judge's. The OT report's ranked fixes now come from the planner.
- **Gait personalization** (`worldmodel/persona.py`, `viewer/src/gaitfit.ts`, HANDOFF_GAIT.md). 8-d embedding, leave-two-out CV over 14 PhysioNet people. Fitting from walker + head improves head error 9.8 → 5.2 cm (12/14 people) and walker error 12.4 → 11.7 cm (10/14). It **does not improve heel** (4.03 → 4.13 cm), and an oracle test says heel style isn't identifiable from this data; closed-loop results are about neutral.
- **Proof:** `proof/demo/planner.mp4`, `planner_vs_judge.mp4`, `personalization.mp4` (`viewer/e2e/record_planner.ts`); e2e check 13.
- **Does gait style change the plan?** No (`planner/persona_effect.py`, `out/gait/persona_effect.json`). We folded 15 embeddings (the mean, held-out P12/P13 fitted from 30 s, and 12 training people) and scored 2,000 common-seed trips each. Feet move: steps range from 34.5 to 42.1 cm, and heels sit up to 22 cm from the mean's. Contacts/month barely change (1.09–1.18; the mean re-seeded gives 1.12), and snags are identical (66.57, from the tables). Brushes vary 122–150, mostly P02. The best option and the fix order (chair8, then mat) are the same for 15/15. Re-picking over all 46 Pareto layouts changes the chosen layout for 4/15, but only between near-tied variants of "move chair8 + remove mat" within the CI. **"Re-plan for me" is hidden in demo mode**, and it now compares the same network at the mean vs the fitted embedding.
- **World model life-size in the kitchen** (`viewer/src/wmghosts.ts`, `imagine.ts`; panel "World model in the kitchen"; all labelled "imagined (world model)"):
  - Two translucent mannequin + walker ghosts start at the fridge: the average person and a chosen style (held-out P12/P13, or training P07/P10/P02, which differ most). They flash on toe catches and frame brushes.
  - A fan of 30 four-step futures is drawn at each heel strike: green clean, red toe catch, amber brush.
  - The predicted self is the model's own walker pose 0.5 s ahead.
  - The month replay walks 60 trips as low-detail ghosts, as scanned and after the fixes, with a counter: e2e run 196 → 63 incidents vs the evaluator's 192.8 → 67.0. The "Plan fixes" fans now draw in the room.
  - fps (`viewer/e2e/fps_ghosts.ts`, ANGLE Intel Arc MTL, 1600×900, headless GPU): room 59, two styles + fan 60, month 51. A headed run was not possible because the screen was locked.
  - Proof: `proof/demo/ghosts_kitchen.mp4`, e2e check 14.
- **Risks:** zones and outlets are read off the viewer, not taped (BLOCKERS 10). Taped-mat and rerouted-cord effects and their costs are assumptions. Chair-move cost is the placeholder `movecost.ts` (about 35 min). `personalization.mp4` is 3 min because the re-plan runs 3,000 layouts live.

## Demo push (2026-10-24)
- **Done:** steps 1-6, 9, 10 (OT report with ranked fixes). Then: the classic two-panel UI is the default again (`?planning` keeps the drawer); demo mode (`?demo=1` or H) hides debug rows, ranges, the "measured height error" line and the fps HUD, and `e2e/shot.ts` records in it on its own server with hot reload off; the fps HUD shows outside demo mode; one palette for ghosts, heatmap and hazards (cyan footsteps, orange to red contacts, white hand rule); the night shot with the nightlight (`proof/demo/shot7_night.mp4`); the optimize test timeout raised to 60 s.
- **Next:** feature freeze at [TIME - 3h], then record `proof/demo/final.mp4` in demo mode at [TIME - 2h] following the storyboard. Judging is at [TIME]; the actual time is still needed (BLOCKERS.md). Step 8 VR with the VR team.
- **Risks:** on battery with power-saver, e2e measures about 20 fps and fails the fps check (BLOCKERS 8: plug in). Storyboard clips 1-6 were recorded in the old drawer UI with debug text, so re-record them in demo mode before final.mp4. Cosmos clip still lists as "other scenario".

Each result counts once it is reproduced here, with proof in `proof/`.

| Spec milestone | In place | To do |
|---|---|---|
| Kitchen splat + scale + accuracy (Must) | SfM, GLOMAP + stray-camera drop, gsplat MCMC, table scale, stage 6b margins | leave-one-out over all three table dimensions; check the kitchen1 table width (BLOCKERS #1) |
| Maps + hazards (Must) | stages 5–8: floor, floater cleanup, occupancy, local-floor bumps, verdicts | coverage map export; hazards.json in the SPEC §5 shape |
| Baseline world model + rollouts (Must) | hand rule, `worldmodel/` rollout engine, contact table calibrated to published toe clearance (`tools/contact_table.py`) | 200 trips on the demo kitchen route |
| Viewer core (Must) | autoplay, free walk, live hazard checks, ghosts, fog, night mode, drag objects, tinted fills, several routes with a risk range, personas, vision filters, heatmap, transfer/reach/EMS checks ([proof](proof/viewer_features/README.md)) | demo route on the demo kitchen; fps check |
| Learned world model (Should) | MDN on PhysioNet, closed-loop / coverage / counterfactual / sanity tests | 20+ step rollouts; sideways spread over-confident in corners; our own walker videos |
| Mannequin + world-model visuals (Should) | third-person mannequin on the simulated footsteps (world-model heels with `?step=world`) | rigged mannequin with foot IK; next-step cloud |
| Editable scene + ranked fixes (Should) | dragging, re-planning, ranked fixes, suggested layouts, fix card (QR) | |
| Walker physics (Should) | Rapier walker pass over the measured floor, snags listed; live object physics (Rapier worker: chairs pushed/tipped, mat slides, curled-corner flap); MuJoCo batch on HiPerGator (9,600 pushes) feeding the rollouts and OT report ([proof](proof/physics/README.md)) | real-walker validation (BLOCKERS #7); batch reruns per scene |
| Cosmos Transfer clip (Should) | controls export, chunking, tinting, settings (edge 0.7, guidance 3) | worst-case clip of the demo kitchen |
| Cosmos Reason evaluation (Should) | – | pipeline + answer key |
| OT report (Should) | stage 11 HTML report; live OT report from the viewer layout | all SPEC §4.12 sections |

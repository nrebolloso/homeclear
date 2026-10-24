# Status

## Demo push (2026-10-24)
- **Done:** step 1. Local work backed up on `backup/pre-merge-2026-10-24`, origin/main (51 commits) merged into main, new configs moved into `configs/`; Python suites, 131 viewer tests, optimize.test.ts alone and the build all pass. Not pushed.
- **Next:** step 2, kitchen4_lighter as the viewer default, route reversed to fridge -> kitchen entrance.
- **Risks:** e2e (`node e2e/run.ts`) not rerun yet, so `viewer/e2e/results.json` is still origin's copy; `merge-juan` (1 unpushed newell_stair commit) left alone.

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

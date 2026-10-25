# Status

## While you were out (2026-10-24, branch merge-juan, nothing pushed, demo-safe tag untouched)
- **Done:** lounge floor has no invisible obstacles left (97 m² walkable, open floor clear); removing an object now takes the whole object, including the parts 6c labelled too weakly (71649ea, self-check `tests/test_export_join.py`, all Python checks pass); `gator_lounge_lighter_v1.0.5.zip` is in the scratchpad; stage changes synced to HPG.
- **Audit (remove each object, look from 3 angles):** sofa, chair3 and the other 14 come out clean with no regressions. sofa2 leaves thin floating streaks; stool2 leaves a small patch (probably the unlabelled bench).
- **In progress:** bedbath_hall (nicoroom) on HPG (SfM map running, then densify and train); night1/turlington (GPU SfM running). Watchers build the demos when training finishes.
- **Needs you:** BLOCKERS 10 (accept sofa2 streaks or retrain with a Gaussian-size cap; render lift not adopted); OK to push d012fb8..d129e81 to main.
- **Risks:** the new stage 12 rules change every `objects: auto` scene on re-export (only the lounge rebuilt so far); e2e not re-run after this last change.

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

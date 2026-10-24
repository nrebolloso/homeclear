# Status

## Demo push (2026-10-24)
- **Done:** steps 1-6, 9, 10. Step 10: OT report gains "Recommended fixes, ranked" (each unapplied fix rolled out from the live layout: contacts/month saved, passage gained, cost, time, effort; as-is: mat -1.1, nightlight -0.4, cord -0.1, chair -0.02/+6 cm); accuracy/scale numbers removed from the report; `proof/demo/shot6_report.mp4`. Step 7 so far: nightlight object + fix (night route 1.12 -> 0.75 from the darkness rule), contacts/month headline tile with hand-rule baseline, shots 1/3/4 frame-stepped. All six storyboard shots in `proof/demo/`. npm test 131/131, build ok, e2e 37/37 (report check now waits for the tab to leave about:blank). Backup `proof/demo/backup_v5.mp4`. Steps 1-6/9 detail in git log; tag `demo-safe` moves with each step.
- **Next:** step 7 rest (demo mode with debug UI hidden, ghost/heat colour pass, night shot with the nightlight), then feature freeze and `proof/demo/final.mp4`; step 8 VR with the VR team.
- **Risks:** Cosmos clip lists as "other scenario" with a magenta chair fill (layout key differs from the live as-is layout); opening the report now waits ~2 s for the fix rollouts (blank tab meanwhile); backup_v3 untracked and choppy (superseded).

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

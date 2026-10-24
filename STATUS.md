# Status

## Demo push (2026-10-24)
- **Done:** steps 1-5. Step 4: `tools/stage_demo_hazards.py` stages a 1.5 cm mat, a 5 mm cord (estimated) and chair8 pulled into the trash-can gap (1 cm/side) + hazards.json. Step 5: 200 trips on the world model (patient), hand rule alongside as amber "Hand-rule footsteps" ghosts + a baseline line in the risk panel. Contacts/month world/hand: as-is 1.12/1.22, mat removed 0.065/0.066, cord taped 1.06/1.14, chair pushed in 1.10/1.20 (6.6 cm/side), mat+cord 0/0; replans ~0.6 s. Tag `demo-safe` @ 3560912; export copied to `../Homeclear-demo-safe/kitchen4_lighter_v3`.
- **Next:** step 9 Cosmos job on hpg-b200 (worst-case night trip), then step 6 mannequin hero shot while it runs.
- **Risks:** another session's ffmpeg holds load ~15: fps measured 2-6 headless (60 unloaded before), `proof/demo/backup_v3.mp4` choppy (re-record when load drops; v2 is the clean backup), optimize timing test 21.7 s vs 20 s limit; rerun the staging tool after any re-export; chair's scanned spot shows the pink "imagined" fill; e2e not rerun.

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

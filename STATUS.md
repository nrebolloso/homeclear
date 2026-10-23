# Status

Each result counts once it is reproduced here, with proof in `proof/`.

| Spec milestone | In place | To do |
|---|---|---|
| Kitchen splat + scale + accuracy (Must) | SfM, GLOMAP + stray-camera drop, gsplat MCMC, table scale, stage 6b margins | leave-one-out over all three table dimensions; check the kitchen1 table width (BLOCKERS #1) |
| Maps + hazards (Must) | stages 5–8: floor, floater cleanup, occupancy, local-floor bumps, verdicts | coverage map export; hazards.json in the SPEC §5 shape |
| Baseline world model + rollouts (Must) | hand rule, `worldmodel/` rollout engine, contact table | 200 trips on the demo kitchen route |
| Viewer core (Must) | autoplay, free walk, live hazard checks, ghosts, fog, night mode, drag objects, tinted fills | demo route on the demo kitchen; fps check |
| Learned world model (Should) | MDN on PhysioNet, closed-loop / coverage / counterfactual / sanity tests | 20+ step rollouts; sideways spread over-confident in corners; our own walker videos |
| Mannequin + world-model visuals (Should) | – | rigged mannequin with foot IK; next-step cloud |
| Editable scene + ranked fixes (Should) | dragging, re-planning | ranked fixes panel |
| Walker physics (Should) | – | Rapier walker; real-walker validation |
| Cosmos Transfer clip (Should) | controls export, chunking, tinting, settings (edge 0.7, guidance 3) | worst-case clip of the demo kitchen |
| Cosmos Reason evaluation (Should) | – | pipeline + answer key |
| OT report (Should) | stage 11 HTML report | all SPEC §4.12 sections |

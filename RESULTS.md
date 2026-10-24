# Results

Each result goes here, linked to its proof in `proof/`.

- **Object physics, live and offline** (2026-10-24): every movable object is a Rapier body in a worker (splat follows it); a curled mat corner is detected from the mat's own splat points (the real kitchen mat shows none). A MuJoCo batch on HiPerGator (3 × 3,200 SIMULATED pushes, properties sampled from assumed ranges, the user's Drive Medical 10210-1 walker from its spec sheet) gives P(chair moved | touch) ≈ 0.85, P(tipped) ≈ 0.003, P(mat slid) ≈ 0.79–0.80, P(corner folds) ≈ 0.01, per speed and angle; the rollouts and OT report use them. Not yet checked against the real walker. [proof/physics](proof/physics/README.md)
- **Viewer features + calibrated contact table** (2026-10-23): Juan's viewer work runs alongside the world model;
  52/52 viewer tests, all Python self-checks, 24/24 headless e2e checks pass. The contact table now follows published
  toe clearance (p = 1/578 per stride at 1 cm), so every risk number before this date is on the old placeholder table.
  [proof/viewer_features](proof/viewer_features/README.md)

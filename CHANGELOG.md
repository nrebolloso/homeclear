# Changelog

Versions follow `MAJOR.MINOR.PATCH`. Each version has a git tag (`v1.0.1`, ...). Viewer scenes are not in git:
a version's scene zips are built from its tagged code and shared separately.

## 1.0.1

Scene: `kitchen4_lighter.zip` (234,485,973 bytes), unzip into `viewer/public/scene/`, open `?scene=kitchen4_lighter`.

**Movable furniture**
- Every object stage 6c detects in kitchen4 can be dragged or removed in the viewer (`game.objects: auto`): 8 chairs,
  table, rug, basket, trash can, 4 boxes, 2 bedside tables.
- Objects split by 3D connectivity, then by label inside touching pieces, so a chair against the table is its own object.
- A removed object takes its unlabelled legs, haze and what stands on it (table leftovers 4739 -> 48 Gaussians).
- Stage 12b fills the floor under moved objects (LaMa loaded once, padded output cropped).

**World model**
- Learned heel + walker model with B200 weights, in the browser with `?step=world`.

**From Juan (PR #1, `feat/rapier-physics`)**
- Rapier physics pass for the walker, wired into the game panel.
- Calibrated contact table (`tools/contact_table.py`), risk ranges, personas, vision checks, transfers, fix optimizer
  and OT report.
- Room shell, object proposals, fills, Cosmos Reason and pre-render, re-scan diff, WebXR.
- Printable scale marker, placeholder measurements, per-user cluster paths and Windows laptop setup.

**Scenes and fixes**
- Table-measured scale for kitchen3 and kitchen4; `tools/lighter_clean.py` for the `_lighter` and `_raw` scenes.
- Occupancy fills enclosed floor holes with nothing standing in them.
- Physics route follower stays with the walker.

## 0.0.1

Pipeline from phone video to OT report: frames, COLMAP/GLOMAP poses, gsplat splat, table scale, floor fit, occupancy
and bump maps, walker route planning, hazard verdicts, report and scene export. Learned next-footstep model, world
model interface and rollout engine, walker game viewer, Cosmos Transfer controls, HiPerGator Slurm jobs, synthetic
self-checks.

# Working in this repo (people and agents)

Read first: `SPEC.md` (what we build, and the hard rules: measured vs. imagined never mixed, nothing faked, "flags for
OT review"), `README.md` (stages, viewer, cluster), `STATUS.md` (what is done), `BLOCKERS.md`.

## Who owns what

Several people work in parallel. Change files you own; for anything else, ask the owner first (or open a PR they review).
Fill in the names.

| Workstream | Owner | Owns (writes) | Reads only |
|---|---|---|---|
| Object detection on the splat | TBD | `stages/06c_detect.py`, `tools/merge_labels.py`, `slurm/detect.sbatch`, `objects_proposed.yaml` | `config.*.yaml` object schema |
| Move effort + insurance / funding (see *Move-Effort Model and Insurance Feature.pdf*) | TM2 (see Teammates) | `viewer/src/effort.ts` (`moveEffort`, funding classification: Part B DMEPOS lookup, then MA SSBCI / Medicaid HCBS / VA HISA / self-pay) | `movecost.ts`, `reimagine.ts` |
| VR (WebXR) | TBD (VR team) | `viewer/src/xr.ts`, headset locomotion, controller input, XR performance | `game.reimagine` API |
| Reimagined room | Juan | `viewer/src/reimagine.ts`, the `movecost.ts` interface (types and signatures), the "Reimagined room" panel | `optimize.ts`, `movecost.ts` numbers, `xr.ts` |
| Pipeline, world model, physics, Cosmos | shared (main authors in `git log`) | `stages/`, `worldmodel/`, `motion/`, `cosmos/`, `viewer/src/physics.ts` | |

## Contracts between workstreams

- **Objects** (detection -> everyone): every object exported to `scene.json` carries `name`, `kind`, `movable`,
  `footprint`, `pivot`, `height_m`, `layer`. Move cost depends on `kind`, so never leave it empty (use `other`).
- **Move cost** (effort/insurance -> reimagine, optimizer, fix card, OT report): `viewer/src/movecost.ts`.
  ```ts
  moveCost(obj, from: Pose, to: Pose): MoveCost      // hand move or optimizer move
  removeCost(obj): MoveCost                           // take it out of the room
  fixCost(iv: Intervention): MoveCost                 // a configured fix (product, minutes, effort)
  interface MoveCost { usd; minutes; helpers; effort; funding: Funding; source: 'placeholder' | string }
  ```
  The signatures are fixed. `movecost.ts` is a thin adapter: once TM2's `effort.ts` (`moveEffort`) lands, these
  functions call it and set `source` to its name. Until then it is a placeholder that mirrors the optimizer's effort
  (`tests/reimagine.test.ts` checks the two agree). Change both together or neither.
- **Reimagine in the headset** (reimagine -> VR): `window.game.reimagine` exposes `setT(t)` (0 = as-is, 1 =
  reimagined), `play(seconds)`, `run()`, `refresh()`, `changes()`. Bind a controller button or thumbstick to these;
  don't reach into `reimagine.ts`.
- **In-headset UI is scene objects** (sprites, meshes), never DOM or `CSS2DObject`: those don't render in WebXR.

## Avoiding merge conflicts

- One branch per person off `main`. Merge `origin/main` into your branch at least daily; keep PRs small.
- New features go in their own module. `viewer/src/main.ts` (1000+ lines, everyone touches it) only gets a short hook
  block under a header like `// ---------- reimagined room (reimagine.ts) ----------`, plus one-line calls where needed.
- Append, don't reorder: new `index.html` panels, new `e2e/run.ts` checks and new `scene.json` fields go at the end of
  their section. `scene.json` changes are additive only (never rename or remove a field others read).
- Don't reformat, re-indent or reorder code you don't own. Match the surrounding style (dense lines, short comments
  saying *why*).
- Don't hand-edit generated output: `out/`, `viewer/public/scene/`, `proof/` (regenerate it instead).

## Teammates (lanes from shared sprint)

Teammates work on feature branches off `main` with their own short-lived PRs. All deliverables must pass
`npm test && npm run build` before merge. No HiPerGator, credentials, or AI attribution in code.

| Lane | Owner | Owns | Branch |
|---|---|---|---|
| Catalog fixes | TM1 | `data/fixes/costs.yaml`, `research/coverage.md` | `tm1-fix-catalog` |
| Move effort + insurance | TM2 | `viewer/src/effort.ts` (moveEffort), integrator (`tm2→tm4→tm3`) | `tm2-effort` |
| Optimization rules | TM3 | `viewer/src/rules.ts`, `optimize.ts` rules (strong-side, keep-clear, 1.5m circle, lighting) | `tm3-rules` |
| Labelling tool | TM4 | `tools/label/index.html`, `objects_labeled.yaml`, `routes_picked.yaml` | `tm4-label-tool` |

**Files no teammate edits:** `physics.ts`, `worker.ts`, `main.ts`, `index.html`, `e2e/run.ts`,
`cosmos/*`, `slurm/*`, `cluster*.yaml`, `README.md`, `BLOCKERS.md`, `MORNING_REPORT.md`, `config.bedroom.yaml`.
**Shared items** (handoff nodes): `DEMO.md`, `LIMITATIONS.md`, `SUBMISSION.md`, `SMOKE_CHECKLIST.md` (TM2 owns).

## Resolving a conflict

1. `git fetch && git merge origin/main` (merge, don't rebase shared branches).
2. **`viewer/src/main.ts` (the hard one):** hook blocks from different features are independent; keep both. If two people changed the
   same line, keep both behaviours and ask the line's owner. Recent hot files: import lines, `const xr = ...` (vision),
   `const night = ...` (night shader), physics viz (pushchart, replay, tour).
3. **`viewer/src/physics.ts`:** conflicted in PR #1 (Juan's Rapier physics → world-model wiring). Keep world-model versions
   (`step=world` in sim/evaluate). Test with `npm run build && node e2e/run.ts`.
4. **`viewer/src/evaluate.ts`, `viewer/src/sim.ts`:** same as physics.ts (keep world-model wiring).
5. **`stages/12_export_scene.py`:** add/add conflict (Juan's physics exports → main's world model). Keep world-model version
   and re-run stage 12 to regenerate `scene.json`.
6. **`tests/run_py.sh`:** take Juan's longer test list (includes hazard/route/physics tests).
7. **`config.kitchen4.yaml`:** take main's version (kitchen4 table, no physics changes).
8. **`viewer/package-lock.json`:** take `main`'s version, then `npm install` to re-add your dependency.
9. Before pushing: `cd viewer && npm test && npm run build`, then `npm run dev` and `node e2e/run.ts`. All must pass.
10. Generated files (`out/`, `public/scene/`): take either side, then re-run the stage that writes them.

# Cleared: a discharge dress rehearsal

Someone films the home with a phone before the patient is discharged. From that video we build a measured Gaussian
splat, find the floor, make occupancy and floor-bump maps, plan the patient's walker route, simulate hundreds of trips
with a learned step model, rank fixes, and write a report for the occupational therapist. See `SPEC.md` for the full product.

**Hard rule: every measurement comes from splat geometry, never from a generative model.** Generated images and fills are
tinted and labelled "imagined, not measured".

## Layout

```
stages/00_env.py ... 12_export_scene.py   one stage each: python stages/NN_x.py <config.yaml>
common.py                                 config, results/<stage>.json records, PLY I/O, floor RANSAC
run_all.sh                                whole pipeline from the laptop
config.*.yaml                             one per scene
slurm/                                    HiPerGator jobs (env build, SfM, splats, GLOMAP, motion model, renders, rug fill)
tools/table_scale.py                      scale from the tape-measured table, with width/height checks
motion/                                   learned next-footstep model (PhysioNet Multi-Gait-Posture), world-model tests
worldmodel/                               world model interface (INTERFACE.md) and Python rollout engine
cosmos/                                   Cosmos Transfer 2.5 controls, jobs, tinting
viewer/                                   walker game (Vite + TS + three.js + Spark); viewer/check.html = plain splat check
marker/make_marker.py                     ArUco scale marker
tests/                                    CPU self-checks on synthetic scenes with known answers
data/                                     footage links + data/measurements.yaml (gitignored)
proof/                                    evidence for every result: job IDs, logs, numbers, images
```

Outputs go to `out/<run_name>/`.

| Where | Stages |
|---|---|
| HiPerGator CPU job (`slurm/sfm.sbatch`, burst QOS) | 1 frames, 2 COLMAP poses |
| HiPerGator GPU job (`slurm/cluster.sbatch`, 1x B200) | 0 env, 3 splat, 4 scale, 5 floor, 6 occupancy |
| Laptop | 7 route planning, 8 hazards |
| HiPerGator GPU job (`slurm/render.sbatch`) | 9 hazard renders (gsplat has no CPU renderer) |
| Laptop | 10 viewer check, 11 report, 12 scene export |
| Laptop | 5c room shell, 12b fills (telea / ns), 14 re-scan diff |
| HiPerGator GPU jobs | 6c object proposals (`slurm/detect.sbatch`), 12b `--backends lama`, Cosmos Reason (`cosmos/slurm/cosmos_reason.sbatch`), Cosmos clips (`cosmos/prerender.py --submit`) |

More stages, all optional, each writing next to the others in `out/<run>/`:

| Stage | What | Output |
|---|---|---|
| `05c_shell.py` | walls (two perpendicular directions) + ceiling fitted to the splat; the Cosmos controls use it where the capture saw nothing | `shell.json` |
| `06c_detect.py` | Grounding DINO + SAM 2 masks voted onto the Gaussians: proposed objects/fixtures in config format, for a person to accept | `objects_proposed.yaml` |
| `12b_fills.py` | the floor (and wall) each movable object hid, inpainted: median / telea / ns (CPU), lama (GPU); imagined, tinted | `objects/fill_<name>_<backend>.ply` |
| `14_rescan_diff.py before.yaml after.yaml` | film again after the fixes: 2-D ICP alignment, each hazard resolved / remaining, new bumps on the route | `verification.json` |
| `cosmos/reason.py` | Cosmos Reason 2 on capture frames along the route, proposals lifted to 3-D and checked against the grids | `reason.json` |
| `tools/contact_table.py` | the toe-contact table, calibrated to ~1 in 578 strides at 1 cm | rewrites `contact_table` in configs |

## Versions

| Package | Version | Why |
|---|---|---|
| PyTorch | 2.14.1 + cu130 | the cu126 build has no sm_100 (B200) |
| CUDA toolkit (HPG module) | cuda/13.0.2, built with gcc/12.2.0 | matches the cu130 torch build for compiling gsplat |
| gsplat | git main @ 512d366 (reports 1.6.0) | the last PyPI release predates torch 2.14 |
| pycolmap | 4.2.1 (CPU wheel) | SfM on CPU; avoids mixing CUDA 12 and CUDA 13 runtimes |
| Viewer | see `viewer/package.json` | Spark (`@sparkjsdev/spark`) + three |

Stage 0 prints the versions it actually found, the GPU, and the driver, and checks that torch has kernels for that GPU.

## Laptop setup

Ubuntu/Mint with Python 3.12, ffmpeg, Google Chrome (headless checks), Node, and rsync.

```bash
python3 -m venv --system-site-packages .venv
.venv/bin/pip install numpy scipy opencv-python pillow plyfile pyyaml
.venv/bin/python tests/test_synthetic.py --viewer     # should end with SYNTHETIC OK
tests/run_py.sh                                       # every Python self-check, synthetic scenes first
cd viewer && npm ci && npm test && node e2e/run.ts   # e2e: headless Chrome against the dev server
```

**Windows laptop** (Git Bash): `py -3.12 -m venv .venv`, `.venv/Scripts/python -m pip install numpy scipy opencv-python
pillow plyfile pyyaml matplotlib imageio-ffmpeg` (bundles ffmpeg). Scripts find `.venv/Scripts/python` themselves
(`hpg.sh`), the e2e checks find Chrome or Edge (`CHROME=` overrides), and ssh/rsync to HiPerGator run inside WSL Ubuntu,
where the ControlMaster lives (Windows OpenSSH has none). Per-person cluster paths go in a gitignored
`cluster.local.yaml` (`cluster: {ssh, base, repo, env}`); the scripts export `HPG_ROOT` from it.

All checks: `tests/run_py.sh` (every Python self-check, stops at the first failure), `cd viewer && npm test`,
and with `npx vite --port 5179` running, `node e2e/run.ts`.

## HiPerGator

**Connect.** Add a `Host hpg` entry (HostName hpg.rc.ufl.edu, your User) to `~/.ssh/config` and export
`HPG_ROOT=/blue/<group>/<user>`, `HPG_GROUP=<group>` and `SBATCH_ACCOUNT=<group>` on the laptop and on HiPerGator.
Login is password + Duo, so open one SSH master and let the scripts reuse it (good for 12 h):

```bash
ssh -o ControlMaster=yes -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=12h -o ServerAliveInterval=30 -o ServerAliveCountMax=6 hpg
```

**Second account, someone else's built envs** (read-only through the group): `BASE_ENV=<their envs/homeclear> sbatch
slurm/extras_env.sbatch` makes an overlay venv in `$HPG_ROOT/envs/homeclear-extras` (their torch and gsplat, plus
transformers / LaMa for 06c, 12b and Reason); point `env:` at it. For Cosmos, put `COSMOS_RO=<their cosmos dir>` in
`$HPG_ROOT/cosmos/local.sh`: their container, venv and checkpoints are used read-only (offline), and outputs go to your
own `$HPG_ROOT/cosmos`. A splat from `train_best.sbatch` skips stage 3:
`STAGES="00_env 04_scale 05_floor 06_occupancy" sbatch slurm/cluster.sbatch <cfg>`.

**Env** (CPU node, about 20–40 min, mostly compiling gsplat's CUDA kernels): `sbatch slurm/setup_env.sbatch`, then
`sbatch slurm/b200_sanity.sbatch`. `slurm/fetch_public.sbatch` downloads Mip-NeRF 360 and makes `data/public_room.mp4`.

CPU-only jobs use the burst QOS (`sbatch --qos=$HPG_GROUP-b`). GPU jobs use the group QOS (shared cap), 1 GPU and 8 CPUs each.
Nothing heavy runs on the login node.

## Capturing a home

See SPEC.md §4.1. **Marker:** `python marker/make_marker.py --print` (`--a4` for A4) makes `marker/aruco_print_letter.pdf`;
print it at 100% ("Actual size"): the black square is 150 mm, and a bank card covers the box on the sheet exactly if the
printer didn't rescale (then `marker_size_m: 0.150`). No tape yet? Put estimates in `scale.ground_truth` /
`accuracy.ground_truth` with `estimated: true`: they are reported, but stage 4 says SKIP (unverified) instead of PASS, only a
gross error (> 15 %) fails it, and they never set stage 8's borderline margins (`config.myhome.yaml` is set up this way).
In short: 4K30 on the main lens, focus and exposure locked, slow walking, three heights (chest, waist
angled down, knee/floor), close orbits around floor hazards, every light on, nothing moved between clips. Tape-measure
the table (length, width, height) plus one gap and the doorway, into `data/measurements.yaml`.

## Run

```bash
./run_all.sh config.public.yaml            # public data first
./run_all.sh config.kitchen2_nofar.yaml    # a real kitchen
SKIP_CLUSTER=1 ./run_all.sh <config>       # only redo the laptop stages (e.g. after changing start/goal)
```

Read start/goal points off `out/<run>/occupancy.png` (1 m grid lines, metres in the floor frame), or hover in the viewer.

Viewer: `cd viewer && npm run dev`, then http://localhost:5179/?scene=<name> (`?step=learned` uses the learned step model).

## Walker game

`python stages/12_export_scene.py <config>` (+ `12b_fills.py`) exports a scene to `viewer/public/scene/<run>/`; then the
viewer above opens it (add `--host` to `vite` for phones on the Wi-Fi).

| Panel / control | What it does |
|---|---|
| Who | this patient, or comparisons with assumed gait: a cane, Parkinson's (shuffling, freezing at turns/doorways) |
| Route | every walk in `game.routes` (night ones get the darkness multiplier); the total covers all of them |
| Eyes | cataract / macular degeneration / glaucoma / low contrast, a post pass on the frame (visual only) |
| Toe contacts per month | expected contacts with a likely range (the measured height error + simulation noise), per route |
| A month of nights | 30 nights drawn at that rate; scrub to see where each night's contacts happen |
| Transfers, reach, emergencies | bed/toilet/chair heights vs knee height (hip precautions), switch and phone reach from the bed, grab bars, stretcher path, phone after a fall |
| Physics pass (walker) | Rapier: the walker pushed along each route over one heightfield of the measured floor; where a front wheel or glide catches, or the frame tips (push, grip and wheel sizes are assumptions, `viewer/src/physics.ts`) |
| Plan fixes | each configured fix rolled out alone: contacts saved, clearance gained, cost / minutes / product |
| Suggest layouts | the optimizer: furniture to wall or bedside slots + fixes, three options (quick / moderate / full), Apply and walk it |
| OT report / Fix card (QR) | printable report of the layout on screen; the family's checklist on a phone, pins on the map |
| Heatmap, Room shell, Re-scan check, Third person | footsteps and contacts on the floor; the fitted walls; stage 14's verdicts; a mannequin on the simulated steps |
| Imagined floor + backend | the tinted fill where moved furniture stood (median / telea / ns / lama) |
| Cosmos clips | pre-rendered clips, "this layout" first (matched by layout key); Export for Cosmos (whole route or hero chunk) |

`?xr=1` adds an Enter VR button (Quest: `adb reverse tcp:5179 tcp:5179`, then localhost). Pre-rendering a scene's
scenarios: `python cosmos/prerender.py cosmos/prerender.yaml --scene <run>` (prints the B200 time; `--submit` runs them as
one Slurm array), then `cosmos/fetch_cosmos.sh`.

## Image-edit backend (stage 9)

Stage 9 renders the real splat at each hazard ("before") and asks an image-editing model for an "after". Subclass
`ImageEditor` in `stages/09_fix_render.py`, register it in `BACKENDS`, and set `fix.backend`. The built-in `stub` backend
returns the render unchanged. Every "after" image is stamped as a visualization.

## Known shortcuts

- COLMAP assumes a single PINHOLE camera.
- When a splat is rotated, SH view-dependent colours aren't rotated. Geometry is exact; colours are slightly off in renders.
- Hazard rules are thresholds with measured margins, not a clinical model.

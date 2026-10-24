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

Ubuntu/Mint or macOS with Python 3.12, ffmpeg, Google Chrome (headless checks), Node, and rsync.

```bash
python3.12 -m venv --system-site-packages .venv
.venv/bin/pip install .                               # dependencies from pyproject.toml
.venv/bin/python tests/test_synthetic.py --viewer     # should end with SYNTHETIC OK
cd viewer && npm ci && npm test
```

## HiPerGator

**Connect.** Add a `Host hpg` entry (HostName hpg.rc.ufl.edu, your User) to `~/.ssh/config` and export
`HPG_ROOT=/blue/<group>/<user>`, `HPG_GROUP=<group>` and `SBATCH_ACCOUNT=<group>` on the laptop and on HiPerGator.
Login is password + Duo, so open one SSH master and let the scripts reuse it (good for 12 h):

```bash
ssh -o ControlMaster=yes -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=12h hpg
```

**Env** (CPU node, about 20–40 min, mostly compiling gsplat's CUDA kernels): `sbatch slurm/setup_env.sbatch`, then
`sbatch slurm/b200_sanity.sbatch`. `slurm/fetch_public.sbatch` downloads Mip-NeRF 360 and makes `data/public_room.mp4`.

CPU-only jobs use the burst QOS (`sbatch --qos=$HPG_GROUP-b`). GPU jobs use the group QOS (shared cap), 1 GPU and 8 CPUs each.
Nothing heavy runs on the login node.

## Capturing a home

See SPEC.md §4.1. In short: 4K30 on the main lens, focus and exposure locked, slow walking, three heights (chest, waist
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

## Image-edit backend (stage 9)

Stage 9 renders the real splat at each hazard ("before") and asks an image-editing model for an "after". Subclass
`ImageEditor` in `stages/09_fix_render.py`, register it in `BACKENDS`, and set `fix.backend`. The built-in `stub` backend
returns the render unchanged. Every "after" image is stamped as a visualization.

## Known shortcuts

- COLMAP assumes a single PINHOLE camera.
- When a splat is rotated, SH view-dependent colours aren't rotated. Geometry is exact; colours are slightly off in renders.
- Hazard rules are thresholds with measured margins, not a clinical model.

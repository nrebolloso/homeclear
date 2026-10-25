# Splatting on HiPerGator: what runs where, what it costs, what we learned

Phone video → frames → camera poses (SfM) → cleanup → gsplat splat → demo. Numbers below are MEASURED from Slurm
(`sacct`) and gsplat's `val_step29999.json` unless marked otherwise. PSNR is on held-out frames of the same scene: compare
runs of one scene, not scenes with each other.

## Where the time goes

| step | script | runs on | typical time (measured) |
|---|---|---|---|
| frames + SIFT features + matching | `slurm/sfm_gpu.sbatch` (stages 01, 02 with `SFM_MATCH_ONLY=1`) | **GPU** (B200, CUDA pycolmap) | 1h27 (bedroom3) - 3h15 (night1, 1200 frames exhaustive) |
| camera placing, incremental mapper | `slurm/sfm.sbatch` (`STAGES=02_poses SFM_REUSE_DB=1`) | **CPU** (burst QOS) | 3h26 (bedbath_hall), 3h42 (bedroom3), 4h40 (night2) |
| camera placing, GLOMAP global mapper | `slurm/glomap.sbatch` | CPU | 16 min (kitchen1, 600), 23 min (bedroom2, 1165), 32 min (newell_stair2, 1500) |
| GLOMAP bundle adjustment (required, see below) | `slurm/glomap_ba.sbatch` | CPU | 2.5 min (kitchen1), 1h38 (bedroom2), 2h11 (newell_stair2) |
| stray-camera cleanup | `slurm/drop_far_cams.py`, `slurm/drop_jump_blocks.py` | CPU | seconds |
| 30k-step splat | `slurm/train_best.sbatch` | GPU | 6-11 min |

Training is not the bottleneck; SfM is. Exhaustive matching grows with frames² (1200 frames ≈ 720k pairs, 2000 ≈ 2M).

## Why camera placing runs on CPU

COLMAP's incremental mapper adds one frame at a time and is CPU code. HiPerGator cancels jobs that hold a GPU without
using it (bedroom2's mapper was killed 2h21m in), so matching (GPU job) and placing (CPU job) are split, and the CPU
job reuses the GPU job's `colmap/database.db`.

The CUDA pycolmap 4.2.1 in `$HPG_ROOT/envs/colmap_gpu` does expose GPU options: `IncrementalPipelineOptions.ba_use_gpu`
(bundle adjustment only, default off) and `GlobalPositionerOptions.use_gpu` (GLOMAP, default on, used from 50 images).
They do nothing in this wheel: GLOMAP in a B200 job (kitchen1, job 47597816) logged "Requested to use GPU for bundle
adjustment, but Ceres was compiled without CUDA support ... without cuDSS support. Falling back to CPU". Placing and bundle
adjustment are CPU-only until COLMAP + Ceres are built from source with CUDA and cuDSS (not done).

## GLOMAP vs incremental: same quality, only with bundle adjustment

Same frames, same matches, same training (kitchen1):

| poses | PSNR | SSIM | LPIPS |
|---|---|---|---|
| incremental (`kitchen1_dv`) | 28.49 | 0.908 | 0.203 |
| GLOMAP raw (`kitchen1_dv_glomap`) | 14.58 | 0.731 | 0.678 |
| GLOMAP + `glomap_ba.sbatch` (`kitchen1_dv_glomap_ba`) | 28.48 | 0.908 | 0.202 |

- Never train on raw GLOMAP poses; always run `glomap_ba.sbatch` first.
- GLOMAP placed more frames where incremental split: newell_stair2 1393/1500 in one model vs 789 for incremental.
  bedroom2: 1120/1165 (3 models) while the incremental run was killed at 1050.
- Speed: GLOMAP mapping is 4-6x faster, but its CPU bundle adjustment took 1h38-2h11 on 1165-1500 frames, so GLOMAP + BA
  on CPU is about 2h vs 3.5h for incremental. Not the big win the mapping time alone suggests; GPU BA is what the open
  test checks.
- Only kitchen1 (600 frames) has the equal-quality result; it has not been repeated on a large scene.

## Training strategy: `STRATEGY=default` unless proven otherwise

gsplat MCMC (1M Gaussian cap) vs the default strategy, same poses:

| scene | MCMC PSNR | default PSNR |
|---|---|---|
| newell_stair2 | 16.22 | 27.53 |
| newell_stair2 (no jump blocks) | 11.85 | 25.62 |
| bedroom3 | 10.79 | 21.25 |
| night2 | 24.88 | 24.72 |
| gator_lounge | 10.20 (loss rose from step 2.7k) | |

MCMC collapses on some scenes and never clearly beat default; new scenes use `CAM_FACTOR=1 STRATEGY=default`. The demo
kitchen (`kitchen4_gpu_best`, MCMC, 28.74) predates this and is unchanged.

## Cleanup before training

- `drop_far_cams.py`: drops cameras more than 3x the p90 radius out. One stray GLOMAP camera blew kitchen1's
  scene_scale from 2.2 to 12 and the splat never fit.
- `drop_jump_blocks.py`: drops stretches SfM placed at a fixed offset (repeated furniture matched to the wrong copy).
  This was gator_lounge's "two trash cans".

## Gotchas

- SQLite on /blue (network FS) can SIGBUS: stage 02 and the GLOMAP jobs copy `database.db` to node-local `$TMPDIR`.
- FAISS + OpenBLAS overflow the thread table on 64-core nodes: `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1`, `--cpus-per-task=16`.
- CPU jobs: `--qos=dream_team-b --partition=hpg-default`. GPU only through Slurm (`hpg-b200`).
- Long repetitive scenes (hallways) get exhaustive matching on purpose; sequential/vocab-tree matching risks wrong loops.

## Standard chain (as submitted for kitchen5)

```
m=$(sbatch --parsable --time=08:00:00 slurm/sfm_gpu.sbatch configs/<scene>.yaml)                       # GPU match
p=$(sbatch --parsable --dependency=afterok:$m --qos=dream_team-b --time=10:00:00 \
    --export=ALL,STAGES=02_poses,SFM_REUSE_DB=1 slurm/sfm.sbatch configs/<scene>.yaml)                  # CPU place
d=$(sbatch ... --dependency=afterok:$p --wrap "python slurm/drop_far_cams.py ... && python slurm/drop_jump_blocks.py ...")
b=$(sbatch --parsable --dependency=afterok:$d --export=ALL,CAM_FACTOR=1,STRATEGY=default \
    slurm/train_best.sbatch $HPG_ROOT/datasets/<scene> <scene>_best)                                  # GPU splat
```

GLOMAP alternative after `$m`: `sbatch --dependency=afterok:$m --qos=dream_team-b slurm/glomap.sbatch <scene>`, then
`slurm/glomap_ba.sbatch <scene>`, then the cleanup and `train_best.sbatch` on `$HPG_ROOT/datasets/<scene>_glomap_ba`.

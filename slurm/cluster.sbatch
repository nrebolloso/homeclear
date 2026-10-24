#!/bin/bash
#SBATCH --job-name=hc-gpu
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4    # GPU jobs share the group's 32 CPU / 4 GPU cap: ask for little
#SBATCH --mem=32gb
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# GPU-side stages 0, 3-6: env check, splat, scale, floor, occupancy (1-2 run first in sfm.sbatch).
# Usage: sbatch slurm/cluster.sbatch <config.yaml>   (stops at the first FAIL; each stage records results/<stage>.json)
# STAGES="00_env 04_scale 05_floor 06_occupancy" sbatch ... when splat.ply + cameras.json come from train_best.sbatch
source slurm/env.sh
CFG=${1:-config.yaml}
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
for s in ${STAGES:-00_env 03_splat 04_scale 05_floor 06_occupancy}; do
  python stages/$s.py "$CFG" || { echo "stopping after $s FAILED"; exit 1; }
done

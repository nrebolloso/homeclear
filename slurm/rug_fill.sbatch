#!/bin/bash
#SBATCH --job-name=hc-rugfill
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96gb   # Qwen-Image-Edit-2511 bf16 (~54 GB on disk) loads through host RAM
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# Imagined floor under the rug (slurm/rug_fill.py): IMAGINED, NOT MEASURED.
#   sbatch slurm/rug_fill.sbatch <splat_aligned.ply> <fill_rug.ply> <out dir> [seeds]
set -euo pipefail
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
export HF_HOME=$HPG_ROOT/hf HF_HUB_OFFLINE=1
python slurm/rug_fill.py "$@"

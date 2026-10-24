#!/bin/bash
#SBATCH --job-name=hc-worldmodel
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16gb
#SBATCH --time=00:30:00   # CPU dry run: 32 s training + ~1 min evaluation
#SBATCH --output=logs/%x-%j.log
# Learned world model (worldmodel/learned.py): train on Multi-Gait-Posture samples (built by worldmodel/gait.py),
# evaluate vs the hand rule on held-out participants, export learned.npz + learned.onnx.
# Runs from its own copy of the code (WM_DIR), not the shared repo checkout. onnx comes from $WM_DIR/pylib (pip --target).
set -euo pipefail
WM_DIR=${WM_DIR:-$HPG_ROOT/hc-worldmodel}
cd $WM_DIR
source slurm/env.sh
export PYTHONPATH=$WM_DIR/pylib
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
time python worldmodel/train.py data/samples.npz out/worldmodel

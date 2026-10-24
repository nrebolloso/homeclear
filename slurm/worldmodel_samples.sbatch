#!/bin/bash
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS)
#SBATCH --job-name=hc-wm-samples --cpus-per-task=4 --mem=16gb --time=01:00:00 --output=logs/%x-%j.log
# World-model samples (heel/walker/route) from the fetched Multi-Gait-Posture data -> data/samples.npz, then slurm/worldmodel.sbatch trains on it.
# Runs from its own copy of the code (WM_DIR), like worldmodel.sbatch.
set -euo pipefail
WM_DIR=${WM_DIR:-$HPG_ROOT/hc-worldmodel}
cd $WM_DIR
source slurm/env.sh
mkdir -p data
time python -I worldmodel/gait.py ${DS:-$HPG_ROOT/datasets/multi-gait-posture} data/samples.npz

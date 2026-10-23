#!/bin/bash
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS)
#SBATCH --job-name=hc-gaitdl --cpus-per-task=2 --mem=4gb --time=03:00:00 --output=logs/%x-%j.log
# Download PhysioNet Multi-Gait-Posture (skeletons + Xsens CSVs, no depth) to /blue: sbatch slurm/fetch_gait.sbatch
set -euo pipefail
R=$HPG_ROOT/Homeclear; cd $R
python3 motion/fetch_gait.py $HPG_ROOT/datasets/multi-gait-posture
du -sh $HPG_ROOT/datasets/multi-gait-posture/*

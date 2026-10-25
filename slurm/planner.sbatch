#!/bin/bash
#SBATCH --job-name=hc-planner
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64gb
#SBATCH --time=03:00:00   # budget cap; 128 chains x 800 steps
#SBATCH --output=logs/%x-%j.log
# Kitchen planner search (planner/search.py): simulated annealing over layouts, plans on 8 CPU workers (the group QOS caps CPUs at 32 across all its GPU jobs), world-model
# rollouts batched on the GPU. Writes out/planner/<scene>/search.json (replay, Pareto, stats) + evals.jsonl (critic data).
# Runs from its own copy of the code (PL_DIR): planner/, configs/planner, physics/batch_results.json, viewer/public/{scene,models}.
set -euo pipefail
PL_DIR=${PL_DIR:-$HPG_ROOT/hc-planner}
cd $PL_DIR
source slurm/env.sh
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
time python -m planner.search --scene ${SCENE:-kitchen4_lighter} --workers 8 "$@"

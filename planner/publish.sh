#!/usr/bin/env bash
# Copy a finished search + critic (out/planner/<scene>/, from slurm/planner.sbatch then planner/critic.py) to the viewer.
#   planner/publish.sh [scene] [out dir]
set -euo pipefail
cd "$(dirname "$0")/.."
SCENE=${1:-kitchen4_lighter}; SRC=${2:-out/planner/$SCENE}
mkdir -p viewer/public/planner/$SCENE
cp $SRC/search.json $SRC/critic.json $SRC/critic_eval.json viewer/public/planner/$SCENE/
ls -la viewer/public/planner/$SCENE

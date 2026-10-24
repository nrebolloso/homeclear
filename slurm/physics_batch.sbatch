#!/bin/bash
#SBATCH --job-name=hc-physics
#SBATCH --qos=dream_team-b
#SBATCH --cpus-per-task=1
#SBATCH --mem=2gb
#SBATCH --time=01:00:00   # 300 trials at ~0.35 s each (laptop) = ~2 min
#SBATCH --array=0-31
#SBATCH --output=logs/%x-%A_%a.log
# Offline physics batch (physics/batch_mujoco.py, MuJoCo on CPU, no GPU needed): each array task runs TRIALS walker
# pushes with its own seed. Summarise afterwards: python physics/batch_mujoco.py summarize out/physics/shard_*.csv --out ...
# Runs from its own copy of the code (PH_DIR), not the shared repo checkout. mujoco comes from $PH_DIR/pylib (pip --target).
set -euo pipefail
PH_DIR=${PH_DIR:-$HPG_ROOT/hc-physics}
cd $PH_DIR
source slurm/env.sh
export PYTHONPATH=$PH_DIR/pylib
python physics/batch_mujoco.py run --scene physics/batch_scene_${RUN:-kitchen4_lighter}.json --trials ${TRIALS:-300} \
  --seed $((SLURM_ARRAY_TASK_ID + 1)) --out out/physics/shard_${SLURM_ARRAY_TASK_ID}.csv

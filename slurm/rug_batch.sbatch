#!/bin/bash
#SBATCH --job-name=hc-rug
#SBATCH --qos=dream_team-b
#SBATCH --cpus-per-task=4
#SBATCH --mem=4gb
#SBATCH --time=00:45:00   # 40 trials at ~7 s each (laptop) over 4 CPUs = ~70 s
#SBATCH --array=0-49
#SBATCH --output=logs/%x-%A_%a.log
# Cloth-rug batch (physics/rug_calib.py batch, MuJoCo on CPU): array task K runs N paired draws per direction in every
# BATCH_ARMS arm. Summarise afterwards: python physics/rug_calib.py summarize out/rug_batch
# Runs from its own copy of the code (RUG_DIR); mujoco comes from hc-physics' pylib (pip --target).
set -euo pipefail
RUG_DIR=${RUG_DIR:-$HPG_ROOT/hc-rug}
cd $RUG_DIR
source slurm/env.sh
export PYTHONPATH=$HPG_ROOT/hc-physics/pylib
python physics/rug_calib.py batch $SLURM_ARRAY_TASK_ID ${N:-4} out/rug_batch

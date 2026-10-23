#!/bin/bash
#SBATCH --job-name=cosmos-download
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# Step 3: checkpoints -> /blue. Needs `hf auth login` done once on the login node (token in ~/.cache/huggingface/token).
set -uo pipefail
cd $HPG_ROOT/cosmos && source env.sh
ct "RESULT=$C/results/download.json python $C/prefetch.py"

#!/bin/bash
#SBATCH --job-name=cosmos-example
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb   # peak RSS 18 GB
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# Step 4: the repo's own known-good edge example (precomputed edge control, robot_input.mp4). Guardrails stay on (model license).
set -uo pipefail
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
run_infer example_edge assets/robot_example/edge/robot_edge_spec.json

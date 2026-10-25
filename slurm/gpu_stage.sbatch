#!/bin/bash
#SBATCH --job-name=dr-stage
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# One stage that wants a GPU but has no job of its own, e.g. the LaMa fills:
#   sbatch slurm/gpu_stage.sbatch 12b_fills configs/bedroom.yaml --backends telea,ns,lama
set -uo pipefail
S=$1; shift
cd $HPG_ROOT/Homeclear && source slurm/env.sh
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
t0=$(date +%s)
python stages/$S.py "$@"; rc=$?
echo "stage=$S rc=$rc wall_s=$(( $(date +%s) - t0 ))"
exit $rc

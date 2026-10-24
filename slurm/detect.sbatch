#!/bin/bash
#SBATCH --job-name=hc-detect
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# Stage 6c: Grounding DINO + SAM 2 on the capture frames -> <work>/objects_proposed.yaml (proposals, not config).
#   sbatch slurm/detect.sbatch <config.yaml> [--frames 60]          (needs stages 2-5c; pinned model revisions in 06c)
set -uo pipefail
CFG=$1; shift
cd $HPG_ROOT/Homeclear && source slurm/env.sh
export HF_HOME=${HF_HOME:-$HPG_ROOT/hf}
export HF_TOKEN_PATH=${HF_TOKEN_PATH:-$HOME/.cache/huggingface/token}   # models on /blue, the token where `hf auth login` put it
python -c "from transformers import Sam2Model, AutoModelForZeroShotObjectDetection" \
  || { echo "env $ENV lacks transformers 4.57.6: run slurm/extras_env.sbatch, point cluster.local.yaml env at it"; exit 1; }
python stages/06c_detect.py $CFG "$@"

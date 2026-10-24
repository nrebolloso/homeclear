#!/bin/bash
#SBATCH --job-name=cosmos-reason
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48gb
#SBATCH --time=01:30:00
#SBATCH --output=logs/%x-%j.log
# Cosmos Reason 2 hazard proposals on the capture frames along the route, lifted to 3-D and checked against the grids.
#   sbatch cosmos/slurm/cosmos_reason.sbatch <config.yaml> [--frames 24]        (from the repo dir on HiPerGator)
# Needs: stages 5-7 done for that config, and the Cosmos-Reason2-8B licence accepted on Hugging Face (BLOCKERS.md);
# the token is wherever `hf auth login` put it, nothing here reads or stores it.
set -uo pipefail
CFG=$1; shift
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
export HF_HOME=${HF_HOME:-$HPG_ROOT/hf}
export HF_TOKEN_PATH=${HF_TOKEN_PATH:-$HOME/.cache/huggingface/token}   # models on /blue, the token where `hf auth login` put it
# transformers with Qwen3-VL (Cosmos Reason 2's base): in the pipeline env or its overlay (slurm/extras_env.sbatch)
python -c "import transformers, accelerate; from transformers import Qwen3VLForConditionalGeneration" \
  || { echo "env $ENV lacks transformers 4.57.6: run slurm/extras_env.sbatch, point cluster.local.yaml env at it"; exit 1; }
t0=$(date +%s)
python cosmos/reason.py $CFG "$@" || exit 1
echo "reason_s=$(( $(date +%s) - t0 ))"
WORK=$(python -c "import sys; sys.path.insert(0, '.'); from common import load_cfg; print(load_cfg('$CFG')['work'])")
mkdir -p proof/reason && cp $WORK/reason.json proof/reason/reason_$(basename $WORK).json

#!/bin/bash
#SBATCH --job-name=hc-motion
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=2
#SBATCH --mem=8gb
#SBATCH --time=00:20:00   # training took 34 s
#SBATCH --output=logs/%x-%j.log
# Learned step model: footstep samples from Multi-Gait-Posture (CPU), then MDN training + held-out evaluation (B200).
set -euo pipefail
cd $HPG_ROOT/Homeclear
source slurm/env.sh
DS=$HPG_ROOT/datasets/multi-gait-posture
OUT=out/motion
mkdir -p $OUT
pip install -q pandas matplotlib   # no-op once setup_env.sbatch has them
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
time python -I motion/gait_data.py $DS $OUT/samples.npz
cat $OUT/samples.trials.csv
time python -I motion/train_eval.py $OUT/samples.npz $OUT

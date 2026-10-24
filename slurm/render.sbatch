#!/bin/bash
#SBATCH --job-name=hc-render
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb
#SBATCH --time=00:30:00
#SBATCH --output=logs/%x-%j.log
# Stage 9: render the splat at each hazard (gsplat needs CUDA) and run the image-edit backend.
source slurm/env.sh
python stages/09_fix_render.py "${1:-configs/home.yaml}"

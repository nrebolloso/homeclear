#!/bin/bash
#SBATCH --job-name=cosmos-prerender
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb
#SBATCH --time=04:00:00
#SBATCH --output=logs/%x-%A_%a.log
# One task of a pre-render array: line SLURM_ARRAY_TASK_ID of viewer/public/exports/<list> is an export job; run it
# exactly as a single "Export for Cosmos" job (render controls, Transfer per chunk, stitch, tint, clip metadata).
#   sbatch --array=0-<n-1>%2 slurm/cosmos_prerender.sbatch prerender_<scene>.txt      (cosmos/prerender.py --submit)
set -uo pipefail
LIST=$HPG_ROOT/Homeclear/viewer/public/exports/$1
JOB=$(sed -n "$(( SLURM_ARRAY_TASK_ID + 1 ))p" "$LIST")
[ -n "$JOB" ] || { echo "no line $SLURM_ARRAY_TASK_ID in $LIST"; exit 1; }
echo "array task $SLURM_ARRAY_TASK_ID: $JOB"
exec bash $HPG_ROOT/cosmos/slurm/cosmos_job.sbatch "$JOB"

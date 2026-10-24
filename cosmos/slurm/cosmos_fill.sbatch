#!/bin/bash
#SBATCH --job-name=cosmos-fill
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48gb
#SBATCH --time=01:30:00
#SBATCH --output=logs/%x-%j.log
# The floor a movable object hid, imagined by Cosmos Transfer from an orbit around its spot, then projected back onto the
# stage 12b fill Gaussians (colours only):  sbatch slurm/cosmos_fill.sbatch <scene> <object>   (from the cosmos dir)
# One 93-frame chunk: ~7.5 min in all on a B200 (the lift is CPU, ~1 min). Output: objects/fill_<object>_cosmos.ply (imagined).
set -uo pipefail
SCENE=$1 OBJ=$2
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
python cosmos/fill_object.py render $SCENE $OBJ || exit 1
SPEC=$R/viewer/public/scene/$SCENE/cosmos_fill/$OBJ/spec.json
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
run_infer fill_${SCENE}_${OBJ} $SPEC || exit 1
MP4=$(ls $C/outputs/fill_${SCENE}_${OBJ}/*.mp4 | grep -v control | head -1)
cd $R && source slurm/env.sh && python cosmos/fill_object.py lift $SCENE $OBJ $MP4

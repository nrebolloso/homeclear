#!/bin/bash
#SBATCH --job-name=cosmos-splat
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb   # peak RSS 18 GB
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# Cosmos on the splat: render RGB + depth + seg along the stage-7 walker route from the splat (pipeline env, gsplat),
# then Cosmos Transfer twice: the route at 3 AM, and the route with the nearest furniture moved (revealed floor imagined).
#   sbatch slurm/cosmos_splat.sbatch [config.yaml]        (needs stages 5-7 done for that config)
# RENDER_ONLY=1 stops after the renders (tests the splat side without Cosmos).
set -uo pipefail
CFG=${1:-config.yaml}
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh && python cosmos/render_route.py $CFG || exit 1
WORK=$(python -c "import sys; sys.path.insert(0, '.'); from common import load_cfg; print(load_cfg('$CFG')['work'])")
[ -n "${RENDER_ONLY:-}" ] && exit 0
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
run_infer route_night $WORK/route/route_night_spec.json; rc1=$?
run_infer route_moved $WORK/route/route_moved_spec.json; rc2=$?
pick() { python -c "import json; o = json.load(open('$C/results/$1.json'))['outputs']; print(o[0] if o else '')"; }
a=$(pick route_night); [ -n "$a" ] && python $R/cosmos/tint.py $a $C/outputs/route_night/route_night_labeled.mp4
b=$(pick route_moved); [ -n "$b" ] && python $R/cosmos/tint.py $b $C/outputs/route_moved/route_moved_labeled.mp4 $WORK/route/route_moved_mask.mp4
exit $(( rc1 || rc2 ))

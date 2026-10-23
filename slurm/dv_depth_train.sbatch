#!/bin/bash
#SBATCH --job-name=hc-dv
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48gb
#SBATCH --time=03:00:00
#SBATCH --output=logs/%x-%j.log
# Deja View style depth-guided splat (VISUALS ONLY until its maps are checked against the plain splat):
# Depth Anything V2 maps for every frame, then train_best.sbatch's MCMC run with a tile-correlation mono-depth term and SH
# degree 1 (Deja View's room recipe: degree 3 mottled white walls in their viewer); see slurm/dv_train.py.
#   sbatch slurm/dv_depth_train.sbatch <colmap dir> <run>   -> out/<run>/{splat.ply,cameras.json,gsplat/}, depth maps in <colmap dir>/dv_depth
#   APP_OPT=1: per-photo brightness correction (gsplat --app_opt); the PLY bakes the neutral look, view-independent colours
#   EXTRA="...": more simple_trainer flags, e.g. "--post_processing bilateral_grid" (per-frame colour/exposure, gsplat's own
#   lib_bilagrid; held-out views render uncorrected) or "--antialiased"
#   Depth maps are made once per data dir: runs on the same data must not start together (chain them with --dependency).
set -euo pipefail
DATA=$1; RUN=$2
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
export HF_HOME=$HPG_ROOT/hf HF_HUB_OFFLINE=1   # models pre-downloaded by the hc-hf-dl job
GS=$R/third_party/gsplat; W=$R/out/$RUN; mkdir -p $W
[[ "${EXTRA:-}" == *bilateral_grid* ]] && { python -c "import tensorly" 2>/dev/null || pip install -q tensorly; }   # lib_bilagrid's one extra dep (gsplat examples/requirements.txt)
t0=$(date +%s)
[ -d $DATA/dv_depth ] || (cd $GS/examples && PYTHONPATH=. python $R/slurm/dv_depth.py $DATA $DATA/dv_depth.tmp && mv $DATA/dv_depth.tmp $DATA/dv_depth)
echo "depth_s=$(( $(date +%s) - t0 ))"
S=30000; L=$((S - 1))
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -l 5 > $W/gpu_mem.log &
SMI=$!
t0=$(date +%s)
(cd $GS/examples && MONO_DEPTH_DIR=$DATA/dv_depth python $R/slurm/dv_train.py mcmc --disable_viewer --data_factor 1 --strategy.cap-max 1000000 \
   --depth_loss --depth_lambda 0.1 --sh_degree 1 ${APP_OPT:+--app_opt} ${EXTRA:-} --max_steps $S --eval_steps $S --save_steps $S --save_ply --ply_steps $S \
   --render_traj_path ellipse --data_dir $DATA --result_dir $W/gsplat)
echo "train_s=$(( $(date +%s) - t0 )) peak_vram_mib=$(sort -n $W/gpu_mem.log | tail -1)"
kill $SMI
cp $W/gsplat/ply/point_cloud_$L.ply $W/splat.ply
(cd $GS/examples && PYTHONPATH=. python $R/slurm/gsplat_cameras.py $DATA $W/cameras.json 1)
cat $W/gsplat/stats/val_step$L.json

#!/bin/bash
#SBATCH --job-name=hc-best
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48gb   # peak RSS 21.6 GB (2DGS room)
#SBATCH --time=03:00:00   # longest run 26 min
#SBATCH --output=logs/%x-%j.log
# Best-quality splat for the visuals: gsplat's own examples/simple_trainer.py, MCMC strategy, 30k steps,
# full resolution (data_factor 1), 1M Gaussian cap (gsplat's mcmc benchmark setting; keeps the browser at 30+ fps).
#   sbatch slurm/train_best.sbatch <colmap_dir with images/ + sparse/0> <run>   -> out/<run>/{splat.ply,cameras.json,gsplat/}
# MODE=2dgs (sbatch --export=ALL,MODE=2dgs ...): gsplat's 2DGS trainer instead (flat surfels, sharper surfaces), for
# measurement next to the 3DGS splat for visuals. Same data, same normalised world frame, so the two compare directly.
set -euo pipefail
DATA=$1; RUN=$2
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
W=$R/out/$RUN; mkdir -p $W
GS=$R/third_party/gsplat   # examples/ at the same commit as the installed gsplat wheel
[ -d $GS ] || { git clone -q https://github.com/nerfstudio-project/gsplat.git $GS && git -C $GS checkout -q 512d366b67073d77ca099ede742683c165dfc23b; }
# examples' extra deps (examples/requirements.txt), torch pinned so pip can't swap the cu130 build
pip install -q torch==2.14.1 torchvision --index-url https://download.pytorch.org/whl/cu130
pip install -q torch==2.14.1 tyro viser "nerfview @ git+https://github.com/nerfstudio-project/nerfview@4538024fe0d15fd1a0e4d760f3695fc44ca72787" \
  "imageio[ffmpeg]" torchmetrics==1.8.2 tensorboard scikit-learn matplotlib piexif splines tqdm typing_extensions
TORCH_CUDA_ARCH_LIST=10.0 pip install -q --no-build-isolation "git+https://github.com/rahul-goel/fused-ssim@a7c48d6dd7ac6dc39a7958c7c4452e0b10418f38" \
  || echo "fused-ssim build failed: gsplat falls back to its torch SSIM"
python -c "import torch; print(torch.__version__, torch.cuda.get_device_name(0))"
S=${STEPS:-30000}; L=$((S - 1))   # STEPS/CAP override for a higher-detail run (sbatch --export=ALL,STEPS=60000,CAP=3000000)
# STRATEGY=default (no Gaussian cap) / EXTRA="--means_lr 8e-5 ...": the MCMC run collapsed on gator_lounge (PSNR 10, loss up from step 2.7k)
ST=${STRATEGY:-mcmc}; CAPARG=(); [ $ST = mcmc ] && CAPARG=(--strategy.cap-max ${CAP:-1000000})
CMD=(python $GS/examples/simple_trainer.py $ST --disable_viewer --data_factor 1 "${CAPARG[@]}"
     --max_steps $S --eval_steps $S --save_steps $S --save_ply --ply_steps $S
     --render_traj_path ellipse --data_dir $DATA --result_dir $W/gsplat ${EXTRA:-})
[ "${MODE:-3dgs}" = 2dgs ] && python $R/slurm/patch_gsplat_2dgs.py
[ "${MODE:-3dgs}" = 2dgs ] && CMD=(python $GS/examples/simple_trainer_2dgs.py --disable_viewer --data_factor 1
     --max_steps $S --eval_steps $S --save_steps $S --data_dir $DATA --result_dir $W/gsplat)
echo "cmd: ${CMD[*]}"
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -l 5 > $W/gpu_mem.log &
SMI=$!
t0=$(date +%s)
(cd $GS/examples && "${CMD[@]}")
echo "train_s=$(( $(date +%s) - t0 )) peak_vram_mib=$(sort -n $W/gpu_mem.log | tail -1)"
kill $SMI
if [ "${MODE:-3dgs}" = 2dgs ]; then python $R/slurm/ckpt_to_ply.py $W/gsplat/ckpts/ckpt_$L.pt $W/splat.ply   # 2DGS saves no PLY
else cp $W/gsplat/ply/point_cloud_$L.ply $W/splat.ply; fi
# cameras in the trainer's normalised world frame (the frame splat.ply is in), for stages 4-12
(cd $GS/examples && PYTHONPATH=. python $R/slurm/gsplat_cameras.py $DATA $W/cameras.json ${CAM_FACTOR:-4})   # CAM_FACTOR=1 for phone-video frames
cat $W/gsplat/stats/val_step$L.json
ls -la $W/splat.ply

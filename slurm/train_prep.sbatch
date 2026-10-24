#!/bin/bash
#SBATCH --job-name=hc-trainprep
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=48gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# One-time setup for slurm/train_best.sbatch: the gsplat examples checkout and the extra pip installs, done once so
# several train_best jobs started together don't race on the same clone and site-packages. fused-ssim compiles with nvcc
# only (no GPU needed). Same pins as train_best.sbatch.
#   sbatch --qos=$HPG_GROUP-b slurm/train_prep.sbatch
set -euo pipefail
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
GS=$R/third_party/gsplat
[ -d $GS ] || { git clone -q https://github.com/nerfstudio-project/gsplat.git $GS && git -C $GS checkout -q 512d366b67073d77ca099ede742683c165dfc23b; }
pip install -q torch==2.14.1 torchvision --index-url https://download.pytorch.org/whl/cu130
pip install -q torch==2.14.1 tyro viser "nerfview @ git+https://github.com/nerfstudio-project/nerfview@4538024fe0d15fd1a0e4d760f3695fc44ca72787" \
  "imageio[ffmpeg]" torchmetrics==1.8.2 tensorboard scikit-learn matplotlib piexif splines tqdm typing_extensions
TORCH_CUDA_ARCH_LIST=10.0 MAX_JOBS=$SLURM_CPUS_PER_TASK pip install -q --no-build-isolation "git+https://github.com/rahul-goel/fused-ssim@a7c48d6dd7ac6dc39a7958c7c4452e0b10418f38" \
  || echo "fused-ssim build failed: gsplat falls back to its torch SSIM"
python -c "import torch, gsplat, tyro, torchmetrics; print('prep OK', torch.__version__, gsplat.__version__)"
python -c "import fused_ssim; print('fused_ssim OK')" || true

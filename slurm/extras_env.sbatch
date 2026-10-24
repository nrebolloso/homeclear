#!/bin/bash
#SBATCH --job-name=dr-extras
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS)
#SBATCH --cpus-per-task=4
#SBATCH --mem=16gb
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# An overlay venv on top of a read-only pipeline env (someone else's envs/homeclear): their torch/gsplat/pycolmap,
# plus the extras the newer stages need (06c detect, 12b lama, cosmos/reason.py), installed here instead of into theirs.
#   BASE_ENV=/blue/.../envs/homeclear sbatch slurm/extras_env.sbatch      -> $HPG_ROOT/envs/homeclear-extras
# Then point cluster.local.yaml's env at the overlay.
set -euo pipefail
cd $HPG_ROOT/Homeclear
module load gcc/12.2.0 cuda/13.0.2 conda
BASE_ENV=${BASE_ENV:-$HPG_ROOT/envs/homeclear}
OV=$HPG_ROOT/envs/homeclear-extras
[ -x $OV/bin/python ] || $BASE_ENV/bin/python -m venv --system-site-packages $OV
export PIP_CACHE_DIR=$HPG_ROOT/cache/pip
# torch stays the base env's cu130 build: list it as a constraint so nothing swaps it
$BASE_ENV/bin/python -c "import torch; print(f'torch=={torch.__version__}')" > $OV/constraints.txt
$OV/bin/pip install -q -c $OV/constraints.txt "transformers==4.57.6" "accelerate==1.10.1" "fire==0.7.1"
# simple-lama-inpainting pins an old pillow; its code only needs torch, numpy, pillow, fire
$OV/bin/pip install -q --no-deps "simple-lama-inpainting==0.1.2"
$OV/bin/python - <<'PY'
import torch, gsplat, pycolmap, transformers, accelerate, simple_lama_inpainting, cv2
from transformers import Sam2Model, AutoModelForZeroShotObjectDetection, Qwen3VLForConditionalGeneration
print("torch", torch.__version__, "gsplat", gsplat.__version__, "transformers", transformers.__version__, "OK")
PY

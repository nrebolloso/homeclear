#!/bin/bash
#SBATCH --job-name=hc-setup
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=48gb
#SBATCH --time=06:00:00   # gsplat's largest kernel file alone takes ~1.7 h under nvcc 13 for two archs
#SBATCH --output=logs/%x-%j.log
# One-time env build. A CPU node is enough: gsplat's CUDA kernels compile with nvcc, no GPU needed.
# Kernels are built for L4 (sm_89) and B200 (sm_100); stage 0 then checks them on a real GPU.
set -euo pipefail
source slurm/env.sh
[ -x "$ENV/bin/python" ] || conda create -y -p "$ENV" python=3.12
pip install -U pip setuptools wheel
pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cu130   # cu130 has sm_100 (cu126 does not)
pip install numpy scipy pillow plyfile pyyaml opencv-python-headless pycolmap==4.2.1 ninja jaxtyping rich nvtx pandas matplotlib   # pandas+matplotlib: motion/
TORCH_CUDA_ARCH_LIST="8.9;10.0" MAX_JOBS=$SLURM_CPUS_PER_TASK \
  pip install --no-build-isolation "gsplat @ git+https://github.com/nerfstudio-project/gsplat.git@512d366b67073d77ca099ede742683c165dfc23b"
python -c "import torch, gsplat, pycolmap, cv2; print('torch', torch.__version__, torch.version.cuda, torch.cuda.get_arch_list()); print('gsplat', gsplat.__version__, 'pycolmap', pycolmap.__version__, 'cv2', cv2.__version__)"

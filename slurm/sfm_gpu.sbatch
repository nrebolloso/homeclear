#!/bin/bash
#SBATCH --job-name=hc-sfm-gpu
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=16   # SIFT + matching run on the GPU; the incremental mapper is still CPU
#SBATCH --mem=96gb
#SBATCH --time=06:00:00
#SBATCH --output=logs/%x-%j.log
# Stages 1-2 like sfm.sbatch, with SIFT extraction + matching on the GPU: same stages/02_poses.py, run from a venv whose
# pycolmap is the CUDA wheel (pycolmap-cuda12, same version as the CPU one), so Device.auto picks CUDA.
#   one-time: python -m venv --system-site-packages $HPG_ROOT/envs/colmap_gpu && $HPG_ROOT/envs/colmap_gpu/bin/pip install pycolmap-cuda12==4.2.1
# Usage: sbatch slurm/sfm_gpu.sbatch <config.yaml>
export ENV=$HPG_ROOT/envs/colmap_gpu
source slurm/env.sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1   # same FAISS/OpenBLAS thread-table crash guard as sfm.sbatch
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
python -c "import pycolmap; assert pycolmap.has_cuda, 'pycolmap in $ENV is the CPU build'; print('pycolmap', pycolmap.__version__, 'cuda')" || exit 1
CFG=${1:-config.yaml}
for s in 01_frames 02_poses; do
  python stages/$s.py "$CFG" || { echo "stopping after $s FAILED"; exit 1; }
done

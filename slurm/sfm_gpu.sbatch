#!/bin/bash
#SBATCH --job-name=hc-sfm-gpu
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=16
#SBATCH --mem=96gb
#SBATCH --time=03:00:00
#SBATCH --output=logs/%x-%j.log
# Stages 1-2 like sfm.sbatch, with SIFT extraction + matching on the GPU: same stages/02_poses.py, run from a venv whose
# pycolmap is the CUDA wheel (pycolmap-cuda12, same version as the CPU one), so Device.auto picks CUDA.
#   one-time: python -m venv --system-site-packages $HPG_ROOT/envs/colmap_gpu && $HPG_ROOT/envs/colmap_gpu/bin/pip install pycolmap-cuda12==4.2.1
# The incremental mapper is CPU-only and HiPerGator cancels jobs that leave an allocated GPU idle (bedroom2, 2h21m in), so this
# job stops after matching (stage 2 SKIP, colmap/database.db saved) and a CPU job in the burst QOS maps it:
#   m=$(sbatch --parsable slurm/sfm_gpu.sbatch <cfg>)
#   sbatch --dependency=afterok:$m --qos=$HPG_GROUP-b --time=06:00:00 --export=ALL,STAGES=02_poses,SFM_REUSE_DB=1 slurm/sfm.sbatch <cfg>
export ENV=$HPG_ROOT/envs/colmap_gpu
source slurm/env.sh
export SFM_MATCH_ONLY=1
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1   # same FAISS/OpenBLAS thread-table crash guard as sfm.sbatch
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
python -c "import pycolmap; assert pycolmap.has_cuda, 'pycolmap in $ENV is the CPU build'; print('pycolmap', pycolmap.__version__, 'cuda')" || exit 1
CFG=${1:-config.yaml}
for s in 01_frames 02_poses; do
  python stages/$s.py "$CFG" || { echo "stopping after $s FAILED"; exit 1; }
done

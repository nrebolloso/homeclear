#!/bin/bash
#SBATCH --job-name=hc-sfm
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=48gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# CPU stages 1-2: frames + COLMAP poses (pycolmap is a CPU build).
# Usage: sbatch slurm/sfm.sbatch <config.yaml>
source slurm/env.sh
# pycolmap matching runs FAISS under OpenMP; each thread calling sgemm then spawns OpenBLAS threads and, on 64-core nodes,
# overflows the precompiled thread table (SIGSEGV in blas_memory_alloc, myhome_living 02_poses). One BLAS thread per caller.
export OPENBLAS_NUM_THREADS=1
CFG=${1:-config.yaml}
for s in 01_frames 02_poses; do
  python stages/$s.py "$CFG" || { echo "stopping after $s FAILED"; exit 1; }
done

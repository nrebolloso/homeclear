#!/bin/bash
#SBATCH --job-name=hc-sfm
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=48gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# CPU stages 1-2: frames + COLMAP poses (pycolmap is a CPU build).
# Usage: sbatch slurm/sfm.sbatch <config.yaml>   (STAGES="02_poses" SFM_REUSE_DB=1: map the matches slurm/sfm_gpu.sbatch saved)
source slurm/env.sh
# pycolmap matching runs FAISS under OpenMP; each thread calling sgemm then spawns OpenBLAS threads and, on 64-core nodes,
# overflows the precompiled thread table (SIGSEGV in blas_memory_alloc, myhome_living 02_poses). One BLAS thread per caller.
export OPENBLAS_NUM_THREADS=1
# That alone did not hold (myhome_living_b crashed again on 64 cores): the callers are the 64 COLMAP matcher threads, so also keep FAISS
# single-threaded and submit with --cpus-per-task=16 (stage 02 sizes its matcher threads from the job's cores; <= 24 stays inside the table).
export OMP_NUM_THREADS=1
CFG=${1:-config.yaml}
for s in ${STAGES:-01_frames 02_poses}; do
  python stages/$s.py "$CFG" || { echo "stopping after $s FAILED"; exit 1; }
done

# Sourced by every sbatch script: same modules + python env on every node.
# gcc must load before cuda, otherwise HiPerGator's lmod doesn't put nvcc on PATH.
: "${HPG_ROOT:?export HPG_ROOT=/blue/<group>/<user> (and HPG_GROUP, SBATCH_ACCOUNT=<group>)}"
module load gcc/12.2.0 cuda/13.0.2 ffmpeg/n6.1 conda
ENV=${ENV:-$HPG_ROOT/envs/homeclear}
export PATH="$ENV/bin:$PATH"
mkdir -p logs
echo "host=$(hostname) job=${SLURM_JOB_ID:-none} env=$ENV"

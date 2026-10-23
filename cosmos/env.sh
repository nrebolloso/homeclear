# Sourced by every cosmos/slurm job. Everything big lives on /blue (home quota is small).
: "${HPG_ROOT:?export HPG_ROOT=/blue/<group>/<user> (and HPG_GROUP, SBATCH_ACCOUNT=<group>)}"
C=$HPG_ROOT/cosmos
REPO=$C/cosmos-transfer2.5            # nvidia-cosmos/cosmos-transfer2.5 @ 2ff49d0 (synced from the laptop clone, LFS assets included)
SIF=$C/containers/pytorch_25.10-py3.sif   # the repo's Blackwell base image (docker/nightly.Dockerfile), via Apptainer
VENV=$C/venv                          # created inside the container, --system-site-packages
export HF_HUB_CACHE=$C/hf/hub         # checkpoints; the HF token stays where `hf auth login` put it (~/.cache/huggingface/token)
export PIP_CACHE_DIR=$C/cache/pip APPTAINER_CACHEDIR=$C/cache/apptainer APPTAINER_TMPDIR=$C/cache/tmp
export PYTHONNOUSERSITE=1             # don't let ~/.local packages leak into the container
unset UV_PYTHON                       # set by the host conda module (slurm/env.sh); uvx in the container then looks for /apps python
mkdir -p $C/logs $C/results $C/outputs $HF_HUB_CACHE $PIP_CACHE_DIR $APPTAINER_CACHEDIR $APPTAINER_TMPDIR
module load apptainer/1.4.2
ct() { apptainer exec --nv -B /blue "$SIF" bash -c "source $VENV/bin/activate && cd $REPO && $*"; }
echo "host=$(hostname) job=${SLURM_JOB_ID:-none} $(date -Is)"

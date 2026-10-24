# Sourced by every cosmos/slurm job. Everything big lives on /blue (home quota is small).
: "${HPG_ROOT:?export HPG_ROOT=/blue/<group>/<user> (and HPG_GROUP, SBATCH_ACCOUNT=<group>)}"
C=$HPG_ROOT/cosmos   # writable: logs, results, outputs, caches, these scripts
# Optional $C/local.sh (on the cluster only, no credentials): COSMOS_RO=<someone's built cosmos dir> to reuse their
# container, venv, repo clone and checkpoints read-only instead of rebuilding them (~1.5 h, 44 GB).
[ -f $C/local.sh ] && source $C/local.sh
CR=${COSMOS_RO:-$C}
REPO=$CR/cosmos-transfer2.5           # nvidia-cosmos/cosmos-transfer2.5 @ 2ff49d0 (synced from the laptop clone, LFS assets included)
SIF=$CR/containers/pytorch_25.10-py3.sif   # the repo's Blackwell base image (docker/nightly.Dockerfile), via Apptainer
VENV=$CR/venv                          # created inside the container, --system-site-packages
export HF_HUB_CACHE=$CR/hf/hub         # checkpoints; the HF token stays where `hf auth login` put it (~/.cache/huggingface/token)
[ "$CR" != "$C" ] && export HF_HUB_OFFLINE=1   # a cache that is not yours is read-only: use what is there, download nothing
export PIP_CACHE_DIR=$C/cache/pip APPTAINER_CACHEDIR=$C/cache/apptainer APPTAINER_TMPDIR=$C/cache/tmp
export PYTHONNOUSERSITE=1             # don't let ~/.local packages leak into the container
unset UV_PYTHON                       # set by the host conda module (slurm/env.sh); uvx in the container then looks for /apps python
mkdir -p $C/logs $C/results $C/outputs $PIP_CACHE_DIR $APPTAINER_CACHEDIR $APPTAINER_TMPDIR
[ "$CR" = "$C" ] && mkdir -p $HF_HUB_CACHE
module load apptainer/1.4.2
ct() { apptainer exec --nv -B /blue "$SIF" bash -c "source $VENV/bin/activate && cd $REPO && $*"; }
echo "host=$(hostname) job=${SLURM_JOB_ID:-none} $(date -Is) cosmos_ro=$CR"

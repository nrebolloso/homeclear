#!/usr/bin/env bash
# Upload a walker-game export and submit it on the B200 partition:  cosmos/submit_cosmos.sh <job> [extra sbatch args]
# Uses the SSH ControlMaster from config.yaml (cluster.*) - log in once with password + Duo, no credentials stored here.
set -euo pipefail
cd "$(dirname "$0")/.."
JOB=${1:?usage: cosmos/submit_cosmos.sh <job> [sbatch args, e.g. --dependency=afterok:<id>]   (job = folder under viewer/public/exports/)}; shift
D=viewer/public/exports/$JOB
[ -f "$D/cosmos_job.json" ] || { echo "no $D/cosmos_job.json - press Export for Cosmos in the viewer first"; exit 1; }
source ./hpg.sh && hpg_load config.yaml   # PY, HOST REPO HPG_ROOT, hpg_ssh / hpg_rsync (WSL on Windows)
SCENE=$($PY -c "import json; print(json.load(open('$D/cosmos_job.json'))['scene'])")
hpg_ssh "mkdir -p $REPO/viewer/public/exports $REPO/viewer/public/scene"
hpg_rsync -a common.py "$HOST:$REPO/"
hpg_rsync -a cosmos/ "$HOST:$REPO/cosmos/"
hpg_rsync -a cosmos/ "$HOST:$HPG_ROOT/cosmos/"
hpg_rsync -a "viewer/public/scene/$SCENE" "$HOST:$REPO/viewer/public/scene/"
hpg_rsync -a "$D" "$HOST:$REPO/viewer/public/exports/"
hpg_ssh "bash -lc 'cd $HPG_ROOT/cosmos && HPG_ROOT=$HPG_ROOT ENV=$ENV sbatch --parsable $* slurm/cosmos_job.sbatch $JOB'"
echo "submitted $JOB; when squeue is empty: cosmos/fetch_cosmos.sh $JOB"

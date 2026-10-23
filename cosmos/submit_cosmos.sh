#!/usr/bin/env bash
# Upload a walker-game export and submit it on the B200 partition:  cosmos/submit_cosmos.sh <job> [extra sbatch args]
# Uses the SSH ControlMaster from config.yaml (cluster.*) - log in once with password + Duo, no credentials stored here.
set -euo pipefail
cd "$(dirname "$0")/.."
JOB=${1:?usage: cosmos/submit_cosmos.sh <job> [sbatch args, e.g. --dependency=afterok:<id>]   (job = folder under viewer/public/exports/)}; shift
D=viewer/public/exports/$JOB
[ -f "$D/cosmos_job.json" ] || { echo "no $D/cosmos_job.json - press Export for Cosmos in the viewer first"; exit 1; }
cfg() { .venv/bin/python -c "import os, sys, yaml; c = yaml.safe_load(open('config.yaml')); print(os.path.expandvars(str(eval(sys.argv[1], {}, c))))" "$1"; }
HOST=$(cfg "cluster['ssh']"); REPO=$(cfg "cluster['repo']"); CP=$(cfg "cluster['control_path']"); CP=${CP/#\~/$HOME}
SSH="ssh -o ControlPath=$CP -o BatchMode=yes"
SCENE=$(.venv/bin/python -c "import json; print(json.load(open('$D/cosmos_job.json'))['scene'])")
$SSH "$HOST" "mkdir -p $REPO/viewer/public/exports $REPO/viewer/public/scene"
rsync -a -e "$SSH" common.py "$HOST:$REPO/"
rsync -a -e "$SSH" cosmos/ "$HOST:$REPO/cosmos/"
rsync -a -e "$SSH" cosmos/ "$HOST:$HPG_ROOT/cosmos/"
rsync -a -e "$SSH" "viewer/public/scene/$SCENE" "$HOST:$REPO/viewer/public/scene/"
rsync -a -e "$SSH" "$D" "$HOST:$REPO/viewer/public/exports/"
$SSH "$HOST" "bash -lc 'cd $HPG_ROOT/cosmos && sbatch --parsable $* slurm/cosmos_job.sbatch $JOB'"
echo "submitted $JOB; when squeue is empty: cosmos/fetch_cosmos.sh $JOB"

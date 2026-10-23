#!/usr/bin/env bash
# Pull finished Cosmos clips into viewer/public/clips/ (re-encoded to H.264: HiPerGator's ffmpeg has no libx264 and
# Chrome won't play mpeg4/mp4v):  cosmos/fetch_cosmos.sh [job ...]    (no args = every finished job)
set -euo pipefail
cd "$(dirname "$0")/.."
cfg() { .venv/bin/python -c "import os, sys, yaml; c = yaml.safe_load(open('config.yaml')); print(os.path.expandvars(str(eval(sys.argv[1], {}, c))))" "$1"; }
HOST=$(cfg "cluster['ssh']"); CP=$(cfg "cluster['control_path']"); CP=${CP/#\~/$HOME}
SSH="ssh -o ControlPath=$CP -o BatchMode=yes"
C=$HPG_ROOT/cosmos
JOBS=${*:-$($SSH "$HOST" "cd $C/outputs && ls -d */clip 2>/dev/null | cut -d/ -f1")}
mkdir -p viewer/public/clips
for j in $JOBS; do
  tmp=$(mktemp -d)
  rsync -a -e "$SSH" "$HOST:$C/outputs/$j/clip/" "$tmp/"
  rsync -a -e "$SSH" "$HOST:$C/results/$j.json" "viewer/public/clips/$j.run.json" || true
  ffmpeg -y -v error -i "$tmp/$j.mp4" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "viewer/public/clips/$j.mp4"
  cp "$tmp/$j.json" viewer/public/clips/
  rm -rf "$tmp"
  echo "viewer/public/clips/$j.mp4"
done

#!/usr/bin/env bash
# Pull finished Cosmos clips into viewer/public/clips/ (re-encoded to H.264: HiPerGator's ffmpeg has no libx264 and
# Chrome won't play mpeg4/mp4v):  cosmos/fetch_cosmos.sh [job ...]    (no args = every finished job)
set -euo pipefail
cd "$(dirname "$0")/.."
source ./hpg.sh && hpg_load config.yaml   # PY, HOST REPO HPG_ROOT, hpg_ssh / hpg_rsync (WSL on Windows)
C=$HPG_ROOT/cosmos
JOBS=${*:-$(hpg_ssh "cd $C/outputs && ls -d */clip 2>/dev/null | cut -d/ -f1")}
mkdir -p viewer/public/clips
# libx264: the system ffmpeg, else the one bundled with the venv's imageio-ffmpeg (Windows laptops have no ffmpeg on PATH)
FFMPEG=$(command -v ffmpeg || $PY -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")
for j in $JOBS; do
  tmp=viewer/public/clips/.tmp_$j; mkdir -p "$tmp"   # relative: rsync may run inside WSL, where /tmp is another place
  hpg_rsync -a "$HOST:$C/outputs/$j/clip/" "$tmp/"
  hpg_rsync -a "$HOST:$C/results/$j.json" "viewer/public/clips/$j.run.json" || true
  "$FFMPEG" -y -v error -i "$tmp/$j.mp4" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "viewer/public/clips/$j.mp4"
  cp "$tmp/$j.json" viewer/public/clips/
  rm -rf "$tmp"
  echo "viewer/public/clips/$j.mp4"
done

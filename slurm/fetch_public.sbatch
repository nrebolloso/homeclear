#!/bin/bash
#SBATCH --job-name=hc-fetch
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=8gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# Mip-NeRF 360 "room" (311 photos) stitched into a 10 fps video, so stage 1 runs exactly as on a phone video.
set -euo pipefail
source slurm/env.sh
DS=${DS:-$HPG_ROOT/datasets/mipnerf360}
mkdir -p "$DS" data
cd "$DS"
[ -d room/images_2 ] || { wget -nv -c http://storage.googleapis.com/gresearch/refraw360/360_v2.zip; unzip -q -o 360_v2.zip 'room/*'; }
ls room/images_2 | wc -l
cd - >/dev/null
ffmpeg -v error -y -framerate 10 -pattern_type glob -i "$DS/room/images_2/*.JPG" \
  -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v mpeg4 -q:v 2 data/public_room.mp4   # HPG ffmpeg has no libx264
ffprobe -v error -show_entries format=duration:stream=width,height -of default=nw=1 data/public_room.mp4

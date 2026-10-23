#!/bin/bash
#SBATCH --job-name=hc-sfm-join
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=24
#SBATCH --mem=128gb   # 400 frames at 1600 px peaked under 48 GB; 800 at 4K extracts ~4x the SIFT features
#SBATCH --time=12:00:00   # exhaustive matching grows with frames squared: 400 frames at 1600 px took 29 min
#SBATCH --output=logs/%x-%j.log
# Join phone clips at full resolution into the config's video (unless it exists), then stages 1-2, and link the result
# as a gsplat data dir for slurm/train_best.sbatch.
# usage: sbatch [--job-name=...] slurm/sfm_join.sbatch <config> <clip.mp4>...   (clips in filming order)
set -euo pipefail
source slurm/env.sh
CFG=$1; shift
read -r VID RUN WORK < <(python -c "import sys, yaml; c = yaml.safe_load(open(sys.argv[1])); print(c['video'], c['run_name'], c['work_dir'])" $CFG)
[ -s $VID ] || {
  ins=(); f=""; i=0
  for c in "$@"; do ins+=(-i $c); f+="[$i:v]fps=30,setsar=1[v$i];"; i=$((i + 1)); done
  # the cluster ffmpeg has no libx264: intra-frame MJPEG at top quality; tmp name so a cancelled join is never reused
  ffmpeg -v error "${ins[@]}" -filter_complex "$f$(for k in $(seq 0 $((i - 1))); do printf '[v%d]' $k; done)concat=n=$i:v=1:a=0[out]" \
    -map "[out]" -c:v mjpeg -q:v 2 -pix_fmt yuvj420p -threads $SLURM_CPUS_PER_TASK -f matroska $VID.tmp
  mv $VID.tmp $VID
}
for s in 01_frames 02_poses; do
  python stages/$s.py $CFG || { echo "stopping after $s FAILED"; exit 1; }
done
python slurm/drop_far_cams.py $WORK/colmap/best   # a stray camera inflates gsplat's scene scale and the splat never fits (kitchen2)
D=$HPG_ROOT/datasets/$RUN; mkdir -p $D/sparse
ln -sfn $PWD/$WORK/images $D/images; ln -sfn $PWD/$WORK/colmap/best $D/sparse/0

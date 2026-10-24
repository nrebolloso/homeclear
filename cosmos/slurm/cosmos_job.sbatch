#!/bin/bash
#SBATCH --job-name=cosmos-job
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb   # peak RSS 18 GB
#SBATCH --time=04:00:00
#SBATCH --output=logs/%x-%j.log
# A walker-game "Export for Cosmos" job: render depth/seg/edge controls from the splat along the exported path
# (render_controls.py, pipeline env), run Cosmos Transfer on every 93-frame chunk under ONE model load, stitch the
# chunks, label/tint, and write the clip metadata the viewer's clip player reads.
#   sbatch slurm/cosmos_job.sbatch <job>       (cosmos/submit_cosmos.sh uploads and submits; fetch_cosmos.sh pulls)
set -uo pipefail
JOB=$1
R=$HPG_ROOT/Homeclear
D=$R/viewer/public/exports/$JOB
cd $R && source slurm/env.sh
t0=$(date +%s)
python cosmos/render_controls.py $D || exit 1
echo "render_controls_s=$(( $(date +%s) - t0 ))"
SPECS=$(python -c "import json; print(' '.join(json.load(open('$D/controls/render_controls.json'))['specs']))")
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
run_infer $JOB "$SPECS" || exit 1
OUT=$C/outputs/$JOB
CLIP=$OUT/clip; mkdir -p $CLIP
ls $OUT/${JOB}_c[0-9][0-9].mp4 | sed "s/.*/file '&'/" > $OUT/concat.txt
ffmpeg -y -v error -f concat -safe 0 -i $OUT/concat.txt -c copy $OUT/stitched.mp4 || exit 1
python $R/cosmos/tint.py $OUT/stitched.mp4 $CLIP/$JOB.mp4 $D/controls/mask.mp4 || exit 1
python - "$D/cosmos_job.json" "$CLIP/$JOB.json" "$JOB.mp4" <<'PY'
import json, sys
j = json.load(open(sys.argv[1]))
moved = [o["name"] + (" removed" if o["removed"] else " moved") for o in j["objects"] if o.get("moved") or o["removed"]]
layout = ", ".join(moved + j["fixes_applied"]) or "original layout"
json.dump({"file": sys.argv[3], "title": j["label"], "date": j["created"], "prompt": j["prompt"], "layout": layout,
           "objects": j["objects"], "night": j["night"], "fps": j["fps"], "width": j["width"], "height": j["height"],
           "K": j["K"], "cameras": j["cameras"], "hazards": j["hazards"], "per_month": j["per_month"],
           # pre-render bookkeeping: the viewer lists clips made for the layout on screen first (prerender.ts layoutKey)
           **{k: j.get(k) for k in ("layout_key", "route", "condition", "mode", "scenario", "route_s")},
           "label": "imagined, not measured (Cosmos Transfer 2.5); hazard markers are overlays from measured geometry"},
          open(sys.argv[2], "w"), indent=1)
PY
echo "clip: $CLIP/$JOB.mp4 (mp4v; fetch_cosmos.sh re-encodes to H.264 for the browser)"

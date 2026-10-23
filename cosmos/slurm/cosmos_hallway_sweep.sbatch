#!/bin/bash
#SBATCH --job-name=cosmos-sweep
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb   # peak RSS 18 GB
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# The first hallway run (edge 1.0 + vis/blur 0.5) kept the original lighting: blur control carries the input's colours.
# Relighting needs edge only. Sweep edge weight + guidance to find what turns the kitchen into "3 AM".
set -uo pipefail
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
mk() {   # mk <name> <edge_weight> <guidance>
  python3 - "$@" <<'PY'
import json, os, sys
n, w, g = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
s = json.load(open(os.environ["HPG_ROOT"] + "/cosmos/inputs/hallway_spec.json"))
s.pop("vis", None); s.update(name=n, guidance=g, edge={"control_weight": w})
s["prompt"] = ("The same kitchen at 3 AM in near darkness: all ceiling lights off, windows black, deep shadows everywhere; "
               "the only light is one small warm orange nightlight plugged in low near the floor, casting a dim glow on the floor; "
               "realistic home interior at night; camera moving slowly forward.")
json.dump(s, open(f"{os.environ['HPG_ROOT']}/cosmos/inputs/{n}.json", "w"), indent=1)
PY
}
rc=0
for v in "night_e10_g3 1.0 3" "night_e07_g3 0.7 3" "night_e05_g5 0.5 5" "night_e03_g7 0.3 7"; do
  set -- $v; mk $1 $2 $3; run_infer $1 $C/inputs/$1.json || rc=1
done
exit $rc

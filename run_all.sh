#!/usr/bin/env bash
# Whole pipeline from the laptop: ./run_all.sh [configs/<scene>.yaml]
#   CLUSTER  stages 1-2  (frames, COLMAP) - CPU job on burst QOS
#   CLUSTER  stages 0, 3-6 (env, splat, scale, floor, occupancy) - one GPU job on HiPerGator
#   LAPTOP   stages 7-8  (route planning, hazards)
#   CLUSTER  stage  9    (hazard renders + image-edit backend) - short GPU job
#   LAPTOP   stages 10-11 (viewer check, reports)
# Needs an open SSH ControlMaster to HiPerGator (password + Duo), see README.
# SKIP_CLUSTER=1 reruns only the laptop part on what was already pulled back.
set -uo pipefail
cd "$(dirname "$0")"
CFG=${1:-configs/home.yaml}
source ./hpg.sh && hpg_load "$CFG"   # PY, HOST REPO ENV HPG_ROOT (config + cluster.local.yaml), hpg_ssh / hpg_rsync
cfg() { $PY -c "import os, sys, yaml; c = yaml.safe_load(open('$CFG')); print(os.path.expandvars(str(eval(sys.argv[1], {}, c))))" "$1"; }
WORK=$(cfg work_dir); VIDEO=$(cfg video)
remote() { hpg_ssh "bash -lc 'cd $REPO && HPG_ROOT=$HPG_ROOT ENV=$ENV $*'"; }  # login shell: lmod's module() is inherited by the jobs
pull() { hpg_rsync -a --exclude candidates/ --exclude images/ --exclude colmap/ --exclude splat.ply --exclude splat_scaled.ply "$HOST:$REPO/$WORK/" "$WORK/"; }
laptop() { for s in "$@"; do $PY stages/$s.py "$CFG"; done; }

if [ -z "${SKIP_CLUSTER:-}" ]; then
  : "${HPG_ROOT:?export HPG_ROOT=/blue/<group>/<user> (README: 'Connect')}" "${HPG_GROUP:?export HPG_GROUP=<group>}"
  $X ssh $SSH_OPTS -O check "$HOST" 2>/dev/null || { echo "No SSH master for $HOST. Open one first (README: 'Connect'; on Windows inside WSL)."; exit 1; }
  echo "== CLUSTER: sync repo + video"
  remote "mkdir -p $(dirname "$VIDEO") logs" || exit 1
  hpg_rsync -a --exclude .git --exclude .venv --exclude out --exclude data --exclude logs --exclude node_modules --exclude viewer/public ./ "$HOST:$REPO/"
  [ -f "$VIDEO" ] && hpg_rsync -a "$VIDEO" "$HOST:$REPO/$VIDEO"
  echo "== CLUSTER: stages 1-2 (CPU, burst QOS)"
  remote sbatch --wait --parsable --qos=$HPG_GROUP-b slurm/sfm.sbatch "$CFG" || exit 1
  echo "== CLUSTER: stages 0, 3-6 (sbatch --wait; queue time depends on hpg-b200)"
  remote sbatch --wait --parsable slurm/cluster.sbatch "$CFG"
  mkdir -p "$WORK" && pull
fi

echo "== LAPTOP: stages 5c, 6b-8 (room shell, accuracy check, route, hazards)"
laptop 05c_shell 06b_accuracy 07_plan 08_hazards

if [ -z "${SKIP_CLUSTER:-}" ] && [ -f "$WORK/hazards.json" ]; then
  echo "== CLUSTER: stage 9 (renders)"
  hpg_rsync -a "$WORK/hazards.json" "$WORK/path.json" "$HOST:$REPO/$WORK/"
  hpg_rsync -a "$CFG" "$HOST:$REPO/$CFG"
  remote sbatch --wait --parsable slurm/render.sbatch "$CFG"
  pull
fi

echo "== LAPTOP: stages 10-11"
laptop 10_viewer 11_report
echo "Report: $WORK/smoke_test_report.md  $WORK/report.html"
echo "Viewer: python3 -m http.server 8000  ->  http://localhost:8000/viewer/check.html?run=$WORK"

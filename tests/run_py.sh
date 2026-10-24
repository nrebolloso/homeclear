#!/usr/bin/env bash
# Every Python self-check, in order, stopping at the first failure:  tests/run_py.sh
# (the synthetic scenes first: the later checks read out/game_synth and viewer/public/scene/game_synth)
set -euo pipefail
cd "$(dirname "$0")/.."
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) PY=.venv/Scripts/python ;; *) PY=.venv/bin/python ;; esac
export PYTHONUTF8=1
for t in test_synthetic make_game_scene test_contact_table test_shell test_fills test_reason_lift test_detect_vote test_score_proposals test_rescan_diff test_fill_composite test_verdict test_plan_auto test_table_scale test_table_loo test_spec_export test_clean; do
  printf '%-20s ' "$t"
  $PY tests/$t.py > "out/$t.log" 2>&1 || { echo FAIL; tail -20 "out/$t.log"; exit 1; }
  tail -1 "out/$t.log" | cut -c1-100
done

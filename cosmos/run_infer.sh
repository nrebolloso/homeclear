# Sourced by cosmos_example / cosmos_hallway: run_infer <name> <spec.json> [extra inference.py args]
# Logs the exact command, wall clock (model load vs generation), peak VRAM (nvidia-smi every 0.5 s), output mp4s.
run_infer() {
  local name=$1 spec=$2; shift 2
  local out=$C/outputs/$name; mkdir -p $out
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -lms 500 > $out/vram_mib.csv &
  local mon=$!
  local cmd="python $C/timed_inference.py -i $spec -o $out $*"
  echo "COMMAND (in $REPO, inside $SIF): $cmd" | tee $out/command.txt
  local t0=$(date +%s)
  ct "TIMINGS=$out/timings.json $cmd"
  local rc=$? t1=$(date +%s)
  kill $mon
  ct "python - <<'PY'
import json, glob, pathlib
out = pathlib.Path('$out')
t = json.loads((out / 'timings.json').read_text()) if (out / 'timings.json').exists() else {}
v = [int(x) for x in (out / 'vram_mib.csv').read_text().split() if x.strip().isdigit()]
mp4 = sorted(p for p in glob.glob('$out/**/*.mp4', recursive=True) if '_control_' not in p and '_mask_' not in p)
r = {'step': '$name', 'status': 'PASS' if $rc == 0 and mp4 else 'FAIL', 'exit_code': $rc, 'wall_s': $((t1-t0)),
     **t, 'peak_vram_gb_nvidia_smi': round(max(v, default=0) / 1024, 1), 'outputs': mp4,
     'controls': sorted(glob.glob('$out/**/*_control_*.mp4', recursive=True)), 'command': (out / 'command.txt').read_text().strip()}
print(json.dumps(r, indent=1)); (pathlib.Path('$C/results') / '$name.json').write_text(json.dumps(r, indent=1))
PY"
  return $rc
}

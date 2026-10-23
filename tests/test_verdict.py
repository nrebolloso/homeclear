"""Stage 8 verdicts on the synthetic game route (SYNTHETIC): 5 cm side clearance, measured width error 4 cm.
Limit 10 cm -> fail (5 cm short, outside the error); 8 cm -> borderline (3 cm short, inside it); 0 -> not flagged.
Run after tests/make_game_scene.py:  .venv/bin/python tests/test_verdict.py"""
import json, shutil, subprocess, sys
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
src, d = ROOT / "out" / "game_synth", ROOT / "out" / "verdict_test"
shutil.rmtree(d, ignore_errors=True)
shutil.copytree(src, d, ignore=shutil.ignore_patterns("*.ply", "results", "images"))
cfg = yaml.safe_load((src / "config.yaml").read_text())
cfg.update(run_name="verdict_test", work_dir="out/verdict_test")
for limit, want in ((0.10, "fail"), (0.08, "borderline, OT to verify"), (0.0, None)):
    cfg["hazards"]["clearance_margin_m"] = limit
    (d / "config.yaml").write_text(yaml.safe_dump(cfg))
    subprocess.run([sys.executable, str(ROOT / "stages" / "08_hazards.py"), str(d / "config.yaml")], check=True, capture_output=True)
    hz = json.loads((d / "hazards.json").read_text())
    tight = [h for h in hz["hazards"] if h["type"] == "tight_clearance"]
    print(limit, hz["accuracy_margin_m"], [(h["min_side_clearance_m"], h["verdict"]) for h in tight])
    assert (tight[0]["verdict"] == want) if want else not tight, (limit, tight)
print("VERDICT TEST OK")

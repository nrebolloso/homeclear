"""Stage 7 plan.via (SYNTHETIC grid): start == goal with waypoints round a block walks one full loop, as route_via.ts does
in the viewer.   .venv/bin/python tests/test_plan_via.py"""
import json, shutil, subprocess, sys
from pathlib import Path
import cv2, numpy as np, yaml

ROOT = Path(__file__).resolve().parents[1]
d = ROOT / "out" / "plan_via_test"
shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
obst = np.zeros((60, 60), bool)   # 6 x 6 m at 10 cm, a 2 x 2 m block in the middle
obst[20:40, 20:40] = True
np.save(d / "obstacles.npy", obst); np.save(d / "floor.npy", np.ones_like(obst))
(d / "grid.json").write_text(json.dumps({"origin_xy": [0, 0], "cell_m": 0.1}))
cv2.imwrite(str(d / "occupancy.png"), np.full((60, 60, 3), 235, np.uint8))
cfg = {"run_name": "plan_via_test", "work_dir": "out/plan_via_test", "hazards": {"clearance_margin_m": 0.1},
       "plan": {"walker_width_m": 0.6, "preferred_clearance_m": 0.3, "clearance_weight": 5.0,
                "start": [0.8, 3], "goal": [0.8, 3], "via": [[3, 0.8], [5.2, 3], [3, 5.2]]}}
(d / "config.yaml").write_text(yaml.safe_dump(cfg))
subprocess.run([sys.executable, str(ROOT / "stages" / "07_plan.py"), str(d / "config.yaml")], check=True, capture_output=True)
m = json.loads((d / "path.json").read_text())
a = np.unwrap(np.arctan2(*(np.array(m["xy"]) - 3)[:, ::-1].T))
assert m["xy"][0] == m["xy"][-1] and abs(abs(a[-1] - a[0]) - 2 * np.pi) < 0.1, (m["xy"][0], m["xy"][-1], a[-1] - a[0])
assert (np.abs(np.diff(m["cells"], axis=0)).sum(1) > 0).all(), "legs joined with a repeated cell"
print(f"PLAN VIA OK loop {m['path_length_m']} m (SYNTHETIC)")

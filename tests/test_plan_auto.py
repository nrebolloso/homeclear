"""Stage 7 auto start/goal (SYNTHETIC grid): the far ends of the free region are picked with the hazard clearance margin
to spare when the room allows it, instead of parked against a wall.   .venv/bin/python tests/test_plan_auto.py"""
import json, shutil, subprocess, sys
from pathlib import Path
import cv2, numpy as np, yaml

ROOT = Path(__file__).resolve().parents[1]
d = ROOT / "out" / "plan_auto_test"
shutil.rmtree(d, ignore_errors=True); d.mkdir(parents=True)
obst = np.zeros((300, 100), bool)   # 6 x 2 m room, 2 cm cells, walls all round
obst[[0, -1]] = obst[:, [0, -1]] = True
np.save(d / "obstacles.npy", obst); np.save(d / "floor.npy", np.ones_like(obst))
(d / "grid.json").write_text(json.dumps({"origin_xy": [0, 0], "cell_m": 0.02}))
cv2.imwrite(str(d / "occupancy.png"), np.full((100, 300, 3), 235, np.uint8))
cfg = {"run_name": "plan_auto_test", "work_dir": "out/plan_auto_test", "hazards": {"clearance_margin_m": 0.1},
       "plan": {"walker_width_m": 0.66, "preferred_clearance_m": 0.3, "clearance_weight": 5.0}}
(d / "config.yaml").write_text(yaml.safe_dump(cfg))
subprocess.run([sys.executable, str(ROOT / "stages" / "07_plan.py"), str(d / "config.yaml")], check=True, capture_output=True)
m = json.loads((d / "path.json").read_text())
side = np.array(m["side_clearance_m"])
print(m["start_xy"], m["goal_xy"], "side clearance at ends", side[[0, -1]].round(3))
assert (side[[0, -1]] >= 0.1 - 1e-6).all(), "auto start/goal sit closer than the clearance margin"
assert m["path_length_m"] > 4.0, "auto start/goal should still be far apart"
print("OK")

"""Cosmos Reason post-processing on the synthetic game scene (no model): parsing messy answers, lifting a pixel with a
known depth, confirming / dismissing against the measured grids, merging repeats, precision/recall.
  .venv/bin/python tests/test_reason_lift.py      (after tests/make_game_scene.py)"""
import importlib, json, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "cosmos")]
import reason_lift as rl
look_at = importlib.import_module("09_fix_render").look_at

answer = """<think>The rug edge is raised...</think>Here is the list:
```json
[{"hazard": "rug edge in the path", "kind": "floor_bump", "pixel": [640, 500], "why": "trip", "confidence": 0.8},
 {"hazard": "no grab bar by the toilet", "kind": "grab_bar", "pixel": [100, 200], "confidence": 0.6},
 {"broken": true}]
```"""
P = rl.parse(answer)
assert [p["kind"] for p in P] == ["floor_bump", "grab_bar"], P
assert rl.parse("no hazards found") == [] and rl.parse('{"hazards": [{"kind": "cable", "pixel": [1, 2]}]}')[0]["kind"] == "cable"

# lift: a camera 1.4 m up looking straight down at (3.0, 1.6); every pixel 1.4 m deep -> the centre pixel lands there
w2c = look_at(np.array([3.0, 1.6, 1.4]), np.array([3.0, 1.601, 0.0]))
K = [[500, 0, 320], [0, 500, 240], [0, 0, 1]]
p = rl.lift([320, 240], np.full((480, 640), 1.4), w2c, K)
assert np.allclose(p, [3.0, 1.6, 0.0], atol=0.01), p
assert rl.lift([10, 10], np.full((480, 640), np.inf), w2c, K) is None

w = ROOT / "out/game_synth"
grid = json.loads((w / "grid.json").read_text())
bump, obst, est = np.load(w / "bump_height_m.npy"), np.load(w / "obstacles.npy"), np.load(w / "bump_estimated.npy")
on_rug = rl.verdict([2.95, 1.6, 0], "floor_bump", grid, bump, obst, est)
assert on_rug["verdict"] == "confirmed" and abs(on_rug["height_m"] - 0.015) < 0.004, on_rug
assert rl.verdict([1.0, 0.8, 0], "floor_bump", grid, bump, obst, est)["verdict"] == "dismissed"
assert rl.verdict([1.0, 0.8, 0], "cable", grid, bump, obst, est)["verdict"].startswith("not seen")
assert rl.verdict([6.0, 1.5, 0], "grab_bar", grid, bump, obst, est)["verdict"].startswith("unmeasurable")

items = [{"kind": "floor_bump", "position_m": [2.95, 1.6, 0], "confidence": 0.8, "frames": ["a"], "verdict": "confirmed"},
         {"kind": "floor_bump", "position_m": [3.1, 1.7, 0], "confidence": 0.6, "frames": ["b"], "verdict": "confirmed"},
         {"kind": "grab_bar", "position_m": [6.0, 1.5, 0], "confidence": 0.6, "frames": ["b"], "verdict": "unmeasurable, OT to verify"},
         {"kind": "floor_bump", "position_m": [1.0, 0.8, 0], "confidence": 0.4, "frames": ["c"], "verdict": "dismissed"}]
M = rl.merge(items)
assert len(M) == 3 and M[0]["frames"] == ["a", "b"], M
key = [{"kind": "rug", "xy": [3.0, 1.6]}, {"kind": "cable", "xy": [3.64, 1.5]}, {"kind": "grab_bar", "xy": [6.1, 1.3]}]
e = rl.evaluate(M, key)
assert e == {"claims": 2, "key_items": 3, "true_positives": 2, "precision": 1.0, "recall": 0.667}, e
print("REASON LIFT OK", e)

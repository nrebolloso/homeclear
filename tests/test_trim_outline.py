"""Stage 12 trimmed_rect(): a few spill points 40 cm off a rotated 2.0 x 1.3 m bed don't stretch its outline (aleroom)."""
import importlib
import sys
from pathlib import Path

import numpy as np

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "stages")]
e = importlib.import_module("12_export_scene")

rng = np.random.default_rng(0)
a = np.deg2rad(30)
R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
bed = rng.uniform([-1.0, -0.65], [1.0, 0.65], (20000, 2))
spill = rng.uniform([1.0, -0.2], [1.4, 0.2], (40, 2))   # mask spill onto the bucket beside it
p = np.r_[bed, spill] @ R.T + [0.3, 0.5]
poly = e.trimmed_rect(p, 1)
side = sorted(np.linalg.norm(poly - np.roll(poly, 1, 0), axis=1).round(2)[:2])
assert abs(side[0] - 1.27) < 0.03 and abs(side[1] - 1.96) < 0.03, side   # 1% off each end of the true 1.3 x 2.0
assert abs(poly.mean(0) - [0.3, 0.5]).max() < 0.02, poly.mean(0)
print(f"TRIM OUTLINE OK {side[0]:.2f} x {side[1]:.2f} m (SYNTHETIC)")

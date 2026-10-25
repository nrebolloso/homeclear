"""fit_floor skips a bed top: a big flat bed 0.7 m up outvotes a cluttered floor, cameras held at 1.4 m (bedroom2_glomap)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from common import fit_floor

rng = np.random.default_rng(0)
xy = lambda n, lo, hi: rng.uniform(lo, hi, (n, 2))
floor = np.c_[xy(4000, -2, 2), rng.normal(0, 0.005, 4000)]
bed = np.c_[xy(9000, -1, 1), 0.7 + rng.normal(0, 0.005, 9000)]
C = np.c_[xy(50, -1.5, 1.5), np.full(50, 1.4)]
cams = [{"w2c": [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0]]}] * 50   # image y down = world -z, so up = +z
fc = {"ransac_iters": 500, "inlier_m": 0.02}
n, d, inl, _ = fit_floor(np.r_[floor, bed], C, cams, fc)
h = float(np.median(C @ n + d))
assert abs(h - 1.4) < 0.02, h
n, d, _, _ = fit_floor(np.r_[floor, bed[:1000]], C, cams, fc)   # floor already wins: unchanged
assert abs(float(np.median(C @ n + d)) - 1.4) < 0.02
print(f"FLOOR BED OK camera height {h:.3f} m (SYNTHETIC)")

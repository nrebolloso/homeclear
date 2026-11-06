"""floor.fit: walked levels a large tilted floor: a flat patch at one end wins RANSAC, the walked fit follows the whole path."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from common import fit_floor

rng = np.random.default_rng(0)
tilt = np.tan(np.radians(1.9))
xy = rng.uniform(-40, 40, (60000, 2))
floor = np.c_[xy, -tilt * xy[:, 0] + rng.normal(0, 0.005, len(xy))]
patch = np.c_[rng.uniform(-40, -25, (80000, 2)), np.zeros(80000)]           # one dead-flat end: RANSAC's favourite
patch[:, 2] = tilt * 32                                                      # level, so off the true slope
planter = np.c_[rng.uniform(0, 2, (3000, 2)), 0.6 + rng.uniform(-0.01, 0.01, 3000)]
cxy = rng.uniform(-38, 38, (300, 2))
C = np.c_[cxy, -tilt * cxy[:, 0] + 2.3]   # 2.3 m up, as night1 before rescaling: over 1 m above the level patch, so no bed rule
cams = [{"w2c": [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0]]}] * len(C)
fc = {"ransac_iters": 300, "inlier_m": 0.02}
pts = np.r_[floor, patch, planter]
n, d, _, _ = fit_floor(pts, C, cams, fc)
assert np.ptp(np.percentile(C @ n + d, [5, 95])) > 1.0   # plain RANSAC: the level patch wins, the far end sinks
n, d, _, _ = fit_floor(pts, C, cams, {**fc, "fit": "walked"})
h = C @ n + d
assert np.ptp(np.percentile(h, [5, 95])) < 0.05 and abs(np.median(h) - 2.3) < 0.03, (np.percentile(h, [5, 50, 95]))
print(f"FLOOR WALKED OK camera height {np.median(h):.3f} m, spread {np.ptp(np.percentile(h, [5, 95])) * 100:.1f} cm (SYNTHETIC)")

"""triangulate_robust ignores false/mis-posed sightings that drag plain DLT off (newell_stair2 markers: ~55% of sightings > 3 px off)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from common import triangulate, triangulate_robust

rng = np.random.default_rng(0)
K = np.array([[800, 0, 640], [0, 800, 360], [0, 0, 1.]])
Ps = [K @ np.hstack([np.eye(3), [[-x], [0.1 * x], [4]]]) for x in np.linspace(-1.5, 1.5, 40)]
X0 = np.array([0.3, -0.2, 0.5])
uvs = np.array([(lambda x: x[:2] / x[2])(P @ np.append(X0, 1)) for P in Ps]) + rng.normal(0, 0.3, (40, 2))
uvs[::2] += rng.uniform(20, 200, (20, 2))   # half the sightings are wrong
X, inl = triangulate_robust(Ps, uvs)
assert np.linalg.norm(X - X0) < 0.01 and inl.sum() == 20 and not inl[::2].any(), (X, inl.sum())
assert np.linalg.norm(triangulate(Ps, uvs) - X0) > 0.05   # plain DLT is dragged off: the case this guards
clean = np.array([(lambda x: x[:2] / x[2])(P @ np.append(X0, 1)) for P in Ps])
assert np.allclose(triangulate_robust(Ps, clean)[0], triangulate(Ps, clean), atol=1e-9)   # clean data: same answer as before
assert triangulate_robust(Ps[:2], clean[:2])[1].all()   # two views: nothing to vote on, both used
print(f"TRIANGULATE ROBUST OK error {np.linalg.norm(X - X0) * 1000:.2f} mm, 20/40 inliers (SYNTHETIC)")

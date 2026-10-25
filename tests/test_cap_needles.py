"""tools/cap_needles.py shortens only the longest axis of a needle and touches nothing else.
  .venv/bin/python tests/test_cap_needles.py"""
import sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tools")]
from cap_needles import cap_needles

dt = np.dtype([(n, "f4") for n in ("x", "y", "z", "scale_0", "scale_1", "scale_2", "opacity", "f_dc_0", "rot_0")])
v = np.zeros(5, dt)
v["x"] = np.arange(5)
v["opacity"] = 2.0
#                          long axis  mid     short     what it is
sizes = np.array([[1.20, 0.02, 0.01],      # a 1.2 m streak: a needle, long axis 0
                  [0.02, 0.90, 0.02],      # a 0.9 m streak along axis 1
                  [0.01, 0.02, 0.60],      # a 0.6 m streak along axis 2
                  [0.80, 0.60, 0.50],      # big but round (a wall or floor Gaussian): not a needle
                  [0.20, 0.02, 0.01]])     # a needle, but shorter than the cap: left alone
for k in range(3):
    v[f"scale_{k}"] = np.log(sizes[:, k])
out, n = cap_needles(v, cap=0.45, aspect=6)
s = np.exp(np.stack([out["scale_0"], out["scale_1"], out["scale_2"]], 1))
assert n == 3, n
assert np.allclose(s[0], [0.45, 0.02, 0.01], atol=1e-5) and np.allclose(s[1], [0.02, 0.45, 0.02], atol=1e-5) and np.allclose(s[2], [0.01, 0.02, 0.45], atol=1e-5), s
assert np.allclose(s[3], sizes[3], atol=1e-5) and np.allclose(s[4], sizes[4], atol=1e-5), "round and short ones are untouched"
for f in ("x", "opacity", "f_dc_0", "rot_0"):
    assert np.array_equal(out[f], v[f]), f"{f} must not change"
assert np.exp(v["scale_0"][0]) > 1.0, "the input is not modified in place"
print("CAP NEEDLES OK", n)

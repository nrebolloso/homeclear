"""tools/rug_ingest.py xcorr on SYNTHETIC onsets: a 6 s floor clip cut from a 20 s wide clip at 7.30 s (plus noise) is found at
7.30 s with a clear peak; a clip of unrelated noise gives no clear peak.  .venv/bin/python tests/test_rug_sync.py"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from rug_ingest import HZ, xcorr

rng = np.random.default_rng(0)
wide = np.maximum(rng.normal(size=20 * HZ), 0) ** 3        # sparse onsets, like wheel clacks
floor = wide[730: 730 + 6 * HZ] + 0.3 * rng.random(6 * HZ)
lag, c, ratio = xcorr(floor, wide)
print(lag, c, ratio)
assert abs(lag - 7.30) < 1e-9 and c > 0.9 and ratio > 1.25, (lag, c, ratio)
_, c2, r2 = xcorr(rng.random(6 * HZ), wide)
print(c2, r2)
assert c2 < 0.3, (c2, r2)
print("RUG SYNC TEST OK")

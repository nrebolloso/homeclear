"""Contact table: anchored to the cited rate, monotone, and what the configs carry is what the generator makes.
  .venv/bin/python tests/test_contact_table.py"""
import sys
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from contact_table import table, trip_average, mtc_cdf, KNOTS_M, ANCHOR_P

for cv in (0.0, 0.25, 0.4):
    p, k = table(cv)
    assert abs(trip_average(KNOTS_M, p, 0.010, cv) - ANCHOR_P) < 1e-9, cv        # 1 in 578 at 1 cm, as the rollouts see it
    assert all(b >= a for a, b in zip(p, p[1:])) and p[0] == 0, p               # taller never safer; flat floor never trips
    assert 0.003 < k < 0.006, k
# the lognormal shape has the published mean
s = np.sort(np.random.default_rng(0).lognormal(np.log(0.0141) - np.log(1 + (0.0083 / 0.0141) ** 2) / 2,
                                                np.sqrt(np.log(1 + (0.0083 / 0.0141) ** 2)), 400_000))
assert abs(s.mean() - 0.0141) < 2e-4 and abs(np.searchsorted(s, 0.010) / len(s) - float(mtc_cdf(0.010))) < 5e-3

for cfg in sorted(ROOT.glob("config*.yaml")):
    c = yaml.safe_load(cfg.read_text())
    if "game" not in c:
        continue
    t = c["game"]["risk"]["contact_table"]["older_adult_walker"]
    want, _ = table(c["game"]["persona"]["toe_clearance_cv"])
    assert t["height_m"] == KNOTS_M and np.allclose(t["p_per_stride"], want, rtol=2e-3), cfg.name
print("CONTACT TABLE OK: p(10 mm) = 1/578 trip-averaged in every config")

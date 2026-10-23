"""SYNTHETIC: tools/table_scale.tabletop() finds a rotated, round-cornered table next to a counter of similar size and
chair backs crossing the tabletop band, and measures it."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from table_scale import tabletop

r = np.random.default_rng(0)
L, W, H, R = 1.6, 1.05, 0.73, 0.15
u = r.uniform(-0.5, 0.5, (40000, 2)) * [L, W]
q = np.maximum(np.abs(u) - [L / 2 - R, W / 2 - R], 0)
u = u[np.linalg.norm(q, axis=1) <= R]                                   # rounded corners
a = np.radians(25)
top = np.c_[u @ np.array([[np.cos(a), np.sin(a)], [-np.sin(a), np.cos(a)]]) + [2, 1], H + r.normal(0, 0.004, len(u))]
floor = np.c_[r.uniform(-1, 5, (30000, 2)), r.normal(0, 0.004, 30000)]
counter = np.c_[r.uniform([0, -2.2], [3, -1.6], (30000, 2)), 0.91 + r.normal(0, 0.004, 30000)]
backs = np.concatenate([np.c_[np.full(800, x) + r.normal(0, 0.01, 800), np.full(800, y) + r.uniform(-0.2, 0.2, 800), r.uniform(0.45, 0.95, 800)]
                        for x, y in ((2.9, 1.3), (1.1, 0.7))])
# dense band (closing 3 cells) and a sparse one like the real kitchen splat (closing 5; the chair back 6 cm off the end stays out)
for name, tp in (("dense", top), ("sparse", top[r.random(len(top)) < 0.1])):
    t = tabletop(np.r_[tp, floor, counter, backs], near=np.array([2.1, 0.9]))
    print(name, {k: round(t[k], 4) for k in ("length", "width", "height", "fill", "closing_cells")})
    assert abs(t["length"] - L) < 0.02 and abs(t["width"] - W) < 0.02 and abs(t["height"] - H) < 0.01, t
assert tabletop(np.r_[top[r.random(len(top)) < 0.03], floor, counter, backs], near=np.array([2.1, 0.9])) is None  # too sparse: no table, not the counter
print("TABLE SCALE TEST OK (SYNTHETIC)")

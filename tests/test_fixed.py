"""grid.fixed (stage 6 / 12 stamp_fixed): a hand outline fills solid inside, leaves the rest of the obstacle map alone.
Run: .venv/bin/python tests/test_fixed.py"""
import importlib, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
occ = importlib.import_module("stages.06_occupancy")

obst = np.zeros((100, 50), bool); obst[0, 0] = True               # 2 x 1 m at 2 cm, one existing obstacle cell
g = {"cell_m": 0.02, "fixed": [{"name": "bench", "poly_xy": [[0.5, 0.2], [1.0, 0.2], [1.0, 0.6], [0.5, 0.6]]}]}
occ.stamp_fixed(g, np.array([0.0, 0.0]), obst.shape, obst)
assert obst[25:50, 10:30].all(), "inside the outline not solid"
assert obst[0, 0] and obst.sum() <= 26 * 21 + 1, f"{obst.sum()} cells: stamped outside the outline"
assert not obst[60:, :].any() and not obst[:, 35:].any()
occ.stamp_fixed({"cell_m": 0.02}, np.array([0.0, 0.0]), obst.shape, obst)   # no grid.fixed: a no-op
print("test_fixed: OK", int(obst.sum()), "cells")

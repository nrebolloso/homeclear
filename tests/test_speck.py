"""Stage 6 opt-in noise rules: speck.min_points drops a small patch of a few Gaussians "spanning" a metre (a floor-noise point
under an air floater) but keeps a thin post with many; grid.no_bumps reports no bumps. Run: .venv/bin/python tests/test_speck.py"""
import importlib, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
occ = importlib.import_module("stages.06_occupancy")

rng = np.random.default_rng(0)
floor = np.c_[rng.uniform(0, 2, (20000, 2)), rng.normal(0, 0.002, 20000)]
fake = np.array([[0.51, 0.51, 0.06], [0.51, 0.51, 1.2]])                                  # 2 Gaussians, 1 cell, 1.14 m apart
post = np.c_[np.full((40, 2), 1.51), np.linspace(0.06, 1.0, 40)]                             # 40 Gaussians up a 1-cell post
rug = np.c_[rng.uniform(1.2, 1.6, (2000, 1)), rng.uniform(0.2, 0.6, (2000, 1)), np.full((2000, 1), 0.01)]
p = np.r_[floor, fake, post, rug]
g = {"cell_m": 0.02, "obstacle_z": [0.05, 1.8], "bump_z": [0.004, 0.05], "min_count": 2, "floor_band_m": 0.015,
     "floor_local_m": 1.0, "floor_close_cells": 2, "speck": {"max_cells": 6, "min_span_m": 0.1, "floor_gap_m": 0.04}}
lo, shape = np.array([0.0, 0.0]), (100, 100)
cell = lambda x, y: (int(x / 0.02), int(y / 0.02))
ob = occ.layers(p, g, lo, shape)[1]
assert ob[cell(0.51, 0.51)] and ob[cell(1.51, 1.51)], "without min_points both stay (the span hides the fake one)"
g["speck"]["min_points"] = 6
_, ob, bumps, _, _ = occ.layers(p, g, lo, shape)
assert not ob[cell(0.51, 0.51)], "2 Gaussians a metre apart kept as an obstacle"
assert ob[cell(1.51, 1.51)], "a thin post with 40 Gaussians dropped"
assert bumps[cell(1.4, 0.4)], "the rug should read as a bump"
assert not occ.layers(p, {**g, "no_bumps": "noisy floor"}, lo, shape)[2].any(), "no_bumps still reports bumps"
print("ok")

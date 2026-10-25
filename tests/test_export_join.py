"""Stage 12 joined(): unlabelled pieces touching an object's labels (3 cm voxels) go with it; a piece across a gap does not."""
import importlib
import sys
from pathlib import Path

import numpy as np

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "stages")]
e = importlib.import_module("12_export_scene")

# a labelled seed, a chain of unlabelled points touching it, then a 10 cm gap and an island
x = np.r_[0.0, 0.02, 0.04, 0.06, 0.16, 0.18]
xyz = np.c_[x, np.zeros_like(x), np.zeros_like(x)]
seed = np.array([1, 0, 0, 0, 0, 0], bool)
cand = np.array([0, 1, 1, 1, 1, 1], bool)
got = e.joined(xyz, seed, cand)
assert got.tolist() == [False, True, True, True, False, False], got
# a candidate is only joined through seed or candidate points, never through a point that is neither
cand2 = np.array([0, 1, 0, 1, 0, 0], bool)
assert e.joined(xyz, seed, cand2).tolist() == [False, True, False, False, False, False]
print("ok: joined keeps touching pieces, drops pieces across a gap")

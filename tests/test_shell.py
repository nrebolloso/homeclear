"""Room shell on the synthetic game scene (known walls) + its depth render.
  .venv/bin/python tests/test_shell.py      (needs tests/make_game_scene.py first: out/game_synth/splat_aligned.ply)"""
import importlib, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "cosmos")]
from common import read_ply, ply_xyz, solid_mask
shell_mod = importlib.import_module("05c_shell")
from shell_depth import shell_depth, WALL, FLOOR, CEILING
look_at = importlib.import_module("09_fix_render").look_at

v = read_ply(ROOT / "out/game_synth/splat_aligned.ply")
sh = shell_mod.fit_shell(ply_xyz(v), solid_mask(v), shell_mod.normals(v))
assert abs(sh["angle_deg"]) < 1 or abs(sh["angle_deg"] - 90) < 1, sh["angle_deg"]   # the synthetic house is axis-aligned
xs = sorted({round(w["a"][0], 2) for w in sh["walls"] if abs(w["a"][0] - w["b"][0]) < 0.03})
ys = sorted({round(w["a"][1], 2) for w in sh["walls"] if abs(w["a"][1] - w["b"][1]) < 0.03})
near = lambda vals, want: min(abs(x - want) for x in vals) < 0.04
for want in (0.0, 4.0, 6.5):        # bedroom west wall face, the wall with the doorway, bathroom east wall
    assert near(xs, want), (want, xs)
for want in (0.0, 4.0):             # south wall, bedroom north wall
    assert near(ys, want), (want, ys)
assert sh["ceiling_assumed"] and sh["ceiling_z"] == 2.4, sh   # the synthetic scene has no ceiling

# from the middle of the bedroom looking at the north wall: wall straight ahead at ~1.8 m, floor below, ceiling above
w2c = look_at(np.array([2.0, 2.2, 1.4]), np.array([2.0, 4.0, 1.4]))
K = [[100, 0, 160], [0, 100, 120], [0, 0, 1]]   # wide: the bottom row hits the floor, the top row the ceiling
depth, label = shell_depth(w2c, K, 320, 240, sh)
assert label[120, 160] == WALL and abs(depth[120, 160] - 1.8) < 0.06, (label[120, 160], depth[120, 160])
assert label[239, 160] == FLOOR and label[0, 160] == CEILING, (label[239, 160], label[0, 160])
print("SHELL OK", {"walls": len(sh["walls"]), "x": xs, "y": ys, "ceiling": sh["ceiling_z"]})

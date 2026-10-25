"""Fill backends on the synthetic game scene: the bed's hidden floor comes back floor-coloured, its headboard wall
wall-coloured, and every fill is flat, in the floor frame, where the footprint was.
  .venv/bin/python tests/test_fills.py      (after tests/make_game_scene.py)"""
import importlib, json, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages")]
from common import read_ply, ply_xyz
fills = importlib.import_module("12b_fills")
from make_game_scene import COLORS

rep = fills.main(str(ROOT / "out/game_synth/config.yaml"), ["median", "telea", "ns"])
sc = json.loads((ROOT / "viewer/public/scene/game_synth/scene.json").read_text())
bed = next(o for o in sc["objects"] if o["name"] == "bed")
assert set(bed["fills"]) == {"median", "telea", "ns"} and bed["fill"].endswith("_ns.ply"), bed
assert rep["bed"]["wall_patch"], "the bed's head stands against the north wall: its patch of wall gets a fill too"
for b in ("telea", "ns"):
    v = read_ply(ROOT / "viewer/public/scene/game_synth" / bed["fills"][b])
    xyz, rgb = ply_xyz(v), fills.rgb_of(v)
    floor = np.isclose(xyz[:, 2], fills.FILL_Z)
    assert abs(floor.sum() - 1.6 * 2.05 / 1e-4) / (1.6 * 2.05 / 1e-4) < 0.15, floor.sum()    # one Gaussian per cm² of footprint
    assert np.abs(np.median(rgb[floor], 0) - COLORS["floor"]).max() < 0.08, np.median(rgb[floor], 0)
    wall = xyz[:, 2] > 0.05
    want = np.array(COLORS["wall"]) * 0.74          # make_game_scene shades faces facing y by 0.74
    assert wall.sum() > 1000 and np.abs(np.median(rgb[wall], 0) - want).max() < 0.1, (wall.sum(), np.median(rgb[wall], 0))
    assert np.abs(xyz[wall, 1] - 4.0).max() < 0.03, "the wall patch lies on the wall plane"
print("FILLS OK", {k: v["default"] for k, v in rep.items()})

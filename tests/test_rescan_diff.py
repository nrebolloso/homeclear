"""Re-scan diff on the synthetic scene: the "after" capture is the same room with the rug and cable gone, filmed in a
frame turned 7 degrees and shifted. The diff must find the turn, call the bump hazard resolved, keep the doorway
squeeze as remaining, and see a new box dropped on the route.
  .venv/bin/python tests/test_rescan_diff.py      (after tests/make_game_scene.py)"""
import importlib, shutil, sys
from pathlib import Path
import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "tests")]
from common import read_ply, write_ply, ply_xyz
diff = importlib.import_module("14_rescan_diff")
from make_game_scene import write_splat, box_surface

src, dst = ROOT / "out/game_synth", ROOT / "out/rescan_after"
shutil.rmtree(dst, ignore_errors=True)
dst.mkdir(parents=True)
v = read_ply(src / "splat_aligned.ply")
xyz = ply_xyz(v)
inb = lambda lo, hi: np.all((xyz[:, :2] >= lo) & (xyz[:, :2] <= hi), 1) & (xyz[:, 2] > 0.001) & (xyz[:, 2] < 0.05)
keep = ~inb([2.38, 0.88], [3.52, 2.32]) & ~inb([3.6, 0.28], [3.68, 2.72])            # rug and cable taken away
after = v[keep].copy()
# the floor under the old rug, now visible, and a laundry basket put down on the route
fx, fy = np.meshgrid(np.arange(2.4, 3.5, 0.02), np.arange(0.9, 2.3, 0.02), indexing="ij")
floor = np.stack([fx.ravel(), fy.ravel(), np.zeros(fx.size)], 1)
basket = box_surface([4.75, 1.4, 0.0], [4.95, 1.6, 0.03], 0.01)   # in the bathroom, on the route
extra_p = np.concatenate([floor, basket])
extra = np.zeros(len(extra_p), v.dtype)
extra["x"], extra["y"], extra["z"] = extra_p.T
for k in range(3):
    extra[f"f_dc_{k}"], extra[f"scale_{k}"] = 0.3, np.log(0.014 if k < 2 else 0.002)
extra["opacity"], extra["rot_0"] = 4.0, 1.0
after = np.concatenate([after, extra])
a = np.radians(7.0)
R, t = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]]), np.array([0.3, -0.2])
p = ply_xyz(after)
after["x"], after["y"] = (p[:, :2] @ R.T + t).T
write_ply(dst / "splat_aligned.ply", after)
cfg = yaml.safe_load((src / "config.yaml").read_text())
cfg.update(run_name="rescan_after", work_dir="out/rescan_after")
(dst / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False))

res = diff.main(str(src / "config.yaml"), str(dst / "config.yaml"))
al = res["alignment"]
assert abs(al["yaw_deg"] + 7.0) < 0.5 and al["inlier_share"] > 0.5, al          # after -> before turns back 7 degrees
st = {i["type"]: i["status"] for i in res["items"]}
assert st == {"floor_bump": "resolved", "tight_clearance": "remaining"}, res["items"]
assert any(abs(n["position_m"][0] - 4.85) < 0.25 and abs(n["position_m"][1] - 1.5) < 0.25 for n in res["new"]), res["new"]
print("RESCAN DIFF OK", al, st, f"{len(res['new'])} new")

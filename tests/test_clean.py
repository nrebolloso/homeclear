"""Stage 5b on the synthetic game room with injected junk (SYNTHETIC): it must drop the junk and keep the room.
Run: .venv/bin/python tests/test_clean.py   -> prints before/after counts, writes out/clean_test/clean.json"""
import importlib, json, shutil, sys
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "tests")]
from common import load_cfg, read_ply
from make_game_scene import scene, write_splat

rng = np.random.default_rng(1)
pts, rgb, size = scene(0.80)
n_room = len(pts)
junk = {  # what a real capture leaves behind
    "isolated": rng.uniform([0, 0, 0.3], [6.5, 4, 2.3], (1500, 3)),          # floaters in the air of the room
    "transparent": rng.uniform([0, 0, 0.3], [6.5, 4, 2.3], (500, 3)),
    "oversized": rng.uniform([0, 0, 0.3], [6.5, 4, 2.3], (300, 3)),
    "outside": rng.uniform([-6, -6, -2], [12, 10, 6], (3000, 3)),            # background beyond the walls
}
junk["outside"] = junk["outside"][(junk["outside"][:, :2] < -0.7).any(1) | (junk["outside"][:, :2] > [7.2, 4.7]).any(1)
                                  | (junk["outside"][:, 2] < -0.2) | (junk["outside"][:, 2] > 3.0)]
P = np.concatenate([pts] + list(junk.values()))
C = np.concatenate([rgb, rng.uniform(0, 1, (len(P) - n_room, 3))])
S = np.concatenate([size, np.full((len(P) - n_room, 3), 0.02)])
o = np.cumsum([n_room] + [len(j) for j in junk.values()])
S[o[2]:o[3]] = 0.9                                                          # oversized
work = ROOT / "out" / "clean_test"
shutil.rmtree(work, ignore_errors=True)
work.mkdir(parents=True)
write_splat(work / "splat_aligned.ply", P, C, S)
v = read_ply(work / "splat_aligned.ply").copy()   # read_ply memory-maps the file it then overwrites
v["opacity"][o[1]:o[2]] = -4.0                                              # sigmoid -> 0.018: transparent
from common import write_ply
write_ply(work / "splat_aligned.ply", v)
cfg_y = yaml.safe_load((ROOT / "config.yaml").read_text())
cfg_y.update(run_name="clean_test", work_dir="out/clean_test")
(work / "config.yaml").write_text(yaml.safe_dump(cfg_y))
cfg = load_cfg(work / "config.yaml")
ok, m = importlib.import_module("05b_clean").main(cfg)
kept = read_ply(work / "splat_aligned.ply")
key = lambda a: set(map(tuple, np.round(np.stack([a["x"], a["y"], a["z"]], 1), 5)))
kk = key(kept)
room_kept = len(key(v[:n_room]) & kk) / len(key(v[:n_room]))
junk_left = {k: len(key(v[a:b]) & kk) for k, a, b in zip(junk, o[:-1], o[1:])}
from scipy.spatial import cKDTree
left_iso = np.array(sorted(key(v[o[0]:o[1]]) & kk))
gap = cKDTree(pts).query(left_iso)[0] if len(left_iso) else np.zeros(0)   # surviving floaters: how far from a real surface
print(json.dumps({"SYNTHETIC": True, "room_gaussians": n_room, "room_kept_pct": round(100 * room_kept, 2),
                  "junk_injected": {k: len(j) for k, j in junk.items()}, "junk_left": junk_left,
                  "isolated_left_max_dist_to_surface_cm": round(100 * float(gap.max(initial=0)), 1), "stage": m}, indent=1))
assert ok and room_kept > 0.99, room_kept
assert junk_left["transparent"] == junk_left["oversized"] == junk_left["outside"] == 0, junk_left
assert (gap < 0.10).all(), gap.max()   # floaters left are within 10 cm of a wall/object: in the surface, not in the walk's air
print("CLEAN TEST OK")

# what the floaters do to measurements: the same accuracy check (known dimensions) on maps built before and after 5b
import subprocess
from make_game_scene import GROUND_TRUTH
acc = {}
for tag, ply in (("before", "splat_aligned_raw.ply"), ("after", "splat_aligned.ply")):
    d = ROOT / "out" / f"clean_test_{tag}"
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    shutil.copy(work / ply, d / "splat_aligned.ply")
    c = {**cfg_y, "run_name": f"clean_test_{tag}", "work_dir": f"out/clean_test_{tag}", "accuracy": {"ground_truth": GROUND_TRUTH}}
    (d / "config.yaml").write_text(yaml.safe_dump(c))
    for s in ("06_occupancy", "06b_accuracy"):
        subprocess.run([sys.executable, str(ROOT / "stages" / f"{s}.py"), str(d / "config.yaml")], check=True, capture_output=True)
    acc[tag] = json.loads((d / "accuracy.json").read_text())
rows = [{"name": b["name"], "truth_m": b["truth_m"], "before_m": b["measured_m"], "after_m": a["measured_m"]}
        for b, a in zip(acc["before"]["checks"], acc["after"]["checks"])]
(work / "accuracy_before_after.json").write_text(json.dumps({"SYNTHETIC": True, "rows": rows,
    "max_error_m": {t: acc[t]["max_error_m"] for t in acc}, "margin_m": {t: acc[t]["margin_m"] for t in acc}}, indent=1))
print(json.dumps(rows, indent=1), {t: acc[t]["max_error_m"] for t in acc})
assert acc["after"]["max_error_m"] <= acc["before"]["max_error_m"], acc
print("CLEAN ACCURACY OK")

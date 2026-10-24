"""Stage 6c without the models: masks drawn by projecting the synthetic bed and nightstand into the synthetic cameras
(as a perfect detector would) must vote their Gaussians into a bed / nightstand proposal with the right footprint, and
nothing else may come out.  .venv/bin/python tests/test_detect_vote.py   (after tests/make_game_scene.py)"""
import importlib, json, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages")]
from common import read_ply, ply_xyz, solid_mask
det = importlib.import_module("06c_detect")

w = ROOT / "out/game_synth"
v = read_ply(w / "splat_aligned.ply")
xyz = ply_xyz(v)[solid_mask(v)]
labels = list(det.VOCAB)
BOXES = {"bed": ([0.1, 1.9, 0], [1.7, 3.95, 0.55]), "nightstand": ([1.8, 3.45, 0], [2.3, 3.95, 0.6])}
inside = lambda p, lo, hi: np.all((p >= np.array(lo) - 0.01) & (p <= np.array(hi) + 0.01), 1)
frames = []
for c in json.loads((w / "cameras.json").read_text())[::3]:
    w2c, K, W, H = np.array(c["w2c"]), np.array(c["K"]), c["width"], c["height"]
    vis, u, vv = det.zbuffer_visible(xyz, w2c, K, W, H)
    masks = []
    for name, (lo, hi) in BOXES.items():
        m = np.zeros((H, W), bool)
        sel = vis & inside(xyz, lo, hi)
        m[np.clip(vv[sel], 0, H - 1).astype(int), np.clip(u[sel], 0, W - 1).astype(int)] = True
        import cv2
        m = cv2.dilate(m.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0   # a detector's mask is solid, not dotted
        if m.any():
            masks.append((labels.index(name), m))
    frames.append({"w2c": w2c, "K": K, "width": W, "height": H, "masks": masks})
lab = det.vote(xyz, frames, labels)
prop = det.propose(xyz, lab, labels, shell=json.loads((w / "shell.json").read_text()))
names = sorted(e["kind"] for e in prop["objects"])
assert names == ["bed", "nightstand"], prop
for e in prop["objects"]:
    lo, hi = BOXES[e["kind"]]
    (x0, y0), (x1, y1) = e["box_xy"]
    assert abs(x0 - lo[0]) < 0.08 and abs(y0 - lo[1]) < 0.08 and abs(x1 - hi[0]) < 0.08 and abs(y1 - hi[1]) < 0.08, (e["kind"], e["box_xy"])
    assert abs(e["z_max"] - hi[2]) < 0.06, (e["kind"], e["z_max"])
print("DETECT VOTE OK", {e["kind"]: e["box_xy"] for e in prop["objects"]})

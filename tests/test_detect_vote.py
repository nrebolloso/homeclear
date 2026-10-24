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

# instances(): a chair pushed against a table, both labelled (with some table-mask spill onto the chair), plus a second
# chair apart from both -> three objects, the touching chair not taken by the table
rng = np.random.default_rng(0)
box = lambda lo, hi, n: rng.uniform(lo, hi, (n, 3))
tab = np.r_[box([0, 0, 0.70], [1.2, 0.8, 0.74], 6000), *[box([x, y, 0], [x + .04, y + .04, .7], 300) for x in (0, 1.16) for y in (0, .76)]]
ch = lambda x0: np.r_[box([x0, 0.2, 0.42], [x0 + .4, 0.6, 0.45], 2500), box([x0 + .37, 0.2, 0.45], [x0 + .4, 0.6, 0.9], 1500)]
p3 = np.r_[tab, ch(-0.39), ch(-1.5)]
li = np.r_[np.full(len(tab), labels.index("table")), np.full(8000, labels.index("chair"))]
li[len(tab):len(tab) + 300] = labels.index("table")   # spill
inst, _ = det.instances(p3, li, [])
n_tab, a, b = inst[0], inst[len(tab) + 1000], inst[-1]
assert len({n_tab, a, b}) == 3 and (inst[len(tab):len(tab) + 4000] == a).mean() > 0.95, np.unique(inst, return_counts=True)
print("DETECT VOTE OK", {e["kind"]: e["box_xy"] for e in prop["objects"]})

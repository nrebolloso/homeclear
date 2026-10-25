"""Cap the longest Gaussians of an exported scene, for rendering. A scanned railing is a few very elongated splats; seen from
close by they read as black streaks across the stairs (up to 1.2 m on kitchen4). This shortens only the longest axis of a
needle (longer than --cap and --aspect times its middle axis) down to --cap. Centres, opacity, colour and the other two
axes are untouched, so nothing measured from the splat (rail band, tread heights) moves; only how far the stretched
Gaussian reaches on screen. Visual only: run it on a COPY of a scene folder, never on the shared export.

  python tools/cap_needles.py viewer/public/scene/<run_copy> [--cap 0.45] [--aspect 6] [--dry-run]

The original is kept once as main.ply.orig next to it.
"""
import argparse, gc, shutil, sys
from pathlib import Path
sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from common import read_ply, write_ply

import numpy as np


def cap_needles(v, cap=0.45, aspect=6.0):
    """Returns (a copy of v with the needles shortened, how many). v: a structured array in the 3DGS layout (log scales)."""
    s = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1).astype(np.float64))
    order = np.argsort(s, 1)                                  # per Gaussian: shortest, middle, longest axis index
    rows = np.arange(len(v))
    longest, middle = s[rows, order[:, 2]], s[rows, order[:, 1]]
    needle = (longest > cap * 1.001) & (longest > aspect * np.maximum(middle, 1e-6))   # the margin: a capped one stored as float32 reads back a hair over
    out = v.copy()
    for k in range(3):
        sel = needle & (order[:, 2] == k)
        out[f"scale_{k}"][sel] = np.log(cap)
    return out, int(needle.sum())


def main(scene_dir, cap=0.45, aspect=6.0, dry=False):
    d = Path(scene_dir)
    ply = d / "main.ply"
    v = np.array(read_ply(ply))   # a real copy: read_ply memory-maps the file, and Windows will not overwrite a mapped file
    gc.collect()
    out, n = cap_needles(v, cap, aspect)
    print(f"{n} of {len(v)} Gaussians are needles (longer than {cap} m and {aspect}x their middle axis)")
    if dry or not n:
        return n
    if not (d / "main.ply.orig").exists():
        shutil.copy2(ply, d / "main.ply.orig")
    write_ply(ply, out)
    print(f"capped to {cap} m in {ply}")
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("scene_dir")
    ap.add_argument("--cap", type=float, default=0.45)
    ap.add_argument("--aspect", type=float, default=6.0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    main(a.scene_dir, a.cap, a.aspect, a.dry_run)

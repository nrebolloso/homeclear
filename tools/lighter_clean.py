"""Viewer-only scene with a much lighter clean than stage 5b: stage 5b's opacity cut leaves black holes in floors and walls
(the many faint Gaussians hold their colour), so this keeps everything except lone Gaussians (fewer than 4 others in their
15 cm block, mostly far-off junk) above the floor band, and anything above the ceiling. Measurements use stage 5b.
The movable objects are cut out of this splat the same way stage 12 cuts them (its object_parts), so they still move/delete.
  python tools/lighter_clean.py <config.yaml> [--raw]   -> viewer/public/scene/<run>_lighter (or <run>_raw: nothing removed)
Run after stage 12 (copies its grids and scene.json).
"""
import json, shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, write_ply, ply_xyz
import importlib
export = importlib.import_module("stages.12_export_scene")

import numpy as np
import yaml

VOX, MIN_NEIGHBOURS, FLOOR_BAND_M = 0.05, 4, 0.3


def neighbours(p):
    """Gaussians in each one's 3x3x3 voxel block, counted sparsely (far background makes a dense grid too big)."""
    q = np.floor(p / VOX).astype(np.int64)
    q -= q.min(0) - 1
    key = lambda a: (a[:, 0] << 42) + (a[:, 1] << 21) + a[:, 2]
    u, cnt = np.unique(key(q), return_counts=True)
    n = np.zeros(len(q), np.int64)
    for o in np.stack(np.meshgrid(*[[-1, 0, 1]] * 3), -1).reshape(-1, 3):
        k = key(q + o)
        i = np.clip(np.searchsorted(u, k), 0, len(u) - 1)
        n += np.where(u[i] == k, cnt[i], 0)
    return n


def main():
    cfg = yaml.safe_load(open(sys.argv[1]))
    raw = "--raw" in sys.argv
    run, ceiling = cfg["run_name"], cfg["clean"]["ceiling_m"]
    v = read_ply(Path(cfg["work_dir"]) / "splat_aligned_raw.ply")
    p = ply_xyz(v)
    drop = np.zeros(len(v), bool) if raw else ((neighbours(p) < MIN_NEIGHBOURS) & (p[:, 2] > FLOOR_BAND_M)) | (p[:, 2] > ceiling)
    name = f"{run}_{'raw' if raw else 'lighter'}"
    src, dst = Path("viewer/public/scene") / run, Path("viewer/public/scene") / name
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    (dst / "removed.ply").unlink(missing_ok=True)
    s = json.loads((dst / "scene.json").read_text())
    grid = json.loads((Path(cfg["work_dir"]) / "grid.json").read_text())
    taken = np.zeros(len(v), bool)
    for o, so in zip(cfg["game"]["objects"], s["objects"]):   # same order as stage 12 wrote them
        sel = ~drop & ~taken & export.object_parts(o, p, cfg["grid"], Path(cfg["work_dir"]), np.array(grid["origin_xy"]), grid["cell_m"], tuple(grid["shape"]))
        taken |= sel
        ov = v[sel].copy()
        ov["x"], ov["y"] = ov["x"] - so["pivot"][0], ov["y"] - so["pivot"][1]
        write_ply(dst / so["splat"], ov)
    write_ply(dst / "main.ply", v[~drop & ~taken])
    s.update(run=name, removed_splat=None)
    (dst / "scene.json").write_text(json.dumps(s, indent=1))
    print(f"{dst}: kept {int((~drop).sum())} of {len(v)} Gaussians")


if __name__ == "__main__":
    assert (neighbours(np.array([[0, 0, 0], [0.01, 0, 0], [5, 5, 5.]])) == [2, 2, 1]).all()   # self-check
    main()

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
freespace = importlib.import_module("tools.freespace")

import numpy as np
import yaml
from scipy.spatial import cKDTree

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


def in_box(p, b):
    """Points inside box b = {center: [x,y,z], size: [lx,ly,lz], yaw_deg} (floor frame, size along its own yawed axes)."""
    c, s, a = np.array(b["center"], float), np.array(b["size"], float), np.radians(b.get("yaw_deg", 0))
    d = p - c
    loc = np.c_[d[:, 0] * np.cos(a) + d[:, 1] * np.sin(a), -d[:, 0] * np.sin(a) + d[:, 1] * np.cos(a), d[:, 2]]
    return (np.abs(loc) <= s / 2).all(1)


def crop_air_drop(v, p, clean, grid):
    """Gaussians that show as blobs from above: past the floor grid + lighter_crop_m (background seen through doors), and
    faint/large haze above the floor band (lighter_air: {min_opacity, max_scale_m})."""
    drop = np.zeros(len(v), bool)
    crop, air = clean.get("lighter_crop_m"), clean.get("lighter_air")
    if crop is not None:
        lo = np.array(grid["origin_xy"]); hi = lo + np.array(grid["shape"]) * grid["cell_m"]
        drop |= ((p[:, :2] < lo - crop) | (p[:, :2] > hi + crop)).any(1)
    if air:
        op, big_s = 1 / (1 + np.exp(-v["opacity"])), np.exp(np.stack([v[f"scale_{i}"] for i in range(3)], 1)).max(1)
        drop |= (p[:, 2] > FLOOR_BAND_M) & ((op < air["min_opacity"]) | (big_s > air["max_scale_m"]))
    return drop


def main():
    cfg = yaml.safe_load(open(sys.argv[1]))
    raw = "--raw" in sys.argv
    run, ceiling = cfg["run_name"], cfg["clean"]["ceiling_m"]
    v = read_ply(Path(cfg["work_dir"]) / "splat_aligned_raw.ply")
    p = ply_xyz(v)
    drop = np.zeros(len(v), bool) if raw else ((neighbours(p) < MIN_NEIGHBOURS) & (p[:, 2] > FLOOR_BAND_M)) | (p[:, 2] > ceiling)
    if not raw and cfg["clean"].get("lighter_camera_clear_m"):   # fog in the air the phone moved through (freespace.py)
        drop |= cKDTree(freespace.camera_path(Path(cfg["work_dir"]))).query(p)[0] < cfg["clean"]["lighter_camera_clear_m"]
    big = cfg["clean"].get("lighter_big_above")   # {z, scale_m}: streaks in air the capture never filmed (an upper floor's ceiling)
    if not raw and big:
        drop |= (p[:, 2] > big["z"]) & (np.exp(np.stack([v[f"scale_{i}"] for i in range(3)], 1)).max(1) > big["scale_m"])
    grid = json.loads((Path(cfg["work_dir"]) / "grid.json").read_text())
    if not raw:
        drop |= crop_air_drop(v, p, cfg["clean"], grid)
    mid = np.sort(np.exp(np.stack([v[f"scale_{i}"] for i in range(3)], 1)), 1)[:, 1]
    for b in [] if raw else cfg["clean"].get("lighter_drop_boxes", []):   # hand-placed boxes of haze no rule catches
        drop |= in_box(p, b) & (mid >= b.get("min_mid_scale_m", 0))   # discs only: keeps thin real parts (rails) in the box
    name = f"{run}_{'raw' if raw else 'lighter'}"
    src, dst = Path("viewer/public/scene") / run, Path("viewer/public/scene") / name
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    (dst / "removed.ply").unlink(missing_ok=True)
    s = json.loads((dst / "scene.json").read_text())
    taken = np.zeros(len(v), bool)
    exported = {so["name"]: so for so in s["objects"]}   # stage 12 skips objects it found no Gaussians for
    for o, so in [(o, exported[o["name"]]) for o in export.config_objects(cfg["game"], cfg["work_dir"]) if o["name"] in exported]:
        sel = ~drop & ~taken & export.object_parts(o, p, cfg["grid"], Path(cfg["work_dir"]), np.array(grid["origin_xy"]), grid["cell_m"], tuple(grid["shape"]), v)
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
    assert (in_box(np.array([[0.9, 0.9, 0], [0, 1.4, 0], [1.4, 0, 0.]]), {"center": [0, 0, 0], "size": [3, 0.4, 1], "yaw_deg": 45}) == [1, 0, 0]).all()
    main()

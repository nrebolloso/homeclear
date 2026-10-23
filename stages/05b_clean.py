"""Stage 5b: clean the aligned splat for the walk-through. Drops near-invisible and oversized Gaussians, everything
outside the room (floor extent + margin, below the floor, above the ceiling), and isolated floaters (Gaussians in
nearly empty space). splat_aligned.ply is rewritten; the original is kept as splat_aligned_raw.ply and the dropped
Gaussians go to removed.ply (the viewer can show them for a before/after). Measurement stages use solid_mask on top.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, write_ply, ply_xyz, solid_mask

import numpy as np
from scipy import ndimage


def main(cfg):
    w, c, g = cfg["work"], cfg["clean"], cfg["grid"]
    raw = w / "splat_aligned_raw.ply"
    if not raw.exists():   # re-runs clean the original, never an already-cleaned splat
        (w / "splat_aligned.ply").rename(raw)
    v = read_ply(raw)
    p = ply_xyz(v)
    op = 1 / (1 + np.exp(-v["opacity"]))
    big = np.exp(np.max(np.stack([v[f"scale_{i}"] for i in range(3)], 1), 1))
    floor = p[solid_mask(v, min_opacity=g.get("min_opacity", 0.3)) & (np.abs(p[:, 2]) < g["floor_band_m"])]
    lo = np.percentile(floor[:, :2], 0.5, 0) - c["room_margin_m"]
    hi = np.percentile(floor[:, :2], 99.5, 0) + c["room_margin_m"]
    reasons = {
        "transparent": op < c["min_opacity"],
        "oversized": big > c["max_scale_m"],
        "outside_room": (p[:, :2] < lo).any(1) | (p[:, :2] > hi).any(1) | (p[:, 2] < -c["below_floor_m"]) | (p[:, 2] > c["ceiling_m"]),
    }
    # haze: hand-checked boxes of splat haze with nothing real in them (glass reflections); each box says why in the config
    hz = [(p[:, 0] >= x0) & (p[:, 0] <= x1) & (p[:, 1] >= y0) & (p[:, 1] <= y1) & (p[:, 2] >= z0) & (p[:, 2] <= z1)
          for b in c.get("haze_boxes") or [] for (x0, y0), (x1, y1), (z0, z1) in [(*b["box_xy"], b["z"])]]
    reasons["haze_box"] = np.logical_or.reduce(hz) if hz else np.zeros(len(v), bool)
    keep = ~np.logical_or.reduce(list(reasons.values()))
    # isolated floaters: few other Gaussians in the 3x3x3 voxel block around them
    vox = c["floater_voxel_m"]
    q = np.floor((p[keep] - p[keep].min(0)) / vox).astype(int)
    occ = np.zeros(q.max(0) + 1, np.float32)
    np.add.at(occ, tuple(q.T), 1)
    dens = ndimage.uniform_filter(occ, 3, mode="constant") * 27
    iso = np.zeros(len(v), bool)
    iso[np.flatnonzero(keep)] = dens[tuple(q.T)] < c["floater_min_neighbours"]
    reasons["isolated_floater"] = iso & keep
    keep &= ~iso
    write_ply(w / "splat_aligned.ply", v[keep])
    write_ply(w / "removed.ply", v[~keep])
    m = {"gaussians_before": len(v), "gaussians_after": int(keep.sum()), "removed_pct": round(100 * float(1 - keep.mean()), 1),
         **{f"removed_{k}": int(r.sum()) for k, r in reasons.items()}, "room_box_xy": [lo.round(2).tolist(), hi.round(2).tolist()]}
    (w / "clean.json").write_text(json.dumps(m, indent=1))
    return keep.mean() > 0.5, m


if __name__ == "__main__":
    run_stage("05b_clean", main)

"""Stage 14: did the fixes happen? Film the home again after the family made the changes, run stages 1-5 on that
capture (its own config), then compare it with the first capture hazard by hazard.

  python stages/14_rescan_diff.py <before.yaml> <after.yaml>      -> <before work>/verification.json

1. Align: both splats are floor-aligned (z up, floor z=0), so only x, y and the turn differ. ICP in 2-D on the
   Gaussians of the walls band (0.5-2 m), from 4 starting turns; the best by inlier residual wins.
2. The after-splat is moved into the first capture's frame and gridded with the same cells (stage 6 layers()).
3. Each hazard of the first capture (stage 8) is looked up in the new grids:
     floor bump      resolved (nothing above the bump floor there now) / reduced / remaining (+ the new height)
     tight passage   resolved (clearance now >= the margin) / improved / remaining (+ the new clearance)
   and bumps on the route's corridor that weren't there before come back as "new".
Everything is measured, in both captures; nothing generated is involved. Stage 12 exports the result to the viewer.
"""
import importlib, json, sys
from pathlib import Path
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from common import load_cfg, read_ply, ply_xyz, solid_mask

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

occ = importlib.import_module("06_occupancy")


def wall_points(xyz, n=30000, seed=0):
    p = xyz[(xyz[:, 2] > 0.5) & (xyz[:, 2] < 2.0), :2]
    if len(p) > n:
        p = p[np.random.default_rng(seed).choice(len(p), n, replace=False)]
    return p


def icp2d(src, dst, iters=40):
    """Rigid 2-D transform (R, t) taking src onto dst; best of 4 starting turns. Returns R, t, inlier rms, inlier share."""
    tree, best = cKDTree(dst), None
    for a0 in np.radians([0, 90, 180, 270]):
        R = np.array([[np.cos(a0), -np.sin(a0)], [np.sin(a0), np.cos(a0)]])
        t = dst.mean(0) - src.mean(0) @ R.T
        for it in range(iters):
            cur = src @ R.T + t
            d, k = tree.query(cur)
            keep = d < (0.5 if it < 10 else 0.15 if it < 25 else 0.05)
            if keep.sum() < 50:
                break
            a, b = src[keep], dst[k[keep]]
            ma, mb = a.mean(0), b.mean(0)
            U, _, Vt = np.linalg.svd((a - ma).T @ (b - mb))
            Rn = (U @ Vt).T
            if np.linalg.det(Rn) < 0:
                Vt[-1] *= -1
                Rn = (U @ Vt).T
            R, t = Rn, mb - ma @ Rn.T
        d, _ = tree.query(src @ R.T + t)
        inl = d < 0.05
        score = (inl.mean(), -np.sqrt((d[inl] ** 2).mean()) if inl.any() else -1)
        if best is None or score > best[0]:
            best = (score, R, t, float(np.sqrt((d[inl] ** 2).mean())) if inl.any() else float("inf"), float(inl.mean()))
    return best[1], best[2], best[3], best[4]


def corridor(path_cells, a, b, shape, r):
    m = np.zeros(shape, bool)
    for i, j in path_cells[a:b + 1]:
        m[max(0, i - r):i + r + 1, max(0, j - r):j + r + 1] = True
    return m


def compare(cb, ca):
    wb, wa, g = cb["work"], ca["work"], cb["grid"]
    vb, va = read_ply(wb / "splat_aligned.ply"), read_ply(wa / "splat_aligned.ply")
    pb = ply_xyz(vb)[solid_mask(vb, min_opacity=g.get("min_opacity", 0.3))]
    pa = ply_xyz(va)[solid_mask(va, min_opacity=ca["grid"].get("min_opacity", 0.3))]
    R, t, rms, share = icp2d(wall_points(pa), wall_points(pb))
    pa = np.column_stack([pa[:, :2] @ R.T + t, pa[:, 2]])
    grid = json.loads((wb / "grid.json").read_text())
    lo, cell, shape = np.array(grid["origin_xy"]), grid["cell_m"], tuple(grid["shape"])
    floor_a, obst_a, bumps_a, bump_a, _ = occ.layers(pa, g, lo, shape)
    bumps_b = np.load(wb / "bumps.npy")
    path = json.loads((wb / "path.json").read_text())
    cells = np.array(path["cells"])
    half = cb["plan"]["walker_width_m"] / 2
    r = int(np.ceil(half / cell))
    margin, bmin = cb["hazards"]["clearance_margin_m"], g["bump_z"][0]
    dist_a = ndimage.distance_transform_edt(~(obst_a | ~floor_a)) * cell
    acc = json.loads((wb / "accuracy.json").read_text())["margin_m"] if (wb / "accuracy.json").exists() else {}
    e_h, e_w = (acc.get("height") or 0.003), (acc.get("width") or 0.02)
    items = []
    for h in json.loads((wb / "hazards.json").read_text())["hazards"]:
        a, b = h["path_index"]
        if h["type"] == "floor_bump":
            region = corridor(cells, a, b, shape, r)
            before, after = h["max_bump_height_cm"] / 100, float(bump_a[region].max()) if region.any() else 0.0
            status = "resolved" if after < bmin else "reduced" if after < before - e_h else "remaining"
            items.append({"id": h["id"], "type": h["type"], "position_m": h["position_m"], "before_m": before, "after_m": round(after, 4), "status": status})
        else:
            seg = cells[a:b + 1]
            after = float(dist_a[tuple(seg.T)].min()) - half
            before = h["min_side_clearance_m"]
            status = "resolved" if after >= margin else "improved" if after > before + e_w / 2 else "remaining"
            items.append({"id": h["id"], "type": h["type"], "position_m": h["position_m"], "before_m": before, "after_m": round(after, 3), "status": status})
    route = corridor(cells, 0, len(cells) - 1, shape, r)
    fresh = bumps_a & route & ~ndimage.binary_dilation(bumps_b, iterations=3)
    lab, n = ndimage.label(fresh, np.ones((3, 3)))
    new = []
    for k in range(1, n + 1):
        m = lab == k
        if m.sum() < g.get("bump_min_cells", 4):
            continue
        ij = np.argwhere(m).mean(0)
        new.append({"type": "floor_bump", "status": "new", "after_m": round(float(bump_a[m].max()), 4),
                    "position_m": (lo + (ij + 0.5) * cell).round(3).tolist() + [0.0]})
    return {"alignment": {"yaw_deg": round(float(np.degrees(np.arctan2(R[1, 0], R[0, 0]))), 2), "t_m": np.round(t, 3).tolist(),
                          "inlier_rms_m": round(rms, 4), "inlier_share": round(share, 3)},
            "items": items, "new": new, "after_run": ca["run_name"],
            "note": "both captures measured; status by the map error of the first (stage 6b)"}


def main(before, after):
    cb, ca = load_cfg(before), load_cfg(after)
    res = compare(cb, ca)
    (cb["work"] / "verification.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    return res


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

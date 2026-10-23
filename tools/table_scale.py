"""Metric scale from a tape-measured rectangular table, measured in the floor-aligned splat (stage 5 output, any scale).

The tabletop is the flat horizontal patch nearest the centre of the cameras that orbit it (images named --orbit-from..--orbit-to),
so picking it uses neither its size nor its height. Its long side (minimum-area rectangle of the Gaussians in a thin band
at the tabletop height) gives the scale; the short side and the height above the floor are independent checks.

usage: python tools/table_scale.py <work_dir> --orbit-from 01109 --length 1.5748 --width 1.0414 --height 0.7112
writes <work_dir>/table_scale.json and table_scale.png; set scale.manual_factor to "manual_factor" and rerun stages 4-8.
"""
import argparse, json, sys
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, ply_xyz, solid_mask

CELL = 0.01   # m in the splat's current units


def tabletop(xyz, near, z_lo=0.25, z_hi=2.0, band=0.015, min_area=0.2, min_fill=0.6, max_dist=0.5):
    """Flat horizontal patches (peaks of the height histogram, gap-closed, then opened to drop thin chair backs); the one
    nearest `near` (x, y). Gaps are closed just enough for that patch to fill >= min_fill of its rectangle: a real splat's
    tabletop band is sparse, and closing more than needed bridges chairs pushed in close. The patch must come within
    max_dist of `near` (else a fragmented table loses to the next surface over). Returns dict or None."""
    for k in (3, 5, 7, 9):
        t = _tabletop(xyz, near, z_lo, z_hi, band, min_area, k)
        if t and t["fill"] >= min_fill and t["dist_to_orbit_centre"] < max_dist:
            return t | {"closing_cells": k}
    return None


def _tabletop(xyz, near, z_lo, z_hi, band, min_area, k):
    z = xyz[:, 2]
    hist, edges = np.histogram(z[(z > z_lo) & (z < z_hi)], bins=np.arange(z_lo, z_hi + CELL, CELL))
    hist = ndimage.uniform_filter1d(hist.astype(float), 3)
    peaks = [i for i in range(1, len(hist) - 1) if hist[i] >= hist[i - 1] and hist[i] >= hist[i + 1] and hist[i] > 0.1 * hist.max()]
    best = None
    for i in peaks:
        h = edges[i] + CELL / 2
        p = xyz[np.abs(z - h) < band, :2]
        if len(p) < 50:
            continue
        o = p.min(0)
        ij = ((p - o) / CELL).astype(int)
        m = np.zeros(ij.max(0) + 1, bool)
        m[ij[:, 0], ij[:, 1]] = True
        m = ndimage.binary_closing(m, np.ones((k, k)))                        # fill gaps between Gaussians; keeps the outer edge
        m = ndimage.binary_opening(m, np.ones((7, 7)))                        # drop parts thinner than 7 cm (chair backs, edges)
        lab, n = ndimage.label(m)
        for k in range(1, n + 1):
            c = np.argwhere(lab == k)
            if len(c) * CELL ** 2 < min_area:
                continue
            cxy = c * CELL + o + CELL / 2
            d = np.linalg.norm(cxy - near, axis=1).min()
            if best is None or d < best["dist_to_orbit_centre"]:
                rect = cv2.minAreaRect((cxy / CELL).astype(np.float32))
                (w, hh) = rect[1]
                best = {"height": float(np.median(z[np.abs(z - h) < band])), "length": max(w, hh) * CELL, "width": min(w, hh) * CELL,
                        "fill": len(c) / (w * hh), "area_m2": len(c) * CELL ** 2, "dist_to_orbit_centre": float(d),
                        "rect_px": rect, "cells": cxy, "band_pts": p}
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work"); ap.add_argument("--orbit-from", required=True); ap.add_argument("--orbit-to", default="~")   # last orbit frame (default: all after)
    ap.add_argument("--length", type=float, required=True); ap.add_argument("--width", type=float, required=True)
    ap.add_argument("--height", type=float, required=True); ap.add_argument("--ply", default="splat_aligned.ply")
    a = ap.parse_args()
    w = Path(a.work)
    v = read_ply(w / a.ply)
    xyz = ply_xyz(v)[solid_mask(v, min_opacity=0.1)]
    T = np.array(json.loads((w / "align.json").read_text())["T_colmap_to_floor"])
    cams = json.loads((w / "cameras.json").read_text())
    orbit = [c for c in cams if a.orbit_from <= Path(c["name"]).stem <= a.orbit_to]
    C = np.array([-np.array(c["w2c"])[:3, :3].T @ np.array(c["w2c"])[:3, 3] for c in orbit])
    near = (C @ T[:3, :3].T + T[:3, 3])[:, :2].mean(0)
    t = tabletop(xyz, near)
    assert t, "no flat patch found"
    s_old = json.loads((w / "scale.json").read_text())["scale"]
    c = a.length / t["length"]
    res = {"data": "REAL capture, tape measurements rounded to the inch", "orbit_cameras": len(orbit),
           "tabletop_splat_units": {k: round(t[k], 4) for k in ("length", "width", "height", "fill", "area_m2", "dist_to_orbit_centre", "closing_cells")},
           "scale_before": s_old, "correction": round(c, 5), "manual_factor": s_old * c,
           "check_width_m": {"tape": a.width, "splat": round(t["width"] * c, 4), "err_pct": round(100 * (t["width"] * c / a.width - 1), 2)},
           "check_height_m": {"tape": a.height, "splat": round(t["height"] * c, 4), "err_pct": round(100 * (t["height"] * c / a.height - 1), 2)},
           "check_aspect": {"tape": round(a.length / a.width, 4), "splat": round(t["length"] / t["width"], 4)}}
    (w / "table_scale.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))

    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8, 8))
    ax.plot(*(t["band_pts"] * c).T, ",", color="0.6")
    ax.plot(*(t["cells"] * c).T, ".", color="tab:green", ms=1)
    box = cv2.boxPoints(t["rect_px"]) * CELL * c
    ax.plot(*np.r_[box, box[:1]].T, "r-", lw=1.5, label=f"min-area rectangle {t['length'] * c:.3f} x {t['width'] * c:.3f} m")
    ax.plot(*(C @ T[:3, :3].T + T[:3, 3])[:, :2].T * c, "b.", ms=3, label="orbit cameras")
    ax.plot(*near * c, "b*", ms=12)
    ax.set_title(f"Tabletop band at {t['height'] * c:.3f} m (tape: 0.711 m), after scale correction"); ax.axis("equal"); ax.legend()
    fig.savefig(w / "table_scale.png", dpi=110)


if __name__ == "__main__":
    main()

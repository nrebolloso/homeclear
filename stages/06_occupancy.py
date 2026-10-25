"""Stage 6: top-down grid. Layers: floor (observed floor), obstacles, floor bumps (+ bump height). PNG + .npy."""
import json, sys, warnings
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, ply_xyz, solid_mask
from tools.freespace import camera_path

import cv2
import numpy as np
from scipy import ndimage


def layers(p, g, lo, shape, pf=None, walked=None):
    """Grid layers from solid Gaussian centres p (floor frame): floor, obstacles, bumps, bump height (m), filled floor holes.
    pf: extra (faint) Gaussian centres that count as floor evidence in the floor band only; walked: cells the capture walked."""
    cell = g["cell_m"]
    ij = np.floor((p[:, :2] - lo) / cell).astype(int)
    ok = (ij >= 0).all(1) & (ij < shape).all(1)
    p, ij = p[ok], ij[ok]

    def count(zmin, zmax):
        sel = (p[:, 2] >= zmin) & (p[:, 2] < zmax)
        c = np.zeros(shape, int)
        np.add.at(c, tuple(ij[sel].T), 1)
        return c, sel

    oc, osel = count(*g["obstacle_z"])
    obstacles = oc >= g["min_count"]
    if g.get("speck"):  # small patches that neither stand on the floor nor span any height are splat floaters, not furniture
        sp = g["speck"]
        lab, n = ndimage.label(obstacles, np.ones((3, 3)))
        L, idx = lab[tuple(ij[osel].T)], np.arange(1, n + 1)
        zlo, zhi = ndimage.minimum(p[osel, 2], L, idx), ndimage.maximum(p[osel, 2], L, idx)
        speck = (np.bincount(lab.ravel(), minlength=n + 1)[1:] <= sp["max_cells"]) & (zhi - zlo < sp["min_span_m"]) & (zlo > sp["floor_gap_m"])
        obstacles &= ~np.r_[False, speck][lab]
    # bump heights are measured from the LOCAL floor, not z=0: a gently tilted or warped floor is not a bump
    p = p.copy()
    lf = local_floor(p, ij, g, shape)
    p[:, 2] -= lf[tuple(ij.T)]
    bc, bsel = count(*g["bump_z"])
    bumps = (bc >= g["min_count"]) & ~ndimage.binary_dilation(obstacles, iterations=2)  # furniture bases aren't rugs
    # lone specks are splat noise, not hazards (cells up to one apart count as one patch: sparse splats leave gaps)
    lab, _ = ndimage.label(ndimage.binary_dilation(bumps), np.ones((3, 3)))
    bumps &= (np.bincount(lab[bumps], minlength=lab.max() + 1) >= g.get("bump_min_cells", 4))[lab]
    # rugs hide the floor under them, so bump cells count as observed floor too
    seen = count(-g["floor_band_m"], g["floor_band_m"])[0] > 0
    if pf is not None:
        fij = np.floor((pf[:, :2] - lo) / cell).astype(int)
        fin = (fij >= 0).all(1) & (fij < shape).all(1)
        fij = fij[fin]
        band = np.abs(pf[fin, 2] - lf[tuple(fij.T)]) < g["floor_band_m"]
        seen[tuple(fij[band].T)] = True
    if walked is not None:
        seen |= walked & ~obstacles
    floor = ndimage.binary_closing(seen | bumps, iterations=g["floor_close_cells"])
    # faint floor (few solid Gaussians) leaves holes too big to close; one ringed by floor with nothing standing in it is
    # floor (otherwise an invisible wall in the open). Counted in the metrics as filled_floor_m2.
    lab, n = ndimage.label(ndimage.binary_fill_holes(floor) & ~floor)
    idx = np.arange(1, n + 1)
    ok = (ndimage.sum(np.ones(shape), lab, idx) * cell ** 2 <= g.get("fill_holes_max_m2", 1.0)) & (ndimage.maximum(obstacles, lab, idx) == 0)
    filled = np.r_[False, ok][lab]
    floor |= filled
    bump_h = np.nan_to_num(cell_median(ij[bsel], p[bsel, 2], shape))   # median, not max: one noisy Gaussian isn't the top
    bump_h[~bumps] = 0
    return floor, obstacles, bumps, bump_h, filled


def cell_median(ij, z, shape):
    """Per-cell median of z (NaN where a cell has no points)."""
    c = ij[:, 0] * shape[1] + ij[:, 1]
    o = np.lexsort((z, c))
    c, z = c[o], z[o]
    first = np.flatnonzero(np.r_[True, c[1:] != c[:-1]])
    n = np.diff(np.r_[first, len(c)])
    out = np.full(shape[0] * shape[1], np.nan)
    out[c[first]] = (z[first + (n - 1) // 2] + z[first + n // 2]) / 2
    return out.reshape(shape)


def local_floor(p, ij, g, shape):
    """Floor height per cell, robust to noise, rugs and cables: lower quartile of the floor-band cell medians in blocks
    of floor_local_m (rug edges and cables can fill most of a block), bilinearly interpolated back to cells."""
    sel = np.abs(p[:, 2]) < g["floor_band_m"]
    med = cell_median(ij[sel], p[sel, 2], shape)
    B = max(1, int(round(g.get("floor_local_m", 0.3) / g["cell_m"])))
    nb = -(-np.array(shape) // B)
    pad = np.full(nb * B, np.nan)
    pad[:shape[0], :shape[1]] = med
    with warnings.catch_warnings():   # all-NaN blocks (no floor seen) warn; they're filled just below
        warnings.simplefilter("ignore")
        blk = np.nanpercentile(pad.reshape(nb[0], B, nb[1], B), 25, axis=(1, 3))
    blk[np.isnan(blk)] = np.nanmedian(blk) if np.isfinite(blk).any() else 0.0
    # block centres -> cells
    ci, cj = [(np.arange(n) + 0.5) / B - 0.5 for n in shape]
    return ndimage.map_coordinates(blk, np.meshgrid(ci, cj, indexing="ij"), order=1, mode="nearest")


def classify_thin(g, bumps, bump_h):
    """Thin bumps (cables, cords) are narrower than a splat can measure: classify them and give them the typical height
    from config, flagged as ESTIMATED. Returns the estimated-cell mask."""
    t = g.get("thin") or {}
    est = np.zeros(bumps.shape, bool)
    if not t:
        return est
    # patches as the viewer groups them (grid.ts bumpComponents): cells up to bump_link_cells apart are one patch.
    # Squares of radius r touch iff their centres are <= 2r + 1 cells apart, so a k x k dilation links exactly that.
    link = g.get("bump_link_cells", 1)
    assert link % 2 == 1, "grid.bump_link_cells must be odd"
    patch = ndimage.label(ndimage.binary_dilation(bumps, np.ones((link, link))), np.ones((3, 3)))[0] * bumps
    lab, n = ndimage.label(bumps, np.ones((3, 3)))   # a mapped cable is one contiguous strip
    width = 2 * ndimage.distance_transform_edt(bumps) * g["cell_m"]   # widest inscribed disc, per cell
    for k, sl in enumerate(ndimage.find_objects(lab), 1):
        m = lab[sl] == k
        q = np.argwhere(m) * g["cell_m"]
        length = np.ptp(q @ np.linalg.svd(q - q.mean(0), full_matrices=False)[2][0]) + g["cell_m"] if len(q) > 1 else g["cell_m"]
        alone = (patch == patch[sl][m][0]).sum() == m.sum()   # anything linked to it makes it a rug edge, not a cable
        # long and narrow as a whole, not only cell by cell: a sparse scatter of rug specks has a large area/length
        if alone and width[sl][m].max() <= t["max_width_m"] and length >= t["min_length_m"] and m.sum() * g["cell_m"] ** 2 / length <= t["max_width_m"]:
            est[sl] |= m
    bump_h[est] = t["typical_height_m"]
    return est


def stamp_synthetic(g, lo, shape, floor, obstacles, bumps, bump_h):
    """grid.synthetic: labelled test hazards stamped over the measured layers (a public scene has none of its own).
    They are NOT measurements; stage 12 passes them to the viewer, which draws and labels them as synthetic."""
    for s in g.get("synthetic") or []:
        (i0, j0), (i1, j1) = np.clip(np.round((np.sort(np.array(s["box_xy"], float), 0) - lo) / g["cell_m"]).astype(int), 0, shape)
        if s["kind"] == "bump":
            floor[i0:i1, j0:j1] = bumps[i0:i1, j0:j1] = True
            bump_h[i0:i1, j0:j1] = np.maximum(bump_h[i0:i1, j0:j1], s["height_m"])
        else:
            obstacles[i0:i1, j0:j1] = True


def floor_evidence(w, g, lo, shape):
    """Floor seen other than as solid Gaussians in the band (layers() pf, walked); both opt-in per config. Stage 12 rebuilds
    the grid with the same evidence, else its export walls the walker in again."""
    cell = g["cell_m"]
    # textureless floor (vinyl, concrete) trains as faint Gaussians that 5b drops: in the thin floor band (only) they are
    # floor evidence too, else the walker meets invisible walls on open floor (gator_lounge). Obstacles stay solid-only.
    fo, pf = g.get("floor_min_opacity"), None
    if fo is not None:
        r = read_ply(w / "splat_aligned_raw.ply")
        pf = ply_xyz(r)[solid_mask(r, min_opacity=fo)]
    # the floor under the capture camera is rarely filmed (the phone looks ahead), but the person walked it: a disc of
    # floor_walked_m round the camera path is floor too (obstacles still win: a phone held out over a table opens nothing)
    walked = None
    if g.get("floor_walked_m"):
        ij = np.floor((camera_path(w)[:, :2] - lo) / cell).astype(int)
        ij = ij[(ij >= 0).all(1) & (ij < shape).all(1)]
        walked = np.zeros(shape, bool)
        walked[tuple(ij.T)] = True
        walked = ndimage.distance_transform_edt(~walked) * cell <= g["floor_walked_m"]
    return pf, walked


def main(cfg):
    w, g = cfg["work"], cfg["grid"]
    v = read_ply(w / "splat_aligned.ply")
    p = ply_xyz(v)[solid_mask(v, min_opacity=g.get("min_opacity", 0.3))]
    near_floor = p[np.abs(p[:, 2]) < g["floor_band_m"]]
    lo = np.percentile(near_floor[:, :2], 0.5, 0) - 0.2
    hi = np.percentile(near_floor[:, :2], 99.5, 0) + 0.2
    cell = g["cell_m"]
    shape = tuple(np.ceil((hi - lo) / cell).astype(int))
    pf, walked = floor_evidence(w, g, lo, shape)
    floor, obstacles, bumps, bump_h, filled = layers(p, g, lo, shape, pf, walked)
    stamp_synthetic(g, lo, shape, floor, obstacles, bumps, bump_h)
    est = classify_thin(g, bumps, bump_h)

    for name, a in [("floor", floor), ("obstacles", obstacles), ("bumps", bumps), ("bump_height_m", bump_h), ("bump_estimated", est)]:
        np.save(w / f"{name}.npy", a)
    (w / "grid.json").write_text(json.dumps({"origin_xy": lo.tolist(), "cell_m": cell, "shape": [int(k) for k in shape],
                                             "axes": "array[i, j] = world (x, y) = origin + (i, j) * cell"}))
    img = np.full(shape + (3,), 40, np.uint8)  # unknown = dark grey
    img[floor] = (235, 235, 235)
    img[bumps] = (0, 165, 255)   # orange (BGR)
    img[obstacles] = (60, 60, 60)
    img = np.ascontiguousarray(np.flipud(img.transpose(1, 0, 2)))  # x right, y up
    for x in range(int(np.ceil(lo[0])), int(hi[0]) + 1):  # 1 m gridlines so start/goal can be read off the map
        c = int((x - lo[0]) / cell)
        cv2.line(img, (c, 0), (c, img.shape[0] - 1), (180, 120, 0), 1)
        cv2.putText(img, f"x={x}", (c + 2, img.shape[0] - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 120, 0), 1)
    for y in range(int(np.ceil(lo[1])), int(hi[1]) + 1):
        r = img.shape[0] - 1 - int((y - lo[1]) / cell)
        cv2.line(img, (0, r), (img.shape[1] - 1, r), (180, 120, 0), 1)
        cv2.putText(img, f"y={y}", (2, r - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 120, 0), 1)
    cv2.imwrite(str(w / "occupancy.png"), img)
    m = {"grid_cells": f"{shape[0]}x{shape[1]}", "area_m2": round(float(floor.sum() * cell ** 2), 2),
         "obstacle_pct": round(100 * float(obstacles.mean()), 1), "bump_cells": int(bumps.sum()),
         "max_bump_cm": round(100 * float(bump_h.max()), 1), "estimated_thin_cells": int(est.sum()),
         "filled_floor_m2": round(float(filled.sum() * cell ** 2), 2)}
    return obstacles.any() and obstacles.mean() < 0.9 and m["area_m2"] > 1.0, m


if __name__ == "__main__":
    run_stage("06_occupancy", main)

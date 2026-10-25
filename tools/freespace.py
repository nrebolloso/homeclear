"""Air the capture showed to be empty: the phone (and the head behind it) moved through it, so Gaussians near the camera path
are floaters (3DGS puts fog right in front of the lens). Viewer-only (lighter_clean, config clean.lighter_camera_clear_m);
measurements use stage 5b.
shortcut: a wall or rail the phone brushed closer than the radius loses its near side; keep the radius under the
arm's-length gap a capture keeps from walls (~0.4 m), or carve the head/body volume instead of a ball if that bites.
"""
import json

import numpy as np


def path_points(E, step_m=0.05, max_gap_m=1.0):
    """Camera centres in capture order, filled in between consecutive frames (the phone moved through that air too); a jump
    over max_gap_m is a cut in the video, not a move."""
    fill = [a + np.linspace(0, 1, int(np.linalg.norm(b - a) / step_m) + 2)[:, None] * (b - a)
            for a, b in zip(E[:-1], E[1:]) if np.linalg.norm(b - a) < max_gap_m]
    return np.vstack([E, *fill])


def camera_path(w):
    """Capture camera centres (cameras.json through align.json) in the floor frame, filled along the path."""
    T = np.array(json.loads((w / "align.json").read_text())["T_colmap_to_floor"])
    cams = sorted(json.loads((w / "cameras.json").read_text()), key=lambda c: c["name"])
    return path_points(np.array([(T @ np.r_[-np.array(c["w2c"])[:3, :3].T @ np.array(c["w2c"])[:3, 3], 1])[:3] for c in cams]))


def solid(v):
    """Small opaque Gaussians: the surfaces carve() measures depth against."""
    sc = np.exp(np.stack([v[f"scale_{i}"] for i in range(3)], 1)).max(1)
    return (1 / (1 + np.exp(-v["opacity"])) > 0.5) & (sc < 0.03)


def carve(w, p, surf, every=4, cell_px=16, kth=3, margin_m=0.05, min_views=3, min_frac=0.5):
    """Gaussians the cameras looked through: nearer than the surface at their pixel (the kth-nearest of surf, floor-frame
    points, in a cell_px cell; kth > 1 so a lone floater can't be the surface) by margin_m, in at least min_views views and
    min_frac of the views that had a surface there. Every every-th capture camera. Thin real parts in front of a wall
    hold their own cell's depth, so they stay; faint haze in front of solid surfaces goes."""
    T = np.array(json.loads((w / "align.json").read_text())["T_colmap_to_floor"])
    s, Ti = abs(np.linalg.det(T[:3, :3])) ** (1 / 3), np.linalg.inv(T)
    cams = sorted(json.loads((w / "cameras.json").read_text()), key=lambda c: c["name"])[::every]
    seen, through = np.zeros(len(p), np.int32), np.zeros(len(p), np.int32)
    for c in cams:
        M = np.array(c["w2c"]) @ Ti   # floor frame -> camera (colmap units; * s = metres)
        K, nx, ny = np.array(c["K"]), -(-c["width"] // cell_px), -(-c["height"] // cell_px)

        def cell(q):
            X = q @ M[:3, :3].T + M[:3, 3]
            z = X[:, 2] * s
            with np.errstate(divide="ignore", invalid="ignore"):
                u, vv = K[0, 0] * X[:, 0] / X[:, 2] + K[0, 2], K[1, 1] * X[:, 1] / X[:, 2] + K[1, 2]
            ok = (z > 0.1) & (u >= 0) & (u < c["width"]) & (vv >= 0) & (vv < c["height"])
            return np.where(ok, (vv // cell_px).clip(0, ny - 1).astype(np.int64) * nx + (u // cell_px).clip(0, nx - 1).astype(np.int64), -1), z

        ci, cz = cell(surf)
        m = ci >= 0
        o = np.lexsort((cz[m], ci[m]))
        sc, sz = ci[m][o], cz[m][o]
        u, first, cnt = np.unique(sc, return_index=True, return_counts=True)
        depth = np.full(nx * ny, np.inf)
        depth[u[cnt >= kth]] = sz[first[cnt >= kth] + kth - 1]
        gi, gz = cell(p)
        d = np.where(gi >= 0, depth[gi.clip(0)], np.inf)
        has = np.isfinite(d)
        seen += has
        through += has & (gz < d - margin_m)
    return (through >= min_views) & (through >= min_frac * seen)


if __name__ == "__main__":   # self-check: a 0.2 m move is filled every 5 cm; a 2 m jump is not filled
    P = path_points(np.array([[0, 0, 0], [0.2, 0, 0], [2.2, 0, 0.]]))
    assert np.abs(np.diff(np.unique(P[P[:, 0] <= 0.2, 0]))).max() <= 0.05 + 1e-9 and not ((P[:, 0] > 0.2) & (P[:, 0] < 2.2)).any()
    # carve: a camera at the origin looking down +z (floor frame = camera frame here) sees a wall at z=2; a floater at
    # z=1 in front of it goes, the wall and a point behind it stay
    import tempfile
    from pathlib import Path
    d = Path(tempfile.mkdtemp())
    (d / "align.json").write_text(json.dumps({"T_colmap_to_floor": np.eye(4).tolist()}))
    (d / "cameras.json").write_text(json.dumps([{"name": f"{i}.jpg", "K": [[100, 0, 50], [0, 100, 50], [0, 0, 1]], "width": 100,
                                                 "height": 100, "w2c": np.eye(4).tolist()} for i in range(3)]))
    g = np.mgrid[-0.9:0.9:0.02, -0.9:0.9:0.02].reshape(2, -1).T
    wall = np.c_[g, np.full(len(g), 2.0)]
    q = np.vstack([wall[:5], [[0.1, 0.1, 1.0], [0.1, 0.1, 3.0]]])
    assert carve(d, q, wall, every=1).tolist() == [False] * 5 + [True, False]
    print("ok")

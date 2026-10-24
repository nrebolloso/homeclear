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


if __name__ == "__main__":   # self-check: a 0.2 m move is filled every 5 cm; a 2 m jump is not filled
    P = path_points(np.array([[0, 0, 0], [0.2, 0, 0], [2.2, 0, 0.]]))
    assert np.abs(np.diff(np.unique(P[P[:, 0] <= 0.2, 0]))).max() <= 0.05 + 1e-9 and not ((P[:, 0] > 0.2) & (P[:, 0] < 2.2)).any()
    print("ok")

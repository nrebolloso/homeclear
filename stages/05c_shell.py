"""Stage 5c: the room shell. Walls as vertical planes (snapped to two perpendicular directions, as most homes are
built) + the ceiling, fitted to the splat. Writes shell.json.

What it is for: the space the camera never saw. Cosmos controls (cosmos/render_route.py, render_controls.py) get the
shell's depth and a "wall"/"ceiling" label where the splat is empty, instead of a void that Cosmos fills with rock,
foliage or sky; the fill backends (stage 12b) know where a wall continues behind furniture; the viewer can draw it,
tinted. The shell is geometry the splat implies, not a measurement: nothing on the hazard side reads it.
  python stages/05c_shell.py <config.yaml>
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, ply_xyz, solid_mask

import numpy as np

BIN_M = 0.02
WALL_Z = (0.4, 2.0)       # above furniture tops is mostly wall; below the ceiling
MIN_LEN_M = 0.6           # a wall segment shorter than this is furniture or noise
MIN_H_M = 1.2             # ... and one shorter in height is furniture
CEILING_DEFAULT_M = 2.4


def normals(v):
    """Each Gaussian's surface normal: its shortest axis (a trained splat flattens onto surfaces)."""
    from scipy.spatial.transform import Rotation
    q = np.stack([v["rot_1"], v["rot_2"], v["rot_3"], v["rot_0"]], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-12
    R = Rotation.from_quat(q).as_matrix()
    k = np.argmin(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1), 1)
    return R[np.arange(len(k)), :, k]


def manhattan_angle(xy):
    """Rotation (rad, in [0, pi/2)) that makes the wall points line up with the axes: the angle where the x and y
    histograms are peakiest (sum of squared bin counts)."""
    best, best_a = -1.0, 0.0
    for a in np.radians(np.arange(0, 90, 0.5)):
        c, s = np.cos(a), np.sin(a)
        u, v = xy @ [c, s], xy @ [-s, c]
        score = sum((np.bincount(((q - q.min()) / BIN_M).astype(int)) ** 2.0).sum() for q in (u, v))
        if score > best:
            best, best_a = score, a
    return best_a


def wall_lines(u, v, z, min_pts):
    """Peaks of the u-histogram = walls at u = const. Each wall keeps the v-extent its points cover (gaps > 0.4 m split
    it), and must stand at least MIN_H_M tall (a dresser side is vertical too, but short)."""
    h = np.bincount(((u - u.min()) / BIN_M).astype(int))
    walls = []
    for k in np.flatnonzero(h >= min_pts):
        if h[k] < h[max(k - 1, 0):k + 2].max():          # local maximum only (one wall face = one line)
            continue
        c = u.min() + (k + 0.5) * BIN_M
        sel = np.abs(u - c) <= BIN_M
        order = np.argsort(v[sel])
        on, zz = v[sel][order], z[sel][order]
        if len(on) < min_pts:
            continue
        cuts = np.flatnonzero(np.diff(on) > 0.4) + 1
        for seg, zs in zip(np.split(on, cuts), np.split(zz, cuts)):
            if seg[-1] - seg[0] >= MIN_LEN_M and len(seg) >= min_pts / 2 and np.ptp(zs) >= MIN_H_M:
                walls.append((float(c), float(seg[0]), float(seg[-1]), int(len(seg))))
    return walls


def fit_shell(xyz, solid, nrm, min_pts=150):
    """nrm: per-Gaussian normals (normals()). Walls from vertical-surface Gaussians, the ceiling from flat ones."""
    band = solid & (xyz[:, 2] >= WALL_Z[0]) & (xyz[:, 2] <= WALL_Z[1]) & (np.abs(nrm[:, 2]) < 0.3)
    xy, zb, nb = xyz[band, :2], xyz[band, 2], nrm[band, :2]
    a = manhattan_angle(xy)
    c, s = np.cos(a), np.sin(a)
    u, v = xy @ [c, s], xy @ [-s, c]
    nu, nv = np.abs(nb @ [c, s]), np.abs(nb @ [-s, c])
    walls = []
    # a wall at u = const is made of points facing along u (and the same for v): the perpendicular walls' points
    # spread evenly over every u bin and would otherwise lift furniture sides into walls
    for axis, (p, q, face) in (("u", (u, v, nu > 0.7)), ("v", (v, u, nv > 0.7))):
        for pos, lo, hi, n in wall_lines(p[face], q[face], zb[face], min_pts):
            # segment ends back in the floor frame: the wall line is p = pos, spanning q in [lo, hi]
            ends = [(pos, lo), (pos, hi)] if axis == "u" else [(lo, pos), (hi, pos)]
            pts = [[float(uu * c - vv * s), float(uu * s + vv * c)] for uu, vv in ends]
            walls.append({"a": pts[0], "b": pts[1], "points": n})
    flat = solid & (xyz[:, 2] > 2.0) & (np.abs(nrm[:, 2]) > 0.8)
    top = xyz[flat, 2]
    spread = np.ptp(xyz[flat, :2], 0).min() if flat.sum() > 1 else 0.0
    if len(top) > min_pts and spread > 1.0:   # a ceiling spans the room, not a door lintel
        hz, edges = np.histogram(top, bins=np.arange(2.0, 3.6, BIN_M))
        ceiling, assumed = float(edges[np.argmax(hz)] + BIN_M / 2), False
    else:
        ceiling, assumed = CEILING_DEFAULT_M, True
    return {"angle_deg": round(float(np.degrees(a)), 2), "walls": walls, "ceiling_z": round(ceiling, 3), "ceiling_assumed": assumed}


def main(cfg):
    w = cfg["work"]
    v = read_ply(w / "splat_aligned.ply")
    xyz = ply_xyz(v)
    sh = fit_shell(xyz, solid_mask(v, min_opacity=cfg["grid"].get("min_opacity", 0.3)), normals(v))
    sh.update(frame="floor frame: metres, floor z=0, +z up", source="fitted to the splat (stage 5c); visual support only, never measured")
    (w / "shell.json").write_text(json.dumps(sh, indent=1))
    return len(sh["walls"]) >= 3, {"walls": len(sh["walls"]), "angle_deg": sh["angle_deg"], "ceiling_z": sh["ceiling_z"],
                                   "ceiling_assumed": sh["ceiling_assumed"]}


if __name__ == "__main__":
    run_stage("05c_shell", main)

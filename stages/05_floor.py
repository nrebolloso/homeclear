"""Stage 5: RANSAC floor plane on Gaussian centres; align floor to z=0 with up=+z. Writes splat_aligned.ply + align.json."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, write_ply, transform_ply, ply_xyz, solid_mask, fit_floor

import numpy as np
from scipy.spatial.transform import Rotation


def main(cfg):
    w, fc = cfg["work"], cfg["floor"]
    cams = json.loads((w / "cameras.json").read_text())
    s = json.loads((w / "scale.json").read_text())["scale"]
    v = read_ply(w / "splat_scaled.ply")
    centers = np.array([-np.array(c["w2c"])[:3, :3].T @ np.array(c["w2c"])[:3, 3] for c in cams]) * s
    n, d, inl, pts = fit_floor(ply_xyz(v)[solid_mask(v, min_opacity=fc.get("min_opacity", 0.3))], centers, cams, fc)
    R = Rotation.align_vectors([[0, 0, 1]], [n])[0].as_matrix()
    t = np.array([0, 0, d])  # z' = n.x + d, so the plane lands on z=0
    write_ply(w / "splat_aligned.ply", transform_ply(v, 1.0, R, t))
    (w / "splat_aligned_raw.ply").unlink(missing_ok=True)  # 5b's copy of the previous alignment: re-clean this one
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = s * R, t  # COLMAP world -> metric floor frame
    (w / "align.json").write_text(json.dumps({"T_colmap_to_floor": T.tolist(), "normal": n.tolist()}))
    resid = np.abs(pts[inl] @ n + d)
    cam_h = centers @ n + d
    m = {"floor_inlier_pct": round(100 * inl.mean(), 1), "floor_rms_cm": round(100 * float(np.sqrt((resid ** 2).mean())), 2),
         "camera_height_median_m": round(float(np.median(cam_h)), 3),
         "cameras_above_floor_pct": round(100 * float((cam_h > 0).mean()), 1)}
    return m["cameras_above_floor_pct"] > 90 and inl.sum() > 1000, m


if __name__ == "__main__":
    run_stage("05_floor", main)

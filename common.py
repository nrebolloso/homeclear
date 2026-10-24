"""Shared helpers: config, per-stage result records, PLY I/O, floor fit."""
import json, os, sys, time, traceback
from pathlib import Path, PurePosixPath

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parent


def _ffmpeg():
    """ffmpeg on PATH (HiPerGator module, Linux laptop), else the binary bundled with imageio-ffmpeg (Windows laptop)."""
    import shutil
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


FFMPEG = _ffmpeg()


def load_cfg(path):
    cfg = yaml.safe_load(Path(path).read_text())
    cfg["cluster"] = {**cfg.get("cluster", {}), **local_cluster()}
    cfg["work"] = Path(cfg["work_dir"]).expanduser()
    if not cfg["work"].is_absolute():
        cfg["work"] = ROOT / cfg["work"]
    cfg["work"].mkdir(parents=True, exist_ok=True)
    return cfg


def local_cluster():
    """Per-person cluster settings (ssh login, /blue base, repo, env) from the gitignored cluster.local.yaml, if any:
    the configs keep the team defaults and each laptop overrides only what differs. No credentials go in it."""
    p = ROOT / "cluster.local.yaml"
    return (yaml.safe_load(p.read_text()) or {}).get("cluster", {}) if p.exists() else {}


def cluster_shell(cfg_path):
    """`eval "$(python -c ...)"` lines for the laptop scripts: HOST REPO ENV HPG_ROOT as shell assignments."""
    import shlex
    c = load_cfg(cfg_path)["cluster"]
    repo, env = (os.path.expandvars(c[k]) for k in ("repo", "env"))
    base = c.get("base") or os.environ.get("HPG_ROOT") or str(PurePosixPath(repo).parent)   # cluster paths are POSIX, also on a Windows laptop
    vals = {"HOST": c["ssh"], "REPO": repo, "ENV": env, "HPG_ROOT": base}
    return "\n".join(f"{k}={shlex.quote(str(v))}" for k, v in vals.items())


def run_stage(name, fn):
    """Run fn(cfg) -> (passed, metrics_dict); record PASS/FAIL/SKIP + runtime to results/<name>.json."""
    cfg = load_cfg(sys.argv[1] if len(sys.argv) > 1 else ROOT / "config.yaml")
    out = cfg["work"] / "results"
    out.mkdir(exist_ok=True)
    t = time.time()
    rec = {"stage": name, "metrics": {}, "error": None}
    try:
        passed, rec["metrics"] = fn(cfg)
        rec["status"] = {True: "PASS", False: "FAIL", None: "SKIP"}[passed]
    except Exception:
        rec["status"], rec["error"] = "FAIL", traceback.format_exc()
    rec["runtime_s"] = round(time.time() - t, 1)
    (out / f"{name}.json").write_text(json.dumps(rec, indent=2, default=float))
    print(f"[{name}] {rec['status']} {rec['metrics']} ({rec['runtime_s']}s)")
    if rec["error"]:
        print(rec["error"], file=sys.stderr)
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(0 if rec["status"] != "FAIL" else 1)  # skip interpreter teardown: pycolmap segfaults there after a PASS


def triangulate(Ps, uvs):
    """Linear DLT triangulation of one point from >=2 views."""
    A = np.concatenate([[u * P[2] - P[0], v * P[2] - P[1]] for P, (u, v) in zip(Ps, uvs)])
    X = np.linalg.svd(A)[2][-1]
    return X[:3] / X[3]


def triangulate_picks(cams, picks):
    """Hand-picked points, each {image name: [u, v]} in >= 2 images -> 3-D points in the cameras.json frame + worst reprojection (px)."""
    by = {c["name"]: c for c in cams}
    P = {n: np.array(by[n]["K"]) @ np.array(by[n]["w2c"])[:3] for pt in picks for n in pt}
    X = [triangulate([P[n] for n in pt], list(pt.values())) for pt in picks]
    rep = max(np.linalg.norm((lambda x: x[:2] / x[2])(P[n] @ np.append(Xk, 1)) - uv)
              for Xk, pt in zip(X, picks) for n, uv in pt.items())  # large = the picks disagree
    return X, float(rep)


# --- Gaussian splat PLY (standard 3DGS layout written by gsplat.export_splats) ---

def read_ply(path):
    from plyfile import PlyData
    v = PlyData.read(str(path))["vertex"].data
    return v


def write_ply(path, v):
    from plyfile import PlyData, PlyElement
    PlyData([PlyElement.describe(v, "vertex")]).write(str(path))


def ply_xyz(v):
    return np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64)


def transform_ply(v, s, R=np.eye(3), t=np.zeros(3)):
    """Apply x -> s*R@x + t to means, rotations and (log) scales of a splat."""
    from scipy.spatial.transform import Rotation
    v = v.copy()
    xyz = ply_xyz(v) @ (s * R).T + t
    v["x"], v["y"], v["z"] = xyz.T
    for k in ("scale_0", "scale_1", "scale_2"):
        v[k] += np.log(s)
    q = np.stack([v["rot_1"], v["rot_2"], v["rot_3"], v["rot_0"]], 1)  # wxyz -> xyzw
    q = (Rotation.from_matrix(R) * Rotation.from_quat(q)).as_quat()
    v["rot_1"], v["rot_2"], v["rot_3"], v["rot_0"] = q.T
    # shortcut: SH rest coefficients (view-dependent color) are not rotated; fine for geometry, slightly off colors when rendering
    return v


def solid_mask(v, min_opacity=0.3, max_scale=0.2):
    """Gaussians that plausibly sit on a surface: opaque, not huge floaters."""
    op = 1 / (1 + np.exp(-v["opacity"]))
    sc = np.exp(np.max(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1), 1))
    return (op > min_opacity) & (sc < max_scale)


def camera_up(cams):
    """Average world-space 'up' of the capture cameras (image y points down)."""
    up = -np.mean([np.array(c["w2c"])[1, :3] for c in cams], 0)
    return up / np.linalg.norm(up)


def fit_plane_ransac(pts, up_hint, iters=2000, thresh=0.02, max_angle_deg=30, seed=0):
    """RANSAC plane among those whose normal is within max_angle of up_hint. Returns (n, d, inliers), n.x + d = 0."""
    rng = np.random.default_rng(seed)
    best = (None, None, np.zeros(len(pts), bool))
    cos_max = np.cos(np.radians(max_angle_deg))
    for _ in range(iters):
        p = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if np.linalg.norm(n) < 1e-12:
            continue
        n /= np.linalg.norm(n)
        if abs(n @ up_hint) < cos_max:
            continue
        inl = np.abs(pts @ n - n @ p[0]) < thresh
        if inl.sum() > best[2].sum():
            best = (n, -n @ p[0], inl)
    n, d, inl = best
    assert n is not None, "no plane found near the up direction"
    # refine with least squares on inliers
    c = pts[inl].mean(0)
    n2 = np.linalg.svd(pts[inl] - c, full_matrices=False)[2][-1]
    n2 = n2 if n2 @ n > 0 else -n2
    return n2, -n2 @ c, inl


def fit_floor(pts, centers, cams, fc):
    """Floor plane (n, d, inliers, pts used) from metric solid points; n points toward the cameras."""
    # only near the capture: background seen through windows/doors outvoted the floor (Mip-NeRF 360 room)
    r = np.linalg.norm(centers - centers.mean(0), axis=1).max() + fc.get("near_cameras_m", 2.0)
    pts = pts[np.linalg.norm(pts - centers.mean(0), axis=1) < r]
    n, d, inl = fit_plane_ransac(pts, camera_up(cams), iters=fc["ransac_iters"], thresh=fc["inlier_m"])
    if np.median(centers @ n + d) < 0:  # floor normal must point toward the cameras
        n, d = -n, -d
    return n, d, inl, pts

"""Self-check for the CPU stages (4-8, 10, 11) on a synthetic room with known answers.

Room 5x4 m; couch + table leave a 0.80 m gap (walker 0.66 m -> ~7 cm side clearance -> tight hazard);
a 2 cm rug spans the room further along (bump hazard); ArUco marker on the far wall at 0.75 m.
Everything is moved into an arbitrary 'COLMAP' frame (scale 1/2.7, random rotation) before the stages see it.
Run: .venv/bin/python tests/test_synthetic.py
"""
import json, subprocess, sys
from pathlib import Path

import cv2
import numpy as np
import yaml
from scipy.spatial.transform import Rotation

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from common import write_ply

W = ROOT / "out" / "synthetic"
rng = np.random.default_rng(0)
S0 = 2.7                                       # metres per COLMAP unit
R0 = Rotation.random(random_state=1).as_matrix()
t0 = np.array([0.3, -1.2, 2.0])
to_colmap = lambda x: (x @ R0.T) / S0 + t0     # metric room frame -> fake COLMAP frame


def box_surface(lo, hi, step=0.03):
    g = [np.arange(a, b + 1e-9, step) for a, b in zip(lo, hi)]
    pts = []
    for ax in range(3):
        for v in (lo[ax], hi[ax]):
            o = [g[i] for i in range(3) if i != ax]
            u, w = np.meshgrid(*o, indexing="ij")
            p = np.zeros((u.size, 3))
            p[:, ax], p[:, [i for i in range(3) if i != ax]] = v, np.stack([u.ravel(), w.ravel()], 1)
            pts.append(p)
    return np.concatenate(pts)


def scene():
    fx, fy = np.meshgrid(np.arange(0, 5, 0.02), np.arange(0, 4, 0.02), indexing="ij")
    floor = np.stack([fx.ravel(), fy.ravel(), rng.normal(0, 0.003, fx.size)], 1)
    rug = (floor[:, 0] > 3.2) & (floor[:, 0] < 3.8)
    floor[rug, 2] += 0.02
    parts = [floor,
             box_surface([0, 0, 0], [5, 4, 2.4], 0.04),          # walls (+ ceiling, removed by the 1.8 m cap)
             box_surface([1.5, 0, 0], [2.5, 1.3, 0.8], 0.015),   # couch
             box_surface([1.5, 2.1, 0], [2.5, 4.0, 0.75], 0.015)]       # table -> 0.8 m gap at y 1.3..2.1
    p = np.concatenate(parts)
    return p[~((p[:, 2] > 2.39))]                                # drop ceiling so floor fit can't pick it


def make_ply(pts_metric):
    pts = to_colmap(pts_metric)
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"] + [f"f_rest_{i}" for i in range(45)] + \
            ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    v = np.zeros(len(pts), [(n, "f4") for n in names])
    v["x"], v["y"], v["z"] = pts.T
    for i in range(3):
        v[f"f_dc_{i}"] = (rng.random(len(pts)) - 0.5)
        v[f"scale_{i}"] = np.log(0.01 / S0)
    v["opacity"], v["rot_0"] = 3.0, 1.0
    write_ply(W / "splat.ply", v)


def make_cameras_and_images():
    (W / "images").mkdir(parents=True, exist_ok=True)
    K = np.array([[1200.0, 0, 800], [0, 1200, 600], [0, 0, 1]])
    canvas = np.full((216, 216), 255, np.uint8)  # 180 px marker = 6 cells x 30 px exactly, in a 0.12 m canvas
    canvas[18:198, 18:198] = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), 0, 180)
    c, L = np.array([4.99, 2.0, 0.75]), 0.12                        # 0.12 m canvas -> 0.10 m black square
    right, down = np.array([0, -1.0, 0]), np.array([0, 0, -1.0])
    corners3d = np.array([c + (u - 0.5) * L * right + (v - 0.5) * L * down for u, v in [(0, 0), (1, 0), (1, 1), (0, 1)]])
    cams = []
    for k in range(12):
        eye = np.array([2.8 + 0.1 * k, 0.8 + 0.2 * k, 1.2 + 0.03 * k])
        fwd = (c - eye) / np.linalg.norm(c - eye)
        r = np.cross(fwd, [0, 0, 1.0]); r /= np.linalg.norm(r)
        Rcw = np.stack([r, np.cross(fwd, r), fwd], 1)               # cam->metric world
        # same camera in the COLMAP frame: x_c = Rcw^T (x_m - eye), x_m = S0 R0^T (x_col - t0)
        w2c = np.eye(4)
        w2c[:3, :3] = Rcw.T @ R0.T * S0
        w2c[:3, 3] = -Rcw.T @ (S0 * R0.T @ t0 + eye)
        w2c[:3] /= S0                                               # rescale so R is a rotation (scene units = COLMAP)
        assert np.allclose(w2c[:3, :3] @ w2c[:3, :3].T, np.eye(3), atol=1e-9)
        uv = (K @ (Rcw.T @ (corners3d - eye).T)).T
        uv = uv[:, :2] / uv[:, 2:]
        H = cv2.getPerspectiveTransform(np.float32([[0, 0], [216, 0], [216, 216], [0, 216]]), np.float32(uv))
        img = cv2.warpPerspective(canvas, H, (1600, 1200), borderValue=128)
        name = f"{k:05d}.jpg"
        cv2.imwrite(str(W / "images" / name), img)
        cams.append({"name": name, "K": K.tolist(), "w2c": w2c.tolist(), "width": 1600, "height": 1200})
    (W / "cameras.json").write_text(json.dumps(cams))


def run(stage, cfg_path):
    r = subprocess.run([sys.executable, str(ROOT / "stages" / f"{stage}.py"), str(cfg_path)], capture_output=True, text=True)
    print(r.stdout.strip(), r.stderr.strip()[-2000:])
    return json.loads((W / "results" / f"{stage}.json").read_text())


if __name__ == "__main__":
    W.mkdir(parents=True, exist_ok=True)
    make_ply(scene())
    make_cameras_and_images()
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    cfg.update(run_name="synthetic", work_dir=str(W))
    cfg["scale"]["assume_camera_height_m"] = None   # this test checks the marker path
    cfg_path = W / "config.yaml"
    cfg_path.write_text(yaml.safe_dump(cfg))

    r4 = run("04_scale", cfg_path)
    assert r4["status"] == "PASS" and abs(r4["metrics"]["scale"] - S0) / S0 < 0.01, r4
    r5 = run("05_floor", cfg_path)
    assert r5["status"] == "PASS", r5
    r6 = run("06_occupancy", cfg_path)
    assert r6["status"] == "PASS" and abs(r6["metrics"]["area_m2"] - 20) < 1.0, r6

    # start/goal given in the synthetic room frame -> floor frame via the recovered alignment
    T = np.array(json.loads((W / "align.json").read_text())["T_colmap_to_floor"])
    to_floor = lambda xy: (T[:3, :3] @ to_colmap(np.array([*xy, 0.0])) + T[:3, 3])
    assert abs(to_floor([2, 2])[2]) < 0.01, "floor point not at z=0"
    cfg["plan"].update(start=to_floor([0.6, 1.7])[:2].tolist(), goal=to_floor([4.4, 1.7])[:2].tolist())
    # known dimensions, measured back through scale + floor + map (the room frame is rotated, so only small boxes)
    rug = to_floor([3.5, 2.0])[:2]
    cfg["accuracy"]["ground_truth"] = [
        {"name": "marker height", "kind": "marker_height", "meters": 0.75, "source": "synthetic known dimension"},
        {"name": "rug height", "kind": "bump_height", "box_xy": [(rug - 0.1).tolist(), (rug + 0.1).tolist()], "meters": 0.02,
         "source": "synthetic known dimension"}]
    cams = json.loads((W / "cameras.json").read_text())[:3]
    pick = lambda X: {c["name"]: (lambda x: (x[:2] / x[2]).tolist())(np.array(c["K"]) @ np.array(c["w2c"])[:3] @ np.append(to_colmap(np.array(X)), 1))
                      for c in cams}   # table top corners projected into 3 images = perfect hand picks
    cfg["accuracy"]["ground_truth"] += [
        {"name": "table top width", "kind": "pick_distance", "points": [pick([1.5, 2.1, 0.75]), pick([2.5, 2.1, 0.75])], "meters": 1.0, "source": "synthetic known dimension"},
        {"name": "table height", "kind": "pick_height", "points": [pick([1.5, 2.1, 0.75])], "meters": 0.75, "source": "synthetic known dimension"}]
    cfg_path.write_text(yaml.safe_dump(cfg))
    r6b = run("06b_accuracy", cfg_path)
    assert r6b["status"] == "PASS" and r6b["metrics"]["max_error_cm"] < 0.5, r6b
    r7 = run("07_plan", cfg_path)
    assert r7["status"] == "PASS" and 0.0 < r7["metrics"]["min_side_clearance_m"] < 0.10, r7
    r8 = run("08_hazards", cfg_path)
    hz = json.loads((W / "hazards.json").read_text())["hazards"]
    bump = [h for h in hz if h["type"] == "floor_bump"]
    assert any(h["type"] == "tight_clearance" for h in hz) and bump and 1.5 < bump[0]["max_bump_height_cm"] < 3.0, hz
    if "--viewer" in sys.argv:
        print(run("10_viewer", cfg_path)["status"])
    run("11_report", cfg_path)
    print("SYNTHETIC OK")

"""Stage 4: metric scale from an ArUco marker of known size, triangulated with COLMAP poses.

Validation: tape-measured height of the marker centre above the floor must match within tolerance.
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, write_ply, transform_ply, ply_xyz, solid_mask, fit_plane_ransac, camera_up, fit_floor, triangulate_robust, triangulate_picks

import cv2
import numpy as np


def detect_marker(cfg, cams):
    sc = cfg["scale"]
    params = cv2.aruco.DetectorParameters()
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX  # default corners are ~1 px biased = ~2% scale error at 60 px
    det = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(getattr(cv2.aruco, sc["marker_dict"])), params)
    want = sc["marker_id"] if isinstance(sc["marker_id"], list) else [sc["marker_id"]]  # several ids = independent scale estimates
    hits = {i: ([], []) for i in want}
    for c in cams:
        img = cv2.imread(str(cfg["work"] / "images" / c["name"]), cv2.IMREAD_GRAYSCALE)
        cs, ids, _ = det.detectMarkers(img)
        if ids is None:
            continue
        for i in want:
            k = np.flatnonzero(ids.ravel() == i)
            if len(k) == 1:  # two prints of one id in a frame can't be told apart: skip that id there
                hits[i][0].append(np.array(c["K"]) @ np.array(c["w2c"])[:3])
                hits[i][1].append(cs[k[0]][0])
    return hits


def main(cfg):
    sc, w = cfg["scale"], cfg["work"]
    cams = json.loads((w / "cameras.json").read_text())
    v = read_ply(w / "splat.ply")
    if sc.get("manual_factor"):
        write_ply(w / "splat_scaled.ply", transform_ply(v, sc["manual_factor"]))
        (w / "scale.json").write_text(json.dumps({"scale": sc["manual_factor"], "source": "manual"}))
        return None, {"scale": sc["manual_factor"], "note": "manual_factor set; marker check skipped"}

    if sc.get("known_object"):  # no marker: an object of standard size, its two ends picked by hand in >= 2 images
        ko = sc["known_object"]
        X, rep = triangulate_picks(cams, ko["points"])
        s = ko["meters"] / float(np.linalg.norm(X[0] - X[1]))
        write_ply(w / "splat_scaled.ply", transform_ply(v, s))
        (w / "scale.json").write_text(json.dumps({"scale": s, "source": f"known object: {ko['name']}", "reproj_px": rep}))
        return rep < 3, {"scale": round(s, 5), "reproj_px": round(float(rep), 2),
                         "note": f"APPROXIMATE SCALE: {ko['name']} assumed {ko['meters']} m"}

    if sc.get("assume_camera_height_m"):  # public datasets have no marker: scale is ASSUMED, not measured
        pts = ply_xyz(v)[solid_mask(v)]
        ext = np.ptp(np.percentile(pts, [5, 95], 0), 0).max()  # inlier threshold relative to scene size (units unknown)
        n, d, _ = fit_plane_ransac(pts, camera_up(cams), thresh=0.005 * ext)
        centers = np.array([-np.array(c["w2c"])[:3, :3].T @ np.array(c["w2c"])[:3, 3] for c in cams])
        s = sc["assume_camera_height_m"] / float(np.median(np.abs(centers @ n + d)))
        fc, solid = cfg["floor"], ply_xyz(v)[solid_mask(v, min_opacity=cfg["floor"].get("min_opacity", 0.3))]
        for _ in range(5):  # re-fit with stage 5's metric floor fit until both agree on the camera height
            n, d, _, _ = fit_floor(solid * s, centers * s, cams, fc)
            s *= sc["assume_camera_height_m"] / float(np.median(centers * s @ n + d))
        write_ply(w / "splat_scaled.ply", transform_ply(v, s))
        (w / "scale.json").write_text(json.dumps({"scale": s, "source": "assumed camera height"}))
        return None, {"scale": round(s, 5), "note": f"ASSUMED: median camera height set to {sc['assume_camera_height_m']} m (no marker)"}

    hits = {i: h for i, h in detect_marker(cfg, cams).items() if len(h[0]) >= 2}
    assert hits, f"marker id(s) {sc['marker_id']} not found in >= 2 frames"
    tri = {i: [triangulate_robust(Ps, [c[k] for c in cs]) for k in range(4)] for i, (Ps, cs) in hits.items()}
    X = {i: np.array([x for x, _ in t]) for i, t in tri.items()}
    edges = {i: np.linalg.norm(x - np.roll(x, 1, 0), axis=1) for i, x in X.items()}
    per = {i: sc["marker_size_m"] / e.mean() for i, e in edges.items()}  # shortcut: one print size for every id; add a per-id size if prints differ
    s = float(np.median(list(per.values())))
    vs = transform_ply(v, s)
    write_ply(w / "splat_scaled.ply", vs)

    # validation against tape: marker centre height above the floor (floor fit on scaled splat)
    n, d, _ = fit_plane_ransac(ply_xyz(vs)[solid_mask(vs)], camera_up(cams), thresh=cfg["floor"]["inlier_m"])
    centers = np.array([-np.array(c["w2c"])[:3, :3].T @ np.array(c["w2c"])[:3, 3] for c in cams]) * s
    if np.median(centers @ n + d) < 0:
        n, d = -n, -d
    m = {"marker_frames": sum(len(h[0]) for h in hits.values()), "scale": round(s, 5),
         "marker_edge_spread_pct": round(max(100 * e.std() / e.mean() for e in edges.values()), 2)}
    if isinstance(sc["marker_id"], list):
        m["marker_ids"] = {str(i): {"frames": len(hits[i][0]), "scale": round(float(per[i]), 5),
                                    "inlier_pct": round(100 * float(np.mean([k.mean() for _, k in tri[i]])), 1)} if i in hits else "not found" for i in sc["marker_id"]}
        m["marker_scale_spread_pct"] = round(100 * float(np.ptp(list(per.values()))) / s, 2)
    if sc.get("marker_size_estimated"):
        m["marker_size"] = f"ESTIMATED {sc['marker_size_m']} m ({sc.get('marker_size_source', 'not taped')})"
    # ground truth marked estimated: true (a guess, a standard size) is reported but can't verify the scale: it can only
    # catch a gross error (more than estimate_tolerance_pct off)
    errs, est = [], []
    for gt in sc["ground_truth"]:
        assert gt["kind"] == "marker_height", f"unsupported ground_truth kind {gt['kind']}"
        mid = gt.get("marker_id", next(iter(X)))  # which marker was taped; default the first id found
        assert mid in X, f"ground truth {gt['name']}: marker id {mid} not found in >= 2 frames"
        meas = float(X[mid].mean(0) * s @ n + d)
        (est if gt.get("estimated") else errs).append(100 * abs(meas - gt["meters"]) / gt["meters"])
        m[f"{gt['name']}_measured_m"] = round(meas, 4)
        m[f"{gt['name']}_{'estimate' if gt.get('estimated') else 'tape'}_m"] = gt["meters"]
    m["scale_error_pct"] = round(max(errs), 2) if errs else None
    if est:
        m["estimate_error_pct"] = round(max(est), 2)
    (w / "scale.json").write_text(json.dumps({"scale": s, "source": "aruco", "verified": bool(errs),
                                              "marker_center_colmap": next(iter(X.values())).mean(0).tolist(), **m}))
    if m.get("marker_scale_spread_pct", 0) > sc["tolerance_pct"]:
        return False, m | {"note": f"markers disagree on scale by {m['marker_scale_spread_pct']}%: check each print's size and detections"}
    if not errs:   # scale applied, but nothing tape-measured to check it against
        if est and max(est) > sc.get("estimate_tolerance_pct", 15.0):
            return False, m | {"note": f"scale off by {max(est):.1f}% even against an ESTIMATE: check marker_size_m and the marker detections"}
        return None, m | {"note": f"UNVERIFIED: within {max(est):.1f}% of an ESTIMATE, no tape measurement" if est else "UNVERIFIED: no ground_truth in config"}
    return m["scale_error_pct"] <= sc["tolerance_pct"], m


if __name__ == "__main__":
    run_stage("04_scale", main)

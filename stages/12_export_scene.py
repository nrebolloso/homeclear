"""Stage 12 (laptop): export the walker-game scene to viewer/public/scene/<run_name>/ (manifest: scene.json).

Everything stays in the floor frame (metres, floor z=0, +z up); the viewer keeps that frame (see viewer/src/frame.ts).
The movable objects in game.objects (config boxes, floor frame) are cut out of the splat into their own PLYs, and the
grids are recomputed without them so the viewer can stamp them back in wherever the user drags them. Each object also
gets a fill patch for its original spot: a flat placeholder coloured from the nearby floor (imagined, not measured)
until a generative fill exists.
"""
import importlib, json, sys
from pathlib import Path
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from common import run_stage, read_ply, write_ply, ply_xyz, solid_mask, ROOT

import cv2
from matplotlib.path import Path as Path2d
import numpy as np
from scipy import ndimage

occ = importlib.import_module("06_occupancy")
layers = occ.layers
COVERAGE_RANGE_M = 6.0   # a camera further than this from a floor cell doesn't count as seeing it
COVERAGE_GOOD = 3        # cells seen by fewer cameras are drawn in fog


def coverage(w, lo, shape, cell, walls):
    """Per floor cell: how many capture cameras had it in view (cameras.json mapped through align.json).
    shortcut: occlusion is a 2D ray march over the obstacle layer, so low furniture also hides the floor behind it."""
    if not (w / "cameras.json").exists():
        return np.full(shape, 255, np.uint8)
    walls = ndimage.binary_dilation(walls, iterations=4)  # 40 ray samples over 6 m step ~15 cm: don't skip thin walls
    T = np.array(json.loads((w / "align.json").read_text())["T_colmap_to_floor"])
    s = np.cbrt(np.linalg.det(T[:3, :3]))
    i, j = np.meshgrid(np.arange(shape[0]), np.arange(shape[1]), indexing="ij")
    P = np.stack([lo[0] + (i.ravel() + 0.5) * cell, lo[1] + (j.ravel() + 0.5) * cell, np.zeros(i.size), np.ones(i.size)])
    X = np.linalg.inv(T) @ P                                   # cell centres in the COLMAP frame
    n = np.zeros(i.size, np.int32)
    for c in json.loads((w / "cameras.json").read_text()):
        w2c, K = np.array(c["w2c"]), np.array(c["K"])
        x = w2c[:3] @ X
        uv = (K @ x)[:2] / np.maximum(x[2], 1e-9)
        vis = (x[2] > 0) & (x[2] * s < COVERAGE_RANGE_M) & (uv[0] >= 0) & (uv[0] < c["width"]) & (uv[1] >= 0) & (uv[1] < c["height"])
        eye = (T @ np.r_[-w2c[:3, :3].T @ w2c[:3, 3], 1])[:2]
        k = np.flatnonzero(vis)
        f = np.linspace(0.02, 0.95, 40)[:, None, None]                    # stop short of the target cell itself
        q = np.floor((eye + f * (P[:2, k].T - eye) - lo) / cell).astype(int)
        q = np.clip(q, 0, np.array(shape) - 1)
        vis[k[walls[q[..., 0], q[..., 1]].any(0)]] = False
        n += vis
    return np.minimum(n, 255).reshape(shape).astype(np.uint8)


def rug_outline(w, lo, cell, shape, box_xy, grow=0.03):
    """Rotated rectangle (floor frame) around the largest stage 6 bump patch inside box_xy, grown for the blurry edge."""
    (i0, j0), (i1, j1) = np.clip(np.round((np.sort(np.array(box_xy, float), 0) - lo) / cell).astype(int), 0, shape)
    lab, n = ndimage.label(np.load(w / "bumps.npy")[i0:i1, j0:j1])
    assert n, "rug: no measured bump cells in its box"
    i, j = np.nonzero(lab == 1 + np.argmax(ndimage.sum(lab > 0, lab, range(1, n + 1))))
    xy = (np.stack([i + i0, j + j0], 1) + 0.5) * cell + lo
    (cx, cy), (bw, bh), ang = cv2.minAreaRect(xy.astype(np.float32))
    return cv2.boxPoints(((cx, cy), (bw + 2 * grow, bh + 2 * grow), ang)).astype(float).round(3).tolist()


def main(cfg):
    w, g, gm = cfg["work"], cfg["grid"], cfg["game"]
    out = ROOT / "viewer" / "public" / "scene" / cfg["run_name"]
    (out / "objects").mkdir(parents=True, exist_ok=True)
    v = read_ply(w / "splat_aligned.ply")
    xyz, solid = ply_xyz(v), solid_mask(v, min_opacity=g.get("min_opacity", 0.3))
    grid = json.loads((w / "grid.json").read_text())
    lo, cell, shape = np.array(grid["origin_xy"]), grid["cell_m"], tuple(grid["shape"])

    taken, objects = np.zeros(len(v), bool), []
    floor_g = solid & (np.abs(xyz[:, 2]) < g["floor_band_m"])
    for o in gm["objects"]:
        (x0, y0), (x1, y1) = np.sort(np.array(o["box_xy"], float), 0)
        inbox = lambda m: (xyz[:, 0] >= x0 - m) & (xyz[:, 0] <= x1 + m) & (xyz[:, 1] >= y0 - m) & (xyz[:, 1] <= y1 + m)
        # parts: the object is only these height-limited boxes (a table = top slab + legs; chairs pushed in under it stay put)
        parts = o.get("parts") or [{"box_xy": o["box_xy"], "z": [g["bump_z"][0], o.get("z_max", 2.0)]}]
        if o.get("kind") == "rug":   # a rug lies at an angle: its box takes bare floor too, so cut the measured bump patch instead
            parts = [{**q, "poly_xy": rug_outline(w, lo, cell, shape, o["box_xy"])} for q in parts]
        # a part is a box_xy or a poly_xy outline (a table turned off the axes: its bounding box would take the chair backs)
        in_xy = lambda q: (Path2d(q["poly_xy"]).contains_points(xyz[:, :2]) if "poly_xy" in q else
                           (xyz[:, :2] >= np.min(q["box_xy"], 0)).all(1) & (xyz[:, :2] <= np.max(q["box_xy"], 0)).all(1))
        sel = ~taken & np.any([in_xy(q) & (xyz[:, 2] >= q["z"][0]) & (xyz[:, 2] <= q["z"][1]) for q in parts], 0)
        assert (sel & solid).sum() > 10, f"object {o['name']}: no Gaussians in its box"
        taken |= sel
        pivot = np.array([(x0 + x1) / 2, (y0 + y1) / 2, 0.0])
        ov = v[sel].copy()
        ov["x"], ov["y"] = ov["x"] - pivot[0], ov["y"] - pivot[1]
        write_ply(out / "objects" / f"{o['name']}.ply", ov)
        (cx, cy), (bw, bh), ang = cv2.minAreaRect((xyz[sel & solid, :2] - pivot[:2]).astype(np.float32))
        foot = cv2.boxPoints(((cx, cy), (bw, bh), ang))
        height = float(np.percentile(xyz[sel & solid, 2], 99))
        if o.get("kind") == "rug":   # the viewer stamps a rug as one flat slab: use stage 6's height above the LOCAL floor, not raw z
            (i0, j0), (i1, j1) = np.clip(np.round((np.array([[x0, y0], [x1, y1]]) - lo) / cell).astype(int), 0, shape)
            rug_h = np.load(w / "bump_height_m.npy")[i0:i1, j0:j1][np.load(w / "bumps.npy")[i0:i1, j0:j1]]
            height = float(np.median(rug_h)) if rug_h.size else height

        # fill: flat patch over the footprint (+3 cm), median colour of the floor in a 10-40 cm ring around the box
        ring = floor_g & inbox(0.4) & ~inbox(0.1)
        dc = np.median(np.stack([v[f"f_dc_{k}"][ring] for k in range(3)], 1), 0) if ring.any() else np.zeros(3)
        gx, gy = np.meshgrid(np.arange(x0 - 0.03, x1 + 0.03, 0.02), np.arange(y0 - 0.03, y1 + 0.03, 0.02), indexing="ij")
        fv = np.zeros(gx.size, v.dtype)
        fv["x"], fv["y"], fv["z"] = gx.ravel(), gy.ravel(), 0.002
        for k in range(3):
            fv[f"f_dc_{k}"], fv[f"scale_{k}"] = dc[k], np.log(0.012 if k < 2 else 0.002)
        fv["opacity"], fv["rot_0"] = 4.0, 1.0
        if o.get("kind") == "rug":   # only where the rug was cut out
            fv = fv[Path2d(parts[0]["poly_xy"]).contains_points(np.stack([fv["x"], fv["y"]], 1))]
        write_ply(out / "objects" / f"fill_{o['name']}.ply", fv)
        objects.append({"name": o["name"], "kind": o.get("kind", "other"), "splat": f"objects/{o['name']}.ply",
                        "fill": f"objects/fill_{o['name']}.ply", "pivot": pivot.round(3).tolist(),
                        "footprint": np.round(foot, 3).tolist(), "height_m": round(height, 3),
                        "layer": {"rug": "bump", "nightlight": "none"}.get(o.get("kind"), "obstacle"),
                        "light_radius_m": o.get("light_radius_m", 1.5 if o.get("kind") == "nightlight" else None)})
    write_ply(out / "main.ply", v[~taken])
    if (w / "removed.ply").exists():   # stage 5b's dropped Gaussians, for the cleanup before/after
        (out / "removed.ply").write_bytes((w / "removed.ply").read_bytes())

    floor, obstacles, bumps, bump_h, _ = layers(xyz[solid & ~taken], g, lo, shape)
    occ.stamp_synthetic(g, lo, shape, floor, obstacles, bumps, bump_h)
    est = occ.classify_thin(g, bumps, bump_h)
    for o in objects:   # nobody filmed the floor under the furniture: assume the fitted plane (z=0) continues
        poly = ((np.array(o["footprint"]) + o["pivot"][:2] - lo) / cell)[:, ::-1].astype(np.int32)  # (j, i) for cv2
        m = np.zeros(shape, np.uint8)
        cv2.fillPoly(m, [poly], 1)
        floor |= m.astype(bool)
    cov = coverage(w, lo, shape, cell, layers(xyz[solid], g, lo, shape)[1])
    if gm.get("fence_min_views"):   # walk (and replan) only where enough capture views saw the floor: no blur, no holes
        floor &= cov >= gm["fence_min_views"]
    (floor.astype(np.uint8)).tofile(out / "floor.u8")
    (obstacles.astype(np.uint8)).tofile(out / "obstacles.u8")
    bump_h.astype(np.float32).tofile(out / "bump.f32")
    est.astype(np.uint8).tofile(out / "bump_estimated.u8")
    cov.tofile(out / "coverage.u8")

    margin = cfg["hazards"]["clearance_margin_m"]
    hz = json.loads((w / "hazards.json").read_text())["hazards"] if (w / "hazards.json").exists() else []
    for h in hz:
        h["source"] = "geometry"
        if h["type"] == "floor_bump":
            h["position_m"][2] = round(h["max_bump_height_cm"] / 100, 3)
            h["ot_check"] = h["verdict"] != "minor"
            h["note"] = f"{h['max_bump_height_cm']} cm floor bump over {h['length_m']} m of the route (measured from the splat)"
        else:
            h["ot_check"] = h["verdict"] != "minor"
            h["note"] = f"{100 * h['min_side_clearance_m']:.0f} cm each side of the walker over {h['length_m']} m (measured)"
    (out / "hazards.json").write_text(json.dumps({"frame": "floor frame, metres, z up", "hazards": hz}, indent=1))

    path = json.loads((w / "path.json").read_text()) if (w / "path.json").exists() else {}
    route = {"start": cfg["plan"].get("start") or path.get("start_xy"), "goal": cfg["plan"].get("goal") or path.get("goal_xy")}
    assert route["start"] and route["goal"], "no start/goal: set plan.start/goal or run stage 7 first"
    wk = gm["walker"]
    hx, hy = wk["user_gap_m"], wk["width_m"] / 2 - wk["leg_radius_m"]
    walker = {**wk, "frame": "x forward from the user's body centre, y left",
              "legs": [[hx + wk["depth_m"], hy], [hx + wk["depth_m"], -hy], [hx, hy], [hx, -hy]]}
    for name, data in (("route", route), ("walker", walker), ("persona", gm["persona"])):
        (out / f"{name}.json").write_text(json.dumps(data, indent=1))
    scene = {"version": 1, "run": cfg["run_name"], "frame": "floor frame: metres, floor z=0, +z up",
             "splat": "main.ply", "removed_splat": "removed.ply" if (w / "removed.ply").exists() else None,
             "synthetic": g.get("synthetic") or [], "scale_note": cfg["scale"].get("note"),
             "grid": {"origin_xy": lo.round(4).tolist(), "cell_m": cell, "shape": list(shape),
                      "index": "flat i*ny + j; cell (i,j) spans origin + (i,j)*cell_m",
                      "floor": "floor.u8", "obstacles": "obstacles.u8", "bump_height_m": "bump.f32",
                      "bump_estimated": "bump_estimated.u8",
                      "coverage": "coverage.u8", "coverage_good": COVERAGE_GOOD},
             "objects": objects, "hazards": "hazards.json", "route": "route.json", "walker": "walker.json",
             "persona": "persona.json", "interventions": gm["interventions"], "risk": gm["risk"],
             "plan": {k: cfg["plan"][k] for k in ("preferred_clearance_m", "clearance_weight")},
             "hazard_rules": {"clearance_margin_m": margin, "bump_min_m": g["bump_z"][0], "bump_link_cells": g.get("bump_link_cells", 1), "bump_limit_m": cfg["hazards"]["bump_limit_m"],
                              # stage 6b's measured map error: within it of a limit = borderline, OT to verify
                              "margin_m": {k: v or 0.0 for k, v in (json.loads((w / "accuracy.json").read_text())["margin_m"]
                                                                    if (w / "accuracy.json").exists() else {"width": 0, "height": 0}).items()}}}
    (out / "scene.json").write_text(json.dumps(scene, indent=1))
    m = {"out": str(out.relative_to(ROOT)), "objects": {o["name"]: o["height_m"] for o in objects},
         "main_gaussians": int((~taken).sum()), "coverage_good_pct": round(100 * float((cov[floor] >= COVERAGE_GOOD).mean()), 1)}
    return bool(floor.any()), m


if __name__ == "__main__":
    run_stage("12_export_scene", main)

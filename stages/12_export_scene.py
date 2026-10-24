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
# where to look for the sitting / lying surface of each kind (m above the floor): the toilet's tank and a bed's headboard
# are higher than the seat and the mattress, so the surface is the densest horizontal layer inside this band
SURFACE_Z = {"bed": (0.25, 0.9), "toilet": (0.3, 0.6), "chair": (0.3, 0.7), "nightstand": (0.3, 1.0)}
POINT_KINDS = {"switch", "phone", "outlet", "grab_bar_wall"}


def surface_height(z, band):
    """Robust top surface: the 1 cm z-bin with the most solid Gaussians in the band, refined by their median.
    A flat seat or mattress is a dense horizontal layer; a percentile would land on the headboard or the tank."""
    z = z[(z >= band[0]) & (z <= band[1])]
    if len(z) < 30:
        return None
    hist, edges = np.histogram(z, bins=np.arange(band[0], band[1] + 0.01, 0.01))
    k = int(np.argmax(hist))
    near = z[np.abs(z - (edges[k] + 0.005)) <= 0.01]
    return float(np.median(near))


def near_poly(p, poly, m):
    """Points inside the polygon or within m of its outline."""
    inside = Path2d(poly).contains_points(p)
    if m <= 0:
        return inside
    a, b = poly, np.roll(poly, -1, 0)
    for s, e in zip(a, b):
        d = e - s
        t = np.clip(((p - s) @ d) / max(d @ d, 1e-12), 0, 1)
        inside |= np.hypot(*(p - (s + t[:, None] * d)).T) <= m
    return inside


def walker_cfg(wk):
    """walker.json: the frame's legs in the user frame (x forward from the body centre, y left)."""
    hx, hy = wk["user_gap_m"], wk["width_m"] / 2 - wk["leg_radius_m"]
    return {**wk, "device": wk.get("device", "walker"), "frame": "x forward from the user's body centre, y left",
            "legs": [[hx + wk["depth_m"], hy], [hx + wk["depth_m"], -hy], [hx, hy], [hx, -hy]]}


def personas_cfg(gm, walker):
    """Who walks the routes. game.personas overrides; by default: this patient (game.persona + game.walker), the same
    person with a cane, and a Parkinsonian walker user. Each one: device + footprint, gait, planner penalties, vision.
    The non-default numbers are ASSUMPTIONS for comparison, labelled in the viewer; only 'patient' is the real person."""
    base = gm["persona"]
    cane = walker_cfg({**gm["walker"], "device": "cane", "width_m": 0.5, "depth_m": 0.25, "user_gap_m": 0.1})
    cane["legs"] = [[0.3, -0.22]]   # the cane tip, ahead and to the side of the stronger hand
    default = {
        "patient": {"label": "This patient (walker)", "walker": walker, "gait": base, "plan": {}, "vision": base.get("vision", "normal")},
        "cane": {"label": "With a cane instead (assumed gait)", "walker": cane,
                 "gait": {**base, "stride_m": 0.45, "toe_clearance_cv": 0.3}, "plan": {}, "vision": base.get("vision", "normal")},
        "parkinsons": {"label": "Parkinson's, walker (assumed: shuffling, freezing at turns/doorways)", "walker": walker,
                       "gait": {**base, "stride_m": 0.25, "foot_sep_m": 0.15, "toe_clearance_cv": 0.35, "clearance_scale": 0.7},
                       "plan": {"turn_weight_m": 0.6, "narrow_weight": 2.0, "narrow_m": 0.15}, "vision": "low_contrast"},
    }
    out = {}
    for k, p in {**default, **gm.get("personas", {})}.items():
        if "walker" in p and "legs" not in p["walker"]:
            p = {**p, "walker": walker_cfg({**gm["walker"], **p["walker"]})}
        out[k] = {**default.get(k, default["patient"]), **p}
    return out


def fixtures(gm, xyz, solid):
    """Things that don't move but matter for transfers and reach: seats (measured surface height) and points (switch,
    phone, outlet, grab-bar wall) placed by hand on the splat (xyz), or riding on a movable object (attach)."""
    out = []
    for f in gm.get("fixtures", []):
        kind, rec = f["kind"], {"name": f["name"], "kind": f["kind"], "note": f.get("note", "")}
        if "attach" in f:
            rec.update(attach=f["attach"], xyz=f.get("xyz"), measured=False)   # e.g. the phone on the nightstand
        elif kind in POINT_KINDS:
            rec.update(xyz=f["xyz"], measured=False)                          # located by hand on the splat
        else:
            poly = f.get("poly_xy") or [[f["box_xy"][0][0], f["box_xy"][0][1]], [f["box_xy"][1][0], f["box_xy"][0][1]],
                                        [f["box_xy"][1][0], f["box_xy"][1][1]], [f["box_xy"][0][0], f["box_xy"][1][1]]]
            inside = solid & Path2d(poly).contains_points(xyz[:, :2])
            band = f.get("z") or SURFACE_Z.get(kind, (0.25, 1.0))
            h = surface_height(xyz[inside, 2], band)
            c = np.mean(np.array(poly, float), 0)
            rec.update(poly_xy=poly, xyz=[round(float(c[0]), 3), round(float(c[1]), 3), round(h or 0.0, 3)],
                       surface_m=None if h is None else round(h, 3), measured=h is not None)
        out.append(rec)
    return out


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


def object_parts(o, xyz, g, w, lo, cell, shape):
    """Gaussians that belong to config object o (its height-limited parts, with a cut margin). tools/lighter_clean.py reuses it."""
    # parts: the object is only these height-limited boxes (a table = top slab + legs; chairs pushed in under it stay put)
    parts = o.get("parts") or [{"box_xy": o["box_xy"], "z": [g["bump_z"][0], o.get("z_max", 2.0)]}]
    if o.get("kind") == "rug":   # a rug lies at an angle: its box takes bare floor too, so cut the measured bump patch instead
        parts = [{**q, "poly_xy": rug_outline(w, lo, cell, shape, o["box_xy"])} for q in parts]
    # a part is a box_xy or a poly_xy outline (a table turned off the axes: its bounding box would take the chair backs),
    # taken with a margin: an object's sides sit on or just past its outline (a bed's sides 1-3 cm out stayed in the
    # room when it was moved). A rug has none: its edge Gaussians are floor-height, the margin would take floor.
    cm = o.get("cut_margin_m", 0.0 if o.get("kind") == "rug" else 0.02)
    in_xy = lambda q: (near_poly(xyz[:, :2], np.array(q["poly_xy"], float), cm) if "poly_xy" in q else
                       (xyz[:, :2] >= np.min(q["box_xy"], 0) - cm).all(1) & (xyz[:, :2] <= np.max(q["box_xy"], 0) + cm).all(1))
    return np.any([in_xy(q) & (xyz[:, 2] >= q["z"][0]) & (xyz[:, 2] <= q["z"][1]) for q in parts], 0)


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
        sel = ~taken & object_parts(o, xyz, g, w, lo, cell, shape)
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
            fv = fv[Path2d(rug_outline(w, lo, cell, shape, o["box_xy"])).contains_points(np.stack([fv["x"], fv["y"]], 1))]
        write_ply(out / "objects" / f"fill_{o['name']}.ply", fv)
        surface = surface_height(xyz[sel & solid, 2], o.get("surface_z") or SURFACE_Z[o.get("kind")]) if o.get("kind") in SURFACE_Z else None
        objects.append({"name": o["name"], "kind": o.get("kind", "other"), "splat": f"objects/{o['name']}.ply",
                        "surface_m": None if surface is None else round(surface, 3),
                        "fill": f"objects/fill_{o['name']}.ply", "pivot": pivot.round(3).tolist(),
                        "footprint": np.round(foot, 3).tolist(), "height_m": round(height, 3),
                        "layer": {"rug": "bump", "nightlight": "none"}.get(o.get("kind"), "obstacle"),
                        "light_radius_m": o.get("light_radius_m", 1.5 if o.get("kind") == "nightlight" else None)})
    write_ply(out / "main.ply", v[~taken])
    if (w / "verification.json").exists():   # stage 14: the re-scan after the fixes, hazard by hazard
        (out / "verification.json").write_text((w / "verification.json").read_text())
    if (w / "shell.json").exists():    # stage 5c's room shell: the Cosmos controls and the viewer's tinted walls read it
        (out / "shell.json").write_text((w / "shell.json").read_text())
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
        # the cut leaves the object's outermost Gaussians (centres just outside its box) as a 1-cell outline in the
        # obstacle layer: a phantom box that traps anything placed inside its old spot. The object itself is stamped
        # back at its live pose, so clear one cell around its footprint (walls are further than that from a box)
        obstacles &= ~cv2.dilate(m, np.ones((3, 3), np.uint8)).astype(bool)
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
    if (w / "reason.json").exists():   # Cosmos Reason proposals (cosmos/reason.py), already checked against the grids
        for r in json.loads((w / "reason.json").read_text())["hazards"]:
            hz.append({"id": len(hz), "type": r["kind"], "source": "cosmos_reason", "position_m": r["position_m"],
                       "verdict": r["verdict"], "measured": r.get("measured"), "frames": len(r["frames"]),
                       "note": r["note"] or r["why"], "ot_check": r["verdict"] != "dismissed"})
    (out / "hazards.json").write_text(json.dumps({"frame": "floor frame, metres, z up", "hazards": hz}, indent=1))

    path = json.loads((w / "path.json").read_text()) if (w / "path.json").exists() else {}
    route = {"start": cfg["plan"].get("start") or path.get("start_xy"), "goal": cfg["plan"].get("goal") or path.get("goal_xy")}
    assert route["start"] and route["goal"], "no start/goal: set plan.start/goal or run stage 7 first"
    # every route the patient walks, weighted by trips per night; night routes get the darkness multiplier.
    # Without game.routes: the one stage-7 route, at risk.trips_per_night, at night (as before)
    routes = gm.get("routes") or [{"name": cfg["plan"].get("name", "main route"), **route, "trips_per_night": gm["risk"]["trips_per_night"], "night": True}]
    for r in routes:
        r.setdefault("night", True)
        r.setdefault("trips_per_night", gm["risk"]["trips_per_night"])
        assert r.get("start") and r.get("goal"), f"route {r.get('name')}: needs start and goal"
    wk = gm["walker"]
    walker = walker_cfg(wk)
    personas = personas_cfg(gm, walker)
    for name, data in (("route", route), ("routes", routes), ("walker", walker), ("persona", gm["persona"]), ("personas", personas)):
        (out / f"{name}.json").write_text(json.dumps(data, indent=1))
    scene = {"version": 1, "run": cfg["run_name"], "frame": "floor frame: metres, floor z=0, +z up",
             "splat": "main.ply", "removed_splat": "removed.ply" if (w / "removed.ply").exists() else None,
             "shell": "shell.json" if (w / "shell.json").exists() else None,
             "verification": "verification.json" if (w / "verification.json").exists() else None,
             "synthetic": g.get("synthetic") or [], "scale_note": cfg["scale"].get("note"),
             "grid": {"origin_xy": lo.round(4).tolist(), "cell_m": cell, "shape": list(shape),
                      "index": "flat i*ny + j; cell (i,j) spans origin + (i,j)*cell_m",
                      "floor": "floor.u8", "obstacles": "obstacles.u8", "bump_height_m": "bump.f32",
                      "bump_estimated": "bump_estimated.u8",
                      "coverage": "coverage.u8", "coverage_good": COVERAGE_GOOD},
             "objects": objects, "fixtures": fixtures(gm, xyz, solid),
             # transfer / reach / emergency-access rules (checks.ts); persona carries knee height and reach
             "transfer": {"min_above_knee_m": 0.05, "max_above_knee_m": 0.20, "reach_height_m": [0.3, 1.3], **gm.get("transfer", {})},
             "ems": {"stretcher_width_m": 0.6, "phone_reach_m": 3.0, **gm.get("ems", {}), "entry": gm.get("entry")},
             "hazards": "hazards.json", "route": "route.json", "routes": "routes.json", "walker": "walker.json", "personas": "personas.json",
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

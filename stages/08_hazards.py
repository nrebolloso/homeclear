"""Stage 8: flag path segments with side clearance below margin, and where the walker footprint crosses floor bumps.
Each hazard gets a verdict. Within the measured map error (stage 6b) of a limit it is "borderline, OT to verify";
cables are classified, not measured, so their height is "estimated, OT to verify"."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage

import numpy as np
from scipy import ndimage


def runs(flags):
    """[start, end) index ranges of consecutive True values."""
    d = np.diff(np.concatenate([[0], flags.astype(int), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def main(cfg):
    w, hc = cfg["work"], cfg["hazards"]
    path = json.loads((w / "path.json").read_text())
    cell = json.loads((w / "grid.json").read_text())["cell_m"]
    P, xy, side = np.array(path["cells"]), np.array(path["xy"]), np.array(path["side_clearance_m"])
    r = int(np.ceil(cfg["plan"]["walker_width_m"] / 2 / cell))
    disk = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
    bump_under = ndimage.maximum_filter(np.load(w / "bump_height_m.npy"), footprint=disk)[tuple(P.T)]
    est = np.load(w / "bump_estimated.npy")
    est_under = ndimage.maximum_filter(est, footprint=disk)[tuple(P.T)]
    meas_under = ndimage.maximum_filter(np.where(est, 0, np.load(w / "bump_height_m.npy")), footprint=disk)[tuple(P.T)]
    acc = json.loads((w / "accuracy.json").read_text()) if (w / "accuracy.json").exists() else {}
    mg = acc.get("margin_m") or {}
    e_w, e_h = mg.get("width") or 0.0, mg.get("height") or 0.0   # no ground truth -> no borderline band
    lim_c, lim_b = hc["clearance_margin_m"], hc["bump_limit_m"]

    def verdict(v, lim, below_is_bad, e):
        if abs(v - lim) <= e:
            return "borderline, OT to verify"
        return "fail" if (v < lim) == below_is_bad else "minor"

    hazards = []
    for kind, flags in (("tight_clearance", side < lim_c + e_w), ("floor_bump", bump_under > 0)):
        for a, b in runs(flags):
            mid = (a + b) // 2
            heading = xy[min(b, len(xy) - 1)] - xy[max(a - 1, 0)]
            h = {"id": len(hazards), "type": kind, "path_index": [int(a), int(b)],
                 "length_m": round(float(np.linalg.norm(np.diff(xy[a:b + 1], axis=0), axis=1).sum()), 2),
                 "heading_xy": (heading / (np.linalg.norm(heading) + 1e-9)).round(3).tolist()}
            if kind == "tight_clearance":
                h["min_side_clearance_m"] = round(float(side[a:b].min()), 3)
                h["required_margin_m"] = lim_c
                h["verdict"] = verdict(h["min_side_clearance_m"], lim_c, True, e_w)
                h["position_m"] = [*xy[a + int(np.argmin(side[a:b]))].round(3).tolist(), 0.0]
            else:
                h["max_bump_height_cm"] = round(100 * float(bump_under[a:b].max()), 1)
                h["position_m"] = [*xy[mid].round(3).tolist(), round(float(bump_under[a:b].max()), 3)]
                h["estimated"] = bool(est_under[a:b].any())
                hm = float(meas_under[a:b].max())   # the verdict comes from measured cells; a cable alone is only estimated
                h["verdict"] = verdict(hm, lim_b, False, e_h) if hm > 0 else "estimated, OT to verify"
            hazards.append(h)
    (w / "hazards.json").write_text(json.dumps({"frame": "metric, floor z=0, up=+z (splat_aligned.ply)",
                                                "source": "splat geometry only", "accuracy_margin_m": mg or None,
                                                "hazards": hazards}, indent=2))
    m = {"hazards": len(hazards), "tight_clearance": sum(h["type"] == "tight_clearance" for h in hazards),
         "floor_bump": sum(h["type"] == "floor_bump" for h in hazards),
         "borderline": sum(h["verdict"].startswith("borderline") for h in hazards), "margin_cm": {"width": round(100 * e_w, 2), "height": round(100 * e_h, 2)}}
    return True, m


if __name__ == "__main__":
    run_stage("08_hazards", main)

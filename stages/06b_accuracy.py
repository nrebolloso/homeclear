"""Stage 6b: map measurements vs ground truth (accuracy.ground_truth: tape measurements, or known synthetic dimensions).
The max error is the margin stage 8 uses: a hazard within it of a limit is "borderline, OT to verify", not pass/fail.
Heights and widths get separate margins: the map's vertical and horizontal errors come from different things.
Kinds:  bump_height  box_xy -> median measured height of the (non-estimated) bump cells in the box
        free_span    box_xy, axis -> narrowest gap: per line along axis (0 = x, 1 = y) its longest obstacle-free run, min over lines
        marker_height  -> stage 4's marker check (scale.json), when there was a marker
        pick_distance  points: 2 hand picks {image: [u, v]} -> 3-D distance through stage 4's scale (e.g. a tabletop's width)
        pick_height    points: 1 hand pick -> height above stage 5's floor (e.g. a tabletop)
pick_* check scale + floor, not the map, and include the pick error, so they are left out of stage 8's margins."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, triangulate_picks

import numpy as np

GROUP = {"bump_height": "height", "marker_height": "height", "free_span": "width", "pick_distance": "pick", "pick_height": "pick"}


def longest_run(a):
    """Longest run of True in a 1-D bool array."""
    d = np.diff(np.concatenate([[0], a.astype(int), [0]]))
    return int((np.flatnonzero(d == -1) - np.flatnonzero(d == 1)).max(initial=0))


def measure(gt, w, grid):
    lo, cell = np.array(grid["origin_xy"]), grid["cell_m"]
    if gt["kind"] == "marker_height":
        s = json.loads((w / "scale.json").read_text())
        return s.get("marker_height_measured_m")
    if gt["kind"] in ("pick_distance", "pick_height"):
        T = np.array(json.loads((w / "align.json").read_text())["T_colmap_to_floor"])
        X, _ = triangulate_picks(json.loads((w / "cameras.json").read_text()), gt["points"])
        X = [T[:3, :3] @ x + T[:3, 3] for x in X]
        return float(np.linalg.norm(X[0] - X[1])) if gt["kind"] == "pick_distance" else float(X[0][2])
    (i0, j0), (i1, j1) = np.clip(np.round((np.sort(np.array(gt["box_xy"], float), 0) - lo) / cell).astype(int), 0, grid["shape"])
    if gt["kind"] == "bump_height":
        h = np.load(w / "bump_height_m.npy")[i0:i1, j0:j1]
        m = np.load(w / "bumps.npy")[i0:i1, j0:j1] & ~np.load(w / "bump_estimated.npy")[i0:i1, j0:j1]
        return float(np.median(h[m])) if m.any() else None
    if gt["kind"] == "free_span":
        free = ~np.load(w / "obstacles.npy")[i0:i1, j0:j1]
        lines = free.T if gt["axis"] == 0 else free
        return float(min(longest_run(l) for l in lines) * cell)
    raise ValueError(f"unsupported accuracy kind {gt['kind']}")


def main(cfg):
    w = cfg["work"]
    grid = json.loads((w / "grid.json").read_text())
    rows = []
    for gt in (cfg.get("accuracy") or {}).get("ground_truth") or []:
        m = measure(gt, w, grid)
        rows.append({"name": gt["name"], "kind": gt["kind"], "truth_m": gt["meters"], "estimated": bool(gt.get("estimated")),
                     "source": gt.get("source", "estimate" if gt.get("estimated") else "tape"),
                     "measured_m": None if m is None else round(m, 4),
                     "error_m": None if m is None else round(abs(m - gt["meters"]), 4)})
    # an estimated truth (a guess, a standard size) is reported, but its "error" is partly the guess's: it never sets margins
    tape = [r for r in rows if not r["estimated"]]
    err = [r["error_m"] for r in tape if r["error_m"] is not None]
    stat = lambda f, g=None, rs=tape: (lambda e: round(float(f(e)), 4) if e else None)(
        [r["error_m"] for r in rs if r["error_m"] is not None and g in (None, GROUP[r["kind"]])])
    out = {"checks": rows, "mean_error_m": stat(np.mean), "max_error_m": stat(np.max),
           "margin_m": {g: stat(np.max, g) for g in ("height", "width")},
           "estimate_max_error_m": stat(np.max, rs=[r for r in rows if r["estimated"]]),
           "note": "stage 8 margins = max error per group over tape measurements only; null = none for it, so no borderline band"}
    (w / "accuracy.json").write_text(json.dumps(out, indent=1))
    missed = [r["name"] for r in rows if r["measured_m"] is None]
    met = {"checks": len(rows), "tape": len(tape), "mean_error_cm": out["mean_error_m"] and round(100 * out["mean_error_m"], 2),
           "max_error_cm": out["max_error_m"] and round(100 * out["max_error_m"], 2),
           "margin_cm": {g: v and round(100 * v, 2) for g, v in out["margin_m"].items()}, "not_measured": missed}
    if not tape:   # nothing tape-measured: no verdict and no margins (estimates, if any, are in accuracy.json)
        return None, met | {"estimate_max_error_cm": out["estimate_max_error_m"] and round(100 * out["estimate_max_error_m"], 2),
                            "note": "UNVERIFIED: no tape measurements" + (", estimates only" if rows else "")}
    return bool(err) and not missed, met


if __name__ == "__main__":
    run_stage("06b_accuracy", main)

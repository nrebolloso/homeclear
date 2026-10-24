"""hazards_spec (SPEC section 5's hazards.json fields next to stage 8's own) and maps_export (occupancy / bumps / coverage as PNG +
JSON). SYNTHETIC inputs shaped like stage 8's and stage 12's. Run:  .venv/bin/python tests/test_spec_export.py"""
import copy, json, sys, tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hazards_spec import add_spec_fields, validate
from maps_export import export_maps, OCC_FLOOR, OCC_OBSTACLE, OCC_UNSEEN

# --- hazards: one of each kind stage 12 hands over
bump = {"id": 0, "type": "floor_bump", "path_index": [3, 9], "length_m": 0.4, "max_bump_height_cm": 1.5, "position_m": [2.38, 1.59, 0.015],
        "estimated": False, "verdict": "fail", "source": "geometry", "ot_check": True, "note": "1.5 cm floor bump"}
cable = {**bump, "id": 1, "max_bump_height_cm": 0.6, "estimated": True, "verdict": "estimated, OT to verify"}
tight = {"id": 2, "type": "tight_clearance", "min_side_clearance_m": 0.056, "required_margin_m": 0.1, "position_m": [1.2, 0.8, 0.0],
         "verdict": "borderline, OT to verify", "source": "geometry", "ot_check": True, "note": "6 cm each side"}
minor = {**bump, "id": 3, "verdict": "minor", "ot_check": False}
reason = {"id": 4, "type": "grab_bar", "source": "cosmos_reason", "position_m": [0.5, 2.0], "verdict": "unmeasurable, OT to verify", "measured": None,
          "note": "no grab bar by the toilet", "ot_check": True, "height_m": None}
hz = [copy.deepcopy(h) for h in (bump, cable, tight, minor, reason)]
assert validate({"hazards": hz}), "unconverted entries are not in the spec shape"
for h in hz:
    add_spec_fields(h)
assert validate({"hazards": hz}) == [], validate({"hazards": hz})
b, c, t, m, r = hz
assert b["pos"] == [2.38, 1.59] and b["height_m"] == 0.015 and b["clearance_m"] is None and b["basis"] == "measured" and not b["borderline"]
assert c["basis"] == "estimated" and c["height_m"] == 0.006                       # a cable is classified, not measured
assert t["clearance_m"] == 0.056 and t["height_m"] is None and t["borderline"] and t["basis"] == "measured"
assert m["basis"] == "measured" and not m["ot_check"]
assert r["basis"] == "estimated" and r["source"] == "cosmos_reason" and r["pos"] == [0.5, 2.0]
assert b["position_m"] == [2.38, 1.59, 0.015] and b["max_bump_height_cm"] == 1.5     # stage 8's fields are untouched
again = copy.deepcopy(hz)
for h in again:
    add_spec_fields(h)
assert again == hz, "idempotent"
broken = copy.deepcopy(hz)
del broken[0]["note"]; broken[1]["basis"] = "guessed"; broken[2]["id"] = 0; broken[3]["borderline"] = "no"
problems = validate({"hazards": broken})
assert any("duplicate" in p for p in problems) and any("missing note" in p for p in problems) and any("basis" in p for p in problems) and any("borderline" in p for p in problems), problems

# --- maps: an 8 x 5 grid, wall column at i = 7, one bump cell, coverage that rises with i
nx, ny = 8, 5
floor = np.ones((nx, ny), bool); floor[0, :] = False
obst = np.zeros((nx, ny), bool); obst[7, :] = True
bump_h = np.zeros((nx, ny), np.float32); bump_h[3, 1] = 0.0153
cov = np.tile(np.arange(nx, dtype=np.uint8)[:, None] * 10, (1, ny))
with tempfile.TemporaryDirectory() as d:
    rel = export_maps(d, (1.0, -2.0), 0.05, floor, obst, bump_h, cov, 3)
    assert rel == {"occupancy": "maps/occupancy.png", "bumps": "maps/bumps.png", "coverage": "maps/coverage.png"}
    P = Path(d) / "maps"
    # read each back in the documented layout: img[ny - 1 - j, i]
    occ = cv2.imread(str(P / "occupancy.png"), cv2.IMREAD_UNCHANGED)
    assert occ.shape == (ny, nx) and occ[ny - 1 - 2, 0] == OCC_UNSEEN and occ[ny - 1 - 2, 3] == OCC_FLOOR and occ[ny - 1 - 4, 7] == OCC_OBSTACLE
    bumps = cv2.imread(str(P / "bumps.png"), cv2.IMREAD_UNCHANGED)
    assert bumps.dtype == np.uint16 and bumps[ny - 1 - 1, 3] == 15 and bumps.sum() == 15      # 15.3 mm -> 15 (unit_m 0.001)
    covim = cv2.imread(str(P / "coverage.png"), cv2.IMREAD_UNCHANGED)
    assert covim[ny - 1, 6] == 60 and covim[0, 2] == 20
    meta = json.loads((P / "coverage.json").read_text())
    assert meta["origin_xy"] == [1.0, -2.0] and meta["cell_m"] == 0.05 and meta["shape"] == [nx, ny] and meta["good_min_views"] == 3
    assert json.loads((P / "bumps.json").read_text())["unit_m"] == 0.001
print("SPEC EXPORT TEST OK")

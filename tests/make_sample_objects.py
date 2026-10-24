"""SYNTHETIC sample-object scene (no GPU): the game_synth rooms plus more kinds of object, to test the physics, the drag-and-
replan logic and the fixes before a real home is filmed. Nothing here is measured: every box and height below is chosen.

Same two rooms and bed-to-bathroom route as tests/make_game_scene.py (its geometry is copied, not imported, so its
INTERVENTIONS can change without touching this). On top of bed / nightstand / rug / nightlight / door / toilet / cable:
  chair            movable, obstacle layer, 0.45 x 0.45 m
  low table        movable, obstacle layer; a top slab on four legs (stage 12 `parts`), 0.9 x 0.5 m, 45 cm high
  threshold strip  FIXED in the splat across the bathroom doorway: 12 mm tall, 12 cm wide, so it is MEASURED (not thin)
  transition strip FIXED, 5 mm tall, 5 cm wide, 0.9 m long: thin, so stage 6 ESTIMATES its height (like the cable)
  rug_curl         a 15 x 15 cm corner of the rug lifted to 3 cm, as its own movable rug object. Stage 12 stamps a rug as ONE
                   flat slab at its median bump height, so a curl does not survive moving the rug: modelled as a second object
Run: .venv/Scripts/python.exe tests/make_sample_objects.py   ->  viewer/public/scene/sample_objects/ (git-ignored)
"""
import json, subprocess, sys
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "tests")]
from make_game_scene import write_splat, cameras, COLORS as GAME_COLORS, RUG_H, CABLE_H, ROUTES, FIXTURES
from test_synthetic import box_surface

RUN = "sample_objects"
SILL_H, STRIP_H, CURL_H = 0.012, 0.005, 0.03
SILL_BOX = [[3.94, 1.1], [4.06, 1.9]]            # across the doorway (the wall's gap is y 1.1 to 1.9)
STRIP_BOX = [[0.90, 0.5], [0.95, 1.4]]           # 5 cm x 0.9 m, off every route
CURL_BOX = [[3.35, 2.15], [3.50, 2.30]]
TABLE_BOX = [[0.5, 0.3], [1.4, 0.8]]
COLORS = {**GAME_COLORS, "chair": (0.35, 0.25, 0.55), "table": (0.55, 0.40, 0.25), "sill": (0.3, 0.3, 0.3), "strip": (0.15, 0.15, 0.4),
          "curl": (0.85, 0.2, 0.2)}
OBJECTS = [  # movable: cut out by stage 12. The curl comes BEFORE the rug so it takes its own Gaussians first.
    {"name": "bed", "kind": "bed", "box_xy": [[0.1, 1.9], [1.7, 3.95]], "z_max": 0.7},
    {"name": "nightstand", "kind": "nightstand", "box_xy": [[1.8, 3.45], [2.3, 3.95]], "z_max": 0.8},
    {"name": "rug_curl", "kind": "rug", "box_xy": CURL_BOX, "z_max": 0.04},
    {"name": "rug", "kind": "rug", "box_xy": [[2.4, 0.9], [3.5, 2.3]], "z_max": 0.04},
    {"name": "chair", "kind": "chair", "box_xy": [[2.6, 3.0], [3.05, 3.45]], "z_max": 0.95},
    {"name": "table", "kind": "other", "box_xy": TABLE_BOX, "z_max": 0.5,
     "parts": [{"box_xy": TABLE_BOX, "z": [0.38, 0.5]},
               *({"box_xy": [[x, y], [x + 0.05, y + 0.05]], "z": [0.05, 0.38]} for x, y in [(0.5, 0.3), (1.35, 0.3), (0.5, 0.75), (1.35, 0.75)])]},
    {"name": "nightlight", "kind": "nightlight", "box_xy": [[0.03, 0.18], [0.17, 0.32]], "z_max": 0.3, "light_radius_m": 1.5},
    {"name": "door", "kind": "door", "box_xy": [[4.11, 1.84], [4.85, 1.90]], "z_max": 2.1},
]
INTERVENTIONS = [  # SYNTHETIC costs, only to give the optimizer and the fix card something to rank
    {"id": "remove_rug", "label": "Remove the rug", "kind": "remove", "object": "rug", "cost_usd": 0, "minutes": 5, "effort": 1},
    {"id": "tape_rug_corner", "label": "Tape the curled rug corner down", "kind": "flatten", "box_xy": CURL_BOX,
     "cost_usd": 5, "minutes": 5, "effort": 1, "product": "double-sided rug tape"},
    {"id": "cord_cover", "label": "Cover the cable with a flat cord cover", "kind": "flatten", "box_xy": [[3.58, 0.25], [3.70, 2.75]],
     "cost_usd": 8, "minutes": 10, "effort": 1, "product": "flat cord cover"},
    {"id": "threshold_ramp", "label": "Threshold ramp at the bathroom doorway", "kind": "flatten", "box_xy": SILL_BOX,
     "cost_usd": 25, "minutes": 10, "effort": 1, "product": "rubber threshold ramp"},
    {"id": "move_chair", "label": "Move the chair to the corner", "kind": "move", "object": "chair", "to": [3.6, 3.6, 0],
     "cost_usd": 0, "minutes": 2, "effort": 1},
    {"id": "move_table", "label": "Move the low table to the far wall", "kind": "move", "object": "table", "to": [1.0, 0.4, 0],
     "cost_usd": 0, "minutes": 5, "effort": 2},
    {"id": "raised_toilet_seat", "label": "Raised toilet seat (+15 cm) with arms", "kind": "raise", "target": "toilet", "by_m": 0.15,
     "cost_usd": 35, "minutes": 5, "effort": 1, "product": "raised toilet seat with arms, 15 cm (6 in)"},
]
GROUND_TRUTH = [  # known by construction, so stage 6b can check the map against them
    {"name": "rug height", "kind": "bump_height", "box_xy": [[2.5, 1.0], [3.3, 2.1]], "meters": RUG_H},
    {"name": "threshold height", "kind": "bump_height", "box_xy": SILL_BOX, "meters": SILL_H},
    {"name": "bathroom doorway width", "kind": "free_span", "box_xy": [[4.0, 0.9], [4.15, 2.1]], "axis": 1, "meters": 0.80},
]


def scene():
    rng = np.random.default_rng(0)
    fx, fy = np.meshgrid(np.arange(0, 6.5, 0.02), np.arange(0, 4, 0.02), indexing="ij")
    floor = np.stack([fx.ravel(), fy.ravel(), rng.normal(0, 0.002, fx.size)], 1)
    under_rug = (floor[:, 0] >= 2.4) & (floor[:, 0] <= 3.5) & (floor[:, 1] >= 0.9) & (floor[:, 1] <= 2.3)
    floor = floor[~((floor[:, 0] > 4) & (floor[:, 1] > 3)) & ~under_rug]
    d0, d1 = 1.5 - 0.4, 1.5 + 0.4
    walls = [([-0.1, -0.1, 0], [0, 4.1, 2.4]), ([-0.1, -0.1, 0], [6.6, 0, 2.4]), ([-0.1, 4, 0], [4.1, 4.1, 2.4]),
             ([4, 3, 0], [6.6, 3.1, 2.4]), ([6.5, -0.1, 0], [6.6, 3.1, 2.4]), ([4, 0, 0], [4.1, d0, 2.4]), ([4, d1, 0], [4.1, 4, 2.4])]
    t = TABLE_BOX
    legs = [box_surface([x, y, 0], [x + 0.05, y + 0.05, 0.38], 0.01) for x, y in [(0.5, 0.3), (1.35, 0.3), (0.5, 0.75), (1.35, 0.75)]]
    parts = [("floor", floor, 0.02)] + [("wall", box_surface(lo, hi, 0.04), 0.04) for lo, hi in walls] + [
        ("bed", box_surface([0.1, 1.9, 0], [1.7, 3.95, 0.55], 0.015), 0.015),
        ("nightstand", box_surface([1.8, 3.45, 0], [2.3, 3.95, 0.6], 0.015), 0.015),
        ("rug", box_surface([2.4, 0.9, 0.002], [3.5, 2.3, RUG_H], 0.01), 0.01),
        ("curl", box_surface([*CURL_BOX[0], 0.002], [*CURL_BOX[1], CURL_H], 0.01), 0.01),
        ("cable", box_surface([3.62, 0.3, 0.002], [3.66, 2.7, CABLE_H], 0.01), 0.01),
        ("sill", box_surface([*SILL_BOX[0], 0.002], [*SILL_BOX[1], SILL_H], 0.01), 0.01),
        ("strip", box_surface([*STRIP_BOX[0], 0.002], [*STRIP_BOX[1], STRIP_H], 0.01), 0.01),
        ("chair", box_surface([2.6, 3.0, 0], [3.05, 3.45, 0.5], 0.015), 0.015),
        ("chair", box_surface([2.6, 3.0, 0.5], [2.65, 3.45, 0.95], 0.015), 0.015),     # the back
        ("table", box_surface([t[0][0], t[0][1], 0.38], [t[1][0], t[1][1], 0.45], 0.015), 0.015),
        *(("table", p, 0.01) for p in legs),
        ("nightlight", box_surface([0.05, 0.2, 0.1], [0.15, 0.3, 0.2], 0.01), 0.01),
        ("toilet", box_surface([5.9, 1.2, 0], [6.45, 1.8, 0.4], 0.015), 0.015),
        ("door", box_surface([4.11, 1.84, 0], [4.85, 1.90, 2.05], 0.015), 0.015)]
    pts = np.concatenate([p for _, p, _ in parts])
    ax = np.concatenate([np.full(len(p), 2) if k == "floor" else np.minimum(abs(p - p.min(0)), abs(p - p.max(0))).argmin(1) for k, p, _ in parts])
    size = np.concatenate([np.full((len(p), 3), 0.7 * d) for _, p, d in parts])
    size[np.arange(len(pts)), ax] = 0.002
    shade = np.array([0.86, 0.74, 1.0])[ax] * (1 + rng.normal(0, 0.012, len(pts)))
    rgb = np.concatenate([np.tile(COLORS[k], (len(p), 1)) for k, p, _ in parts]) * shade[:, None]
    keep = pts[:, 2] < 2.39
    return pts[keep], rgb[keep], size[keep]


def build():
    work = ROOT / "out" / RUN
    work.mkdir(parents=True, exist_ok=True)
    write_splat(work / "splat_aligned.ply", *scene())
    (work / "cameras.json").write_text(json.dumps(cameras()))
    (work / "align.json").write_text(json.dumps({"T_colmap_to_floor": np.eye(4).tolist(), "normal": [0, 0, 1]}))
    cfg = yaml.safe_load((ROOT / "config.yaml").read_text())
    cfg.update(run_name=RUN, work_dir=f"out/{RUN}")
    cfg["plan"].update(start=[2.25, 2.7], goal=[5.4, 1.5])
    cfg["game"].update(objects=OBJECTS, interventions=INTERVENTIONS, routes=ROUTES, fixtures=FIXTURES, entry=[0.6, 0.6])
    cfg["game"]["persona"].update(knee_height_m=0.50, reach_m=0.65, hip_precautions=True)
    cfg["accuracy"]["ground_truth"] = [{**g, "source": "synthetic known dimension"} for g in GROUND_TRUTH]
    (work / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False))
    for s in ("05c_shell", "06_occupancy", "06b_accuracy", "07_plan", "08_hazards", "12_export_scene", "12b_fills"):
        subprocess.run([sys.executable, str(ROOT / "stages" / f"{s}.py"), str(work / "config.yaml")], check=s in ("06_occupancy", "12_export_scene"))
    return json.loads((work / "results" / "12_export_scene.json").read_text())


if __name__ == "__main__":
    res = build()
    assert res["status"] == "PASS", res
    out = ROOT / "viewer" / "public" / "scene" / RUN
    sc = json.loads((out / "scene.json").read_text())
    o = {x["name"]: x for x in sc["objects"]}
    grid = sc["grid"]
    est = np.fromfile(out / "bump_estimated.u8", np.uint8).reshape(grid["shape"])
    bump = np.fromfile(out / "bump.f32", np.float32).reshape(grid["shape"])
    cell = lambda x, y: tuple(int(round((v - lo) / grid["cell_m"] - 0.5)) for v, lo in zip((x, y), grid["origin_xy"]))
    def area(x):   # shoelace
        p = np.array(x["footprint"])
        return abs(float(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))) / 2
    print({k: (v["kind"], v["layer"], round(float(area(v)), 3), v["height_m"]) for k, v in o.items()})
    for name, want in [("chair", 0.45 * 0.45), ("table", 0.9 * 0.5), ("rug_curl", 0.15 * 0.15)]:
        assert abs(area(o[name]) - want) < 0.5 * want + 0.02, (name, area(o[name]), want)
    assert o["chair"]["layer"] == "obstacle" and o["table"]["layer"] == "obstacle" and o["rug"]["layer"] == o["rug_curl"]["layer"] == "bump"
    assert abs(o["rug"]["height_m"] - RUG_H) < 0.003, o["rug"]["height_m"]
    assert o["rug_curl"]["height_m"] > RUG_H + 0.003, o["rug_curl"]["height_m"]
    i, j = cell(3.64, 1.5)
    assert est[i, j] and abs(bump[i, j] - 0.006) < 1e-4, "the cable is thin: height ESTIMATED at the config's typical 6 mm"
    i, j = cell(0.925, 0.9)
    assert est[i, j], "the 5 cm transition strip is thin: ESTIMATED"
    i, j = cell(4.0, 1.5)
    assert not est[i, j] and abs(bump[i, j] - SILL_H) < 0.003, ("the 12 cm threshold is wide enough to be MEASURED", bump[i, j])
    print("SAMPLE OBJECTS OK (SYNTHETIC)", res["metrics"])

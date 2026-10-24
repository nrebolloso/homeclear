"""Synthetic walker-game scene (no GPU): bedroom -> bathroom with known answers, exported for the viewer.

Bedroom 4x4 m, bathroom 2.5x3 m, doorway in the wall at x=4 (0.80 m wide; --narrow makes it 0.55 m, narrower than the
0.66 m walker, so no route exists). Bed, nightstand, a 2.0 cm rug and a nightlight are movable; a 2.0 cm cable on the
floor before the door is not. Cameras cover everything except the far end of the bathroom (fog there).
Run: .venv/bin/python tests/make_game_scene.py   ->  viewer/public/scene/game_synth[_narrow]/
"""
import importlib, json, subprocess, sys
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages")]
from common import write_ply
sys.path.insert(0, str(ROOT / "tests"))
from test_synthetic import box_surface
look_at = importlib.import_module("09_fix_render").look_at

RUG_H, CABLE_H = 0.015, 0.005   # spec: 1.5 cm rug, 5 mm cable
# known dimensions of scene(0.80): the accuracy check (stage 6b) measures them back off the map
GROUND_TRUTH = [
    {"name": "rug height", "kind": "bump_height", "box_xy": [[2.5, 1.0], [3.4, 2.2]], "meters": RUG_H},
    {"name": "bathroom doorway width", "kind": "free_span", "box_xy": [[4.0, 0.9], [4.15, 2.1]], "axis": 1, "meters": 0.80},
    {"name": "bedroom depth (wall to wall)", "kind": "free_span", "box_xy": [[2.9, -0.3], [3.1, 4.3]], "axis": 1, "meters": 4.0},
    {"name": "bathroom depth (wall to wall)", "kind": "free_span", "box_xy": [[4.9, -0.3], [5.1, 3.3]], "axis": 1, "meters": 3.0},
    {"name": "bed to wall gap", "kind": "free_span", "box_xy": [[-0.3, 2.5], [0.5, 2.7]], "axis": 0, "meters": 0.10},
]
COLORS = {"floor": (0.62, 0.48, 0.33), "wall": (0.86, 0.83, 0.76), "bed": (0.80, 0.85, 0.95), "nightstand": (0.45, 0.30, 0.18),
          "rug": (0.70, 0.15, 0.15), "cable": (0.1, 0.1, 0.1), "nightlight": (1.0, 0.9, 0.5), "toilet": (0.97, 0.97, 0.97),
          "door": (0.55, 0.42, 0.30)}
OBJECTS = [  # movable: cut out by stage 12 (boxes in the floor frame)
    {"name": "bed", "kind": "bed", "box_xy": [[0.1, 1.9], [1.7, 3.95]], "z_max": 0.7},
    {"name": "nightstand", "kind": "nightstand", "box_xy": [[1.8, 3.45], [2.3, 3.95]], "z_max": 0.8},
    {"name": "rug", "kind": "rug", "box_xy": [[2.4, 0.9], [3.5, 2.3]], "z_max": 0.04},
    {"name": "nightlight", "kind": "nightlight", "box_xy": [[0.03, 0.18], [0.17, 0.32]], "z_max": 0.3, "light_radius_m": 1.5},
    # the bathroom door, open 90 degrees into the bathroom: its leaf + hinge knuckle (6 cm) take that much of the clear width
    {"name": "door", "kind": "door", "box_xy": [[4.11, 1.84], [4.85, 1.90]], "z_max": 2.1},
]
INTERVENTIONS = [  # cost (USD), minutes and effort (1 = anyone, 5 = two people + furniture moving) feed the fix card and optimizer
    {"id": "remove_rug", "label": "Remove the rug", "kind": "remove", "object": "rug", "cost_usd": 0, "minutes": 5, "effort": 1},
    {"id": "tape_cable", "label": "Tape the cable flat", "kind": "flatten", "box_xy": [[3.58, 0.25], [3.70, 2.75]],
     "cost_usd": 8, "minutes": 10, "effort": 1, "product": "flat cord cover or gaffer tape"},
    {"id": "move_nightstand", "label": "Move the nightstand to the far wall", "kind": "move", "object": "nightstand", "to": [0.4, 0.35, 0],
     "cost_usd": 0, "minutes": 10, "effort": 2},
    {"id": "add_nightlight", "label": "Nightlight by the doorway", "kind": "move", "object": "nightlight", "to": [3.88, 0.95, 90],
     "cost_usd": 12, "minutes": 5, "effort": 1, "product": "plug-in motion-sensor nightlight"},
    {"id": "move_bed", "label": "Turn the bed along the left wall", "kind": "move", "object": "bed", "to": [1.1, 1.05, 90],
     "cost_usd": 0, "minutes": 45, "effort": 5},
    {"id": "offset_hinges", "label": "Swing-clear (offset) hinges on the bathroom door", "kind": "move", "object": "door", "to": [4.48, 1.93, 0],
     "cost_usd": 25, "minutes": 30, "effort": 3, "product": "swing-clear offset hinges (pair)"},
    {"id": "remove_door", "label": "Take the bathroom door off its hinges", "kind": "remove", "object": "door",
     "cost_usd": 0, "minutes": 15, "effort": 4, "product": "a curtain for privacy"},
    {"id": "raised_toilet_seat", "label": "Raised toilet seat (+15 cm) with arms", "kind": "raise", "target": "toilet", "by_m": 0.15,
     "cost_usd": 35, "minutes": 5, "effort": 1, "product": "raised toilet seat with arms, 15 cm (6 in)"},
    {"id": "bed_risers", "label": "Bed risers (+8 cm)", "kind": "raise", "target": "bed", "by_m": 0.08,
     "cost_usd": 20, "minutes": 20, "effort": 3, "product": "bed risers, 8 cm"},
    {"id": "touch_lamp", "label": "Touch lamp on the nightstand", "kind": "add",
     "fixture": {"name": "touch lamp", "kind": "switch", "attach": "nightstand"}, "cost_usd": 15, "minutes": 5, "effort": 1,
     "product": "touch or clap-on bedside lamp"},
]

ROUTES = [  # night trips to the toilet, and a daytime walk to the wardrobe corner (no darkness multiplier)
    {"name": "bed to bathroom", "start": [2.25, 2.7], "goal": [5.4, 1.5], "trips_per_night": 2, "night": True, "start_with": "bed"},
    {"name": "bed to wardrobe (day)", "start": [2.25, 2.7], "goal": [3.3, 0.5], "trips_per_night": 3, "night": False, "start_with": "bed"},
]

FIXTURES = [  # the toilet seat is measured off the splat (0.40 m box top); the switch and phone are placed by hand
    {"name": "toilet", "kind": "toilet", "box_xy": [[5.9, 1.2], [6.45, 1.8]]},
    {"name": "light switch", "kind": "switch", "xyz": [2.6, 3.97, 1.1], "note": "bedroom wall, right of the door"},
    {"name": "phone", "kind": "phone", "attach": "nightstand"},
]


def scene(door_w):
    rng = np.random.default_rng(0)
    d0, d1 = 1.5 - door_w / 2, 1.5 + door_w / 2
    fx, fy = np.meshgrid(np.arange(0, 6.5, 0.02), np.arange(0, 4, 0.02), indexing="ij")
    floor = np.stack([fx.ravel(), fy.ravel(), rng.normal(0, 0.002, fx.size)], 1)
    under_rug = (floor[:, 0] >= 2.4) & (floor[:, 0] <= 3.5) & (floor[:, 1] >= 0.9) & (floor[:, 1] <= 2.3)
    floor = floor[~((floor[:, 0] > 4) & (floor[:, 1] > 3)) & ~under_rug]      # bathroom is only 3 m deep; rug hides its floor
    walls = [([-0.1, -0.1, 0], [0, 4.1, 2.4]), ([-0.1, -0.1, 0], [6.6, 0, 2.4]), ([-0.1, 4, 0], [4.1, 4.1, 2.4]),
             ([4, 3, 0], [6.6, 3.1, 2.4]), ([6.5, -0.1, 0], [6.6, 3.1, 2.4]),
             ([4, 0, 0], [4.1, d0, 2.4]), ([4, d1, 0], [4.1, 4, 2.4])]
    parts = [("floor", floor, 0.02)] + [("wall", box_surface(lo, hi, 0.04), 0.04) for lo, hi in walls] + [
        ("bed", box_surface([0.1, 1.9, 0], [1.7, 3.95, 0.55], 0.015), 0.015),
        ("nightstand", box_surface([1.8, 3.45, 0], [2.3, 3.95, 0.6], 0.015), 0.015),
        ("rug", box_surface([2.4, 0.9, 0.002], [3.5, 2.3, RUG_H], 0.01), 0.01),
        ("cable", box_surface([3.62, 0.3, 0.002], [3.66, 2.7, CABLE_H], 0.01), 0.01),
        ("nightlight", box_surface([0.05, 0.2, 0.1], [0.15, 0.3, 0.2], 0.01), 0.01),
        ("toilet", box_surface([5.9, 1.2, 0], [6.45, 1.8, 0.4], 0.015), 0.015),
        ("door", box_surface([4.11, 1.84, 0], [4.85, 1.90, 2.05], 0.015), 0.015)]
    pts = np.concatenate([p for _, p, _ in parts])
    # flat discs in each face's plane, overlapping their neighbours: a solid surface, no grid or dots (as a trained splat looks)
    ax = np.concatenate([np.full(len(p), 2) if k == "floor" else np.minimum(abs(p - p.min(0)), abs(p - p.max(0))).argmin(1) for k, p, _ in parts])
    size = np.concatenate([np.full((len(p), 3), 0.7 * d) for _, p, d in parts])
    size[np.arange(len(pts)), ax] = 0.002
    shade = np.array([0.86, 0.74, 1.0])[ax] * (1 + rng.normal(0, 0.012, len(pts)))   # fake lighting by face direction + faint grain
    rgb = np.concatenate([np.tile(COLORS[k], (len(p), 1)) for k, p, _ in parts]) * shade[:, None]
    keep = pts[:, 2] < 2.39                                                    # no ceiling
    return pts[keep], rgb[keep], size[keep]


def write_splat(path, pts, rgb, size):
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    v = np.zeros(len(pts), [(n, "f4") for n in names])
    v["x"], v["y"], v["z"] = pts.T
    for i in range(3):
        v[f"f_dc_{i}"] = (rgb[:, i] - 0.5) / 0.28209479
        v[f"scale_{i}"] = np.log(size[:, i])
    v["opacity"], v["rot_0"] = 4.0, 1.0
    write_ply(path, v)


def cameras():
    """Phone-height views sweeping both rooms; bathroom ones never face its far (x > 6) end."""
    cams = []
    K = [[1000.0, 0, 640], [0, 1000.0, 360], [0, 0, 1]]
    stops = [((x, y), range(0, 360, 45)) for x in (0.8, 2.0, 3.2) for y in (0.8, 2.0, 3.2)] + [((4.6, 1.5), range(120, 250, 30))]
    for (x, y), yaws in stops:
        for a in np.radians(list(yaws)):
            eye = np.array([x, y, 1.4])
            w2c = look_at(eye, eye + [np.cos(a), np.sin(a), -0.6])
            cams.append({"name": f"cam{len(cams):03d}", "K": K, "w2c": w2c.tolist(), "width": 1280, "height": 720})
    return cams


def build(run, door_w):
    work = ROOT / "out" / run
    work.mkdir(parents=True, exist_ok=True)
    write_splat(work / "splat_aligned.ply", *scene(door_w))
    (work / "cameras.json").write_text(json.dumps(cameras()))
    (work / "align.json").write_text(json.dumps({"T_colmap_to_floor": np.eye(4).tolist(), "normal": [0, 0, 1]}))
    cfg = yaml.safe_load((ROOT / "configs" / "home.yaml").read_text())
    cfg.update(run_name=run, work_dir=f"out/{run}")
    cfg["plan"].update(start=[2.25, 2.7], goal=[5.4, 1.5])
    cfg["game"].update(objects=OBJECTS, interventions=INTERVENTIONS, routes=ROUTES, fixtures=FIXTURES, entry=[0.6, 0.6])
    cfg["game"]["persona"].update(knee_height_m=0.50, reach_m=0.65, hip_precautions=True)
    cfg["accuracy"]["ground_truth"] = [{**g, "source": "synthetic known dimension"} for g in GROUND_TRUTH] if door_w == 0.80 else []
    (work / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False))
    for s in ("05c_shell", "06_occupancy", "06b_accuracy", "07_plan", "08_hazards", "12_export_scene", "12b_fills"):   # 7 + 8 fail on the narrow door, as they should
        subprocess.run([sys.executable, str(ROOT / "stages" / f"{s}.py"), str(work / "config.yaml")], check=s in ("06_occupancy", "12_export_scene"))
    return json.loads((work / "results" / "12_export_scene.json").read_text())


if __name__ == "__main__":
    a = build("game_synth", 0.80)
    b = build("game_synth_narrow", 0.55)
    assert a["status"] == "PASS" and b["status"] == "PASS", (a, b)
    m = a["metrics"]
    assert abs(m["objects"]["rug"] - RUG_H) < 0.003, m          # rug height measured from its Gaussians
    assert 60 < m["coverage_good_pct"] < 99, m                  # far end of the bathroom is thinly covered
    plan = json.loads((ROOT / "out/game_synth/results/07_plan.json").read_text())
    narrow = json.loads((ROOT / "out/game_synth_narrow/results/07_plan.json").read_text())
    assert plan["status"] == "PASS" and narrow["status"] == "FAIL", (plan["metrics"], narrow["metrics"])
    print("GAME SCENE OK", m)

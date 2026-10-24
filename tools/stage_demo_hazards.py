"""Stage the demo's three route hazards into an exported scene (placed for the demo, not filmed):
a 1.5 cm kitchen mat, a 5 mm cord across the floor, and a chair pulled out into the gap by the trash can.
Their heights are set here; everything on screen about them (contacts/month, clearances) is what the viewer computes.

  .venv/bin/python tools/stage_demo_hazards.py [viewer/public/scene/kitchen4_lighter]

Idempotent: the first run keeps the export as *_scan copies (scene.json, main.ply, bump.f32, bump_estimated.u8,
hazards.json) and every run rebuilds from those. Rerun after stage 12 / lighter_clean rewrite the export.
"""
import json, shutil, sys
from pathlib import Path

import numpy as np
from plyfile import PlyData, PlyElement

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from test_synthetic import box_surface

D = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "viewer/public/scene/kitchen4_lighter")
MAT_H, CORD_H = 0.015, 0.005
MAT_C, MAT_HALF = (0.25, 0.97), (0.45, 0.30)        # on the fridge -> entrance diagonal, ~1 m out from the fridge
CORD_X, CORD_Y = 1.30, (-0.80, 0.20)                 # across the east corridor, before the trash-can gap
CHAIR, CHAIR_AT = "chair8", (1.90, -0.83)            # pulled out from the table into the gap under the trash can
SH0 = 0.28209479


def scan_copy(name):
    src, keep = D / name, D / f"{Path(name).stem}_scan{Path(name).suffix}"
    if not keep.exists():
        shutil.copy2(src, keep)
    return keep


def splat_records(pts, rgb, size, dtype, opacity=4.0):
    v = np.zeros(len(pts), dtype)
    v["x"], v["y"], v["z"] = pts.T
    for i in range(3):
        v[f"f_dc_{i}"] = (rgb[:, i] - 0.5) / SH0
        v[f"scale_{i}"] = np.log(size[:, i])
    v["opacity"], v["rot_0"] = opacity, 1.0
    return v


def flat_discs(pts, d, rng):
    """Discs flat in each face's plane (as make_game_scene.py): a solid surface, faint grain."""
    ax = np.minimum(abs(pts - pts.min(0)), abs(pts - pts.max(0))).argmin(1)
    size = np.full((len(pts), 3), 0.7 * d)
    size[np.arange(len(pts)), ax] = 0.002
    shade = np.array([0.86, 0.74, 1.0])[ax] * (1 + rng.normal(0, 0.03, len(pts)))
    return size, shade


rng = np.random.default_rng(0)
sc = json.loads(scan_copy("scene.json").read_text())
g = sc["grid"]; nx, ny = g["shape"]; cell = g["cell_m"]; ox, oy = g["origin_xy"]

# mat: its own movable object, PLY pivot-local; navy with a lighter border so the edge reads from eye height
hx, hy = MAT_HALF
mat = box_surface([-hx, -hy, 0.002], [hx, hy, MAT_H], 0.008)
size, shade = flat_discs(mat, 0.008, rng)
edge = np.minimum(hx - abs(mat[:, 0]), hy - abs(mat[:, 1])) < 0.05
rgb = np.where(edge[:, None], [0.55, 0.60, 0.68], [0.16, 0.22, 0.36]) * shade[:, None]
simple = [(n, "f4") for n in ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
                              "rot_0", "rot_1", "rot_2", "rot_3"]]
(D / "objects").mkdir(exist_ok=True)
PlyData([PlyElement.describe(splat_records(mat, rgb, size, simple), "vertex")]).write(str(D / "objects/mat.ply"))
# the floor under the mat was filmed (it is in main.ply), so its "fill" is one invisible splat for every fill backend
PlyData([PlyElement.describe(splat_records(np.zeros((1, 3)), np.zeros((1, 3)), np.full((1, 3), 1e-3), simple, -20.0), "vertex")]
        ).write(str(D / "objects/fill_mat.ply"))
backends = {b for o in sc["objects"] for b in (o.get("fills") or {})}
mat_obj = {"name": "mat", "kind": "rug", "splat": "objects/mat.ply", "surface_m": None, "fill": "objects/fill_mat.ply",
           "fills": {b: "objects/fill_mat.ply" for b in backends},
           "pivot": [*MAT_C, 0.0], "footprint": [[-hx, hy], [-hx, -hy], [hx, -hy], [hx, hy]], "height_m": MAT_H,
           "layer": "bump", "light_radius_m": None, "placed": "staged for the demo, not filmed"}

# cord: part of the room (not movable), so it goes into the room splat and the measured bump layers, marked estimated
# like any classified cable; off-white (a common extension cord) so it shows on the wood floor; a gentle S so it reads as a cord, not a line
ys = np.arange(CORD_Y[0], CORD_Y[1], 0.004)
xs = CORD_X + 0.06 * np.sin((ys - CORD_Y[0]) / (CORD_Y[1] - CORD_Y[0]) * 2 * np.pi)
ring = np.linspace(0, 2 * np.pi, 8, endpoint=False)
r = CORD_H / 2
cord = np.concatenate([np.stack([xs + r * np.cos(a), ys, np.full_like(ys, r + r * np.sin(a))], 1) for a in ring])
room = PlyData.read(str(scan_copy("main.ply")))["vertex"].data
add = splat_records(cord, np.full((len(cord), 3), 0.93), np.full((len(cord), 3), 0.003), room.dtype)
PlyData([PlyElement.describe(np.concatenate([room, add]), "vertex")]).write(str(D / "main.ply"))

bump = np.fromfile(scan_copy("bump.f32"), np.float32).reshape(nx, ny)
est = np.fromfile(scan_copy("bump_estimated.u8"), np.uint8).reshape(nx, ny)
for x, y in zip(xs, ys):
    i, j = int((x - ox) // cell), int((y - oy) // cell)
    bump[i, j] = max(bump[i, j], CORD_H); est[i, j] = 1
bump.tofile(D / "bump.f32"); est.tofile(D / "bump_estimated.u8")

# chair: same object, staged start pose; its scanned spot stays the pivot (fills, never-filmed floor, the fix target)
objs = [o for o in sc["objects"] if o["name"] != "mat"] + [mat_obj]
chair = next(o for o in objs if o["name"] == CHAIR)
chair["start"] = [*CHAIR_AT, 0.0]
sc["objects"] = objs
sc["interventions"] = [
    {"id": "remove_mat", "label": "Remove the kitchen mat", "kind": "remove", "object": "mat", "cost_usd": 0, "minutes": 2, "effort": 1},
    {"id": "tape_cord", "label": "Tape the cord flat", "kind": "flatten",
     "box_xy": [[CORD_X - 0.10, CORD_Y[0]], [CORD_X + 0.10, CORD_Y[1]]], "cost_usd": 8, "minutes": 10, "effort": 1,
     "product": "flat cord cover or gaffer tape"},
    {"id": "push_in_chair", "label": "Push the chair back under the table", "kind": "move", "object": CHAIR,
     "to": [chair["pivot"][0], chair["pivot"][1], 0], "cost_usd": 0, "minutes": 1, "effort": 1},
]
(D / "scene.json").write_text(json.dumps(sc, indent=1))

# hazards.json in the stage 8 shape, source "placed"; per-month numbers are left to the viewer's simulation
hz = json.loads(scan_copy("hazards.json").read_text())
hz["hazards"] = [h for h in hz["hazards"] if h.get("source") != "placed"] + [
    {"id": "mat", "type": "floor_bump", "position_m": [*MAT_C, MAT_H], "max_bump_height_cm": MAT_H * 100, "estimated": False,
     "source": "placed", "object": "mat", "fix": "remove_mat", "note": "1.5 cm kitchen mat edge across the route"},
    {"id": "cord", "type": "floor_bump", "position_m": [CORD_X, -0.45, CORD_H], "max_bump_height_cm": CORD_H * 100, "estimated": True,
     "source": "placed", "fix": "tape_cord", "note": "5 mm cord across the route"},
    {"id": "chair", "type": "tight_clearance", "position_m": [CHAIR_AT[0], -0.35, 0.0], "source": "placed", "object": CHAIR,
     "fix": "push_in_chair", "note": "chair pulled out beside the trash can narrows the passage"},
]
(D / "hazards.json").write_text(json.dumps(hz, indent=1))
print(f"staged mat, cord ({len(add)} splats), {CHAIR} at {CHAIR_AT} in {D}")

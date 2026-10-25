"""The occupancy, floor-bump and coverage maps as PNG + JSON (SPEC section 5: maps/occupancy, maps/bumps, maps/coverage), for
people and tools that don't read the viewer's raw grids. The raw files (floor.u8, obstacles.u8, bump.f32, coverage.u8) stay the
source of truth; these are written from the same arrays at export time.

Image layout, all three: column = i (x, to the right), row = ny - 1 - j (y up), so the picture is the floor seen from above
like a map. The JSON beside each image gives the grid (origin, cell size, shape) and what a pixel value means."""
import json
from pathlib import Path

import cv2
import numpy as np

OCC_UNSEEN, OCC_FLOOR, OCC_OBSTACLE = 0, 128, 255


def _image(a):
    return np.ascontiguousarray(a.T[::-1])   # (i, j) -> (row = ny - 1 - j, col = i)


def _grid(origin_xy, cell_m, shape):
    return {"origin_xy": [float(v) for v in origin_xy], "cell_m": float(cell_m), "shape": [int(v) for v in shape],
            "image": "column = i (x right), row = ny - 1 - j (y up); cell (i, j) spans origin + (i, j) * cell_m"}


def export_maps(out, origin_xy, cell_m, floor, obstacles, bump_h, cov, cov_good):
    """Write <out>/maps/{occupancy,bumps,coverage}.{png,json}; returns the relative paths for scene.json."""
    d = Path(out) / "maps"
    d.mkdir(parents=True, exist_ok=True)
    g = _grid(origin_xy, cell_m, floor.shape)
    occ = np.where(obstacles, OCC_OBSTACLE, np.where(floor, OCC_FLOOR, OCC_UNSEEN)).astype(np.uint8)
    cv2.imwrite(str(d / "occupancy.png"), _image(occ))
    (d / "occupancy.json").write_text(json.dumps({**g, "values": {"0": "no floor seen (or not walkable)", "128": "floor", "255": "obstacle"}}, indent=1))
    mm = np.clip(np.rint(np.asarray(bump_h, np.float64) * 1000), 0, 65535).astype(np.uint16)
    cv2.imwrite(str(d / "bumps.png"), _image(mm))
    (d / "bumps.json").write_text(json.dumps({**g, "dtype": "uint16", "unit_m": 0.001, "note": "height above the locally fitted floor plane, millimetres; 0 = none"}, indent=1))
    cv2.imwrite(str(d / "coverage.png"), _image(np.asarray(cov, np.uint8)))
    (d / "coverage.json").write_text(json.dumps({**g, "dtype": "uint8", "note": "capture cameras that had the cell in view (255 when the capture has no camera list)",
                                                 "good_min_views": int(cov_good)}, indent=1))
    return {k: f"maps/{k}.png" for k in ("occupancy", "bumps", "coverage")}

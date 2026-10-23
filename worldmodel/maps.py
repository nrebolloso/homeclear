"""Map loading (stage-6 format, see INTERFACE.md) and the SYNTHETIC kitchen-like test map.

usage: python -m worldmodel.maps <out_dir>     writes the synthetic kitchen to <out_dir>
"""
import json, sys
from pathlib import Path

import numpy as np
from scipy import ndimage


class Map:
    def __init__(self, d):
        d = Path(d)
        g = json.loads((d / "grid.json").read_text())
        self.dir, self.cell, self.origin = d, g["cell_m"], np.array(g["origin_xy"], float)
        self.floor, self.obstacles = np.load(d / "floor.npy"), np.load(d / "obstacles.npy")
        self.bumps, self.bump_h = np.load(d / "bumps.npy"), np.load(d / "bump_height_m.npy").astype(float)
        self.blocked = self.obstacles | ~self.floor
        self.free_dist = ndimage.distance_transform_edt(~self.blocked) * self.cell   # cell -> nearest blocked, m
        self.labels = json.loads((d / "labels.json").read_text())["objects"] if (d / "labels.json").exists() else []
        self.ids = self._hazard_ids()

    def _hazard_ids(self):
        """Per-cell hazard name ('' = none): labelled boxes first, then connected components."""
        ids = np.full(self.floor.shape, "", object)
        lab, _ = ndimage.label(ndimage.binary_dilation(self.bumps, np.ones((3, 3))), np.ones((3, 3)))
        ids[self.bumps] = np.char.add("bump:", lab[self.bumps].astype(str))
        lab, _ = ndimage.label(self.blocked, np.ones((3, 3)))
        ids[self.blocked] = np.char.add("obst:", lab[self.blocked].astype(str))
        ids[~self.floor & ~self.obstacles] = "obst:unknown"   # never-observed space, blocked
        for o in self.labels:
            m = self.box(o["box_xy"]) & (self.bumps if o["kind"] == "bump" else self.blocked)
            ids[m] = f"{o['kind'][:4] if o['kind'] == 'bump' else 'obst'}:{o['name']}"
        return ids

    def box(self, box_xy):
        (i0, j0), (i1, j1) = np.clip(np.round((np.sort(np.array(box_xy, float), 0) - self.origin) / self.cell).astype(int),
                                     0, self.floor.shape)
        m = np.zeros(self.floor.shape, bool)
        m[i0:i1, j0:j1] = True
        return m

    def ij(self, xy):
        """World xy (..., 2) -> clipped cell indices (..., 2)."""
        return np.clip(np.floor((np.asarray(xy) - self.origin) / self.cell).astype(int), 0, np.array(self.floor.shape) - 1)

    def at(self, a, xy):
        i = self.ij(xy)
        return a[i[..., 0], i[..., 1]]

    def ray_dist(self, p, dirs, cap=2.0):
        """Free distance from p along each unit dir (n, 2), capped, by marching half-cells."""
        t = np.arange(0, cap, self.cell / 2)
        hit = self.at(self.blocked, p + t[None, :, None] * dirs[:, None, :])
        return np.where(hit.any(1), t[np.argmax(hit, 1)], cap)

    def edited(self, remove=(), move=()):
        """Copy with hazards removed (bump -> flat floor, obstacle -> floor) or moved by (dx, dy): what-if fixes."""
        m = object.__new__(Map)
        m.__dict__ = {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in self.__dict__.items()}
        for name in remove:
            sel = m.ids == name
            assert sel.any(), f"no hazard {name}"
            m.bumps[sel], m.bump_h[sel], m.obstacles[sel], m.floor[sel], m.ids[sel] = False, 0, False, True, ""
        for name, dx, dy in move:
            sel = m.ids == name
            assert sel.any(), f"no hazard {name}"
            sh = np.round(np.array([dx, dy]) / m.cell).astype(int)
            new = ndimage.shift(sel, sh, order=0)
            for a, fill in ((m.obstacles, False), (m.bumps, False), (m.bump_h, 0)):
                v = a[sel].copy() if a.dtype != bool else a[sel].any()
                a[sel] = fill
                a[new] = v.max() if a.dtype != bool else v
            m.floor[sel | new] = True
            m.ids[sel], m.ids[new] = "", name
        m.blocked = m.obstacles | ~m.floor
        m.free_dist = ndimage.distance_transform_edt(~m.blocked) * m.cell
        return m


# ---- SYNTHETIC kitchen-like test map (not measured) ----
SYNTH = {   # name, kind, box [[x0, y0], [x1, y1]], bump height m
    "walls": [("wall_S_left", [[-0.1, -0.1], [0.6, 0.0]]), ("wall_S_right", [[1.42, -0.1], [5.1, 0.0]]),
              ("wall_N", [[-0.1, 4.0], [5.1, 4.1]]), ("wall_W", [[-0.1, -0.1], [0.0, 4.1]]),
              ("wall_E", [[5.0, -0.1], [5.1, 4.1]]),
              ("hall_W", [[-0.1, -1.3], [0.0, 0.0]]), ("hall_E", [[2.0, -1.3], [2.1, 0.0]]), ("hall_S", [[-0.1, -1.4], [2.1, -1.3]])],
    "obstacles": [("counter", [[0.0, 3.4], [3.6, 4.0]]), ("fridge", [[0.0, 1.5], [0.7, 2.4]]),
                  ("island", [[1.2, 1.6], [2.6, 2.3]]), ("table", [[3.9, 0.9], [4.9, 1.9]]),
                  ("chair_W", [[3.38, 1.18], [3.83, 1.63]]), ("chair_N", [[4.18, 1.97], [4.63, 2.42]]),
                  ("chair_S", [[4.18, 0.38], [4.63, 0.83]]), ("door_jamb_L", [[0.55, -0.1], [0.6, 0.06]]),
                  ("door_jamb_R", [[1.42, -0.1], [1.47, 0.06]])],
    "bumps": [("sink_mat", [[1.6, 2.8], [2.5, 3.35]], 0.012), ("threshold", [[0.6, -0.06], [1.42, 0.06]], 0.008)],
    "route": [[1.0, -0.8], [1.0, 0.4], [2.99, 1.4], [2.99, 2.6], [2.2, 2.6], [2.05, 3.0]],   # hallway -> doorway -> gap -> sink
}


def write_synthetic(out, cell=0.02):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    lo, hi = np.array([-0.3, -1.5]), np.array([5.3, 4.3])
    shape = tuple(np.ceil((hi - lo) / cell).astype(int))
    m = object.__new__(Map)
    m.origin, m.cell, m.floor = lo, cell, np.zeros(shape, bool)
    floor = m.box([[0, 0], [5, 4]]) | m.box([[0, -1.3], [2.0, 0]]) | m.box([[0.6, -0.1], [1.42, 0.1]])
    obst = np.zeros(shape, bool)
    for _, b in SYNTH["walls"] + SYNTH["obstacles"]:
        obst |= m.box(b)
    floor |= obst
    bumps, bh = np.zeros(shape, bool), np.zeros(shape)
    for _, b, h in SYNTH["bumps"]:
        bumps |= m.box(b)
        bh[m.box(b)] = h
    for k, a in dict(floor=floor, obstacles=obst, bumps=bumps, bump_height_m=bh, bump_estimated=np.zeros(shape, bool)).items():
        np.save(out / f"{k}.npy", a)
    (out / "grid.json").write_text(json.dumps({"origin_xy": lo.tolist(), "cell_m": cell, "shape": [int(k) for k in shape],
                                               "axes": "array[i, j] = world (x, y) = origin + (i, j) * cell",
                                               "source": "SYNTHETIC kitchen-like test map (worldmodel/maps.py), not measured"}))
    labels = [{"name": n, "kind": "obstacle", "box_xy": b} for n, b in SYNTH["walls"] + SYNTH["obstacles"]]
    labels += [{"name": n, "kind": "bump", "box_xy": b, "height_m": h} for n, b, h in SYNTH["bumps"]]
    (out / "labels.json").write_text(json.dumps({"objects": labels}, indent=1))
    (out / "route.json").write_text(json.dumps({"waypoints": SYNTH["route"]}))
    return out


if __name__ == "__main__":
    print(write_synthetic(sys.argv[1]))

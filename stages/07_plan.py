"""Stage 7: A* from start to goal with obstacles inflated by the walker footprint. Path, min clearance, PNG overlay."""
import heapq, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage

import cv2
import numpy as np
from scipy import ndimage


def astar(cost, start, goal):
    """8-connected A* on a grid; cost[i,j] = per-metre multiplier, inf = blocked. Returns list of cells or None."""
    H, W = cost.shape
    steps = [(di, dj, np.hypot(di, dj)) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj]
    h = lambda c: np.hypot(c[0] - goal[0], c[1] - goal[1])
    g, prev, pq = {start: 0.0}, {}, [(h(start), start)]
    while pq:
        _, c = heapq.heappop(pq)
        if c == goal:
            path = [c]
            while c in prev:
                c = prev[c]
                path.append(c)
            return path[::-1]
        for di, dj, L in steps:
            n = (c[0] + di, c[1] + dj)
            if 0 <= n[0] < H and 0 <= n[1] < W and np.isfinite(cost[n]):
                ng = g[c] + L * cost[n]
                if ng < g.get(n, np.inf):
                    g[n], prev[n] = ng, c
                    heapq.heappush(pq, (ng + h(n), n))
    return None


def main(cfg):
    w, pc = cfg["work"], cfg["plan"]
    grid = json.loads((w / "grid.json").read_text())
    cell, origin = grid["cell_m"], np.array(grid["origin_xy"])
    blocked = np.load(w / "obstacles.npy") | ~np.load(w / "floor.npy")
    dist = ndimage.distance_transform_edt(~blocked) * cell  # walker centre -> nearest obstacle/unknown, metres
    half = pc["walker_width_m"] / 2
    free = dist > half
    assert free.any(), f"no cell has {half} m clearance; walker cannot fit anywhere"
    side = dist - half  # gap between walker side and the obstacle
    pref = pc["preferred_clearance_m"]
    cost = np.where(free, 1 + pc["clearance_weight"] * np.clip(pref - side, 0, None) / pref, np.inf)

    lab, _ = ndimage.label(free)
    _, near = ndimage.distance_transform_edt(~free, return_indices=True)
    def to_cell(xy):  # world xy -> nearest walker-reachable cell
        i, j = np.clip(((np.array(xy) - origin) // cell).astype(int), 0, np.array(free.shape) - 1)
        return tuple(int(k) for k in near[:, i, j])
    if pc.get("start") and pc.get("goal"):
        start, goal = to_cell(pc["start"]), to_cell(pc["goal"])
    else:  # auto: two far-apart cells of the largest free region (for datasets without a known layout)
        region = lab == np.bincount(lab[lab > 0]).argmax()
        # the region's far ends are at its edge, parked against a wall: keep stage 8's clearance margin when room allows
        roomy = region & (side >= cfg["hazards"]["clearance_margin_m"])
        big = np.argwhere(roomy if roomy.any() else region)
        start = tuple(int(k) for k in big[np.argmax(np.linalg.norm(big - big.mean(0), axis=1))])
        goal = tuple(int(k) for k in big[np.argmax(np.linalg.norm(big - start, axis=1))])
    to_xy = lambda c: (origin + (np.array(c) + 0.5) * cell).tolist()
    m = {"start_xy": [round(x, 2) for x in to_xy(start)], "goal_xy": [round(x, 2) for x in to_xy(goal)],
         "walker_width_m": pc["walker_width_m"]}
    path = astar(cost, start, goal) if lab[start] == lab[goal] else None
    if path is None:
        m["error"] = "no path: start and goal not connected for this walker width"
        return False, m
    P = np.array(path)
    dP = np.linalg.norm(np.diff(P, axis=0), axis=1).sum() * cell
    min_i = int(np.argmin(side[tuple(P.T)]))
    m.update({"path_length_m": round(float(dP), 2), "min_side_clearance_m": round(float(side[tuple(P[min_i])]), 3),
              "min_passage_width_m": round(float(2 * dist[tuple(P[min_i])]), 3), "min_clearance_xy": [round(x, 2) for x in to_xy(P[min_i])]})
    (w / "path.json").write_text(json.dumps({"cells": P.tolist(), "xy": [to_xy(c) for c in P],
                                             "side_clearance_m": side[tuple(P.T)].tolist(), **m}))

    img = cv2.imread(str(w / "occupancy.png"))
    img[np.flipud(free.T) & (img[..., 0] > 200)] = (200, 245, 200)  # walker-reachable floor in light green
    pts = np.stack([P[:, 0], free.shape[1] - 1 - P[:, 1]], 1).astype(np.int32)  # (i, j) -> image (x, y)
    cv2.polylines(img, [pts], False, (255, 0, 0), 2)
    for c, col in ((pts[0], (0, 160, 0)), (pts[-1], (0, 0, 220)), (pts[min_i], (255, 0, 255))):
        cv2.circle(img, tuple(int(x) for x in c), 6, col, -1)
    cv2.imwrite(str(w / "plan_overlay.png"), img)
    return True, m


if __name__ == "__main__":
    run_stage("07_plan", main)

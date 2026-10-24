"""The kitchen planner's evaluator on the GPU: viewer/src/planner.ts + evaluate.ts + sim.ts worldRollouts + objrisk.ts,
mirrored so the B200 search and the viewer score a layout the same way. Layouts are planned on the CPU (stamp, distance
field, shortest path) and then rolled out together on the GPU: [layouts x trips] rows step in lock-step through the
world model, with the same noise for every layout (common random numbers), so layout differences are not dice.
Not bit-identical to the TS evaluator (its trips draw from one mulberry32 stream; Dijkstra may break path ties
differently): planner/rescore.ts re-scores the answers in TS and tests/test_planner.py checks the two agree."""
import json, math
from pathlib import Path

import numpy as np
import torch
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
MOVE_EFFORT = {"bed": 5, "nightstand": 2, "chair": 2, "nightlight": 1, "rug": 1, "other": 3, "door": 99}   # optimize.ts DEFAULTS
EFFORT_PER_M = 0.3


def jround(x):
    return math.floor(x + 0.5)   # JS Math.round


class Scene:
    """One exported scene (viewer/public/scene/<run>/) + its planner config, world model and physics batch."""

    def __init__(self, run="kitchen4_lighter", device="cpu", root=ROOT):
        d = root / "viewer/public/scene" / run
        js = lambda f: json.loads((d / f).read_text())
        sc = js("scene.json")
        self.sc, self.g = sc, sc["grid"]
        self.nx, self.ny = self.g["shape"]
        self.cell, self.origin = self.g["cell_m"], np.array(self.g["origin_xy"])
        rd = lambda f, t: np.fromfile(d / sc["grid"][f], dtype=t).reshape(self.nx, self.ny)
        self.floor, self.obst, self.bump = rd("floor", np.uint8).astype(bool), rd("obstacles", np.uint8).astype(bool), rd("bump_height_m", np.float32)
        self.objects = sc["objects"]
        self.names = [o["name"] for o in self.objects]
        self.routes = js(sc["routes"]) if sc.get("routes") and (d / sc["routes"]).exists() else [
            {"name": "route", **js("route.json"), "trips_per_night": sc["risk"]["trips_per_night"], "night": True}]
        self.persona, self.walker, self.risk = js("persona.json"), js("walker.json"), sc["risk"]
        self.plan_p = {"walker_width_m": self.walker["width_m"], **sc["plan"]}
        self.interventions = {iv["id"]: iv for iv in sc["interventions"]}
        self.cfg = json.loads((root / "configs/planner" / f"{run}.json").read_text())
        self.batch = json.loads((root / "physics/batch_results.json").read_text())
        self.table = self.risk["contact_table"][self.persona["gait_profile"]]
        # the room as scanned: chairs at their scanned spot (o.start: chair8 out in the path), as main.ts `original`
        self.base = [((o.get("start") or o["pivot"])[0], (o.get("start") or o["pivot"])[1],
                      math.radians((o.get("start") or [0, 0, 0])[2]) if o.get("start") else 0.0, False) for o in self.objects]
        self.idx = {n: k for k, n in enumerate(self.names)}
        self.device = device
        self.wm = WorldModel(json.loads((root / "viewer/public/models/world_model.json").read_text()), self.walker, device)
        # cells an object may stand on (planner.ts floorMask)
        self.floor_ok = self.floor & ~self.obst
        for o in self.objects:
            self.floor_ok.flat[self.poly_cells(self.footprint(o, (o["pivot"][0], o["pivot"][1], 0.0)))] = True
        self.zone_cells = {n: set(self.poly_cells(box(z["box_xy"])).tolist()) for n, z in self.cfg["zones"].items()}

    # ---- grid.ts ----
    def to_cell(self, p):
        p = np.asarray(p, dtype=float)
        i = np.clip(np.floor((p[..., 0] - self.origin[0]) / self.cell), 0, self.nx - 1).astype(int)
        j = np.clip(np.floor((p[..., 1] - self.origin[1]) / self.cell), 0, self.ny - 1).astype(int)
        return i, j

    def footprint(self, o, pose):
        x, y, yaw = pose[:3]
        c, s = math.cos(yaw), math.sin(yaw)
        f = np.asarray(o["footprint"], dtype=float)
        return np.stack([x + c * f[:, 0] - s * f[:, 1], y + s * f[:, 0] + c * f[:, 1]], 1)

    def poly_cells(self, poly):
        """Flat indices of cells whose centres are inside the polygon (grid.ts polyCells, even-odd rule)."""
        i0, j0 = self.to_cell(poly.min(0))
        i1, j1 = self.to_cell(poly.max(0))
        I, J = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1), indexing="ij")
        x, y = self.origin[0] + (I + 0.5) * self.cell, self.origin[1] + (J + 0.5) * self.cell
        inside = np.zeros(I.shape, bool)
        for a in range(len(poly)):
            (xa, ya), (xb, yb) = poly[a], poly[a - 1]
            with np.errstate(divide="ignore", invalid="ignore"):
                cross = ((ya > y) != (yb > y)) & (x < (xb - xa) * (y - ya) / (yb - ya) + xa)
            inside ^= cross
        return (I * self.ny + J)[inside]

    def stamp(self, poses, flattened):
        floor, obst, bump = self.floor.copy(), self.obst.copy(), self.bump.copy()
        for o, p in zip(self.objects, poses):
            if p[3] or o["layer"] == "none":
                continue
            c = self.poly_cells(self.footprint(o, p))
            if o["layer"] == "obstacle":
                obst.flat[c] = True
            else:
                bump.flat[c] = np.maximum(bump.flat[c], o["height_m"])
        for (x0, y0), (x1, y1) in flattened:
            bump.flat[self.poly_cells(box([[x0, y0], [x1, y1]]))] = 0
        return floor, obst, bump

    def plan(self, floor, obst, start, goal):
        """grid.ts plan, step for step (same A*, same binary heap, same float rounding) so the GPU search walks the
        path the viewer draws: equal-cost paths tie-break the same way, and a 30 cm different path changes the brushes."""
        nx, ny, cell = self.nx, self.ny, self.cell
        blocked = obst | ~floor
        dist = (distance_transform_edt(~blocked).astype(np.float32).astype(np.float64) * cell).astype(np.float32)   # Float32Array twice, as edt + *= cell
        half, pref, w = self.plan_p["walker_width_m"] / 2, self.plan_p["preferred_clearance_m"], self.plan_p["clearance_weight"]
        D = dist.ravel().astype(np.float64)
        free = D > half
        if not free.any():
            return None, dist, f"no cell has {half} m clearance; walker cannot fit anywhere"
        fk = np.nonzero(free)[0]
        snap = lambda p: (lambda i, j: int(fk[np.argmin((fk // ny - i) ** 2 + (fk % ny - j) ** 2)]))(*self.to_cell(p))
        s, t = snap(start), snap(goal)
        cost = (1 + w * np.maximum(pref - (D - half), 0) / pref).tolist()   # stepCost / len (narrow_weight 0, no turn weight)
        free = free.tolist()
        ti, tj = divmod(t, ny)
        h = lambda k: _hypot(k // ny - ti, k % ny - tj)
        gs, prev, done = [math.inf] * (nx * ny), [-1] * (nx * ny), bytearray(nx * ny)
        hp, hc = [], []   # grid.ts Heap: priorities, cells

        def push(p, c):
            i = len(hp); hp.append(p); hc.append(c)
            while i > 0:
                u = (i - 1) >> 1
                if hp[u] <= p:
                    break
                hp[i], hc[i] = hp[u], hc[u]; i = u
            hp[i], hc[i] = p, c

        def pop():
            top, lp, lc = hc[0], hp.pop(), hc.pop()
            n = len(hp)
            if n:
                i = 0
                while True:
                    m = 2 * i + 1
                    if m >= n:
                        break
                    if m + 1 < n and hp[m + 1] < hp[m]:
                        m += 1
                    if hp[m] >= lp:
                        break
                    hp[i], hc[i] = hp[m], hc[m]; i = m
                hp[i], hc[i] = lp, lc
            return top

        nb = [(di, dj, math.sqrt(di * di + dj * dj)) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj]
        gs[s] = 0
        push(h(s), s)
        while hp:
            c = pop()
            if done[c]:
                continue
            done[c] = 1
            if c == t:
                break
            ci, cj = divmod(c, ny)
            for di, dj, ln in nb:
                i, j = ci + di, cj + dj
                if i < 0 or j < 0 or i >= nx or j >= ny:
                    continue
                n = i * ny + j
                if not free[n] or done[n]:
                    continue
                ng = gs[c] + ln * cost[n]
                if ng < gs[n]:
                    gs[n] = ng; prev[n] = c; push(ng + h(n), n)
        if not done[t]:
            return None, dist, "no path: start and goal not connected for this walker width"
        path = [t]
        while prev[path[-1]] >= 0:
            path.append(prev[path[-1]])
        path = np.array(path[::-1])
        xy = np.stack([self.origin[0] + (path // ny + 0.5) * cell, self.origin[1] + (path % ny + 0.5) * cell], 1)
        return xy, dist, None


def _hypot(a, b):
    """V8 Math.hypot (math.tq: scale by the max, Kahan-summed squares): bit-equal A* priorities"""
    m = max(abs(a), abs(b))
    if m == 0:
        return 0.0
    tot = comp = 0.0
    for x in (a, b):
        n = x / m
        summand = n * n - comp
        pre = tot + summand
        comp = (pre - tot) - summand
        tot = pre
    return math.sqrt(tot) * m


def box(b):
    (x0, y0), (x1, y1) = b
    return np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=float)


def smooth_route(xy, sigma=0.3):
    """worldmodel.ts smoothRoute: resample 1 cm, Gaussian smooth (edge-clamped), resample again."""
    def resample(p):
        s = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
        u = np.arange(0, s[-1] - 1e-12, 0.01) if s[-1] > 0 else np.zeros(1)
        return np.stack([np.interp(u, s, p[:, 0]), np.interp(u, s, p[:, 1])], 1)
    p = resample(np.asarray(xy, float))
    sg = sigma / 0.01
    R = math.ceil(4 * sg)
    ker = np.exp(-0.5 * ((np.arange(2 * R + 1) - R) / sg) ** 2)
    ker /= ker.sum()
    pad = np.r_[np.repeat(p[:1], R, 0), p, np.repeat(p[-1:], R, 0)]
    sm = np.stack([np.convolve(pad[:, d], ker, mode="valid") for d in range(2)], 1)
    return resample(sm)


class WorldModel:
    """worldmodel.ts predict, batched."""

    def __init__(self, m, walker, device):
        t = lambda v: torch.tensor(v, dtype=torch.float32, device=device)
        self.K, self.min_w = m["K"], m["min_w"]
        self.x_mean, self.x_std, self.x_min, self.x_max = t(m["x_mean"]), t(m["x_std"]), t(m["x_min"]), t(m["x_max"])
        self.layers = [(t(l["W"]), t(l["b"])) for l in m["layers"]]
        self.shift = walker["user_gap_m"] + walker["depth_m"] / 2 - m["mean_gap_m"]

    def predict(self, heels, sides, action):
        """heels [R,3,2] newest first, sides [R,3], action [R,3,2] -> (w [R,K], mu [R,K,2] world, sd [R,K,2] local, frame, walker [R,3])."""
        o = heels[:, 0]
        t = action[:, 0] - (heels[:, 0] + heels[:, 1]) / 2
        n = t.norm(dim=1, keepdim=True)
        t = torch.where(n > 0, t / n.clamp_min(1e-12), torch.tensor([1.0, 0.0], device=t.device))
        mir = -sides[:, 0]
        loc = lambda p: torch.stack([((p - o) * t).sum(-1), mir * (-(p[..., 0] - o[:, 0]) * t[:, 1] + (p[..., 1] - o[:, 1]) * t[:, 0])], -1)
        pts = torch.cat([heels[:, 1:3], action], 1)                       # [R,5,2]
        x = torch.stack([loc(pts[:, q]) for q in range(5)], 1).reshape(len(o), 10)
        h = (torch.minimum(torch.maximum(x, self.x_min), self.x_max) - self.x_mean) / self.x_std
        for li, (W, b) in enumerate(self.layers):
            h = h @ W.T + b
            if li < len(self.layers) - 1:
                h = torch.nn.functional.silu(h)
        K = self.K
        mix = h[:, :5 * K].reshape(-1, K, 5)
        w = torch.softmax(mix[..., 0], 1)
        keep = w >= torch.minimum(torch.tensor(self.min_w, device=w.device), w.max(1, keepdim=True).values)
        w = torch.where(keep, w, 0)
        w = w / w.sum(1, keepdim=True)
        world = lambda p: torch.stack([o[:, 0, None] + p[..., 0] * t[:, 0, None] - mir[:, None] * p[..., 1] * t[:, 1, None],
                                       o[:, 1, None] + p[..., 0] * t[:, 1, None] + mir[:, None] * p[..., 1] * t[:, 0, None]], -1)
        mu = world(mix[..., 1:3])
        sd = torch.exp(mix[..., 3:5].clamp(-7, 2))
        wm = h[:, 5 * K:5 * K + 3]
        a = torch.atan2(t[:, 1], t[:, 0]) + mir * wm[:, 2]
        cen = world(wm[:, None, :2])[:, 0]
        walker = torch.stack([cen[:, 0] + self.shift * torch.cos(a), cen[:, 1] + self.shift * torch.sin(a), a], 1)
        return w, mu, sd, (t, mir), walker


# ---- objrisk.ts ----
def _ang(d, n):
    return math.degrees(math.acos(min(1, abs(d[0] * n[0] + d[1] * n[1]) / math.hypot(*d) / math.hypot(*n))))


def _cross(a, b, c, d):
    s = lambda p, q, r: np.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
    return s(a, b, c) * s(a, b, d) < 0 and s(c, d, a) * s(c, d, b) < 0


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy or 1)))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _tail(z):
    return 0.5 * math.erfc(z / math.sqrt(2))


def _lookup(sc, ev, speed, angle):
    for b in sc["bins"]:
        if b["speed_mps"][0] <= speed <= b["speed_mps"][1] and b["angle_deg"][0] <= angle <= b["angle_deg"][1] and b["n"] > 0:
            return b[ev], b[ev + "_ci95"]
    g = sc["given_contact"][ev]
    return g["p"] or 0, g["ci95"]


def _event(name, ev, k, p, ci):
    """(object, event, per_month, lo, hi): planner.ts scales the bin's 95% interval by per_month / p"""
    pm = k * p
    return name, ev, pm, pm * (ci[0] if ci[0] is not None else p) / (p or 1), pm * (ci[1] if ci[1] is not None else p) / (p or 1)


def object_risk(R, route, xy, objs, speed, trips_month, half, sway):
    """objrisk.ts objectRisk: (object, event, per_month, lo, hi) for mat crossings and near passes of chairs."""
    out, speed = [], min(0.6, max(0.1, speed))
    for name, kind, poly in objs:
        n = len(poly)
        edges = [(poly[i], poly[(i + 1) % n]) for i in range(n)]
        if kind == "rug" and "mat_edge" in R["scenarios"]:
            c = poly.mean(0)
            for i in range(1, len(xy)):
                for a, b in edges:
                    if not _cross(xy[i - 1], xy[i], a, b):
                        continue
                    d, nrm, mid = xy[i] - xy[i - 1], (b[1] - a[1], a[0] - b[0]), (a + b) / 2
                    if d[0] * (c[0] - mid[0]) + d[1] * (c[1] - mid[1]) <= 0:
                        continue
                    angle = _ang(d, nrm)
                    for ev in ("slid", "folded"):
                        p, ci = _lookup(R["scenarios"]["mat_edge"], ev, speed, angle)
                        out.append(_event(name, ev, trips_month, p, ci))
        elif kind == "chair" and "chair" in R["scenarios"]:
            best = (math.inf, 1, 0)
            for i in range(1, len(xy)):
                for e, (a, b) in enumerate(edges):
                    d = min(_seg_dist(a, xy[i - 1], xy[i]), _seg_dist(b, xy[i - 1], xy[i]), _seg_dist(xy[i], a, b))
                    if d < best[0]:
                        best = (d, i, e)
            pc = _tail((best[0] - half) / max(sway, 1e-3))
            if pc < 1e-3:
                continue
            a, b = edges[best[2]]
            angle = _ang(xy[best[1]] - xy[best[1] - 1], (b[1] - a[1], a[0] - b[0]))
            for ev in ("moved", "tipped"):
                p, ci = _lookup(R["scenarios"]["chair"], ev, speed, angle)
                out.append(_event(name, ev, trips_month * pc, p, ci))
    return out


# ---- planner.ts: layouts (the same JSON shape as PlanLayout) ----
def to_poses(S, pl):
    """toLayout: base poses with the planner's chairs, mat and nightlight; the cord box flattened unless present."""
    P = list(S.base)
    for n, (x, y, a) in pl["chairs"].items():
        P[S.idx[n]] = (x, y, math.radians(a), False)
    m, nl = S.idx[S.cfg["mat"]], S.idx[S.cfg["nightlight"]]
    if pl["mat"] == "removed":
        P[m] = (*P[m][:3], True)
    elif pl["mat"] == "moved" and pl.get("mat_at"):
        P[m] = (pl["mat_at"][0], pl["mat_at"][1], math.radians(pl["mat_at"][2]), False)
    if pl["nightlight"] == "off":
        P[nl] = (*P[nl][:3], True)
    else:
        at = S.cfg["outlets"].get(pl["nightlight"], {}).get("xy") or pl.get("nightlight_at")
        if at:
            P[nl] = (at[0], at[1], 0.0, False)
    return P, ([] if pl["cord"] == "present" else [S.cfg["cord_box_xy"]])


def poly_dist(p, poly):
    inside, best = False, math.inf
    for a in range(len(poly)):
        (xa, ya), (xb, yb) = poly[a], poly[a - 1]
        if (ya > p[1]) != (yb > p[1]) and p[0] < (xb - xa) * (p[1] - ya) / (yb - ya) + xa:
            inside = not inside
        dx, dy = xb - xa, yb - ya
        t = max(0, min(1, ((p[0] - xa) * dx + (p[1] - ya) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(p[0] - xa - t * dx, p[1] - ya - t * dy))
    return 0 if inside else best


def check(S, pl):
    """planner.ts check: why this layout can't be a proposal ([] = valid)."""
    cfg, out = S.cfg, []
    P, _ = to_poses(S, pl)
    cells_of = lambda k: S.poly_cells(S.footprint(S.objects[k], P[k]))
    t = S.idx[cfg["table"]]
    table_poly = S.footprint(S.objects[t], P[t])
    fixed = set()
    for k, o in enumerate(S.objects):
        if o["layer"] == "obstacle" and not P[k][3] and o["name"] not in cfg["chairs"] and k != t:
            fixed.update(cells_of(k).tolist())
    table_cells, seen = set(cells_of(t).tolist()), []
    for n in cfg["chairs"]:
        k = S.idx[n]
        cells = cells_of(k)
        mine = set(cells.tolist())
        if not S.floor_ok.flat[cells].all():
            out.append(f"{n} is off the floor (wall or unscanned)")
        elif mine & fixed:
            out.append(f"{n} overlaps furniture")
        for m, sc in seen:
            if len(mine & sc) > cfg["chair_overlap_frac"] * min(len(sc), len(mine)):
                out.append(f"{n} overlaps {m}")
        if len(mine & table_cells) > cfg["under_table_frac"] * len(cells):
            out.append(f"{n} is pushed too far under the table")
        seen.append((n, mine))
        d = poly_dist(P[k][:2], table_poly)
        if d > cfg["chair_reach_m"]:
            out.append(f"{n} is {d:.2f} m from the table (limit {cfg['chair_reach_m']} m)")
        for z, zc in S.zone_cells.items():
            if mine & zc:
                out.append(f"{n} is in the {z.replace('_', ' ', 1)} zone")
    if pl["mat"] != "removed":
        cells = cells_of(S.idx[cfg["mat"]])
        if pl["mat"] == "moved" and (not S.floor_ok.flat[cells].all() or set(cells.tolist()) & fixed):
            out.append("the mat is off the floor or under furniture")
        for z, zc in S.zone_cells.items():
            if set(cells.tolist()) & zc:
                out.append(f"the mat is in the {z.replace('_', ' ', 1)} zone")
    if pl["nightlight"] != "off" and pl["nightlight"] not in cfg["outlets"]:
        out.append("the nightlight is not at an outlet")
    return out


def move_cost(kind, a, b):
    """movecost.ts moveCost (placeholder: optimize.ts DEFAULTS)"""
    d, e = math.hypot(b[0] - a[0], b[1] - a[1]), MOVE_EFFORT.get(kind, MOVE_EFFORT["other"])
    return {"usd": 0, "minutes": jround(10 + 10 * e * (1 + d / 2)), "effort": e * (1 + EFFORT_PER_M * d)}


def cost(S, frm, pl):
    """planner.ts cost: (usd, minutes, effort, item keys) from `frm` to `pl`."""
    cfg, items = S.cfg, []

    def opt(key, o):
        if "from_fix" in o:
            iv = S.interventions[o["from_fix"]]
            return key, iv.get("cost_usd") or 0, iv.get("minutes") or 10, iv.get("effort") or 1
        return key, o["cost_usd"], o["minutes"], o["effort"]

    for n in cfg["chairs"]:
        a, b = frm["chairs"][n], pl["chairs"][n]
        if math.hypot(a[0] - b[0], a[1] - b[1]) > 0.01 or a[2] != b[2]:
            c = move_cost(S.objects[S.idx[n]]["kind"], a, b)
            items.append((n, c["usd"], c["minutes"], c["effort"]))
    if pl["mat"] != frm["mat"] or (pl["mat"] == "moved" and pl.get("mat_at") != frm.get("mat_at")):
        if pl["mat"] == "moved":
            m = S.objects[S.idx[cfg["mat"]]]
            c = move_cost(m["kind"], frm.get("mat_at") or [*m["pivot"][:2], 0], pl["mat_at"])
            items.append(("mat", c["usd"], c["minutes"], c["effort"]))
        elif pl["mat"] != "present":
            items.append(opt("mat", cfg["options"]["mat"][pl["mat"]]))
    if pl["cord"] != frm["cord"] and pl["cord"] != "present":
        items.append(opt("cord", cfg["options"]["cord"][pl["cord"]]))
    if pl["nightlight"] != frm["nightlight"]:
        items.append(opt("nightlight", cfg["options"]["nightlight"][pl["nightlight"]]))
    return {"usd": sum(i[1] for i in items), "minutes": sum(i[2] for i in items), "effort": sum(i[3] for i in items), "items": [i[0] for i in items]}


def scanned(S):
    """fromLayout of the scanned room"""
    pl = {"chairs": {n: [S.base[S.idx[n]][0], S.base[S.idx[n]][1], round(math.degrees(S.base[S.idx[n]][2])) % 360] for n in S.cfg["chairs"]},
          "mat": "present", "cord": "present", "nightlight": None}
    nl = S.base[S.idx[S.cfg["nightlight"]]]
    pl["nightlight"] = next((k for k, o in S.cfg["outlets"].items() if math.hypot(o["xy"][0] - nl[0], o["xy"][1] - nl[1]) < 0.15), "elsewhere")
    return pl


# ---- evaluate.ts per layout, on the CPU: stamp, plan, object risk, the grids the GPU rollouts read ----
def prepare(S, pl, _cache={}):
    """Everything about a layout the rollouts need. Plans depend only on the obstacles (the chairs here: the mat is a bump,
    the nightlight has no footprint), so they are cached by the chairs."""
    P, flat = to_poses(S, pl)
    floor, obst, bump = S.stamp(P, flat)
    key = (id(S), json.dumps(pl["chairs"], sort_keys=True))
    if key not in _cache:
        if len(_cache) > 2000:
            _cache.clear()   # shortcut: drop-all instead of LRU, fine while proposals revisit few chair layouts
        assert len(S.routes) == 1, "shortcut: one route (kitchen4); loop rollouts over routes when a scene has more"
        rd = S.routes[0]
        xy, dist, err = S.plan(floor, obst, rd["start"], rd["goal"])
        brush = None
        if not err:
            # planner.ts brushes: a frame point brushes where dist - cell/2 < brush_m; it is attributed to the nearest
            # blocked cell's object (an obstacle footprint), else the room (wall/counter = id 0)
            ids = np.zeros(S.nx * S.ny, np.int16)
            for k, o in enumerate(S.objects):
                if o["layer"] == "obstacle" and not P[k][3]:
                    ids[S.poly_cells(S.footprint(o, P[k]))] = k + 1
            # the first nearest blocked cell in planner.ts's scan order (ties between a wall and a bin go the same way)
            D, ids = dist.ravel().astype(np.float64), ids.ravel()   # f64 like JS: 0.04f - 0.01 vs brush_m sits on the boundary
            c = np.nonzero(D - S.cell / 2 < S.cfg["brush_m"])[0]
            ci, cj = c // S.ny, c % S.ny
            best, brush = np.full(len(c), np.inf), np.full(S.nx * S.ny, -1, np.int16)
            who = np.zeros(len(c), np.int16)
            r = math.ceil((S.cfg["brush_m"] + S.cell) / S.cell) + 1
            for di in range(-r, r + 1):
                for dj in range(-r, r + 1):
                    ii, jj = ci + di, cj + dj
                    ok = (ii >= 0) & (jj >= 0) & (ii < S.nx) & (jj < S.ny)
                    n = np.where(ok, ii * S.ny + jj, 0)
                    ok &= (D[n] <= 0) & (di * di + dj * dj < best)
                    best[ok], who[ok] = di * di + dj * dj, ids[n[ok]]
            brush[c] = who
        _cache[key] = (xy, err, brush)
    xy, err, brush = _cache[key]
    if err:
        return {"error": f"{S.routes[0]['name']}: {err}"}
    rd = S.routes[0]
    objs = [(o["name"], o["kind"], S.footprint(o, P[k])) for k, o in enumerate(S.objects) if not P[k][3]]
    snags = object_risk(S.batch, rd["name"], xy, objs, S.persona.get("speed_mps", 0.5), rd["trips_per_night"] * S.risk["days_per_month"],
                        S.plan_p["walker_width_m"] / 2, S.risk["path_offset_sd_m"])
    if pl["mat"] == "taped":   # config ASSUMPTION: taped edges stop the simulated slide / fold
        snags = [e for e in snags if e[0] != S.cfg["mat"]]
    lights = [(P[k][0], P[k][1], o.get("light_radius_m") or 1.5) for k, o in enumerate(S.objects) if o["kind"] == "nightlight" and not P[k][3]]
    assert len(lights) <= 1, "shortcut: one light per layout on the GPU"
    return {"rt": smooth_route(xy).astype(np.float32), "xy": xy, "bump": bump.ravel().astype(np.float32), "brush": brush,
            "light": lights[0] if lights and rd["night"] else None, "snags": snags, "trips_per_night": rd["trips_per_night"],
            "dark": S.risk["dark_contact_multiplier"] if rd["night"] else 1.0}


# ---- sim.ts worldRollouts + planner.ts brushes, batched: rows = layouts x trips, stepped in lock-step ----
def rollouts(S, preps, trips=None, seed=1, keep=0, Q=160):
    """Contacts and brushes for prepared layouts (no errors). Every layout sees the same noise per (trip, step): common
    random numbers. keep = trips per layout whose heels / walker poses come back (the replay's fan of futures)."""
    dev, T, L = S.device, trips or S.risk["rollouts"], len(preps)
    R, nid = L * T, len(S.objects) + 1
    f32 = lambda a: torch.as_tensor(np.asarray(a), dtype=torch.float32, device=dev)
    n0 = [len(p["rt"]) for p in preps]
    ext = []
    for p in preps:   # the route extended 1.5 m straight on past its end (sim.ts ext)
        rt = p["rt"].astype(float)
        e, b = rt[-1], rt[max(0, len(rt) - 20)]
        u = (e - b) / (np.hypot(*(e - b)) or 1)
        ext.append(np.r_[rt, e + np.arange(1, 151)[:, None] * 0.01 * u])
    M = max(len(e) for e in ext)
    ext = f32(np.stack([np.r_[e, np.repeat(e[-1:], M - len(e), 0)] for e in ext]))           # [L, M, 2] padded with the end
    bump, brush = f32(np.stack([p["bump"] for p in preps])), torch.as_tensor(np.stack([p["brush"] for p in preps]), device=dev).long()
    light = f32([[*p["light"], 1] if p["light"] else [0, 0, 0, 0] for p in preps])
    dark = f32([p["dark"] for p in preps])
    lay = torch.arange(L, device=dev).repeat_interleave(T)
    trip = torch.arange(T, device=dev).repeat(L)
    n0t = torch.as_tensor(n0, device=dev)[lay]
    # common random numbers: one stream of noise per (trip, step), shared by every layout
    G = torch.Generator(device=dev).manual_seed(seed)
    clear = torch.exp(torch.randn(T, generator=G, device=dev) * S.persona["toe_clearance_cv"]) * S.persona.get("clearance_scale", 1)
    s0 = torch.where(torch.rand(T, generator=G, device=dev) < 0.5, -1.0, 1.0)
    NS = 400
    uc, na, nb, uh = (torch.rand(NS, T, generator=G, device=dev), torch.randn(NS, T, generator=G, device=dev),
                      torch.randn(NS, T, generator=G, device=dev), torch.rand(NS, T, generator=G, device=dev))
    clear, s0 = clear[trip], s0[trip]
    # start: mid-heels on route[0] facing route[20]
    r0, r20 = ext[lay, 0], ext[lay, 20]
    uv = (r20 - r0) / (r20 - r0).norm(dim=1, keepdim=True).clamp_min(1e-12)
    at = lambda a, l: torch.stack([r0[:, 0] + a * uv[:, 0] - l * uv[:, 1], r0[:, 1] + a * uv[:, 1] + l * uv[:, 0]], 1)
    L0, Wd = S.persona["stride_m"], S.persona["foot_sep_m"]
    heels = torch.stack([at(L0 / 2 + 0 * s0, s0 * Wd / 2), at(-L0 / 2 + 0 * s0, -s0 * Wd / 2), at(-1.5 * L0 + 0 * s0, s0 * Wd / 2)], 1)
    sides = torch.stack([s0, -s0, s0], 1)
    last = torch.where((s0 > 0)[:, None, None], heels[:, [1, 0]], heels[:, [0, 1]])          # index 0 = right foot
    k = torch.zeros(R, dtype=torch.long, device=dev)
    alive = torch.ones(R, dtype=torch.bool, device=dev)
    contacts, touched = torch.zeros(R, device=dev), torch.zeros(R, nid, dtype=torch.bool, device=dev)
    nsteps = torch.zeros(R, dtype=torch.long, device=dev)
    win, offs = torch.arange(120, device=dev), torch.tensor([25, 50, 100], device=dev)
    H = torch.tensor(S.table["height_m"], device=dev, dtype=torch.float32)
    Pp = torch.tensor(S.table["p_per_stride"], device=dev, dtype=torch.float32)
    org, cell, ny = f32(S.origin), S.cell, S.ny
    cells = lambda p: (((p[..., 0] - org[0]) / cell).floor().clamp(0, S.nx - 1) * ny + ((p[..., 1] - org[1]) / cell).floor().clamp(0, ny - 1)).long()
    # walker frame outline (rollout.py frame_outline): both sides and the front bar, 12 points each
    a_, b_ = S.walker["depth_m"] / 2, S.walker["width_m"] / 2 - S.walker["leg_radius_m"]
    legs = torch.tensor([[a_, b_], [a_, -b_], [-a_, b_], [-a_, -b_]], device=dev)
    u12 = torch.linspace(0, 1, 12, device=dev)[:, None]
    outline = torch.cat([legs[p] + u12 * (legs[q] - legs[p]) for p, q in ((0, 2), (1, 3), (0, 1))])   # [36, 2]
    rows = torch.arange(R, device=dev)
    kept = []
    qs = torch.arange(Q + 1, device=dev, dtype=torch.float32)
    for step in range(NS):
        mid = (heels[:, 0] + heels[:, 1]) / 2
        idx = (k[:, None] + win).clamp(max=M - 1)
        k = idx.gather(1, (ext[lay[:, None], idx] - mid[:, None]).norm(dim=2).argmin(1, keepdim=True))[:, 0]
        alive &= k < n0t - 16
        if not alive.any():
            break
        action = ext[lay[:, None], (k[:, None] + offs).clamp(max=M - 1)]
        w, mu, sd, (t, mir), walker = S.wm.predict(heels, sides, action)
        cum = w.cumsum(1)
        ci = (cum < uc[step][trip][:, None]).sum(1).clamp(max=S.wm.K - 1)
        ci = torch.where(w.gather(1, ci[:, None])[:, 0] > 0, ci, (w > 0).long().cumsum(1).argmax(1))   # fell past the last kept one
        m_, s_ = mu[rows, ci], sd[rows, ci]
        a, b = s_[:, 0] * na[step][trip], s_[:, 1] * nb[step][trip]
        foot = torch.stack([m_[:, 0] + a * t[:, 0] - mir * b * t[:, 1], m_[:, 1] + a * t[:, 1] + mir * b * t[:, 0]], 1)
        side = -sides[:, 0]
        fi = (side > 0).long()
        frm = last[rows, fi]
        ns = ((foot - frm).norm(dim=1) / (cell / 2)).ceil().clamp(2, Q)   # shortcut: swings > Q half-cells sample coarser (never at 1 m steps)
        f = (qs[None] / ns[:, None]).clamp(max=1)
        h = bump[lay[:, None], cells(frm[:, None] + (foot - frm)[:, None] * f[..., None])].amax(1)
        lit = light[lay, 3] * ((foot - light[lay, :2]).norm(dim=1) <= light[lay, 2])
        hc = (h / clear).clamp(H[0], H[-1])
        j = torch.searchsorted(H, hc.contiguous()).clamp(1, len(H) - 1)
        p = Pp[j - 1] + (Pp[j] - Pp[j - 1]) * (hc - H[j - 1]) / (H[j] - H[j - 1])
        pc = torch.where((h > 0) & alive, (p * torch.where(lit > 0, 1.0, dark[lay])).clamp(max=1), 0.0)
        contacts += pc
        nsteps += alive
        # brushes: the frame outline at this step's walker pose
        cy, sy = torch.cos(walker[:, 2]), torch.sin(walker[:, 2])
        px = walker[:, None, 0] + outline[:, 0] * cy[:, None] - outline[:, 1] * sy[:, None]
        py = walker[:, None, 1] + outline[:, 0] * sy[:, None] + outline[:, 1] * cy[:, None]
        who = brush[lay[:, None], cells(torch.stack([px, py], -1))]
        hitw = (who >= 0) & alive[:, None]
        touched[rows[:, None].expand_as(who)[hitw], who[hitw]] = True
        if keep:
            kept.append((foot, (uh[step][trip] < pc), walker, alive.clone()))
        upd = alive[:, None]
        last[rows, fi] = torch.where(upd, foot, frm)
        heels = torch.where(upd[:, :, None], torch.cat([foot[:, None], heels[:, :2]], 1), heels)
        sides = torch.where(upd, torch.cat([side[:, None], sides[:, :2]], 1), sides)
    return _summaries(S, preps, contacts.view(L, T), touched.view(L, T, nid), nsteps.view(L, T).sum(1).tolist(), kept, keep, T)


def _q(v, f):
    """sim.ts batch quantile: linear between sorted batch values"""
    v = sorted(v)
    x = f * (len(v) - 1)
    i = int(math.floor(x))
    return v[i] + (v[min(len(v) - 1, i + 1)] - v[i]) * (x - i)


def _summaries(S, preps, contacts, touched, footsteps, kept, keep, T):
    names = ["wall/counter"] + S.names
    B = min(10, T)
    bi = (torch.arange(T) * B // T).to(contacts.device)
    nb = torch.bincount(bi, minlength=B).clamp(min=1).float()
    out = []
    for l, p in enumerate(preps):
        month = p["trips_per_night"] * S.risk["days_per_month"]
        c, tc = contacts[l], touched[l].float()
        cb = (torch.zeros(B, device=c.device).index_add_(0, bi, c) * month / nb).tolist()
        bb = (torch.zeros(B, device=c.device).index_add_(0, bi, tc.sum(1)) * month / nb).tolist()
        by = {names[i]: v * month / T for i, v in enumerate(tc.sum(0).tolist()) if v}
        con, br = c.sum().item() * month / T, sum(by.values())
        sn = sum(e[2] for e in p["snags"])
        r = {"risk": con + sn + br, "contacts": con, "snags": sn, "brushes": br,
             "lo": _q(cb, 0.1) + _q(bb, 0.1) + sum(e[3] for e in p["snags"]), "hi": _q(cb, 0.9) + _q(bb, 0.9) + sum(e[4] for e in p["snags"]),
             "footsteps": footsteps[l], "snag_by": [{"object": e[0], "event": e[1], "per_month": e[2]} for e in p["snags"]], "brush_by": by}
        if keep:   # heels + walker poses of the first `keep` trips, for the replay's fan of futures
            r["ghosts"] = []
            for tr in range(min(keep, T)):
                row = l * T + tr
                st = [(f[row].tolist(), bool(h[row]), w[row].tolist()) for f, h, w, a in kept if a[row]]
                r["ghosts"].append({"pts": [s[0] for s in st], "hit": [s[1] for s in st], "walker": [s[2] for s in st]})
        out.append(r)
    return out


def score(S, pls, **kw):
    """Score planner layouts (planner.ts score, batched). Errors (no route for the walker) come back as {'error'}."""
    preps = [prepare(S, pl) for pl in pls]
    ok = [i for i, p in enumerate(preps) if "error" not in p]
    res = rollouts(S, [preps[i] for i in ok], **kw) if ok else []
    out = [{"error": p.get("error")} for p in preps]
    for i, r in zip(ok, res):
        out[i] = r
    return out

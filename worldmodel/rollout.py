"""Rollout engine: ghost walkers on a map with a world model (INTERFACE.md section 3).

usage: python -m worldmodel.rollout --map <map dir> --out <dir> [--model baseline|learned] [--nights N]
                                    [--remove <hazard id>]... [--move <hazard id> <dx> <dy>]...
"""
import argparse, csv, importlib, json, sys, time
from pathlib import Path

import numpy as np
import yaml

from .maps import Map
from .models import Baseline, State, walker_legs, walker_pose, unit, left

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
astar = importlib.import_module("stages.07_plan").astar
STEP_OK = (0.10, 0.80)   # sanity: consecutive-heel distance outside this is an impossible step


def load_cfg(path=Path(__file__).with_name("config.yaml")):
    c = yaml.safe_load(Path(path).read_text())
    game = yaml.safe_load((ROOT / c["base"]).read_text())["game"]
    for k, v in (c.get("overrides") or {}).items():
        game[k] = {**game[k], **v}
    return {**c, **game}


# walker users walk smooth curves, not the grid's 2 cm kinks; also keeps the route inside the curvature of the training
# walks (WORLD_MODEL.md "Closed-loop stability"). Clearance is checked by test_route_avoids_obstacles.
SMOOTH_M = 0.3


def plan_route(m, waypoints, walker):
    """A* through the waypoints on the grid inflated by half the walker width (stage-7 cost); 1 cm resampled polyline."""
    half, pref = walker["width_m"] / 2, 0.3
    free = m.free_dist > half
    cost = np.where(free, 1 + 5.0 * np.clip(pref - (m.free_dist - half), 0, None) / pref, np.inf)
    _, near = __import__("scipy.ndimage", fromlist=["x"]).distance_transform_edt(~free, return_indices=True)
    cells = []
    for a, b in zip(waypoints[:-1], waypoints[1:]):
        ca, cb = (tuple(int(k) for k in near[:, i, j]) for i, j in m.ij(np.array([a, b])))
        p = astar(cost, ca, cb)
        assert p, f"no route from {a} to {b} for a {walker['width_m']} m walker"
        cells += p if not cells else p[1:]
    xy = m.origin + (np.array(cells) + 0.5) * m.cell
    from scipy.ndimage import gaussian_filter1d
    xy = gaussian_filter1d(xy, 3, axis=0, mode="nearest")   # take the stair-steps out of the grid path
    for sigma in (0, SMOOTH_M / 0.01):
        xy = gaussian_filter1d(xy, sigma, axis=0, mode="nearest") if sigma else xy
        s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xy, axis=0), axis=1))]
        u = np.arange(0, s[-1], 0.01)
        xy = np.stack([np.interp(u, s, xy[:, k]) for k in range(2)], 1)
    return xy


def contact_prob(t, h):
    return float(np.interp(h, t["height_m"], t["p_per_stride"], right=t["p_per_stride"][-1]))


def rise_along(m, a, b):
    """Highest bump along segment a->b above the height at a (stepping down off a mat is not a trip), and where."""
    n = max(2, int(np.linalg.norm(b - a) / (m.cell / 2)))
    p = a + np.linspace(0, 1, n)[:, None] * (b - a)
    h = m.at(m.bump_h, p)
    k = int(np.argmax(h))
    return h[k] - h[0], p[k]


def frame_outline(pose, walker, n=12):
    """Points along the walker frame's rectangle (sides and front bar; the rear is open for the user)."""
    L = walker_legs(pose, walker)
    t = np.linspace(0, 1, n)[:, None]
    return np.concatenate([L[0] + t * (L[2] - L[0]), L[1] + t * (L[3] - L[1]), L[0] + t * (L[1] - L[0])])


class Engine:
    def __init__(self, m, cfg, model):
        self.m, self.cfg, self.model = m, cfg, model
        self.P, self.W, self.R, self.X = cfg["persona"], cfg["walker"], cfg["risk"], cfg["extras"]
        self.table = self.R["contact_table"][self.P["gait_profile"]]
        from scipy.ndimage import distance_transform_edt
        self.near = distance_transform_edt(~m.blocked, return_indices=True)[1]   # cell -> nearest blocked cell
        self.half = self.W["width_m"] / 2

    def nearest_id(self, xy):
        i, j = self.m.ij(xy)
        a, b = self.near[:, i, j]
        return self.m.ids[a, b]

    def offset_route(self, route, rng):
        """This trip's wander off the planned line: smooth lateral offset (sd path_offset_sd_m), kept inside the free space."""
        s = np.arange(len(route)) * 0.01
        off = sum(np.sin(2 * np.pi * s / rng.uniform(2, 6) + rng.uniform(0, 2 * np.pi)) for _ in range(3))
        off *= self.R["path_offset_sd_m"] / np.sqrt(1.5)
        tang = np.gradient(route, axis=0)
        n = np.stack([-tang[:, 1], tang[:, 0]], 1) / (np.linalg.norm(tang, axis=1, keepdims=True) + 1e-9)
        slack = np.clip(self.m.at(self.m.free_dist, route) - self.half - 0.01, 0, None)
        return route + np.clip(off, -slack, slack)[:, None] * n

    def trip(self, route, rng, night, trip, out):
        m, X, W = self.m, self.X, self.W
        route = self.offset_route(route, rng)
        ext = np.r_[route, route[-1] + np.arange(1, 151)[:, None] * 0.01 * unit(route[-1] - route[-20])]
        clear = np.exp(rng.standard_normal() * self.P["toe_clearance_cv"])     # this trip's toe clearance vs typical
        L0, Wd = self.P["stride_m"], self.P["foot_sep_m"]
        u = unit(route[20] - route[0])
        side0 = rng.choice([-1, 1])
        # mid-heels on route[0], as in the training data (its route points are measured from the nearest point to mid-heels)
        heels = np.array([route[0] + L0 / 2 * u + side0 * Wd / 2 * left(u), route[0] - L0 / 2 * u - side0 * Wd / 2 * left(u),
                          route[0] - 1.5 * L0 * u + side0 * Wd / 2 * left(u)])
        s = State(heels, heels + X["toe_offset_m"] * u, np.array([side0, -side0, side0]),
                  route[0].copy(), u * L0 / X["step_time_s"], np.zeros(3), np.full(8, 2.0))
        k = 0
        action = lambda k: ext[[k + 25, k + 50, k + 100]]
        s.walker = walker_pose(s, s.heels[1], action(0), W)
        touched = set()
        for step in range(400):
            k = k + int(np.argmin(np.linalg.norm(ext[k:k + 120] - (s.heels[0] + s.heels[1]) / 2, axis=1)))
            if k >= len(route) - 16:
                break
            a = action(k)
            hd = np.arctan2(s.com_v[1], s.com_v[0])
            s.obstacle_dist = m.ray_dist(s.com, np.stack([np.cos(hd + np.arange(8) * np.pi / 4), np.sin(hd + np.arange(8) * np.pi / 4)], 1))
            dist = self.model.predict(s, a)
            raw = dist.sample(rng)
            heel, tries = raw, 0
            while m.at(m.blocked, heel) and tries < 10:
                heel, tries = dist.sample(rng), tries + 1
            if m.at(m.blocked, heel):
                heel = dist.mean()
            side = -s.sides[0]
            toe = heel + X["toe_offset_m"] * unit(heel - s.heels[1] if np.linalg.norm(heel - s.heels[1]) > 0.05 else a[-1] - heel)
            out["steps"].append((night, trip, step, side, *heel, *toe, bool(m.at(m.blocked, raw)), tries,
                                 float(np.linalg.norm(heel - s.heels[0])), bool(m.at(m.blocked, heel))))
            rise, at = rise_along(m, s.toes[1], toe)     # the swing foot's toe, from where it last stood
            if rise > 0:
                p = contact_prob(self.table, rise / clear)
                out["events"].append(("toe_contact", night, trip, step, m.at(m.ids, at), round(float(rise), 4), round(p, 5),
                                      int(rng.random() < p), *np.round(at, 3)))
            pose = self.model.walker_pose(s, heel, a, W, s.walker)
            d = np.array([np.cos(pose[2]), np.sin(pose[2])])
            for _ in range(35):   # a user stops the walker at a counter or wall ahead: pull it back, up to 0.7 m
                if not m.at(m.blocked, frame_outline(pose, W)[24:]).any():   # front bar clear
                    break
                pose[:2] -= 0.02 * d
            out["walker"].append((night, trip, step, *pose))
            old, new = walker_legs(s.walker, W), walker_legs(pose, W)
            for leg in range(4):   # legs 0, 1 = front wheels, 2, 3 = rear glides
                r, at = rise_along(m, old[leg], new[leg])
                if r >= X["snag_rise_m"]["wheel" if leg < 2 else "glide"]:
                    out["events"].append(("snag", night, trip, step, m.at(m.ids, at), round(float(r), 4), 1.0, 1, *np.round(at, 3)))
                if m.at(m.blocked, new[leg]):
                    out["events"].append(("collision", night, trip, step, m.at(m.ids, new[leg]), 0.0, 1.0, 1, *np.round(new[leg], 3)))
            fo = frame_outline(pose, W)
            gap = m.at(m.free_dist, fo) - m.cell / 2
            j = int(np.argmin(gap))
            if gap[j] < X["brush_m"]:
                hid = self.nearest_id(fo[j])
                if hid not in touched:       # one brush per obstacle per trip
                    touched.add(hid)
                    out["events"].append(("brush", night, trip, step, hid, round(float(gap[j]), 3), 1.0, 1, *np.round(fo[j], 3)))
            v = (heel - s.heels[0]) / X["step_time_s"]
            s = State(np.r_[[heel], s.heels[:2]], np.r_[[toe], s.toes[:2]], np.r_[side, s.sides[:2]],
                      (heel + s.heels[0]) / 2, v, pose, s.obstacle_dist)


def run(map_dir, out_dir, model_name=None, nights=None, remove=(), move=(), cfg=None, seed=None):
    cfg = cfg or load_cfg()
    nights = nights or cfg["nights"]
    m = Map(map_dir).edited(remove, move) if (remove or move) else Map(map_dir)
    model_name = model_name or cfg["step_model"]
    if model_name == "learned":
        from .learned import Learned
        model = Learned(cfg)
    else:
        model = Baseline(cfg["persona"], cfg["risk"])
    rj = Path(map_dir) / "route.json"
    wps = json.loads(rj.read_text())["waypoints"] if rj.exists() else json.loads((Path(map_dir) / "path.json").read_text())["xy"][::25]
    route = plan_route(Map(map_dir), wps, cfg["walker"])     # the route is planned on the unedited map: same walk, fixed room
    eng = Engine(m, cfg, model)
    rng = np.random.default_rng(cfg["seed"] if seed is None else seed)
    out = {"steps": [], "walker": [], "events": []}
    t0 = time.time()
    for night in range(nights):
        for trip in range(cfg["risk"]["trips_per_night"]):
            eng.trip(route if trip % 2 == 0 else route[::-1], rng, night, trip, out)
    secs = time.time() - t0
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    S = np.array(out["steps"], float)
    np.savez_compressed(out_dir / "rollout.npz", steps=S, walker=np.array(out["walker"], float), route=route,
                        steps_cols=np.array("night trip step side heel_x heel_y toe_x toe_y raw_blocked resampled step_len final_blocked".split()),
                        walker_cols=np.array("night trip step x y yaw".split()))
    with open(out_dir / "events.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow("type night trip step hazard rise_or_gap_m p sampled x y".split())
        w.writerows(out["events"])
    summ = summarize(out["events"], S, nights, cfg)
    summ.update({"map": str(map_dir), "model": model_name, "nights": nights, "trips": nights * cfg["risk"]["trips_per_night"],
                 "remove": list(remove), "move": [list(x) for x in move], "route_length_m": round(len(route) * 0.01, 2),
                 "runtime_s": round(secs, 1), "assumed": cfg["extras"],
                 "labels": "contact_table is a PLACEHOLDER, NOT CALIBRATED; walker pose: " + ("learned walker head (Multi-Gait-Posture camera fit)" if model_name == "learned" else "geometric rule"),
                 "map_source": json.loads((Path(map_dir) / "grid.json").read_text()).get("source", "stage 6 (measured splat)")})
    (out_dir / "summary.json").write_text(json.dumps(summ, indent=1))
    return summ, out, route, m


def summarize(events, S, nights, cfg):
    per_month = 30 / nights          # each night already holds trips_per_night trips
    hz = {}
    months = int(np.ceil(nights / 30))
    series = np.zeros(months)
    for typ, night, trip, step, hid, val, p, smp, *_ in events:
        h = hz.setdefault(hid, {"toe_contacts_expected": 0.0, "toe_contacts_sampled": 0, "swings_over": 0, "snags": 0, "collisions": 0, "brushes": 0})
        if typ == "toe_contact":
            h["toe_contacts_expected"] += p
            h["toe_contacts_sampled"] += smp
            h["swings_over"] += 1
            series[night // 30] += smp
        else:
            h[typ + "es" if typ == "brush" else typ + "s"] += 1   # snags, collisions, brushes
    for h in hz.values():
        for k in list(h):
            h[k] = round(h[k] * per_month, 3)
    full = nights // 30
    tot = lambda k: round(sum(h[k] for h in hz.values()), 3)
    return {"per_hazard_per_month": dict(sorted(hz.items())),
            "totals_per_month": {k: tot(k) for k in ("toe_contacts_expected", "toe_contacts_sampled", "snags", "collisions", "brushes")},
            "toe_contacts_by_month": series[:full].tolist(), "partial_last_month_nights": nights - 30 * full,
            "sanity": {"steps": len(S), "raw_draw_in_obstacle_pct": round(100 * S[:, 8].mean(), 2),
                       "final_feet_in_obstacle_pct": round(100 * S[:, 11].mean(), 2),
                       "resampled_pct": round(100 * (S[:, 9] > 0).mean(), 2),
                       "impossible_step_len_pct": round(100 * ((S[:, 10] < STEP_OK[0]) | (S[:, 10] > STEP_OK[1])).mean(), 2),
                       "step_len_p5_p50_p95": np.percentile(S[:, 10], [5, 50, 95]).round(3).tolist()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model")
    ap.add_argument("--nights", type=int)
    ap.add_argument("--remove", action="append", default=[])
    ap.add_argument("--move", nargs=3, action="append", default=[])
    ap.add_argument("--plot", action="store_true")
    a = ap.parse_args()
    move = [(n, float(dx), float(dy)) for n, dx, dy in a.move]
    summ, out, route, m = run(a.map, a.out, a.model, a.nights, a.remove, move)
    if a.plot:
        from .plots import rollout_figure
        rollout_figure(m, route, a.out, summ)
    print(json.dumps({k: summ[k] for k in ("totals_per_month", "sanity", "runtime_s")}, indent=1))


if __name__ == "__main__":
    main()

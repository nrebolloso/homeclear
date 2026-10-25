"""Offline kitchen-planner search (slurm/planner.sbatch on a B200): simulated annealing over layouts, every proposal
scored by planner/engine.py (plans on a CPU pool, rollouts batched on the GPU with common random numbers).
Writes out/planner/<scene>/: search.json (the replay: the featured chain's accepted moves with a fan of imagined trips,
the risk-vs-effort dots, the Pareto front re-scored on fresh trips, the chosen layout, the job's real stats) and
evals.jsonl (every distinct layout and its score: the critic's training set).
    python -m planner.search [--scene kitchen4_lighter] [--steps N] [--chains-per-weight N] [--workers N]"""
import argparse, copy, json, math, os, random, time
from multiprocessing import get_context
from pathlib import Path

import numpy as np
import torch

from planner import engine as E

_S = None


def _init(run):
    global _S
    torch.set_num_threads(1)
    _S = E.Scene(run, device="cpu")


def _prep(pl):
    return E.prepare(_S, pl)


def key(pl):
    return json.dumps(pl, sort_keys=True)


def snap(v, g):
    return round(round(v / g) * g, 3)


def propose(S, pl, rnd, scan):
    """A neighbour that passes check(): move / turn / jump / reset a chair, or change the mat, cord or nightlight."""
    cfg, g = S.cfg, S.cfg["grid_m"]
    t = S.footprint(S.objects[S.idx[cfg["table"]]], S.base[S.idx[cfg["table"]]])
    lo, hi = t.min(0) - cfg["chair_reach_m"], t.max(0) + cfg["chair_reach_m"]
    for _ in range(200):
        q, r = copy.deepcopy(pl), rnd.random()
        if r < 0.6:
            n = rnd.choice(cfg["chairs"])
            x, y, a = q["chairs"][n]
            m = rnd.random()
            if m < 0.5:
                d = rnd.choice([0.05, 0.1, 0.2, 0.4]) * rnd.choice([-1, 1])
                x, y = (snap(x + d, g), snap(y, g)) if rnd.random() < 0.5 else (snap(x, g), snap(y + d, g))
            elif m < 0.7:
                a = (a + rnd.choice([90, 270])) % 360
            elif m < 0.9:
                x, y, a = snap(rnd.uniform(lo[0], hi[0]), g), snap(rnd.uniform(lo[1], hi[1]), g), rnd.choice([0, 90, 180, 270])
            else:
                x, y, a = scan["chairs"][n]
            q["chairs"][n] = [x, y, a]
        elif r < 0.75:
            q["mat"] = rnd.choice(["present", "taped", "removed", "moved"])
            q.pop("mat_at", None)
            if q["mat"] == "moved":
                m = S.objects[S.idx[cfg["mat"]]]["pivot"]
                q["mat_at"] = [snap(m[0] + rnd.uniform(-0.6, 0.6), g), snap(m[1] + rnd.uniform(-0.6, 0.6), g), rnd.choice([0, 90])]
        elif r < 0.8:
            if "walker" in cfg["options"]:
                q["caps"] = not q.get("caps")
        elif r < 0.87:
            q["cord"] = rnd.choice(["present", "taped", "rerouted"])
        else:
            q["nightlight"] = rnd.choice([*cfg["outlets"], "off"])
        if q != pl and not E.check(S, q):
            return q
    return pl


def pareto(pts):
    """indices of the (risk, effort) points no other point beats on both"""
    out, best = [], math.inf
    for i in sorted(range(len(pts)), key=lambda i: (pts[i][1], pts[i][0])):
        if pts[i][0] < best - 1e-9:
            out.append(i); best = pts[i][0]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="kitchen4_lighter")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--chains-per-weight", type=int)
    ap.add_argument("--workers", type=int, default=min(32, os.cpu_count()))
    ap.add_argument("--confirm-trips", type=int, default=2000)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    t_start = time.time()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    S = E.Scene(a.scene, device=dev)
    sc = S.cfg["search"]
    steps, per = a.steps or sc["steps"], a.chains_per_weight or sc["chains_per_weight"]
    lams = [l for l in sc["effort_weight"] for _ in range(per)]
    C, rnd = len(lams), random.Random(1)
    out = Path(a.out or E.ROOT / "out/planner" / a.scene)
    out.mkdir(parents=True, exist_ok=True)
    scan = E.scanned(S)
    pool = get_context("fork").Pool(a.workers, initializer=_init, initargs=(a.scene,))
    seen, layouts, gpu_s, n_evals = {}, [], 0.0, 0   # key -> index into layouts (each: layout, score, cost)

    def evaluate(pls, step=0):
        nonlocal gpu_s, n_evals
        n_evals += len(pls)
        new = list(dict.fromkeys(key(p) for p in pls if key(p) not in seen))
        if new:
            preps = pool.map(_prep, [json.loads(k) for k in new], chunksize=1)
            ok = [i for i, p in enumerate(preps) if "error" not in p]
            t = time.time()
            res = dict(zip(ok, E.rollouts(S, [preps[i] for i in ok]))) if ok else {}
            if dev == "cuda":
                torch.cuda.synchronize()
            gpu_s += time.time() - t
            for i, k in enumerate(new):
                pl = json.loads(k)
                seen[k] = len(layouts)
                layouts.append({"step": step, "layout": pl, "score": res.get(i) or {"error": preps[i]["error"]}, "cost": E.cost(S, scan, pl)})
        return [layouts[seen[key(p)]] for p in pls]

    J = lambda e, lam: math.inf if e["score"].get("error") else e["score"]["risk"] + lam * e["cost"]["effort"]
    cur = [scan] * C
    cur_e = evaluate(cur)
    trace = [[] for _ in range(C)]   # per chain: (step, layout index) at each accepted move
    for c in range(C):
        trace[c].append((0, seen[key(scan)]))
    for step in range(1, steps + 1):
        T = sc["t0"] * (sc["t1"] / sc["t0"]) ** ((step - 1) / max(1, steps - 1))
        props = [propose(S, cur[c], rnd, scan) for c in range(C)]
        ev = evaluate(props, step)
        for c in range(C):
            d = J(ev[c], lams[c]) - J(cur_e[c], lams[c])
            if d <= 0 or rnd.random() < math.exp(-d / T):
                cur[c], cur_e[c] = props[c], ev[c]
                trace[c].append((step, seen[key(props[c])]))
        if step % 50 == 0:
            best = min(range(len(layouts)), key=lambda i: J(layouts[i], 0))
            print(f"step {step} T={T:.2f} layouts={len(layouts)} evals={n_evals} best risk={layouts[best]['score']['risk']:.1f} "
                  f"gpu={gpu_s:.0f}s wall={time.time() - t_start:.0f}s", flush=True)
    pool.close()

    # Pareto front on risk vs effort, then re-scored on fresh trips (seed 2) so the front isn't the search's lucky draws
    valid = [i for i, e in enumerate(layouts) if not e["score"].get("error")]
    front = [valid[i] for i in pareto([(layouts[i]["score"]["risk"], layouts[i]["cost"]["effort"]) for i in valid])]
    conf = E.score(S, [layouts[i]["layout"] for i in front], trips=a.confirm_trips, seed=2)
    pf = [{"i": i, "layout": layouts[i]["layout"], "cost": layouts[i]["cost"], "search": _slim(layouts[i]["score"]), "confirm": _slim(c)} for i, c in zip(front, conf)]
    # the chosen layout: the knee of the confirmed front (furthest below the line from the scanned room to the lowest
    # risk), plus the cheapest real improvement and the lowest risk as the other options
    base = layouts[seen[key(scan)]]
    r0, rmin = pf[0]["confirm"]["risk"], min(p["confirm"]["risk"] for p in pf)
    emax = max(p["cost"]["effort"] for p in pf) or 1
    knee = max(range(len(pf)), key=lambda k: (r0 - pf[k]["confirm"]["risk"]) / max(1e-9, r0 - rmin) - pf[k]["cost"]["effort"] / emax)
    low = min(range(len(pf)), key=lambda k: pf[k]["confirm"]["risk"])
    cheap = next((k for k in range(len(pf)) if pf[k]["confirm"]["risk"] < 0.8 * r0 and k != knee), None)
    options = [{"why": w, "k": k} for w, k in (("chosen: most risk removed per unit of effort", knee), ("lowest risk found", low),
                                                ("least effort for 20% less risk", cheap)) if k is not None]
    options = [o for j, o in enumerate(options) if o["k"] not in [p["k"] for p in options[:j]]]

    # the featured chain: the chosen layout's effort weight, the chain whose final layout scores best; its accepted moves
    # are the replay, each with 12 imagined trips (heels + walker) for the fan of futures
    lam = min(sc["effort_weight"], key=lambda l: abs(l - _lam_of(pf, knee, sc["effort_weight"])))
    cs = [c for c in range(C) if lams[c] == lam]
    fc = min(cs, key=lambda c: J(layouts[trace[c][-1][1]], lam))
    frames = trace[fc]
    if len(frames) > 80:   # keep the first, the last and the biggest drops
        keep_i = set(np.linspace(0, len(frames) - 1, 80).round().astype(int))
        frames = [f for j, f in enumerate(frames) if j in keep_i]
    fan = E.score(S, [layouts[i]["layout"] for _, i in frames], keep=12)
    replay = [{"step": st, "i": i, "layout": layouts[i]["layout"], "cost": layouts[i]["cost"], "score": _slim(layouts[i]["score"]),
               "ghosts": [{"pts": _r(g["pts"]), "hit": g["hit"], "walker": _r(g["walker"])} for g in f["ghosts"]]} for (st, i), f in zip(frames, fan)]
    dots = [[round(layouts[i]["score"]["risk"], 2), round(layouts[i]["cost"]["effort"], 2), round(layouts[i]["cost"]["usd"], 2), layouts[i]["step"]] for i in valid]   # risk, effort, $, step first seen
    stats = {"layouts_searched": len(layouts), "valid_layouts": len(valid), "evaluations": n_evals, "chains": C, "steps": steps,
             "trips_per_layout": S.risk["rollouts"], "trips_imagined": len(valid) * S.risk["rollouts"] + len(front) * a.confirm_trips,
             "footsteps_imagined": sum(layouts[i]["score"]["footsteps"] for i in valid) + sum(c.get("footsteps", 0) for c in conf),
             "runtime_s": round(time.time() - t_start, 1), "gpu_rollout_s": round(gpu_s, 1),
             "gpu": torch.cuda.get_device_name(0) if dev == "cuda" else "cpu", "cpu_workers": a.workers,
             "slurm_job": os.environ.get("SLURM_JOB_ID"), "host": os.uname().nodename, "seed": 1, "confirm_seed": 2,
             "effort_weights": sc["effort_weight"], "featured_chain": {"chain": fc, "effort_weight": lam}}
    json.dump({"scene": a.scene, "cfg": S.cfg, "stats": stats, "scanned": {"layout": scan, "score": _slim(base["score"]), "confirm": _slim(conf[0]) if front[0] == seen[key(scan)] else None},
               "replay": replay, "dots": dots, "pareto": pf, "options": options}, open(out / "search.json", "w"))
    with open(out / "evals.jsonl", "w") as f:
        for e in layouts:
            f.write(json.dumps({"layout": e["layout"], "cost": e["cost"], "score": _slim(e["score"])}) + "\n")
    print(json.dumps(stats))
    print("options:", [(o["why"], pf[o["k"]]["confirm"]["risk"], pf[o["k"]]["cost"]["effort"]) for o in options])


def _lam_of(pf, k, lams):
    """the effort weight at which point k of the front is the best: the middle of its supporting slopes"""
    e, r = pf[k]["cost"]["effort"], pf[k]["confirm"]["risk"]
    sl = [(r - p["confirm"]["risk"]) / (p["cost"]["effort"] - e) for p in pf if p["cost"]["effort"] > e + 1e-9 and p["confirm"]["risk"] < r]
    sr = [(p["confirm"]["risk"] - r) / (e - p["cost"]["effort"]) for p in pf if p["cost"]["effort"] < e - 1e-9 and p["confirm"]["risk"] > r]
    lo, hi = (max(sl) if sl else 0), (min(sr) if sr else max(lams))
    return (lo + hi) / 2


def _slim(s):
    return {k: v for k, v in s.items() if k not in ("ghosts",)}


def _r(v):
    return np.round(np.asarray(v, float), 3).tolist()


if __name__ == "__main__":
    main()

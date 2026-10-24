"""Self-checks for worldmodel/horizon.py (SYNTHETIC trials, no dataset): python -m pytest worldmodel/test_horizon.py, or
python worldmodel/test_horizon.py (the plain runner at the bottom, for machines without pytest)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worldmodel.closed_loop import frenet, walk
from worldmodel.horizon import BUCKETS, accumulate, bucket_of, report, run, table, paired
from worldmodel.models import Baseline
from worldmodel.rollout import load_cfg

CFG = load_cfg()


def test_buckets_cover_every_step_once():
    assert [bucket_of(k) for k in (0, 4, 5, 9, 10, 19, 20, 21, 200)] == [0, 0, 1, 1, 2, 2, 3, 3, 3]
    assert [b[0] for b in BUCKETS] == ["1-5", "6-10", "11-20", "21+"]


def _trial(real_sd, ens_sd, steps=40, trials=60, R=50, seed=0):
    """Per trial: an ensemble of N(0, ens_sd) lateral offsets and a real value from N(0, real_sd), every step."""
    rng, out = np.random.default_rng(seed), []
    for t in range(trials):
        sc = {"lat": rng.normal(0, ens_sd, (R, steps)), "real": rng.normal(0, real_sd, steps), "wpos": np.ones((R, steps)), "wyaw": np.ones((R, steps))}
        out.append((f"t{t}", "corner", accumulate(sc)))
    return table(out, R)["corner"]


def test_calibrated_ensemble_reads_calibrated():
    m = _trial(real_sd=0.03, ens_sd=0.03)["21+"]
    assert 0.9 < m["spread_ratio"] < 1.1, m
    assert abs(m["cover_50"] - 0.5) < 0.06 and abs(m["cover_90"] - 0.9) < 0.05, m
    lo, hi = m["ci90"]["spread_ratio"]
    assert lo < 1 < hi, m["ci90"]


def test_over_confident_ensemble_is_flagged():
    m = _trial(real_sd=0.06, ens_sd=0.03)["21+"]      # the real walk lands twice as wide as the model says
    assert m["spread_ratio"] < 0.6 and m["cover_90"] < 0.7 and m["cover_50"] < 0.35, m
    u = _trial(real_sd=0.015, ens_sd=0.03)["21+"]     # and the opposite
    assert u["spread_ratio"] > 1.6 and u["cover_90"] > 0.99, u


def _route(corner):
    """1 cm resampled route: straight, then (corner) a left quarter turn of radius 1.2 m, then straight to leave the 2 m extension."""
    s = np.arange(0, 11.0, 0.01)
    if not corner:
        return np.c_[s, np.zeros_like(s)]
    R, a = 1.2, 6.0
    xy = np.zeros((len(s), 2))
    for i, d in enumerate(s):
        if d < a:
            xy[i] = [d, 0]
        elif d < a + R * np.pi / 2:
            th = (d - a) / R
            xy[i] = [a + R * np.sin(th), R * (1 - np.cos(th))]
        else:
            xy[i] = [a + R, R + (d - a - R * np.pi / 2)]
    return xy


def _fake_trial(route, name, kind, model, seed):
    """Samples of the layout train.py's z uses, built from one rollout of `model` (the 'real' walk)."""
    init = {"heels": np.array([[0.0, -0.1], [-0.35, 0.1], [-0.7, -0.1]]), "sides": np.array([-1, 1, -1]), "walker0": np.array([[-0.3, 0.0, 0.0]])}
    z0 = {"heels": init["heels"][None], "sides": init["sides"][None], "walker0": init["walker0"]}
    H, S, P = walk(model, z0, route, 0, 300, 0.0, CFG, np.random.default_rng(seed))
    C = np.r_[init["heels"][::-1], H]                       # chronological heels, oldest first
    D = np.r_[init["sides"][::-1], S]
    n = len(H)
    return {"heels": np.stack([C[[i + 2, i + 1, i]] for i in range(n)]), "sides": np.stack([D[[i + 2, i + 1, i]] for i in range(n)]),
            "heel1": C[3:3 + n], "walker0": np.repeat(init["walker0"], n, 0), "walker1": P,
            "trial": np.array([name] * n), "kind": np.array([kind] * n), "pid": np.full(n, 12)}


def test_closed_loop_by_horizon_on_synthetic_trials():
    base = Baseline(CFG["persona"], CFG["risk"])
    wide = Baseline({**CFG["persona"], "stride_cv": CFG["persona"].get("stride_cv", 0.1) * 0.2}, {**CFG["risk"], "step_jitter_m": CFG["risk"].get("step_jitter_m", 0.03) * 0.2})
    routes, parts = {}, []
    for k, (corner, kind) in enumerate([(False, "straight"), (False, "straight"), (True, "left"), (True, "left")]):
        name = f"T{k}"
        routes[name] = _route(corner)
        parts.append(_fake_trial(routes[name], name, kind, base, seed=k))
    z = {key: np.concatenate([p[key] for p in parts]) for key in parts[0]}
    steps = [len(p["heel1"]) for p in parts]
    assert min(steps) > 25, steps                         # long enough to reach the 21+ bucket
    res = run(z, routes, {"baseline_fit_to_train": base, "learned": wide}, CFG, 0.0, z["pid"] == 12, n_roll=20)
    assert res["trials"] == 4
    t = res["table"]["baseline_fit_to_train"]
    for g in ("straight", "corner"):
        for label, *_ in BUCKETS:
            assert t[g][label]["trials"] == 2, (g, label, t[g][label])
    # the 'real' walk came from this same model, so its own ensemble should read about honest
    assert 0.5 < t["straight"]["21+"]["spread_ratio"] < 1.6, t["straight"]["21+"]
    # a model that spreads five times too little reads over-confident against the same real walks, in every bucket
    over = res["table"]["learned"]["straight"]
    assert all(over[label]["spread_ratio"] < t["straight"][label]["spread_ratio"] for label, *_ in BUCKETS), (over, t["straight"])
    d = res["learned_minus_baseline_fit"]["all"]["1-5"]
    assert d["trials"] == 4 and d["mean_diff_cm"] == d["mean_diff_cm"] and 0 <= d["better_in"] <= 4, d
    md = report([res])
    assert "21+" in md and "spread ratio" in md


def test_frenet_straight_route():
    r = _route(False)
    s, lat = frenet(r, np.array([[1.0, 0.25], [2.0, -0.1]]))
    assert np.allclose(s, [1.0, 2.0], atol=0.011) and np.allclose(lat, [0.25, -0.1], atol=0.011)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)

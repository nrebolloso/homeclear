"""Closed-loop error and spread calibration by horizon (steps from the start of a held-out trial) and by trial kind.

train.py scores a closed-loop walk as one number per trial, which hides two things SPEC 4.6 asks about: whether the model keeps
beating the hand rule after 20+ steps, and whether its sideways spread is honest at corners. Here every model walks every
held-out trial `n_roll` times from the trial's first state (the same walk as train.py: worldmodel/closed_loop.py), and each REAL
step k is scored against the rollouts at the same arc length (phase-free), then pooled by horizon bucket.

Per step: heel lateral offset (same foot), walker position and yaw. Spread calibration is on the heel lateral offset, the
"sideways" spread that decides whether a walker brushes a chair:
  pit      share of the n_roll rollouts below the real value (uniform if the ensemble is calibrated)
  cover_50 / cover_90   real value inside the central 50 / 90 % of the rollouts (should be 0.5 / 0.9)
  ratio    sqrt((1 + 1/n_roll) * mean ensemble variance) / RMS error of the ensemble mean. 1 = honest; < 1 over-confident
           (the real walk lands further from the ensemble than the ensemble thinks it spreads), > 1 under-confident.
`rho` = within-trip step-noise persistence (models.TripNoise); 0 is independent draws, as train.py scores. One number for every
model, or a {model: rho} dict (train.py measures it per model: the hand rule's residuals persist, the learned model's barely do).
Intervals are 90 % bootstrap over TRIALS (the steps of one trial are not independent).

usage: python -m worldmodel.horizon <samples.npz> <out_dir> [--n-roll 100] [--rho 0.0] [--rho baseline_fit_to_train=0.73,learned=0.0 ...]
       [--weights worldmodel/weights/learned.npz]   (each --rho is one run: a number for every model, or name=value pairs)
Writes horizon_results.json and horizon.md."""
import argparse, json, sys
from pathlib import Path

import numpy as np

from .closed_loop import SPLIT, fit_hand, frenet, shift, walk

BUCKETS = [("1-5", 1, 5), ("6-10", 6, 10), ("11-20", 11, 20), ("21+", 21, 10 ** 9)]   # horizon in steps (real step k is horizon k + 1)
MODEL_ORDER = ("baseline_as_configured", "baseline_fit_to_train", "learned")
ACC = ("n", "abs", "sq", "var", "in50", "in90", "wpos", "wyaw")


def bucket_of(k):
    """Bucket index of the 0-based real step k."""
    h = k + 1
    return next(b for b, (_, lo, hi) in enumerate(BUCKETS) if lo <= h <= hi)


def trial_scores(z, routes, trial, models, cfg, d_shift, n_roll, rho=0.0, seed=0):
    """{model: {k: arrays}} for one trial: per real step the lateral heel scores and the walker errors. All lengths n_steps."""
    idx = np.flatnonzero(z["trial"] == trial)
    route, i0 = routes[trial], idx[0]
    rs, rl = frenet(route, z["heel1"][idx])
    real_side = -z["sides"][idx, 0]
    real_w = shift(z["walker1"][idx], d_shift)
    ws, _ = frenet(route, real_w[:, :2])
    n = len(idx)
    out = {}
    for name, mod in models.items():
        rng = np.random.default_rng(seed)
        lat, wpos, wyaw = np.full((n_roll, n), np.nan), np.full((n_roll, n), np.nan), np.full((n_roll, n), np.nan)
        for r in range(n_roll):
            H, S, P = walk(mod, z, route, i0, 3 * n + 30, d_shift, cfg, rng, rho.get(name, 0.0) if isinstance(rho, dict) else rho)
            if len(H) < 2:
                continue
            hs, hl = frenet(route, H)
            for side in (1, -1):
                sel, real = S == side, real_side == side
                if sel.any() and real.any():
                    o = np.argsort(hs[sel])
                    lat[r, real] = np.interp(rs[real], hs[sel][o], hl[sel][o])
            ps, _ = frenet(route, P[:, :2])
            o = np.argsort(ps)
            pw = np.stack([np.interp(ws, ps[o], P[o, c]) for c in (0, 1)], 1)
            yaw = np.angle(np.interp(ws, ps[o], np.cos(P[o, 2])) + 1j * np.interp(ws, ps[o], np.sin(P[o, 2])))
            wpos[r] = np.linalg.norm(pw - real_w[:, :2], axis=1)
            wyaw[r] = np.abs(np.degrees(np.angle(np.exp(1j * (yaw - real_w[:, 2])))))
        out[name] = {"lat": lat, "real": rl, "wpos": wpos, "wyaw": wyaw}
    return out


def accumulate(sc):
    """One model's one trial -> per bucket sums (the table is ratios of sums, so a bootstrap over trials is a resample of these)."""
    lat, real = sc["lat"], sc["real"]
    R, n = lat.shape
    sums = np.zeros((len(BUCKETS), len(ACC)))
    for k in range(n):
        col = lat[:, k]
        ok = ~np.isnan(col)
        if ok.sum() < max(5, R // 2):
            continue
        col, b = col[ok], bucket_of(k)
        pit = (col < real[k]).mean() + 0.5 * (col == real[k]).mean()
        sums[b] += [1, np.abs(col - real[k]).mean(), (col.mean() - real[k]) ** 2, col.var(ddof=1), abs(pit - 0.5) <= 0.25, abs(pit - 0.5) <= 0.45,
                    np.nanmean(sc["wpos"][:, k]), np.nanmean(sc["wyaw"][:, k])]
    return sums


def table(per_trial, n_roll, boots=500, seed=0):
    """per_trial: [(trial, kind, sums (buckets, ACC))] for ONE model -> {group: {bucket: metrics}}, groups straight / corner / all."""
    rng, out = np.random.default_rng(seed), {}
    for g in ("straight", "corner", "all"):
        rows = [s for _, kind, s in per_trial if g == "all" or kind == g]
        out[g] = {}
        for b, (label, _, _) in enumerate(BUCKETS):
            S = np.array([r[b] for r in rows]).reshape(len(rows), len(ACC))
            has = S[:, 0] > 0
            if not has.any():
                out[g][label] = {"trials": 0, "steps": 0}
                continue
            f = lambda T: dict(zip(("heel_err_cm", "mean_err_rms_cm", "spread_sd_cm", "spread_ratio", "cover_50", "cover_90", "walker_pos_cm", "walker_yaw_deg"),
                                   _metrics(T.sum(0), n_roll)))
            m = f(S[has])
            ci = {}
            if has.sum() >= 3:
                bs = [f(S[has][rng.integers(0, has.sum(), has.sum())]) for _ in range(boots)]
                ci = {k: [round(float(np.percentile([x[k] for x in bs], q)), 3) for q in (5, 95)] for k in ("heel_err_cm", "spread_ratio", "cover_50", "cover_90")}
            out[g][label] = {"trials": int(has.sum()), "steps": int(S[:, 0].sum()), **{k: round(float(v), 3) for k, v in m.items()}, "ci90": ci}
    return out


def _metrics(t, n_roll):
    n = t[0]
    rms = np.sqrt(t[2] / n)
    return (100 * t[1] / n, 100 * rms, 100 * np.sqrt(t[3] / n), np.sqrt((1 + 1 / n_roll) * t[3] / n) / max(rms, 1e-9), t[4] / n, t[5] / n, 100 * t[6] / n, t[7] / n)


def paired(per_model, a, b, kind, boots=500, seed=0):
    """Per bucket, a's heel error minus b's over the trials of `kind`: mean difference (cm), 90 % interval, trials a does better."""
    rng, out = np.random.default_rng(seed), {}
    A, B = per_model[a], per_model[b]
    keep = [i for i, (_, k, _) in enumerate(A) if kind == "all" or k == kind]
    for bi, (label, _, _) in enumerate(BUCKETS):
        d = []
        for i in keep:
            na, nb = A[i][2][bi], B[i][2][bi]
            if na[0] > 0 and nb[0] > 0:
                d.append(100 * (na[1] / na[0] - nb[1] / nb[0]))
        if len(d) < 3:
            out[label] = {"trials": len(d)}
            continue
        d = np.array(d)
        bs = [d[rng.integers(0, len(d), len(d))].mean() for _ in range(boots)]
        out[label] = {"trials": len(d), "mean_diff_cm": round(float(d.mean()), 3), "ci90": [round(float(np.percentile(bs, q)), 3) for q in (5, 95)],
                      "better_in": int((d < 0).sum())}
    return out


def run(z, routes, models, cfg, d_shift, test_mask, n_roll=100, rho=0.0):
    """-> {"table": {model: table}, "paired_vs_baseline_fit": {...}} for one rho."""
    per_model = {n: [] for n in models}
    for trial in dict.fromkeys(z["trial"][test_mask]):
        kind = "straight" if z["kind"][np.flatnonzero(z["trial"] == trial)[0]] == "straight" else "corner"
        sc = trial_scores(z, routes, trial, models, cfg, d_shift, n_roll, rho)
        for n in models:
            per_model[n].append((str(trial), kind, accumulate(sc[n])))
    res = {"rho": rho if isinstance(rho, dict) else {n: rho for n in models}, "n_roll": n_roll, "trials": len(per_model[next(iter(models))]),
           "table": {n: table(v, n_roll) for n, v in per_model.items()}}
    if "learned" in models and "baseline_fit_to_train" in models:
        res["learned_minus_baseline_fit"] = {g: paired(per_model, "learned", "baseline_fit_to_train", g) for g in ("straight", "corner", "all")}
    return res


def report(results):
    """Markdown tables: per rho, per group, per model and bucket."""
    L = []
    for res in results:
        rho = ", ".join(f"{n} {v:g}" for n, v in res["rho"].items())
        L += [f"### step-noise persistence rho: {rho}; {res['n_roll']} rollouts per trial, {res['trials']} held-out trials", ""]
        for g in ("corner", "straight"):
            L += [f"**{g} trials**", "", "| model | steps | trials | heel error (cm) | ensemble-mean error (cm) | spread sd (cm) | spread ratio | cover 50 | cover 90 | walker pos (cm) | walker yaw (deg) |",
                  "|---|---|---|---|---|---|---|---|---|---|---|"]
            for n in MODEL_ORDER:
                if n not in res["table"]:
                    continue
                for label, _, _ in BUCKETS:
                    m = res["table"][n][g][label]
                    if not m["trials"]:
                        L.append(f"| {n} {label} | 0 | 0 | | | | | | | | |")
                        continue
                    ci = m["ci90"]
                    rc = f" [{ci['spread_ratio'][0]:.2f}, {ci['spread_ratio'][1]:.2f}]" if ci else ""
                    L.append(f"| {n} {label} | {m['steps']} | {m['trials']} | {m['heel_err_cm']:.2f} | {m['mean_err_rms_cm']:.2f} | {m['spread_sd_cm']:.2f} | "
                             f"{m['spread_ratio']:.2f}{rc} | {m['cover_50']:.2f} | {m['cover_90']:.2f} | {m['walker_pos_cm']:.2f} | {m['walker_yaw_deg']:.2f} |")
            L.append("")
        d = res.get("learned_minus_baseline_fit")
        if d:
            L += ["**learned minus hand rule fit to train (heel error, cm; negative = learned better; 90 % bootstrap over trials)**", "",
                  "| group | " + " | ".join(b[0] for b in BUCKETS) + " |", "|---|" + "---|" * len(BUCKETS)]
            for g in ("corner", "straight", "all"):
                cells = []
                for label, _, _ in BUCKETS:
                    m = d[g][label]
                    cells.append(f"{m['mean_diff_cm']:+.2f} [{m['ci90'][0]:+.2f}, {m['ci90'][1]:+.2f}] ({m['better_in']}/{m['trials']})" if "mean_diff_cm" in m else f"n={m['trials']}")
                L.append(f"| {g} | " + " | ".join(cells) + " |")
            L.append("")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("npz"); ap.add_argument("out")
    ap.add_argument("--n-roll", type=int, default=100); ap.add_argument("--rho", action="append")
    ap.add_argument("--weights", default=None)
    a = ap.parse_args(argv)
    from .learned import Learned, WEIGHTS
    from .models import Baseline
    from .rollout import load_cfg
    cfg = load_cfg()
    z = dict(np.load(a.npz))
    routes = dict(np.load(Path(a.npz).with_suffix(".routes.npz")))
    sp = {k: np.isin(z["pid"], v) for k, v in SPLIT.items()}
    learned = Learned(cfg, a.weights or WEIGHTS)
    hand, sd_lat = fit_hand(z, sp["train"], cfg["persona"])
    models = {"baseline_as_configured": Baseline(cfg["persona"], cfg["risk"]),
              "baseline_fit_to_train": Baseline({**cfg["persona"], **hand}, {**cfg["risk"], "step_jitter_m": sd_lat}), "learned": learned}
    def parse(r):
        return {k: float(v) for k, v in (kv.split("=") for kv in r.split(","))} if "=" in r else float(r)
    results = [run(z, routes, models, cfg, learned.shift, sp["test"], a.n_roll, parse(r)) for r in (a.rho or ["0"])]
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    (out / "horizon_results.json").write_text(json.dumps({"split_participants": SPLIT, "buckets": [b[0] for b in BUCKETS], "runs": results}, indent=1))
    (out / "horizon.md").write_text(report(results))
    print(report(results))


if __name__ == "__main__":
    main()

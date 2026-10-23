"""The step model as a WORLD MODEL: closed-loop rollouts, where every predicted step feeds the next prediction exactly as
in the simulator (viewer/src/stepmodel.ts: toes at the mean offset, CoM at its mean, input and draw clamped to the training
ranges). Held-out test participants only.

1. closed-loop error vs the real walk: from a real starting state, roll N steps along the real route; compare step k with
   the real step k (distance, and cross-track = sideways offset from the route, the number clearances depend on).
2. closed-loop uncertainty: 200 sampled rollouts per start; how often the real step falls inside the 50% / 90% band
   (along-track and cross-track separately).
3. counterfactual: the same real starting state, the route ahead swapped for a 90 deg left turn, a right turn, or straight.
4. physical sanity over every sampled rollout: forward progress, step length / width inside the real range, no feet crossing.
Baseline: the hand rule fit to the training participants (results.json "baseline_hand_rule"), rolled out the same way.

usage: python motion/world_model_tests.py <samples.npz> <step_model.json> <out_dir>
"""
import json, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gait_data import features

TEST = [12, 13]
HORIZONS = [1, 2, 3, 5, 8, 12]
N_SAMPLES, MIN_RUN = 200, 6


class Model:
    def __init__(self, path):
        m = json.loads(Path(path).read_text())
        self.m, self.K = m, m["K"]
        self.layers = [(np.array(l["W"]), np.array(l["b"])) for l in m["layers"]]
        for k in ("x_mean", "x_std", "x_min", "x_max", "y_min", "y_max", "toe_offset", "com_mean"):
            setattr(self, k, np.array(m[k]))
        self.hand = m["hand_rule_fit"]

    def inputs(self, heels, speed, ahead):
        """heels (B,3,2) local, ahead (B,151,2) local -> clamped (B,21) features, as stepmodel.ts features()."""
        B = len(heels)
        hist = np.concatenate([np.concatenate([heels[:, j], heels[:, j] + self.toe_offset[j]], 1) for j in range(3)], 1)
        x = features(hist, np.broadcast_to(self.com_mean, (B, 2)), np.stack([speed, np.zeros(B)], 1), ahead)
        return np.clip(x, self.x_min, self.x_max)

    def mixture(self, x):
        h = (x - self.x_mean) / self.x_std
        for i, (W, b) in enumerate(self.layers):
            h = h @ W.T + b
            if i < len(self.layers) - 1:
                h = h / (1 + np.exp(-h))
        o = h.reshape(len(x), self.K, 5)
        lw = o[..., 0] - o[..., 0].max(1, keepdims=True)
        w = np.exp(lw) / np.exp(lw).sum(1, keepdims=True)
        return w, o[..., 1:3], np.exp(np.clip(o[..., 3:5], -7, 2))

    def step(self, heels, speed, ahead, rng):
        """Next heel (B,2) local: the mixture mean when rng is None, else a draw (rejection into the training range, as draw())."""
        w, mu, sd = self.mixture(self.inputs(heels, speed, ahead))
        mean = np.clip((w[..., None] * mu).sum(1), self.y_min, self.y_max)
        if rng is None:
            return mean
        out, todo = mean.copy(), np.ones(len(w), bool)
        for _ in range(20):
            k = np.minimum((rng.random((len(w), 1)) > w.cumsum(1)).sum(1), self.K - 1)
            i = np.arange(len(w))
            p = mu[i, k] + sd[i, k] * rng.standard_normal((len(w), 2))
            ok = todo & ((p >= self.y_min) & (p <= self.y_max)).all(1)
            out[ok], todo = p[ok], todo & ~ok
            if not todo.any():
                break
        return out

    def hand_step(self, heels, speed, ahead, rng):
        """Hand rule (train_eval.hand_predict): stride_m along the route, foot_sep_m beside the current heel; Gaussian draws."""
        k = int(round(self.hand["stride_m"] * 100))
        t = ahead[:, k + 1] - ahead[:, k - 1]
        t /= np.linalg.norm(t, axis=1, keepdims=True)
        n = np.stack([-t[:, 1], t[:, 0]], 1)
        a, l = np.zeros(len(heels)), heels[:, 0, 1] + self.hand["foot_sep_m"]
        if rng is not None:
            a = a + self.hand["sd_along_m"] * rng.standard_normal(len(heels))
            l = l + self.hand["sd_lat_m"] * rng.standard_normal(len(heels))
        return ahead[:, k] + t * a[:, None] + n * l[:, None]


def frame(route, p):
    """Nearest route index to each world point p (B,2), and the local (tangent, normal) there, as gait_data.local()."""
    k = np.linalg.norm(route[None] - p[:, None], axis=2).argmin(1)
    t = route[np.minimum(k + 5, len(route) - 1)] - route[np.maximum(k - 5, 0)]
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    return k, t, np.stack([-t[:, 1], t[:, 0]], 1)


def rollout(route, heels_w, side, speed, n_steps, stepper, rng):
    """route (R,2) world, 1 cm spacing; heels_w (B,3,2) world, newest first; side (B,) of the NEXT foot (+1 left).
    Returns (B, n_steps, 2) world heels. Stops early (NaN) where the route runs out of 1.5 m lookahead."""
    B = len(heels_w)
    heels_w, side, out = heels_w.copy(), side.astype(float).copy(), np.full((B, n_steps, 2), np.nan)
    for s in range(n_steps):
        k, t, n = frame(route, heels_w[:, 0])
        live = k + 150 < len(route)
        if not live.any():
            break
        k = np.where(live, k, 0)
        r = route[k]
        L = lambda p: np.stack([((p - r[:, None]) * t[:, None]).sum(-1), side[:, None] * ((p - r[:, None]) * n[:, None]).sum(-1)], -1)
        ahead = L(route[k[:, None] + np.arange(151)])
        y = stepper(L(heels_w), speed, ahead, rng)
        new = r + y[:, :1] * t + (side[:, None] * y[:, 1:]) * n
        new[~live] = np.nan
        out[:, s] = new
        heels_w = np.concatenate([new[:, None], heels_w[:, :2]], 1)
        side = -side
    return out


def to_world(z, j, p):
    """Local (mirrored) points of sample j -> world."""
    t, mir = z["tangent"][j], z["mirror"][j]
    return z["origin"][j] + p[..., :1] * t + (p[..., 1:] * mir) * np.array([-t[1], t[0]])


def route_of_run(z, run):
    """World route through a run of samples: each sample's 1.5 m lookahead up to the next sample's origin; all of the last
    one, then 2 m straight on (as gait_data.route_of)."""
    parts = []
    for a, b in zip(run, list(run[1:]) + [None]):
        aw = to_world(z, a, z["ahead"][a])
        parts.append(aw if b is None else aw[:max(1, np.linalg.norm(aw - z["origin"][b], axis=1).argmin())])
    r = np.concatenate(parts)
    d = r[-1] - r[-11]
    return np.r_[r, r[-1] + np.arange(1, 201)[:, None] * 0.01 * d / np.linalg.norm(d)]


def runs_of(z):
    """Runs of consecutive steps (no dropped sample in between) within each test trial."""
    idx = np.flatnonzero(np.isin(z["pid"], TEST))
    out = []
    for tr in dict.fromkeys(z["trial"][idx]):
        j = idx[z["trial"][idx] == tr]
        j = j[np.argsort(z["step"][j])]
        for seg in np.split(j, np.flatnonzero(np.diff(z["step"][j]) != 1) + 1):
            if len(seg) >= MIN_RUN:
                out.append(seg)
    return out


def track(route, p):
    """(arc length, signed cross-track) of world points p (B,2) along a 1 cm route."""
    k, t, n = frame(route, p)
    q = p - route[k]
    return k * 0.01 + (q * t).sum(1), (q * n).sum(1)


def closed_loop(z, model, runs):
    res = {}
    for name, stepper in (("learned", model.step), ("hand_rule", model.hand_step)):
        err, xt, cov = {h: [] for h in HORIZONS}, {h: [] for h in HORIZONS}, {h: [] for h in HORIZONS}
        kind = {h: [] for h in HORIZONS}
        for ri, run in enumerate(runs):
            j0 = run[0]
            route = route_of_run(z, run)
            heels0 = to_world(z, j0, z["hist"][j0][[0, 1, 4, 5, 8, 9]].reshape(3, 2))
            real = z["heel_world"][run]                                          # real step k+1 = target of run[k]
            H = min(len(run), max(HORIZONS))
            mean = rollout(route, heels0[None], np.r_[z["mirror"][j0]], np.r_[z["speed"][j0]], H, stepper, None)[0]
            rng = np.random.default_rng(ri)
            smp = rollout(route, np.repeat(heels0[None], N_SAMPLES, 0), np.full(N_SAMPLES, z["mirror"][j0]),
                          np.full(N_SAMPLES, z["speed"][j0]), H, stepper, rng)
            for h in HORIZONS:
                if h > H or np.isnan(mean[h - 1]).any():
                    continue
                err[h].append(np.linalg.norm(mean[h - 1] - real[h - 1]))
                kind[h].append("straight" if z["kind"][j0] == "straight" else "corner")
                xt[h].append(abs(track(route, mean[h - 1:h])[1][0] - track(route, real[h - 1:h])[1][0]))
                s_al, s_xt = track(route, smp[:, h - 1][~np.isnan(smp[:, h - 1, 0])])
                r_al, r_xt = (v[0] for v in track(route, real[h - 1:h]))
                q = lambda v, a: np.quantile(v, [0.5 - a / 2, 0.5 + a / 2])
                cov[h].append([q(s_al, a)[0] <= r_al <= q(s_al, a)[1] for a in (0.5, 0.9)] +
                              [q(s_xt, a)[0] <= r_xt <= q(s_xt, a)[1] for a in (0.5, 0.9)])
        res[name] = {f"step_{h}": {"n_runs": len(err[h]), "mean_err_cm": round(100 * float(np.mean(err[h])), 2),
                                    "p90_err_cm": round(100 * float(np.percentile(err[h], 90)), 2),
                                    "mean_crosstrack_err_cm": round(100 * float(np.mean(xt[h])), 2),
                                    **dict(zip(("cover50_along", "cover90_along", "cover50_cross", "cover90_cross"),
                                               np.round(np.mean(cov[h], 0), 3).tolist())),
                                    **{f"{g}_err_cm|crosstrack_cm|cover90_cross": [round(100 * float(np.mean(np.array(err[h])[np.array(kind[h]) == g])), 2),
                                        round(100 * float(np.mean(np.array(xt[h])[np.array(kind[h]) == g])), 2),
                                        round(float(np.mean(np.array(cov[h])[np.array(kind[h]) == g, 3])), 3)]
                                       for g in ("straight", "corner") if (np.array(kind[h]) == g).any()}}
                     for h in HORIZONS if err[h]}
    return res


def turn_route(o, t, sign, R=0.8, lead=0.4, tail=6.0):
    """Straight `lead` m, a 90 deg arc of radius R to the left (sign +1) / right (-1), then `tail` m; sign 0 = straight."""
    n = np.array([-t[1], t[0]])
    pts = [o + t * s for s in np.arange(0, lead, 0.01)]
    if sign:
        c = o + t * lead + sign * n * R
        for a in np.arange(0, np.pi / 2, 0.01 / R):
            pts.append(c - sign * n * R * np.cos(a) + t * R * np.sin(a))
        end, d = pts[-1], sign * n
    else:
        end, d = pts[-1], t
    pts += [end + d * s for s in np.arange(0.01, tail + 2, 0.01)]
    return np.array(pts)


def counterfactual(z, model, runs, steps=10):
    """From each straight-trial start: same real state, three routes. Where do the feet go?"""
    starts = [r[0] for r in runs if z["kind"][r[0]] == "straight"]
    out, paths = {}, {}
    for name, sign in (("left", 1), ("right", -1), ("straight", 0)):
        lat, hd, mirr = [], [], []
        for si, j0 in enumerate(starts):
            o, t = z["origin"][j0], z["tangent"][j0]
            route = turn_route(o, t, sign)
            heels0 = to_world(z, j0, z["hist"][j0][[0, 1, 4, 5, 8, 9]].reshape(3, 2))
            smp = rollout(route, np.repeat(heels0[None], N_SAMPLES, 0), np.full(N_SAMPLES, z["mirror"][j0]),
                          np.full(N_SAMPLES, z["speed"][j0]), steps, model.step, np.random.default_rng(si))
            n = np.array([-t[1], t[0]])
            last = np.nanmean(smp[:, -2:], 1)                                   # midpoint of the last two steps
            lat.append(((last - o) @ n))                                          # + = left of the start heading
            v = np.nanmean(smp[:, -2:], 1) - np.nanmean(smp[:, -6:-4], 1)
            hd.append(np.degrees(np.arctan2(v @ n, v @ t)))
            _, xt = track(route, smp.reshape(-1, 2))
            mirr.append(np.abs(xt))
            if si == 0:
                paths[name] = (route, smp, heels0)
        lat, hd, mirr = np.concatenate(lat), np.concatenate(hd), np.concatenate(mirr)
        out[name] = {"starts": len(starts), "rollouts": len(lat),
                     "final_lateral_m_p05_p50_p95": np.round(np.percentile(lat, [5, 50, 95]), 3).tolist(),
                     "final_heading_deg_p05_p50_p95": np.round(np.percentile(hd, [5, 50, 95]), 1).tolist(),
                     "frac_turned_correct_way": round(float(np.mean(lat > 0.3 if sign > 0 else lat < -0.3 if sign < 0 else np.abs(lat) < 0.3)), 3),
                     "crosstrack_cm_p50_p99": np.round(100 * np.percentile(mirr, [50, 99]), 1).tolist()}
    return out, paths


def sanity(z, model, runs, rng_seed=7):
    """Physical checks on every step of the sampled closed-loop rollouts vs the real held-out steps."""
    def stats(seq):                                      # seq (B, S, 2) world heels, alternating feet; first side known
        d = np.diff(seq, axis=1)
        step_len = np.linalg.norm(d, axis=2)
        return step_len
    real_len, sim = [], {"learned": [], "hand_rule": []}
    cross = {"real": [], "learned": [], "hand_rule": []}
    width = {"real": [], "learned": [], "hand_rule": []}
    back = {"learned": [], "hand_rule": []}
    for ri, run in enumerate(runs):
        j0 = run[0]
        route = route_of_run(z, run)
        heels0 = to_world(z, j0, z["hist"][j0][[0, 1, 4, 5, 8, 9]].reshape(3, 2))
        side0 = z["mirror"][j0]
        sides = side0 * (-1.0) ** np.arange(len(run))                       # side of real step k+1
        real = np.r_[heels0[:1], z["heel_world"][run]][None]
        seqs = {"real": (real, np.r_[-side0, sides])}
        for name, st in (("learned", model.step), ("hand_rule", model.hand_step)):
            smp = rollout(route, np.repeat(heels0[None], 50, 0), np.full(50, side0), np.full(50, z["speed"][j0]), len(run), st,
                          np.random.default_rng(1000 + ri))
            seqs[name] = (np.concatenate([np.repeat(heels0[None, :1], 50, 0), smp], 1), np.r_[-side0, sides])
        for name, (seq, sd) in seqs.items():
            for b in range(len(seq)):
                p = seq[b][~np.isnan(seq[b, :, 0])]
                if len(p) < 3:
                    continue
                al, xt = track(route, p)
                lat = sd[:len(p)] * xt                                       # + = the foot is on its own side
                w = (xt[1:] - xt[:-1]) * sd[1:len(p)]                         # new foot's sideways offset from the other foot, + = correct side
                cross[name] += list(w < 0)
                width[name] += list(np.abs(xt[1:] - xt[:-1]))
                L = np.diff(al)
                if name == "real":
                    real_len += list(L)
                else:
                    sim[name] += list(L)
                    back[name] += list(L <= 0)
    lo, hi = np.percentile(real_len, [0.5, 99.5])
    wlo, whi = np.percentile(width["real"], [0.5, 99.5])
    out = {"real_step_along_m_p0.5_p99.5": [round(lo, 3), round(hi, 3)],
           "real_step_width_m_p0.5_p99.5": [round(wlo, 3), round(whi, 3)],
           "real_frac_feet_crossed": round(float(np.mean(cross["real"])), 4), "real_steps": len(real_len)}
    for name in ("learned", "hand_rule"):
        L, W = np.array(sim[name]), np.array(width[name])
        out[name] = {"steps": len(L), "frac_backward": round(float(np.mean(back[name])), 4),
                     "frac_step_outside_real_range": round(float(np.mean((L < lo) | (L > hi))), 4),
                     "frac_width_outside_real_range": round(float(np.mean((W < wlo) | (W > whi))), 4),
                     "frac_feet_crossed": round(float(np.mean(cross[name])), 4),
                     "step_along_m_p05_p50_p95": np.round(np.percentile(L, [5, 50, 95]), 3).tolist()}
    out["real_step_along_m_p05_p50_p95"] = np.round(np.percentile(real_len, [5, 50, 95]), 3).tolist()
    return out


def plot(cl, paths, path):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(14, 6.5))
    for name, c in (("learned", "tab:purple"), ("hand_rule", "tab:orange")):
        h = [int(k.split("_")[1]) for k in cl[name]]
        ax[0].plot(h, [v["mean_err_cm"] for v in cl[name].values()], "o-", color=c, label=f"{name}: distance")
        ax[0].plot(h, [v["mean_crosstrack_err_cm"] for v in cl[name].values()], "s--", color=c, label=f"{name}: cross-track")
    ax[0].set_xlabel("steps rolled out (closed loop)"); ax[0].set_ylabel("error vs real step, cm (mean over runs)")
    ax[0].set_title("Closed-loop error, held-out participants 12, 13 (REAL)"); ax[0].legend(); ax[0].grid(alpha=0.3)
    for name, c in (("left", "tab:blue"), ("right", "tab:red"), ("straight", "0.4")):
        route, smp, h0 = paths[name]
        ax[1].plot(*route[:450].T, "-", color=c, lw=1)
        ax[1].plot(*smp[:, :, :].reshape(-1, 2).T, ".", color=c, ms=1, alpha=0.15)
        ax[1].plot(*np.nanmean(smp, 0).T, "o-", color=c, ms=4, label=f"route {name}: mean of 200 rollouts")
    ax[1].plot(*h0.T, "k*", ms=10, label="real start (last 3 heels)")
    ax[1].axis("equal"); ax[1].legend(fontsize=8)
    ax[1].set_title("Counterfactual: same real start, route turns left / right / goes straight")
    fig.tight_layout(); fig.savefig(path, dpi=110)


def main(npz, model_json, out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    z, model = dict(np.load(npz)), Model(model_json)
    runs = runs_of(z)
    assert runs and all(np.isin(z["pid"][r], TEST).all() for r in runs)
    cl = closed_loop(z, model, runs)
    cf, paths = counterfactual(z, model, runs)
    ps = sanity(z, model, runs)
    res = {"data": "REAL: PhysioNet Multi-Gait-Posture, held-out participants " + str(TEST),
           "runs": len(runs), "run_len_steps_min_median_max": [int(min(map(len, runs))), int(np.median(list(map(len, runs)))), int(max(map(len, runs)))],
           "closed_loop": cl, "counterfactual_turn": cf, "physical_sanity": ps}
    (out / "world_model_tests.json").write_text(json.dumps(res, indent=1))
    plot(cl, paths, out / "world_model_tests.png")
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:])

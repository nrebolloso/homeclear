"""Next-foot-placement models on Multi-Gait-Posture samples (motion/gait_data.py), split by PARTICIPANT.

baseline: the simulator's hand rule (viewer/src/sim.ts) - feet every L metres along the route, alternating +-W/2 about a
          per-walk offset - with L, W and the spread fit to the training participants.
learned:  small MLP -> mixture of K 2D Gaussians over the next heel position (local frame, see gait_data.py).
Both are scored on the held-out test participants: placement error (cm) of the predicted mean, mean and P90, for
straight trials, corner trials and the steps actually inside a turn; and coverage (how often the real step falls in
the predicted 50% / 90% region).

usage: python motion/train_eval.py <samples.npz> <out_dir>
"""
import json, sys, time
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gait_data import features, turn_deg, AHEAD, TURN_DEG

SPLIT = {"train": list(range(10)), "val": [10, 11], "test": [12, 13]}   # participant ids, fixed before training
K, HIDDEN, EPOCHS, SEED = 5, 128, int(__import__("os").environ.get("EPOCHS", 400)), 0
CFG_HAND = {"stride_m": 0.35, "foot_sep_m": 0.20, "step_jitter_m": 0.04, "stride_cv": 0.10}   # configs/home.yaml persona as shipped


# ---------- baseline ----------
def frenet(ahead, p):
    """Point p (local) -> (arc length along the route ahead, signed lateral offset)."""
    d = np.linalg.norm(ahead - p[:, None], axis=2)
    k = np.clip(d.argmin(1), 1, len(AHEAD) - 2)
    i = np.arange(len(p))
    t = ahead[i, k + 1] - ahead[i, k - 1]
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    q = p - ahead[i, k]
    return AHEAD[k] + (q * t).sum(1), t[:, 0] * q[:, 1] - t[:, 1] * q[:, 0]


def fit_hand(z, m):
    s, n = frenet(z["ahead"][m], z["target"][m])
    cur = z["hist"][m, 1]                      # current heel's lateral offset (its route point is the frame origin)
    L, W = s.mean(), (n - cur).mean()
    return {"stride_m": float(L), "foot_sep_m": float(W), "sd_along_m": float(s.std()), "sd_lat_m": float((n - cur - W).std())}


def hand_predict(z, m, h):
    """Mean (N,2) and covariance (N,2,2) of the hand rule's next step."""
    ahead = z["ahead"][m]
    k = int(round(h["stride_m"] * 100))
    t = ahead[:, k + 1] - ahead[:, k - 1]
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    nrm = np.stack([-t[:, 1], t[:, 0]], 1)
    mu = ahead[:, k] + nrm * (z["hist"][m, 1] + h["foot_sep_m"])[:, None]
    R = np.stack([t, nrm], 2)                  # columns: along, lateral
    cov = R @ np.diag([h["sd_along_m"] ** 2, h["sd_lat_m"] ** 2]) @ R.transpose(0, 2, 1)
    return mu, cov


# ---------- learned ----------
class MDN(nn.Module):
    def __init__(self, d_in):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d_in, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, K * 5))

    def forward(self, x):
        o = self.net(x).view(-1, K, 5)
        return torch.log_softmax(o[..., 0], -1), o[..., 1:3], o[..., 3:5].clamp(-7, 2)   # log weight, mean, log sd


def nll(out, y):
    lw, mu, ls = out
    lp = -0.5 * (((y[:, None] - mu) / ls.exp()) ** 2).sum(-1) - ls.sum(-1) - np.log(2 * np.pi)
    return -torch.logsumexp(lw + lp, -1)


def mdn_np(model, x):
    with torch.no_grad():
        lw, mu, ls = (t.cpu().numpy() for t in model(x))
    return np.exp(lw), mu, np.exp(ls)


def sim_inputs(z, m, toe_off, com_mean):
    """What the simulator can give the model: its own heel history, toes at the mean heel->toe offset, CoM at its mean
    position with velocity = walking speed along the route. Shows how much the proxies cost."""
    hist = z["hist"][m].copy()
    for j in range(3):
        hist[:, 4 * j + 2:4 * j + 4] = hist[:, 4 * j:4 * j + 2] + toe_off[j]
    com = np.broadcast_to(com_mean, (m.sum(), 2))
    com_v = np.stack([z["speed"][m], np.zeros(m.sum())], 1)
    return features(hist, com, com_v, z["ahead"][m])


def scores(err, cover, z, m):
    """err (N,) in m; cover: dict of (N,) bools or fractions. Grouped by straight / corner trials / in-turn steps."""
    kind, turn = z["kind"][m], np.abs(turn_deg(z["ahead"][m]))
    groups = {"all": np.ones(m.sum(), bool), "straight": kind == "straight", "corner": kind != "straight",
              f"in_turn(>{TURN_DEG}deg/1m)": (kind != "straight") & (turn > TURN_DEG)}
    out = {}
    for g, s in groups.items():
        e = 100 * err[s]
        out[g] = {"n": int(s.sum()), "mean_cm": round(float(e.mean()), 2), "p90_cm": round(float(np.percentile(e, 90)), 2),
                  **{k: round(float(v[s].mean()), 3) for k, v in cover.items()}}
    return out


def per_sample_cover_gauss(mu, cov, y):
    d = y - mu
    m2 = np.einsum("ni,nij,nj->n", d, np.linalg.inv(cov), d)
    return {f"cover_{int(100 * a)}": (m2 < -2 * np.log(1 - a)).astype(float) for a in (0.5, 0.9)}


def per_sample_cover_mdn(w, mu, sd, y, n=4000, seed=1):
    r = np.random.default_rng(seed)
    dens = lambda p: (w[:, None] * np.exp(-0.5 * (((p[:, :, None] - mu[:, None]) / sd[:, None]) ** 2).sum(-1))
                      / (2 * np.pi * sd[:, None].prod(-1))).sum(-1)
    comp = np.array([r.choice(K, n, p=wi / wi.sum()) for wi in w])
    i = np.arange(len(w))[:, None]
    smp = mu[i, comp] + sd[i, comp] * r.standard_normal((len(w), n, 2))
    frac = (dens(smp) > dens(y[:, None])).mean(1)
    return {f"cover_{int(100 * a)}": (frac < a).astype(float) for a in (0.5, 0.9)}


def main(npz, out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    z = dict(np.load(npz))
    sp = {k: np.isin(z["pid"], v) for k, v in SPLIT.items()}
    assert not (sp["train"] & sp["test"]).any() and all(sp[k].any() for k in sp), {k: int(v.sum()) for k, v in sp.items()}
    X = features(z["hist"], z["com"], z["com_v"], z["ahead"])
    Y = z["target"].astype(np.float32)
    mx, sx = X[sp["train"]].mean(0), X[sp["train"]].std(0) + 1e-6
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    T = lambda a: torch.tensor((a - mx) / sx, dtype=torch.float32, device=dev)
    Ty = lambda m: torch.tensor(Y[m], device=dev)
    log = {"device": torch.cuda.get_device_name(0) if dev == "cuda" else "cpu", "split_participants": SPLIT,
           "samples": {k: int(v.sum()) for k, v in sp.items()}, "epochs": []}
    print(json.dumps({k: log[k] for k in ("device", "samples")}), flush=True)

    torch.manual_seed(SEED)
    model = MDN(X.shape[1]).to(dev)
    opt = torch.optim.AdamW(model.parameters(), 2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    xtr, ytr, xva, yva = T(X[sp["train"]]), Ty(sp["train"]), T(X[sp["val"]]), Ty(sp["val"])
    best, best_state, t0 = np.inf, None, time.time()
    g = torch.Generator(device="cpu").manual_seed(SEED)
    for ep in range(EPOCHS):
        model.train()
        for b in torch.randperm(len(xtr), generator=g).split(256):
            loss = nll(model(xtr[b]), ytr[b]).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
        model.eval()
        with torch.no_grad():
            tr, va = nll(model(xtr), ytr).mean().item(), nll(model(xva), yva).mean().item()
        log["epochs"].append({"epoch": ep, "train_nll": round(tr, 4), "val_nll": round(va, 4)})
        if va < best:
            best, best_state, log["best_epoch"] = va, {k: v.clone() for k, v in model.state_dict().items()}, ep
        if ep % 25 == 0 or ep == EPOCHS - 1:
            print(f"epoch {ep:3d} train_nll {tr:.3f} val_nll {va:.3f}", flush=True)
    log["train_s"] = round(time.time() - t0, 1)
    model.load_state_dict(best_state); model.eval()

    hand = fit_hand(z, sp["train"])
    m = sp["test"]
    y = z["target"][m]
    res = {"hand_rule_fit": hand, "best_epoch": log["best_epoch"], "best_val_nll": round(best, 4)}
    for name, h in (("baseline_hand_rule", hand), ("hand_rule_as_configured", {**CFG_HAND, "sd_along_m": CFG_HAND["stride_cv"] * CFG_HAND["stride_m"], "sd_lat_m": CFG_HAND["step_jitter_m"]})):
        mu, cov = hand_predict(z, m, h)
        res[name] = scores(np.linalg.norm(mu - y, axis=1), per_sample_cover_gauss(mu, cov, y), z, m)
        if name == "baseline_hand_rule":
            hand_mu = mu
    w, mu, sd = mdn_np(model, T(X[m]))
    mean = (w[..., None] * mu).sum(1)
    res["learned_mdn"] = scores(np.linalg.norm(mean - y, axis=1), per_sample_cover_mdn(w, mu, sd, y), z, m)
    toe_off = [(z["hist"][sp["train"], 4 * j + 2:4 * j + 4] - z["hist"][sp["train"], 4 * j:4 * j + 2]).mean(0) for j in range(3)]
    com_mean = z["com"][sp["train"]].mean(0)
    ws, mus, sds = mdn_np(model, T(sim_inputs(z, m, toe_off, com_mean)))
    res["learned_mdn_sim_inputs"] = scores(np.linalg.norm((ws[..., None] * mus).sum(1) - y, axis=1), per_sample_cover_mdn(ws, mus, sds, y), z, m)
    (out / "results.json").write_text(json.dumps(res, indent=1))
    (out / "train_log.json").write_text(json.dumps(log, indent=1))

    # weights for the viewer's worker (viewer/src/stepmodel.ts): plain arrays, row-major [out][in]
    lin = [l for l in model.net if isinstance(l, nn.Linear)]
    (out / "step_model.json").write_text(json.dumps({
        "K": K, "hand_rule_fit": hand, "x_mean": mx.tolist(), "x_std": sx.tolist(),
        # training ranges: the sim clamps its inputs and its draws to them (its own steps feed back as history)
        "x_min": X[sp["train"]].min(0).tolist(), "x_max": X[sp["train"]].max(0).tolist(),
        "y_min": Y[sp["train"]].min(0).tolist(), "y_max": Y[sp["train"]].max(0).tolist(), "toe_offset": [t.tolist() for t in toe_off], "com_mean": com_mean.tolist(),
        "layers": [{"W": l.weight.detach().cpu().numpy().round(6).tolist(), "b": l.bias.detach().cpu().numpy().round(6).tolist()} for l in lin],
        "trained_on": "PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0), participants " + str(SPLIT["train"]),
        "features": "see motion/gait_data.py features(); target = next heel in the mirrored route frame"}))
    # numbers for a parity check of the TS port
    (out / "step_model_check.json").write_text(json.dumps({"x": X[m][:5].tolist(), "w": w[:5].tolist(), "mu": mu[:5].tolist(), "sd": sd[:5].tolist()}))

    plot_corner(z, m, mean, hand_mu, w, mu, sd, out / "corner_turn.png")
    print(json.dumps({k: res[k] for k in ("baseline_hand_rule", "learned_mdn", "learned_mdn_sim_inputs")}, indent=1))


def plot_corner(z, m, mean, hand_mu, w, mu, sd, path):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    idx = np.flatnonzero(m)
    trials = [t for t in dict.fromkeys(z["trial"][idx]) if "_corner" in t]
    fig, axes = plt.subplots(1, 2, figsize=(14, 7))
    pick = [next((t for t in trials if f"_{d}_" in t), None) for d in ("left", "right")]
    for ax, tr in zip(axes, [t for t in pick if t] or trials[:2]):
        s = z["trial"][idx] == tr
        o, t, mir = z["origin"][idx][s], z["tangent"][idx][s], z["mirror"][idx][s]
        nrm = np.stack([-t[:, 1], t[:, 0]], 1)
        W = lambda p: o + p[..., :1] * t + (p[..., 1:] * mir[:, None]) * nrm
        real = z["heel_world"][idx][s]
        rng = np.random.default_rng(0)
        for q in range(s.sum()):   # predicted spread: 200 samples per step
            wi, mi, si = w[s][q], mu[s][q], sd[s][q]
            c = rng.choice(K, 200, p=wi / wi.sum())
            p = mi[c] + si[c] * rng.standard_normal((200, 2))
            pw = o[q] + p[:, :1] * t[q] + (p[:, 1:] * mir[q]) * nrm[q]
            ax.plot(*pw.T, ".", color="tab:purple", ms=1, alpha=0.25)
        ax.plot(*o.T, "-", color="0.6", lw=1, label="route (smoothed CoM path)")
        ax.plot(*W(hand_mu[s]).T, "s", mfc="none", color="tab:orange", ms=7, label="baseline (hand rule) prediction")
        ax.plot(*W(mean[s]).T, "^", color="tab:purple", ms=6, label="learned prediction (mean) + spread")
        for side, c in ((1, "tab:blue"), (-1, "tab:red")):
            k = mir == side
            ax.plot(*real[k].T, "o", color=c, ms=7, label=f"real {'left' if side > 0 else 'right'} heel")
        ax.set_title(f"{tr} (test participant)"); ax.axis("equal"); ax.set_xlabel("m"); ax.legend(fontsize=8)
    fig.suptitle("Next-footstep prediction through a corner turn: held-out participant, one step ahead at a time")
    fig.tight_layout(); fig.savefig(path, dpi=110)


if __name__ == "__main__":
    main(*sys.argv[1:])

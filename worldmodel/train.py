"""Train the learned world model (worldmodel/learned.py) and evaluate it against the hand-rule baseline on held-out
participants. Split by PARTICIPANT, fixed before training: train P00-P09, val P10-P11 (early stopping), test P12-P13.

One-step scores (test): next-heel error of the predicted mean (cm, mean / P90), NLL, coverage of the 50% / 90%
regions; walker pose error (position cm, yaw deg) of the learned head vs the geometric rule given the REAL next heel.
Closed loop (test): each model walks each held-out trial's route from the real first steps, 20 rollouts, its own
outputs fed back; scored against the real walk at the same arc length (phase-free): heel lateral offset, walker pose,
step length.

usage: python worldmodel/train.py <samples.npz> <out_dir>    (EPOCHS env var, default 400)
Writes learned.npz (numpy weights the rollout engine loads), learned.onnx, results.json, train_log.json.
"""
import json, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np
import torch
from torch import nn

from worldmodel.learned import K, D_IN, Learned, features, targets
from worldmodel.models import Baseline, State, unit, left
from worldmodel.rollout import load_cfg
from worldmodel.trip_corr import component_zscores, lag_corr

SPLIT = {"train": list(range(10)), "val": [10, 11], "test": [12, 13]}
HIDDEN, EPOCHS, SEED, TURN_DEG = 128, int(os.environ.get("EPOCHS", 400)), 0, 15


class Net(nn.Module):
    """Normalisation inside, so the ONNX file takes raw features. Outputs: heel MDN (K x [logit, mu xy, log sd xy]) and
    walker Gaussian ([mu x y yaw, log sd x y yaw])."""
    def __init__(self, mx, sx):
        super().__init__()
        self.register_buffer("mx", torch.tensor(mx)); self.register_buffer("sx", torch.tensor(sx))
        self.net = nn.Sequential(nn.Linear(D_IN, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, K * 5 + 6))

    def forward(self, x):
        o = self.net((x - self.mx) / self.sx)
        h = o[:, :K * 5].reshape(-1, K, 5)
        return (torch.log_softmax(h[..., 0], -1), h[..., 1:3], h[..., 3:5].clamp(-7, 2),
                o[:, K * 5:K * 5 + 3], o[:, K * 5 + 3:].clamp(-7, 2))


def nll(out, y):
    lw, mu, ls, wm, wls = out
    lp = -0.5 * (((y[:, None, :2] - mu) / ls.exp()) ** 2).sum(-1) - ls.sum(-1) - np.log(2 * np.pi)
    heel = -torch.logsumexp(lw + lp, -1)
    dy = y[:, 2:] - wm
    dy = torch.cat([dy[:, :2], torch.atan2(torch.sin(dy[:, 2:]), torch.cos(dy[:, 2:]))], 1)
    walk = (0.5 * (dy / wls.exp()) ** 2 + wls).sum(-1) + 1.5 * np.log(2 * np.pi)
    return heel, walk


def state(z, i, walker=None):
    h = z["heels"][i]
    return State(h, h, z["sides"][i], h[:2].mean(0), np.zeros(2), z["walker0"][i] if walker is None else walker, np.full(8, 2.0))


def shift(w, d):
    """Walker point moved d metres along its heading (camera point <-> sim frame centre)."""
    w = np.array(w, float)
    w[..., :2] += d * np.stack([np.cos(w[..., 2]), np.sin(w[..., 2])], -1)
    return w


def coverage(dist, y, rng, n=4000):
    """Is y inside the 50% / 90% highest-density region of dist (Monte Carlo)."""
    frac = (dist.logpdf(dist.sample(rng, n)) > dist.logpdf(y)).mean()
    return frac < 0.5, frac < 0.9


def fit_hand(z, m, persona):
    """Hand-rule step length / width / spreads fit to the training participants (the fair baseline)."""
    L, W = persona["stride_m"], persona["foot_sep_m"]
    idx = np.flatnonzero(m)
    for _ in range(5):
        a, c = [], []
        for i in idx:
            h0, s0, tgt = z["heels"][i][0], z["sides"][i][0], z["action"][i][-1]
            u = unit(tgt - h0); mid = h0 - s0 * W / 2 * left(u); u = unit(tgt - mid)
            d = z["heel1"][i] - mid
            a.append(d @ u); c.append(-s0 * (d @ left(u)))
        L, W = float(np.mean(a)), float(2 * np.mean(c))
    return {"stride_m": L, "foot_sep_m": W, "stride_cv": float(np.std(a) / L)}, float(np.std(c))


def one_step(z, m, models, cfg, d_shift):
    rng = np.random.default_rng(1)
    kind = z["kind"][m]
    turn = []
    res = {n: {"err": [], "nll": [], "c50": [], "c90": [], "wpos": [], "wyaw": []} for n in models}
    for i in np.flatnonzero(m):
        a = z["action"][i]
        turn.append(abs(np.degrees(np.angle(np.exp(1j * (np.arctan2(*(a[2] - a[1])[::-1]) - np.arctan2(*(a[0] - z["heels"][i][:2].mean(0))[::-1])))))))
        real_w = shift(z["walker1"][i], d_shift)
        for n, mod in models.items():
            s = state(z, i, shift(z["walker0"][i], d_shift))
            dist = mod.predict(s, a)
            y = z["heel1"][i]
            r = res[n]
            r["err"].append(np.linalg.norm(dist.mean() - y)); r["nll"].append(-dist.logpdf(y))
            c5, c9 = coverage(dist, y, rng); r["c50"].append(c5); r["c90"].append(c9)
            p = mod.walker_pose(s, y, a, cfg["walker"], s.walker)
            r["wpos"].append(np.linalg.norm(p[:2] - real_w[:2]))
            r["wyaw"].append(abs(np.degrees(np.angle(np.exp(1j * (p[2] - real_w[2]))))))
    turn = np.array(turn)
    groups = {"all": np.ones(len(kind), bool), "straight": kind == "straight", "corner": kind != "straight",
              f"in_turn(>{TURN_DEG}deg)": turn > TURN_DEG}
    out = {}
    for n, r in res.items():
        r = {k: np.array(v, float) for k, v in r.items()}
        out[n] = {g: {"n": int(s.sum()), "heel_err_mean_cm": round(100 * r["err"][s].mean(), 2),
                      "heel_err_p90_cm": round(100 * np.percentile(r["err"][s], 90), 2), "heel_nll": round(r["nll"][s].mean(), 3),
                      "cover_50": round(r["c50"][s].mean(), 3), "cover_90": round(r["c90"][s].mean(), 3),
                      "walker_pos_err_mean_cm": round(100 * r["wpos"][s].mean(), 2), "walker_yaw_err_mean_deg": round(r["wyaw"][s].mean(), 2)}
                  for g, s in groups.items()}
    return out


def step_autocorr(z, masks, models, cfg, d_shift):
    """Within-trip persistence of each model's one-step residual (worldmodel/trip_corr.py): the value for rollout step_corr.
    Scored on the held-out groups only (test = P12-P13; val+test = P10-P13, more pairs)."""
    out = {}
    for n, mod in models.items():
        zs = np.full((len(z["pid"]), 2), np.nan)
        for i in np.flatnonzero(masks["val+test"]):
            zs[i] = component_zscores(mod.predict(state(z, i, shift(z["walker0"][i], d_shift)), z["action"][i]), z["heel1"][i])
        out[n] = {}
        for g, m in masks.items():
            idx = np.flatnonzero(m)
            out[n][g] = {"z_sd_along_across": np.round(zs[idx].std(0), 3).tolist(),
                         **{f"lag{k}": lag_corr(zs[idx], z["trial"][idx], z["step"][idx], k) for k in (1, 2)}}
    return out


def frenet(route, p):
    """Points (n, 2) -> arc length along the route and signed lateral offset (left +)."""
    k = np.linalg.norm(route[None] - p[:, None], axis=2).argmin(1)
    t = route[np.minimum(k + 5, len(route) - 1)] - route[np.maximum(k - 5, 0)]
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    q = p - route[k]
    return k * 0.01, t[:, 0] * q[:, 1] - t[:, 1] * q[:, 0]


def closed_loop(z, routes, m, models, cfg, d_shift, n_roll=20):
    """Each model walks each test trial's route from the trial's first sample, n_roll times. Phase-free scores against
    the real walk at the same arc length: heel lateral offset (same foot), walker position / yaw, and step length."""
    out = {n: {"straight": [], "corner": []} for n in models}
    for trial in dict.fromkeys(z["trial"][m]):
        idx = np.flatnonzero(z["trial"] == trial)
        route, i0 = routes[trial], idx[0]
        end = len(route) - 200                                   # the last 2 m is the straight extension
        rs, rl = frenet(route, z["heel1"][idx])
        real_side, real_len = -z["sides"][idx, 0], np.linalg.norm(z["heel1"][idx] - z["heels"][idx, 0], axis=1).mean()
        real_w = shift(z["walker1"][idx], d_shift)
        ws, _ = frenet(route, real_w[:, :2])
        g = "straight" if z["kind"][i0] == "straight" else "corner"
        for n, mod in models.items():
            rng = np.random.default_rng(0)
            el, ew, ey, es = [], [], [], []
            for _ in range(n_roll):
                s, k, H, S, P = state(z, i0, shift(z["walker0"][i0], d_shift)), 0, [], [], []
                for _ in range(3 * len(idx) + 30):
                    k += int(np.argmin(np.linalg.norm(route[k:k + 120] - s.heels[:2].mean(0), axis=1)))
                    if k >= end - 16:
                        break
                    a = route[[k + 25, k + 50, k + 100]]
                    heel = mod.predict(s, a).sample(rng)
                    pose = mod.walker_pose(s, heel, a, cfg["walker"], s.walker)
                    H.append(heel); S.append(-s.sides[0]); P.append(pose)
                    s = State(np.r_[[heel], s.heels[:2]], np.r_[[heel], s.heels[:2]], np.r_[-s.sides[0], s.sides[:2]],
                              (heel + s.heels[0]) / 2, np.zeros(2), pose, s.obstacle_dist)
                H, S, P = np.array(H), np.array(S), np.array(P)
                hs, hl = frenet(route, H)
                for side in (1, -1):
                    o = np.argsort(hs[S == side])
                    el += list(np.abs(np.interp(rs[real_side == side], hs[S == side][o], hl[S == side][o]) - rl[real_side == side]))
                ps, _ = frenet(route, P[:, :2])
                o = np.argsort(ps)
                pw = np.stack([np.interp(ws, ps[o], P[o, c]) for c in (0, 1)], 1)
                yaw = np.angle(np.interp(ws, ps[o], np.cos(P[o, 2])) + 1j * np.interp(ws, ps[o], np.sin(P[o, 2])))
                ew += list(np.linalg.norm(pw - real_w[:, :2], axis=1))
                ey += list(np.abs(np.degrees(np.angle(np.exp(1j * (yaw - real_w[:, 2]))))))
                es.append(abs(np.linalg.norm(np.diff(H, axis=0), axis=1).mean() - real_len))
            out[n][g].append([np.mean(el), np.mean(ew), np.mean(ey), np.mean(es)])
    names = ["heel_lateral_err_cm", "walker_pos_err_cm", "walker_yaw_err_deg", "step_len_err_cm"]
    return {n: {g: {"trials": len(v), **{k: round(float(x) * (1 if "deg" in k else 100), 2) for k, x in zip(names, np.mean(v, 0))}}
                for g, v in r.items()} for n, r in out.items()}


def main(npz, out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    z = dict(np.load(npz))
    routes = dict(np.load(Path(npz).with_suffix(".routes.npz")))
    cfg = load_cfg()
    sp = {k: np.isin(z["pid"], v) for k, v in SPLIT.items()}
    assert not (sp["train"] & sp["test"]).any() and not (sp["val"] & sp["test"]).any()
    X = np.stack([features(z["heels"][i], z["sides"][i], z["action"][i]) for i in range(len(z["pid"]))])
    Y = np.stack([targets(z["heels"][i], z["sides"][i], z["action"][i], z["heel1"][i], z["walker1"][i]) for i in range(len(z["pid"]))])
    mx, sx = X[sp["train"]].mean(0), X[sp["train"]].std(0) + 1e-6
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    T = lambda a: torch.tensor(a, dtype=torch.float32, device=dev)
    log = {"device": torch.cuda.get_device_name(0) if dev == "cuda" else "cpu", "split_participants": SPLIT,
           "samples": {k: int(v.sum()) for k, v in sp.items()}, "epochs": []}
    print(json.dumps({k: log[k] for k in ("device", "samples")}), flush=True)

    torch.manual_seed(SEED)
    net = Net(mx, sx).to(dev)
    opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    xtr, ytr, xva, yva = T(X[sp["train"]]), T(Y[sp["train"]]), T(X[sp["val"]]), T(Y[sp["val"]])
    best, best_state, t0 = np.inf, None, time.time()
    g = torch.Generator().manual_seed(SEED)
    for ep in range(EPOCHS):
        net.train()
        for b in torch.randperm(len(xtr), generator=g).split(256):
            hl, wl = nll(net(xtr[b]), ytr[b])
            loss = (hl + wl).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
        net.eval()
        with torch.no_grad():
            tr = [v.mean().item() for v in nll(net(xtr), ytr)]
            va = [v.mean().item() for v in nll(net(xva), yva)]
        log["epochs"].append({"epoch": ep, "train_heel_nll": round(tr[0], 4), "train_walker_nll": round(tr[1], 4),
                              "val_heel_nll": round(va[0], 4), "val_walker_nll": round(va[1], 4)})
        if sum(va) < best:
            best, best_state, log["best_epoch"] = sum(va), {k: v.clone() for k, v in net.state_dict().items()}, ep
        if ep % 25 == 0 or ep == EPOCHS - 1:
            print(f"epoch {ep:3d} train {tr[0]:.3f}/{tr[1]:.3f} val {va[0]:.3f}/{va[1]:.3f} (heel/walker nll)", flush=True)
    log["train_s"] = round(time.time() - t0, 1)
    net.load_state_dict(best_state); net.eval(); net.cpu()

    # mean user -> walker-point distance along the walker heading (training participants), for the sim's own walker geometry
    tr_i = np.flatnonzero(sp["train"])
    gap = np.mean([(z["walker0"][i][:2] - z["heels"][i][:2].mean(0)) @ np.array([np.cos(z["walker0"][i][2]), np.sin(z["walker0"][i][2])]) for i in tr_i])
    lin = [l for l in net.net if isinstance(l, nn.Linear)]
    W = {f"W{j}": l.weight.detach().numpy() for j, l in enumerate(lin)} | {f"b{j}": l.bias.detach().numpy() for j, l in enumerate(lin)}
    meta = {"mean_gap_m": float(gap), "K": K, "features": "worldmodel/learned.py features()",
            "trained_on": f"PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0), participants {SPLIT['train']}"}
    np.savez(out / "learned.npz", x_mean=mx, x_std=sx, x_min=X[sp["train"]].min(0), x_max=X[sp["train"]].max(0), meta=json.dumps(meta), **W)

    x5 = torch.tensor(X[sp["test"]][:5])
    torch.onnx.export(net, x5, out / "learned.onnx", input_names=["x"], output_names=["log_w", "mu", "log_sd", "walker_mu", "walker_log_sd"],
                      dynamic_axes={"x": {0: "n"}}, opset_version=17, dynamo=False)
    with torch.no_grad():
        ref = [t.numpy().tolist() for t in net(x5)]
    (out / "onnx_check.json").write_text(json.dumps({"x": X[sp["test"]][:5].tolist(), "outputs": ref}))

    learned = Learned(cfg, out / "learned.npz")             # as the simulation runs it: glitch components dropped
    d_shift = learned.shift
    hand, sd_lat = fit_hand(z, sp["train"], cfg["persona"])
    models = {"baseline_as_configured": Baseline(cfg["persona"], cfg["risk"]),
              "baseline_fit_to_train": Baseline({**cfg["persona"], **hand}, {**cfg["risk"], "step_jitter_m": sd_lat}),
              "learned": learned}
    res = {"split_participants": SPLIT, "samples": log["samples"], "best_epoch": log["best_epoch"], "hand_rule_fit": {**hand, "sd_lat_m": sd_lat},
           "walker_gap_shift_m": round(d_shift, 3), "mean_user_to_camera_m": round(gap, 3),
           "one_step_test": one_step(z, sp["test"], {**models, "learned": Learned(cfg, out / "learned.npz", min_w=0)}, cfg, d_shift),   # full mixture density
           "closed_loop_test": closed_loop(z, routes, sp["test"], models, cfg, d_shift),
           "step_noise_autocorr": step_autocorr(z, {"test": sp["test"], "val+test": sp["val"] | sp["test"]},
                                                {"baseline_fit_to_train": models["baseline_fit_to_train"], "learned": Learned(cfg, out / "learned.npz", min_w=0)}, cfg, d_shift)}
    (out / "results.json").write_text(json.dumps(res, indent=1))
    (out / "train_log.json").write_text(json.dumps(log, indent=1))
    print(json.dumps({k: res[k] for k in ("one_step_test", "closed_loop_test", "step_noise_autocorr")}, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:])

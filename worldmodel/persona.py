"""Gait personalization: the learned world model (learned.py) plus a per-person gait embedding (E = 8 dims), trained as an
auto-decoder on PhysioNet Multi-Gait-Posture (one free embedding per training participant, N(0, I) prior). Besides the
next heel and the walker pose it predicts the HEAD position when that heel lands, so a person's embedding can be fitted
from what a Quest 2 tracks (head + a controller on the walker) without seeing their feet.

Online fit (fit()): start at the population mean embedding, gradient steps on the embedding only (network frozen) on the
mean walker + head NLL of the steps seen so far, plus a tempered Gaussian prior fitted to the training embeddings. viewer/src/gaitfit.ts runs the same objective.

Evaluation (the proof number): leave-two-participants-out cross-validation (7 folds). For each held-out person their
trials play in a fixed random order as one stream; the first FIT_S seconds are fitted, every later step is scored:
next-step error of heel / walker / head with the population mean embedding vs the fitted one, and a convergence curve
(fit on the first t seconds). The network still takes the real heel history as input (as train.py does); in the headset
the feet are not tracked, so gaitfit.ts feeds back its own predicted heels (HANDOFF_GAIT.md).

usage: python -m worldmodel.persona [out/gait/samples.npz] [out/gait] [--extra <walker_videos dir> ...]
Writes persona_eval.json (CV tables), persona.json (viewer model = the fold holding out P12+P13, its training
embeddings and a 2-D style map), persona_stream.json (held-out P12/P13 streams the viewer replays as "the user").
"""
import argparse, json, os, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np
import torch
from torch import nn

from worldmodel.learned import K, D_IN, features, targets, frame, to_local

E, HIDDEN, EPOCHS, FIT_S, FIT_STEPS, FIT_LR = 8, 128, int(os.environ.get("EPOCHS", 300)), 30.0, 150, 0.05
PRIOR_W = 20.0   # fit prior = the training embeddings' Gaussian x 20: weaker priors overfit head/walker and worsen the heel (CV 2026-10-24)
FOLDS = [[2 * i, 2 * i + 1] for i in range(7)]
VIEWER_FOLD = 6                                  # holds out P12 + P13, the same test people as train.py
CURVE_S = [0, 2.5, 5, 10, 15, 20, 30]


def head_target(heels, sides, action, head1):
    """(3,) head when the heel lands: local xy (learned.py frame) + height."""
    o, t, mir = frame(heels, sides, action)
    return np.r_[to_local(head1[:2], o, t, mir), head1[2]].astype(np.float32)


class Net(nn.Module):
    """[features, embedding] -> heel MDN (K x [logit, mu xy, log sd xy]), walker Gaussian (3 + 3), head Gaussian (3 + 3).
    Features are normalised inside; the embedding is used raw (prior N(0, I))."""
    def __init__(self, mx, sx):
        super().__init__()
        self.register_buffer("mx", torch.tensor(mx)); self.register_buffer("sx", torch.tensor(sx))
        self.net = nn.Sequential(nn.Linear(D_IN + E, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, HIDDEN), nn.SiLU(), nn.Linear(HIDDEN, K * 5 + 12))

    def forward(self, x, e):
        o = self.net(torch.cat([(x - self.mx) / self.sx, e.expand(len(x), E) if e.dim() == 1 else e], 1))
        h = o[:, :K * 5].reshape(-1, K, 5)
        return (torch.log_softmax(h[..., 0], -1), h[..., 1:3], h[..., 3:5].clamp(-7, 2), o[:, K * 5:K * 5 + 3], o[:, K * 5 + 3:K * 5 + 6].clamp(-7, 2),
                o[:, K * 5 + 6:K * 5 + 9], o[:, K * 5 + 9:].clamp(-7, 2))


def nll(out, y):
    """Per-sample heel, walker, head negative log likelihoods; y = [heel xy, walker x y yaw, head x y z]."""
    lw, mu, ls, wm, wls, hm, hls = out
    lp = -0.5 * (((y[:, None, :2] - mu) / ls.exp()) ** 2).sum(-1) - ls.sum(-1) - np.log(2 * np.pi)
    dy = y[:, 2:5] - wm
    dy = torch.cat([dy[:, :2], torch.atan2(torch.sin(dy[:, 2:]), torch.cos(dy[:, 2:]))], 1)
    g = lambda d, s: (0.5 * (d / s.exp()) ** 2 + s).sum(-1) + 1.5 * np.log(2 * np.pi)
    return -torch.logsumexp(lw + lp, -1), g(dy, wls), g(y[:, 5:] - hm, hls)


def dataset(z):
    X = np.stack([features(z["heels"][i], z["sides"][i], z["action"][i]) for i in range(len(z["pid"]))])
    Y = np.stack([np.r_[targets(z["heels"][i], z["sides"][i], z["action"][i], z["heel1"][i], z["walker1"][i]),
                        head_target(z["heels"][i], z["sides"][i], z["action"][i], z["head1"][i])] for i in range(len(z["pid"]))])
    return X.astype(np.float32), Y.astype(np.float32)


def train(X, Y, pid, people, dev, seed=0):
    m = np.isin(pid, people)
    mx, sx = X[m].mean(0), X[m].std(0) + 1e-6
    torch.manual_seed(seed)
    net = Net(mx, sx).to(dev)
    idx = {p: i for i, p in enumerate(people)}
    emb = nn.Parameter(torch.zeros(len(people), E, device=dev))
    opt = torch.optim.AdamW([{"params": net.parameters(), "weight_decay": 1e-4}, {"params": [emb], "weight_decay": 0}], 2e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
    T = lambda a: torch.tensor(a, device=dev)
    x, y, ix = T(X[m]), T(Y[m]), T(np.array([idx[p] for p in pid[m]]))
    g = torch.Generator().manual_seed(seed)
    for ep in range(EPOCHS):
        for b in torch.randperm(len(x), generator=g).split(256):
            loss = sum(v.mean() for v in nll(net(x[b], emb[ix[b]]), y[b])) + 0.5 * (emb ** 2).sum() / len(x)   # MAP: N(0, I) prior
            opt.zero_grad(); loss.backward(); opt.step()
        sched.step()
    net.eval().requires_grad_(False)
    return net, emb.detach()


def prior(emb):
    """(mean, precision) of the training people's embeddings: the population the fit starts at and is pulled back to."""
    return emb.mean(0), torch.linalg.inv(torch.cov(emb.T) + 1e-3 * torch.eye(E, device=emb.device))


def fit(net, x, y, emb, steps=FIT_STEPS, lr=FIT_LR):
    """Embedding only, network frozen: mean walker + head NLL of the observed steps + PRIOR_W x the training-embedding
    Gaussian / n (a tempered posterior, so 30 steps of head data can't drag e off the people it was trained on)."""
    mu, P = prior(emb)
    e = mu.clone().requires_grad_(True)
    if not len(x):
        return mu.clone()
    opt = torch.optim.Adam([e], lr)
    for _ in range(steps):
        _, w, h = nll(net(x, e), y)
        loss = (w + h).mean() + PRIOR_W * 0.5 * (e - mu) @ P @ (e - mu) / len(x)
        opt.zero_grad(); loss.backward(); opt.step()
    return e.detach()


def errors(net, x, y, e):
    """Per-sample next-step errors (m): heel = predicted mixture mean, walker xy, head xyz; and the summed NLL."""
    with torch.no_grad():
        lw, mu, ls, wm, wls, hm, hls = out = net(x, e)
        heel = (lw.exp()[..., None] * mu).sum(1)
        hn, wn, dn = nll(out, y)
    return {"heel_cm": 100 * (heel - y[:, :2]).norm(dim=1), "walker_cm": 100 * (wm[:, :2] - y[:, 2:4]).norm(dim=1),
            "head_cm": 100 * (hm - y[:, 5:]).norm(dim=1), "nll": hn + wn + dn}


def folded(net, e, box):
    """A Learned (learned.py) with the embedding folded into the first layer's bias: what the rollout engine and the viewer
    (gaitfit.ts toWorldModel) run for one person."""
    from worldmodel.learned import Learned
    lin = [l for l in net.net if isinstance(l, nn.Linear)]
    W = {f"W{j}": l.weight.detach().cpu().numpy().astype(float) for j, l in enumerate(lin)} | {f"b{j}": l.bias.detach().cpu().numpy().astype(float) for j, l in enumerate(lin)}
    W["b0"] = W["b0"] + W["W0"][:, D_IN:] @ e.cpu().numpy(); W["W0"] = W["W0"][:, :D_IN]
    L = Learned.__new__(Learned)
    L.min_w, L.W, L._last = 0.02, {"x_mean": net.mx.cpu().numpy(), "x_std": net.sx.cpu().numpy(), **W}, None
    (L.lo, L.hi), L.shift = box, 0.0   # clamp features to the training range, as learned.py does (unclamped rollouts run away)
    return L


def closed(z, routes, ix, net, embs, box):
    """train.py closed_loop on this person's scored trials: each model walks the real routes on its own steps, 20 rollouts
    (the planner's use: no real heel history). Mean over straight + corner trials."""
    from worldmodel.train import closed_loop
    cfg = {"walker": None}   # Learned.walker_pose ignores the walker config (the sim's own geometry enters via shift = 0 here)
    m = np.zeros(len(z["pid"]), bool); m[ix] = True
    r = closed_loop(z, routes, m, {k: folded(net, e, box) for k, e in embs.items()}, cfg, 0.0)
    out = {}
    for k, g in r.items():
        n = sum(v["trials"] for v in g.values())
        out[k] = {q: round(sum(v[q] * v["trials"] for v in g.values() if v["trials"]) / n, 2) for q in ("heel_lateral_err_cm", "walker_pos_err_cm", "walker_yaw_err_deg", "step_len_err_cm")}
    return out


def stream(z, p, seed=0):
    """A person's samples as one walk: their trials in a fixed random order, each trial's steps in order."""
    trials = sorted(set(z["trial"][z["pid"] == p]))
    np.random.default_rng(seed + p).shuffle(trials)
    return np.concatenate([np.flatnonzero(z["trial"] == t)[np.argsort(z["step"][z["trial"] == t])] for t in trials])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples", nargs="?", default=str(ROOT / "out/gait/samples.npz"))
    ap.add_argument("out", nargs="?", default=str(ROOT / "out/gait"))
    ap.add_argument("--extra", nargs="*", default=[], help="our walker-video recordings (worldmodel/walker_videos.py)")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    z = dict(np.load(a.samples))
    if a.extra:
        from worldmodel.walker_videos import load, merge
        for d in a.extra:
            z = merge(z, load(d))
    X, Y = dataset(z)
    routes = dict(np.load(Path(a.samples).with_suffix(".routes.npz")))
    pid = z["pid"]
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    T = lambda v: torch.tensor(v, device=dev)
    rows, curve, t0 = [], {s: [] for s in CURVE_S}, time.time()
    folds = FOLDS + [[p] for p in sorted(set(pid.tolist())) if p >= 100]   # recorded people (walker_videos ids >= 100) get their own fold
    for fi, test in enumerate(folds):
        people = [p for p in sorted(set(pid.tolist())) if p not in test]
        ck = out / "folds" / f"fold{fi}_{'_'.join(map(str, test))}.pt"
        if ck.exists() and not os.environ.get("RETRAIN"):   # re-scoring a fit variant doesn't need a retrain
            net, emb = torch.load(ck, weights_only=False)
        else:
            net, emb = train(X, Y, pid, people, dev)
            ck.parent.mkdir(exist_ok=True); torch.save((net, emb), ck)
        e_pop, mtr = emb.mean(0), np.isin(pid, people)
        box = (X[mtr].min(0), X[mtr].max(0))
        for p in test:
            ix = stream(z, p)
            t = np.cumsum(z["dt"][ix]) - z["dt"][ix][0]
            n_fit = int((t < FIT_S).sum())
            xf, yf, xe, ye = T(X[ix[:n_fit]]), T(Y[ix[:n_fit]]), T(X[ix[n_fit:]]), T(Y[ix[n_fit:]])
            e_fit = fit(net, xf, yf, emb)
            r_pop, r_fit = errors(net, xe, ye, e_pop), errors(net, xe, ye, e_fit)
            cl = closed(z, routes, ix[n_fit:], net, {"mean_emb": e_pop, "fitted": e_fit}, box)
            rows.append({"pid": int(p), "fold": fi, "fit_steps": n_fit, "eval_steps": len(ix) - n_fit, "closed_loop": cl,
                         **{f"{k}_mean_emb": round(float(v.mean()), 2) for k, v in r_pop.items()},
                         **{f"{k}_fitted": round(float(v.mean()), 2) for k, v in r_fit.items()}})
            for s in CURVE_S:
                k = int((t < s).sum())
                curve[s].append(float(errors(net, xe, ye, fit(net, xf[:k], yf[:k], emb))["heel_cm"].mean()))
            print(json.dumps(rows[-1]), flush=True)
        if fi == VIEWER_FOLD:
            viewer = (net, emb, people, test)
    keys = ["heel_cm", "walker_cm", "head_cm", "nll"]
    w = np.array([r["eval_steps"] for r in rows], float)
    avg = lambda k: round(float(np.average([r[k] for r in rows], weights=w)), 2)
    better = lambda k: sum(r[f"{k}_fitted"] < r[f"{k}_mean_emb"] for r in rows)
    rep = {"data": "PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0), 14 participants" + (f" + {len(a.extra)} recorded dirs" if a.extra else ""),
           "embedding_dims": E, "cv": "leave-two-participants-out, 7 folds; each held-out person's first "
           f"{FIT_S:.0f} s fitted from walker + head only, every later step scored", "device": dev,
           "train_s": round(time.time() - t0, 1), "epochs": EPOCHS,
           "summary": {k: {"mean_embedding": avg(f"{k}_mean_emb"), "fitted": avg(f"{k}_fitted"),
                           "people_improved": f"{better(k)} / {len(rows)}"} for k in keys},
           "closed_loop": {k: {q: round(float(np.average([r["closed_loop"][k][q] for r in rows], weights=w)), 2) for q in rows[0]["closed_loop"][k]} for k in ("mean_emb", "fitted")},
           "closed_loop_people_improved": {q: f"{sum(r['closed_loop']['fitted'][q] < r['closed_loop']['mean_emb'][q] for r in rows)} / {len(rows)}" for q in rows[0]["closed_loop"]["fitted"]},
           "convergence_heel_cm": [{"fit_s": s, "heel_cm": round(float(np.mean(v)), 2)} for s, v in curve.items()],
           "per_person": rows}
    (out / "persona_eval.json").write_text(json.dumps(rep, indent=1))
    print(json.dumps({k: rep[k] for k in ("summary", "closed_loop", "closed_loop_people_improved", "convergence_heel_cm")}, indent=1))
    export(z, X, Y, *viewer, out)


def export(z, X, Y, net, emb, people, test, out):
    """Viewer files: network + training embeddings + PCA style map; the held-out people's streams (measured, replayed)."""
    lin = [l for l in net.net if isinstance(l, nn.Linear)]
    f = lambda a: np.asarray(a.detach().cpu() if torch.is_tensor(a) else a, float).round(6).tolist()
    m = np.isin(z["pid"], people)
    em = emb.cpu().numpy()
    c = em.mean(0)
    U = np.linalg.svd(em - c)[2][:2]                    # style map: the 2 main directions of the training embeddings
    # mean user -> walker-point distance along the walker heading (train.py), so the viewer can fit its own walker geometry
    gap = float(np.mean([(z["walker0"][i][:2] - z["heels"][i][:2].mean(0)) @ np.array([np.cos(z["walker0"][i][2]), np.sin(z["walker0"][i][2])]) for i in np.flatnonzero(m)]))
    model = {"K": K, "E": E, "min_w": 0.02, "mean_gap_m": gap, "x_mean": f(net.mx), "x_std": f(net.sx), "x_min": f(X[m].min(0)), "x_max": f(X[m].max(0)),
             "layers": [{"W": f(l.weight), "b": f(l.bias)} for l in lin], "e_pop": f(c),
             "people": [{"pid": int(p), "e": f(em[i]), "map": f((em[i] - c) @ U.T)} for i, p in enumerate(people)],
             "map_axes": f(U), "map_center": f(c), "fit": {"steps": FIT_STEPS, "lr": FIT_LR, "window_s": FIT_S, "prior_w": PRIOR_W, "prior_prec": f(prior(emb)[1])},
             "trained_on": f"PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0), participants {people}; held out {test}"}
    (out / "persona.json").write_text(json.dumps(model))
    S = {}
    for p in test:
        ix = stream(z, p)
        S[int(p)] = {"heels": f(z["heels"][ix]), "sides": z["sides"][ix].astype(int).tolist(), "action": f(z["action"][ix]),
                     "heel1": f(z["heel1"][ix]), "walker1": f(z["walker1"][ix]), "head1": f(z["head1"][ix]), "dt": f(z["dt"][ix]),
                     "trial": z["trial"][ix].tolist(), "x": f(X[ix]), "y": f(Y[ix])}
    (out / "persona_stream.json").write_text(json.dumps({"source": "measured: PhysioNet Multi-Gait-Posture, held-out participants", "people": S}))
    # check rows the TS port must reproduce (forward pass at e_pop and at a person's embedding)
    rows = []
    for e in (c, em[0]):
        with torch.no_grad():
            o = net(torch.tensor(X[:3]), torch.tensor(e, dtype=torch.float32))
        rows.append({"x": f(X[:3]), "e": f(e), "out": [f(v) for v in o]})
    (out / "persona_check.json").write_text(json.dumps(rows))
    web = ROOT / "viewer/public/gait"                    # generated, like export_web.py's viewer/public/models
    web.mkdir(exist_ok=True)
    for n in ("persona.json", "persona_stream.json", "persona_check.json", "persona_eval.json"):
        (web / n).write_bytes((out / n).read_bytes())


if __name__ == "__main__":
    main()

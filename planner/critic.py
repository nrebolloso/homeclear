"""The planner's critic: a small MLP that predicts a layout's risk (falls-risk events / month) from the layout alone, trained
on every layout the search scored (out/planner/<scene>/evals.jsonl). The viewer's live mode runs it in the browser to
search thousands of layouts, then confirms its top 5 with real rollouts, so it only has to rank well, not be exact.
Writes critic.json (features + weights for planfix.ts), critic.onnx (when onnx is installed) and critic_eval.json
(accuracy against the real evaluator on held-out layouts the critic never saw).
    python -m planner.critic [--scene kitchen4_lighter] [--evals out/planner/<scene>/evals.jsonl]"""
import argparse, json, math, random
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
MAT, CORD = ["present", "taped", "removed", "moved"], ["present", "taped", "rerouted"]


def spec(cfg):
    return {"chairs": cfg["chairs"], "mat": MAT, "cord": CORD, "nightlight": [*cfg["outlets"], "off"]}


def features(sp, pl):
    """chairs: x, y, cos, sin of yaw; mat, cord, nightlight one-hot; the moved mat's x, y and yaw (0 when not moved).
    Mirrored by planfix.ts criticFeatures(): change both together."""
    f = []
    for n in sp["chairs"]:
        x, y, a = pl["chairs"][n]
        f += [x, y, math.cos(math.radians(a)), math.sin(math.radians(a))]
    f += [float(pl["mat"] == m) for m in sp["mat"]]
    at = pl.get("mat_at") or [0, 0, 0]
    f += [at[0], at[1], float(at[2] == 90)]
    f += [float(pl["cord"] == c) for c in sp["cord"]]
    f += [float(pl["nightlight"] == o) for o in sp["nightlight"]]
    return f


def spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="kitchen4_lighter")
    ap.add_argument("--evals")
    ap.add_argument("--out")
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=3000)
    a = ap.parse_args()
    cfg = json.loads((ROOT / "configs/planner" / f"{a.scene}.json").read_text())
    sp = spec(cfg)
    ev = Path(a.evals or ROOT / "out/planner" / a.scene / "evals.jsonl")
    out = Path(a.out or ev.parent)
    rows = [json.loads(l) for l in ev.open()]
    rows = [r for r in rows if not r["score"].get("error")]
    X = np.array([features(sp, r["layout"]) for r in rows], np.float32)
    y = np.array([r["score"]["risk"] for r in rows], np.float32)
    idx = list(range(len(rows))); random.Random(0).shuffle(idx)
    nt = max(1, len(idx) // 5)
    te, tr = np.array(idx[:nt]), np.array(idx[nt:])   # held out: a random 20% of the distinct layouts
    mx, sx = X[tr].mean(0), X[tr].std(0) + 1e-6
    my, sy = float(y[tr].mean()), float(y[tr].std() + 1e-6)
    box, yr = (X[tr].min(0), X[tr].max(0)), (float(y[tr].min()), float(y[tr].max()))   # the critic is only trusted inside what it saw
    torch.manual_seed(0)
    net = torch.nn.Sequential(torch.nn.Linear(X.shape[1], a.hidden), torch.nn.SiLU(), torch.nn.Linear(a.hidden, a.hidden), torch.nn.SiLU(), torch.nn.Linear(a.hidden, 1))
    Xt, yt = torch.tensor((X.clip(*box) - mx) / sx), torch.tensor((y - my) / sy)   # held-out rows get the same clamp as the viewer
    opt = torch.optim.AdamW(net.parameters(), 3e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, a.epochs)
    trt = torch.tensor(tr)
    for ep in range(a.epochs):   # full batch: the set is tens of thousands of rows, a few ms per step
        opt.zero_grad()
        loss = torch.nn.functional.mse_loss(net(Xt[trt]).squeeze(1), yt[trt])
        loss.backward(); opt.step(); sched.step()
    with torch.no_grad():
        p = (net(Xt).squeeze(1).numpy() * sy + my).clip(*yr)
    def acc(ix):
        e = p[ix] - y[ix]
        top = set(ix[np.argsort(y[ix])[:max(1, len(ix) // 20)]])   # did the critic's best 5% contain the real best 5%?
        return {"n": int(len(ix)), "mae": round(float(np.abs(e).mean()), 2), "rmse": round(float(np.sqrt((e ** 2).mean())), 2),
                "r2": round(1 - float((e ** 2).sum() / ((y[ix] - y[ix].mean()) ** 2).sum()), 3), "spearman": round(spearman(p[ix], y[ix]), 3),
                "top5pct_overlap": round(len(top & set(ix[np.argsort(p[ix])[:len(top)]])) / len(top), 3),
                "risk_range": [round(float(y[ix].min()), 1), round(float(y[ix].max()), 1)]}
    rep = {"scene": a.scene, "target": "risk (events / month, search rollouts)", "features": X.shape[1], "hidden": [a.hidden, a.hidden],
           "train": acc(tr), "held_out": acc(te), "note": "held-out = a random 20% of the searched layouts, never trained on; "
           "their 'real' risk is the evaluator's own Monte Carlo estimate (200 trips), so part of the error is that noise"}
    W = [l for l in net if isinstance(l, torch.nn.Linear)]
    try:   # onnx lives in the cluster env's pylib; locally the JSON weights are what the viewer uses
        import onnx  # noqa: F401
        full = torch.nn.Sequential(Norm(mx, sx, box), net, Denorm(my, sy, yr))
        torch.onnx.export(full, torch.zeros(1, X.shape[1]), out / "critic.onnx", input_names=["features"], output_names=["risk"], dynamic_axes={"features": {0: "n"}},
                          dynamo=False)   # the dynamo exporter needs onnxscript, which the cluster pylib lacks
        rep["onnx"] = "critic.onnx"
    except ImportError:
        rep["onnx"] = None
    json.dump({"spec": sp, "x_mean": mx.tolist(), "x_std": sx.tolist(), "x_min": box[0].tolist(), "x_max": box[1].tolist(), "y_mean": my, "y_std": sy, "y_range": yr, "act": "silu",
               "layers": [{"w": l.weight.detach().numpy().round(6).tolist(), "b": l.bias.detach().numpy().round(6).tolist()} for l in W],
               "eval": rep}, open(out / "critic.json", "w"))
    json.dump(rep, open(out / "critic_eval.json", "w"), indent=1)
    print(json.dumps(rep, indent=1))


class Norm(torch.nn.Module):
    def __init__(self, m, s, box):
        super().__init__(); self.m, self.s, self.lo, self.hi = torch.tensor(m), torch.tensor(s), torch.tensor(box[0]), torch.tensor(box[1])
    def forward(self, x):
        return (torch.minimum(torch.maximum(x, self.lo), self.hi) - self.m) / self.s


class Denorm(torch.nn.Module):
    def __init__(self, m, s, yr):
        super().__init__(); self.m, self.s, self.yr = m, s, yr
    def forward(self, x):
        return (x.squeeze(1) * self.s + self.m).clamp(*self.yr)


if __name__ == "__main__":
    main()

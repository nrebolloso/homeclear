"""Weights of the learned world model for the viewer (viewer/src/worldmodel.ts) + a check file the TS test compares against.

usage: python -m worldmodel.export_web [viewer/public/models]
"""
import json, sys
from pathlib import Path

import numpy as np

from .learned import K, MIN_W, WEIGHTS, Learned
from .models import State
from .rollout import load_cfg


def main(out=Path(__file__).resolve().parents[1] / "viewer/public/models"):
    out = Path(out)
    W = dict(np.load(WEIGHTS))
    meta = json.loads(str(W.pop("meta")))
    n = sum(1 for k in W if k.startswith("W"))
    f = lambda a: np.asarray(a, float).round(7).tolist()
    model = {"K": K, "min_w": MIN_W, "mean_gap_m": meta["mean_gap_m"], "trained_on": meta["trained_on"],
             "x_mean": f(W["x_mean"]), "x_std": f(W["x_std"]), "x_min": f(W["x_min"]), "x_max": f(W["x_max"]),
             "layers": [{"W": f(W[f"W{i}"]), "b": f(W[f"b{i}"])} for i in range(n)]}
    (out / "world_model.json").write_text(json.dumps(model))

    # states the TS port must reproduce: straight, left bend, right bend, both mirror sides
    cfg = load_cfg()
    L = Learned(cfg)
    rows = []
    for turn, side in [(0, 1), (0.6, 1), (-0.6, -1), (0.3, -1)]:
        heels = np.array([[0.2, side * -0.1], [-0.2, side * 0.1], [-0.6, side * -0.1]])
        a = np.array([[0.25 * np.cos(turn * s), 0.25 * np.sin(turn * s)] for s in (1, 2, 4)]) * [[1], [2], [4]]
        s = State(heels, heels, np.array([side, -side, side]), heels[:2].mean(0), np.zeros(2), np.zeros(3), np.zeros(8))
        d = L.predict(s, a)
        rows.append({"heels": heels.tolist(), "sides": [side, -side, side], "action": a.tolist(),
                     "w": d.w.tolist(), "mu": d.mu.tolist(), "sd": d.sd.tolist(),
                     "walker": L.walker_pose(s, None, a, cfg["walker"]).tolist(), "walker_cfg": cfg["walker"]})
    (out / "world_model_check.json").write_text(json.dumps(rows))
    print(f"wrote {out / 'world_model.json'} ({(out / 'world_model.json').stat().st_size // 1024} KB) + check")


if __name__ == "__main__":
    main(*sys.argv[1:])

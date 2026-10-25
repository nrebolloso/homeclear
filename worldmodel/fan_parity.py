"""Parity check for the futures fan's world model: the TRAINED checkpoint (out/gait/folds/fold6_12_13.pt, the viewer fold)
run in torch on fresh measured states (24 random steps, held-out people included, not the export's 3 check rows), at each
gait style the fan offers (viewer/public/gait/styles.json). viewer/tests/futures.test.ts runs the fan's own path
(gaitfit toWorldModel -> worldmodel predict, as fanworker.ts does) on the same states and must match.

usage: python -m worldmodel.fan_parity   (writes viewer/public/gait/fan_parity.json, prints the weight diff vs persona.json)
"""
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn

from worldmodel.learned import features
from worldmodel.persona import Net  # noqa: F401  (torch.load unpickles it)

ROOT = Path(__file__).resolve().parents[1]


def main():
    net, emb = torch.load(ROOT / "out/gait/folds/fold6_12_13.pt", weights_only=False, map_location="cpu")
    net.eval()
    web = ROOT / "viewer/public/gait"
    M, styles = json.loads((web / "persona.json").read_text()), json.loads((web / "styles.json").read_text())["styles"]
    lin = [l for l in net.net if isinstance(l, nn.Linear)]
    wdiff = max(float(np.abs(np.asarray(L["W"]) - l.weight.detach().numpy()).max()) for L, l in zip(M["layers"], lin))
    print(f"persona.json vs checkpoint: max |weight diff| {wdiff:.1e} (export rounds to 1e-6)")

    z = dict(np.load(ROOT / "out/gait/samples.npz"))
    ix = np.random.default_rng(7).choice(len(z["pid"]), 24, replace=False)
    lo, hi = np.asarray(M["x_min"], np.float32), np.asarray(M["x_max"], np.float32)
    rows = []
    for i in ix:
        x = features(z["heels"][i], z["sides"][i], z["action"][i]).astype(np.float32)
        out = {}
        for st in styles:
            with torch.no_grad():   # worldmodel.ts predict clips the features to the training box first
                lw, mu, ls, wm, *_ = net(torch.tensor(np.clip(x, lo, hi))[None], torch.tensor(st["e"], dtype=torch.float32))
            out[st["name"]] = {"w": lw.exp()[0].tolist(), "mu": mu[0].tolist(), "sd": ls.exp()[0].tolist(), "walker": wm[0].tolist()}
        rows.append({"pid": int(z["pid"][i]), "heels": z["heels"][i].tolist(), "sides": z["sides"][i].astype(int).tolist(),
                     "action": z["action"][i].tolist(), "x": x.tolist(), "out": out})
    (web / "fan_parity.json").write_text(json.dumps({"checkpoint": "out/gait/folds/fold6_12_13.pt", "weight_diff": wdiff, "rows": rows}))
    print(f"wrote {web / 'fan_parity.json'}: {len(rows)} states x {len(styles)} styles, people {sorted(set(r['pid'] for r in rows))}")


if __name__ == "__main__":
    main()

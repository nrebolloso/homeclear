"""Does a person's gait embedding (worldmodel/persona.py) change what the planner should do? The persona network is folded
with each embedding (gaitfit.ts toWorldModel) and walks the kitchen route in planner/engine.py with common random numbers:
the population mean, the held-out P12 / P13 fitted from their first 30 s of walker + head (as persona.py evaluates them),
and every training participant's learned embedding. Per embedding: foot placement on the scanned room (step length,
lateral heel offset from the route, heel displacement vs the mean at the same step), contacts / snags / brushes of the
scanned room and the search's three options, and the one-change-at-a-time fix ranking (planfix.ts rankedFixes).
Also writes the ghost styles the viewer walks (viewer/public/gait/styles.json: generated).
    python -m planner.persona_effect [--trips 2000]"""
import argparse, copy, json, math, sys
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner import engine as E
from worldmodel import persona as P


def folded(m, e):
    """gaitfit.ts toWorldModel: the embedding folded into the first layer's bias, as a world_model.json dict"""
    nx, l0 = len(m["x_mean"]), m["layers"][0]
    W = np.array(l0["W"])
    return {**{k: m[k] for k in ("K", "min_w", "mean_gap_m", "x_mean", "x_std", "x_min", "x_max")},
            "layers": [{"W": W[:, :nx].tolist(), "b": (np.array(l0["b"]) + W[:, nx:] @ np.asarray(e)).tolist()}, *m["layers"][1:]]}


def fitted(test):
    """held-out people's embeddings from their first FIT_S seconds (persona.py main, the viewer fold)"""
    z = dict(np.load(ROOT / "out/gait/samples.npz"))
    X, Y = P.dataset(z)
    sys.modules["__main__"].Net = P.Net   # the folds were pickled by `python -m worldmodel.persona` (module __main__)
    net, emb = torch.load(ROOT / f"out/gait/folds/fold{P.VIEWER_FOLD}_{'_'.join(map(str, test))}.pt", weights_only=False, map_location="cpu")
    out = {}
    for p in test:
        ix = P.stream(z, p)
        t = np.cumsum(z["dt"][ix]) - z["dt"][ix][0]
        n = int((t < P.FIT_S).sum())
        out[p] = P.fit(net.cpu(), torch.tensor(X[ix[:n]]), torch.tensor(Y[ix[:n]]), emb.cpu()).numpy().tolist()
    return out


def placement(S, g, ref=None):
    """foot placement of kept trips: step length, |lateral heel offset| from the planned route, displacement vs ref"""
    rt = g["rt"]
    L, lat, d = [], [], []
    for n, tr in enumerate(g["ghosts"]):
        h = np.array(tr["pts"])
        if len(h) < 3:
            continue
        L += np.linalg.norm(np.diff(h, axis=0), axis=1).tolist()
        j = np.linalg.norm(rt[None] - h[:, None], axis=2).argmin(1)
        lat += np.linalg.norm(h - rt[j], axis=1).tolist()
        if ref is not None and n < len(ref["ghosts"]):
            r = np.array(ref["ghosts"][n]["pts"]); k = min(len(r), len(h))
            d += np.linalg.norm(h[:k] - r[:k], axis=1).tolist()
    q = lambda v: round(float(np.mean(v)) * 100, 1) if v else None
    return {"step_cm": q(L), "lateral_cm": q(lat), "vs_mean_cm": q(d), "steps": len(L) // max(1, len(g["ghosts"])) + 1}


def one_change(S, cur, goal):
    """planfix.ts rankedFixes: each of goal's changes applied alone to cur"""
    out = {}
    for k in cur["chairs"]:
        if cur["chairs"][k] != goal["chairs"][k]:
            q = copy.deepcopy(cur); q["chairs"][k] = goal["chairs"][k]; out[k] = q
    for k in ("mat", "cord", "nightlight"):
        if cur[k] != goal[k]:
            q = copy.deepcopy(cur); q[k] = goal[k]
            for a in (f"{k}_at",):
                if a in goal: q[a] = goal[a]
            out[k] = q
    return out


def repick(pf, risks):
    """search.py's option rule (knee / lowest / cheapest 20% cut) re-applied to the Pareto front scored with one style"""
    r0, rmin = risks[0], min(risks)
    emax = max(p["cost"]["effort"] for p in pf) or 1
    knee = max(range(len(pf)), key=lambda k: (r0 - risks[k]) / max(1e-9, r0 - rmin) - pf[k]["cost"]["effort"] / emax)
    low = min(range(len(pf)), key=lambda k: risks[k])
    cheap = next((k for k in range(len(pf)) if risks[k] < 0.8 * r0 and k != knee), None)
    return {"chosen": knee, "lowest": low, "cheap": cheap}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="kitchen4_lighter")
    ap.add_argument("--trips", type=int, default=2000)
    a = ap.parse_args()
    m = json.loads((ROOT / "viewer/public/gait/persona.json").read_text())
    search = json.loads((ROOT / f"viewer/public/planner/{a.scene}/search.json").read_text())
    S = E.Scene(a.scene, device="cuda" if torch.cuda.is_available() else "cpu")
    test = [int(v) for v in m["trained_on"].split("held out ")[1].strip("[]").split(",")]
    embs = {"mean": m["e_pop"], **{f"P{p:02d} (held out, fitted 30 s)": e for p, e in fitted(test).items()},
            **{f"P{p['pid']:02d} (training)": p["e"] for p in m["people"]}}
    scan = search["scanned"]["layout"]
    opts = [(o["why"], search["pareto"][o["k"]]["layout"]) for o in search["options"]]
    chosen = opts[0][1]
    singles = one_change(S, scan, chosen)
    pf = search["pareto"]
    pls = [scan, *[pl for _, pl in opts], *singles.values(), *[p["layout"] for p in pf]]
    want = {"chosen": search["options"][0]["k"], "lowest": search["options"][1]["k"], "cheap": search["options"][2]["k"]}
    rows, ref = {}, None
    for name, e in embs.items():
        S.wm = E.WorldModel(folded(m, e), S.walker, S.device)
        r = E.score(S, pls, trips=a.trips, seed=1, keep=40)
        g = {**r[0], "rt": E.prepare(S, scan)["rt"]}
        if ref is None:
            ref = g
        sl = lambda s: {k: round(s[k], 2) for k in ("risk", "lo", "hi", "contacts", "snags", "brushes")}
        base = r[0]["risk"]
        rank = sorted(((k, round(base - s["risk"], 2)) for k, s in zip(singles, r[1 + len(opts):])), key=lambda t: -t[1])
        best = min(range(len(opts)), key=lambda i: r[1 + i]["risk"])
        rows[name] = {"placement": placement(S, g, None if g is ref else ref), "scanned": sl(r[0]),
                      "options": [{"why": w, **sl(s)} for (w, _), s in zip(opts, r[1:1 + len(opts)])],
                      "best_option": opts[best][0], "fix_ranking": rank,
                      "repick": repick(pf, [x["risk"] for x in r[1 + len(opts) + len(singles):]]), "ghosts": g["ghosts"][:1]}
        print(name, json.dumps({k: v for k, v in rows[name].items() if k != "ghosts"}), flush=True)
    # summary: how far the styles spread vs the noise of the same style re-run on new trips
    S.wm = E.WorldModel(folded(m, m["e_pop"]), S.walker, S.device)
    noise = E.score(S, [scan], trips=a.trips, seed=2)[0]
    mean = rows["mean"]
    def spread(k):
        v = [r["scanned"][k] for r in rows.values()]
        return {"min": round(min(v), 2), "max": round(max(v), 2), "mean_style": mean["scanned"][k], "mean_style_reseeded": round(noise[k], 2)}
    order = lambda r: [k for k, _ in r["fix_ranking"]]
    rep = {"what": "kitchen route walked by the persona world model folded with each embedding (planner/engine.py, common random numbers, "
                   f"{a.trips} trips each); scanned room, the search's 3 options, one change at a time toward the chosen option",
           "data": m["trained_on"],
           "scanned_spread": {k: spread(k) for k in ("contacts", "snags", "brushes", "risk")},
           "same_best_option": sum(r["best_option"] == mean["best_option"] for r in rows.values()),
           "same_fix_order": sum(order(r) == order(mean) for r in rows.values()),
           "search_picks": want,
           "same_repick": {o: sum(r["repick"][o] == want[o] for r in rows.values()) for o in want},
           "repick_by_style": {k: r["repick"] for k, r in rows.items()},
           "n": len(rows), "per_style": {k: {q: v for q, v in r.items() if q != "ghosts"} for k, r in rows.items()}}
    out = ROOT / "out/gait/persona_effect.json"
    out.write_text(json.dumps(rep, indent=1))
    print(json.dumps({k: rep[k] for k in ("scanned_spread", "same_best_option", "same_fix_order", "same_repick", "repick_by_style", "n")}, indent=1))
    # the viewer's ghost styles: the mean and the two held-out people (measured, never trained on), plus the training
    # people whose kitchen walks differ most from the mean (largest heel displacement), and the one whose risk differs most
    tr = sorted((k for k in rows if "training" in k), key=lambda k: -(rows[k]["placement"]["vs_mean_cm"] or 0))[:2]
    tr += [max((k for k in rows if "training" in k and k not in tr), key=lambda k: abs(rows[k]["scanned"]["risk"] - mean["scanned"]["risk"]))]
    pick = ["mean", *[k for k in rows if "held out" in k], *tr]
    styles = {"source": "imagined: persona world model (PhysioNet stand-in) folded with each embedding; " + m["trained_on"],
              "styles": [{"name": k, "e": embs[k], "placement": rows[k]["placement"], "scanned": rows[k]["scanned"]} for k in pick]}
    (ROOT / "viewer/public/gait/styles.json").write_text(json.dumps(styles))
    (ROOT / "viewer/public/gait/persona_effect.json").write_text(out.read_text())


if __name__ == "__main__":
    main()

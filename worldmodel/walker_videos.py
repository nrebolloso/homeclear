"""Loader hook for OUR walker recordings (team members walking the configured walker, config game.walker: Drive Medical
10210-1, 0.61 m wide), so they train the gait embedding next to PhysioNet: python -m worldmodel.persona --extra <dir>.
No recordings exist yet (BLOCKERS.md); this fixes the format so whoever annotates the videos knows what to write.

<dir>/steps.csv, one row per heel strike, world-frame metres / radians / seconds:
    person, trial, t, side, heel_x, heel_y, walker_x, walker_y, walker_yaw, head_x, head_y, head_z, acted
side +1 left / -1 right; walker = frame centre and heading at that strike; head = headset position (Quest 2 or the video
head track); acted = 1 for passes acted on purpose (shuffle, catching a foot): they are kept and labelled, so a model can
be trained with or without them. The route is the smoothed head path (CoM stand-in), as gait.py uses the CoM.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "motion"))

import numpy as np
import pandas as pd

from gait_data import FPS, route_of

PID0 = 100      # recorded people get pids 100, 101, ... (PhysioNet uses 0-13)


def load(d):
    df = pd.read_csv(Path(d) / "steps.csv")
    people = {p: PID0 + i for i, p in enumerate(sorted(df.person.unique()))}
    recs = []
    for (person, trial), g in df.groupby(["person", "trial"], sort=False):
        g = g.sort_values("t")
        t = np.arange(g.t.iloc[0], g.t.iloc[-1], 1 / FPS)   # head path at the Xsens rate, so route_of smooths it the same way
        route = route_of(np.stack([np.interp(t, g.t, g.head_x), np.interp(t, g.t, g.head_y)], 1))
        H, S = g[["heel_x", "heel_y"]].to_numpy(), g.side.to_numpy()
        Wk, Hd = g[["walker_x", "walker_y", "walker_yaw"]].to_numpy(), g[["head_x", "head_y", "head_z"]].to_numpy()
        for i in range(2, len(g) - 1):
            if S[i + 1] == S[i] or S[i - 1] == S[i]:
                continue
            heels = H[[i, i - 1, i - 2]]
            k = int(np.argmin(np.linalg.norm(route - heels[:2].mean(0), axis=1)))
            if k + 150 >= len(route):
                continue
            recs.append({"heels": heels, "sides": np.array([S[i], -S[i], S[i]]), "action": route[[k + 25, k + 50, k + 100]],
                         "walker0": Wk[i], "heel1": H[i + 1], "walker1": Wk[i + 1], "com": Hd[i, :2], "dt": g.t.iloc[i + 1] - g.t.iloc[i],
                         "route_k": k, "step": i, "pid": people[person], "kind": "recorded", "speed": np.nan,
                         "trial": f"{person}_{trial}", "head0": Hd[i], "head1": Hd[i + 1], "acted": int(g.acted.iloc[i + 1])})
    return {k: np.stack([r[k] for r in recs]) for k in recs[0]}


def merge(z, r):
    """Append recorded samples to the PhysioNet arrays (PhysioNet rows get acted = 0)."""
    z = {**z, "acted": z.get("acted", np.zeros(len(z["pid"]), int))}
    return {k: np.concatenate([z[k], r[k].astype(z[k].dtype) if z[k].dtype.kind != "U" else r[k]]) for k in z}

"""Footstep samples from PhysioNet Multi-Gait-Posture (Xsens MVN, world frame, z up, metres, 60 Hz).

A step = one stance phase of a foot (horizontal foot speed below STANCE_MPS for >= MIN_STANCE frames); its placement
is the median Xsens "Foot" segment origin (ankle; the suit has no heel point) and "Toe" origin over the stance.
The ROUTE is the trial's centre-of-mass path smoothed over ROUTE_SIGMA_S: step sway removed, the shape of the walk
kept, the closest stand-in in this data for the planned route the simulator walks along.

Each sample predicts step i+1 from the state when step i lands, in a local frame: origin = the route point nearest
step i's heel, x = route direction there, y = left. When step i+1 is a RIGHT foot, y is mirrored, so every target is
"the next foot, on the left": one model for both feet.

usage: python motion/gait_data.py <dataset_dir> <out.npz>   (dataset_dir holds raw/participantNN/...)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.ndimage import gaussian_filter1d, uniform_filter1d

FPS = 60
STANCE_MPS, MIN_STANCE = 0.10, 6
ROUTE_SIGMA_S = 1.0
AHEAD = np.arange(0, 1.51, 0.01)       # route samples ahead of the current step (m of arc length)
TURN_DEG = 15                          # a step is "in a turn" when the route turns more than this over the next 1 m


def steps_of(seg):
    """Footsteps of one trial: list of (side +1 left / -1 right, t_on, heel xy, toe xy), in time order."""
    out = []
    for side, name in ((1, "Left"), (-1, "Right")):
        heel = seg[[f"{name} Foot x", f"{name} Foot y"]].to_numpy()
        toe = seg[[f"{name} Toe x", f"{name} Toe y"]].to_numpy()
        v = uniform_filter1d(np.linalg.norm(np.gradient(heel, axis=0), axis=1) * FPS, 5)
        st = np.r_[False, v < STANCE_MPS, False].astype(int)
        on, off = np.flatnonzero(np.diff(st) == 1), np.flatnonzero(np.diff(st) == -1)
        for a, b in zip(on, off):
            if b - a >= MIN_STANCE:
                out.append((side, a, np.median(heel[a:b], 0), np.median(toe[a:b], 0)))
    return sorted(out, key=lambda s: s[1])


def route_of(com_xy):
    """Smoothed CoM path resampled every 1 cm of arc length, extended 2 m straight past its end (lookahead at the goal)."""
    r = gaussian_filter1d(com_xy, ROUTE_SIGMA_S * FPS, axis=0, mode="nearest")
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(r, axis=0), axis=1))]
    keep = np.r_[True, np.diff(s) > 1e-6]
    u = np.arange(0, s[-1], 0.01)
    pts = np.stack([np.interp(u, s[keep], r[keep, k]) for k in range(2)], 1)
    d = pts[-1] - pts[-11]
    return np.r_[pts, pts[-1] + np.arange(1, 201)[:, None] * 0.01 * d / np.linalg.norm(d)]


def local(route, k, side, p):
    """World points p -> frame at route index k (x along the route, y left; y mirrored when the target foot is right)."""
    t = route[min(k + 5, len(route) - 1)] - route[max(k - 5, 0)]
    t /= np.linalg.norm(t)
    q = p - route[k]
    return np.stack([q @ t, side * (q @ np.array([-t[1], t[0]]))], -1)


def trial_samples(seg, com):
    st = steps_of(seg)
    com_xy = com[["CoM x", "CoM y"]].to_numpy()
    com_v = np.gradient(gaussian_filter1d(com_xy, 3, axis=0), axis=0) * FPS
    route = route_of(com_xy)
    rows, dropped = [], {"same_side": 0, "edge": 0, "implausible": 0}
    for i in range(2, len(st) - 2):            # first two and last steps: starting / stopping, not walking
        (s0, t0, h0, _), (s1, t1, h1, toe1) = st[i], st[i + 1]
        if s1 == s0 or st[i - 1][0] == s0:
            dropped["same_side"] += 1
            continue
        k = int(np.argmin(np.linalg.norm(route - h0, axis=1)))
        if k + 150 >= len(route):
            dropped["edge"] += 1
            continue
        L = lambda p: local(route, k, s1, np.asarray(p, float))
        tgt = L(h1)
        if not (0.05 < tgt[0] < 1.0 and abs(tgt[1]) < 0.6):   # detection glitch (merged / split stance)
            dropped["implausible"] += 1
            continue
        hist = np.concatenate([np.r_[L(st[i - j][2]), L(st[i - j][3])] for j in range(3)])   # heel, toe of steps i, i-1, i-2
        t = route[min(k + 5, len(route) - 1)] - route[max(k - 5, 0)]
        t /= np.linalg.norm(t)
        rot = np.array([t, [-t[1], t[0]]]) * np.array([[1], [s1]])   # world vector -> local (mirrored) vector
        rows.append({"hist": hist, "com": L(com_xy[t0]), "com_v": rot @ com_v[t0], "ahead": L(route[k + (AHEAD * 100).astype(int)]),
                     "target": tgt, "target_toe": L(toe1), "dt": (t1 - t0) / FPS,
                     "origin": route[k], "tangent": t, "mirror": s1, "step": i, "heel_world": h1})
    return rows, dropped, len(st)


def features(hist, com, com_v, ahead):
    """Model input (N, 21): heel+toe of the last 3 steps, CoM position + velocity, speed, heading vs route, route turn ahead."""
    speed = np.linalg.norm(com_v, axis=-1, keepdims=True)
    heading = np.arctan2(com_v[..., 1:2], com_v[..., 0:1])
    turn = []
    for m in (0.25, 0.5, 1.0):
        k = int(round(m * 100))
        d = ahead[:, k + 1] - ahead[:, k - 1]
        turn.append(np.arctan2(d[:, 1], d[:, 0])[:, None])
    return np.concatenate([hist, com, com_v, speed, heading] + turn, 1).astype(np.float32)


def turn_deg(ahead):
    d = ahead[:, 101] - ahead[:, 99]
    return np.degrees(np.arctan2(d[:, 1], d[:, 0]))


def main(ds, out):
    ds = Path(ds)
    recs, log = [], []
    for csvdir in sorted(ds.glob("raw/participant*/participant*_*/participant*/*_csv")):
        trial = csvdir.parent.name                      # participantNN_{left|right|straight}_{speed}_{cornerN|corridorN}
        if csvdir.name != trial + "_csv":               # P02 left_0.3_corner1 holds a stray right_0.5_corner3_csv matching neither
            print("skip mislabelled", csvdir.relative_to(ds))
            continue
        pid, kind, speed, place = trial.split("_")
        seg = pd.read_csv(csvdir / "Segment Position.csv", sep=";")
        com = pd.read_csv(csvdir / "Center of Mass.csv", sep=";")
        rows, dropped, n_steps = trial_samples(seg, com)
        log.append({"trial": trial, "frames": len(seg), "steps": n_steps, "samples": len(rows), **dropped})
        for r in rows:
            recs.append({**r, "pid": int(pid[-2:]), "kind": kind, "speed": float(speed), "trial": trial})
    log = pd.DataFrame(log)
    log.to_csv(Path(out).with_suffix(".trials.csv"), index=False)
    A = lambda k: np.stack([r[k] for r in recs])
    np.savez_compressed(out, hist=A("hist"), com=A("com"), com_v=A("com_v"), ahead=A("ahead"), target=A("target"),
                        target_toe=A("target_toe"), dt=np.array([r["dt"] for r in recs]),
                        pid=np.array([r["pid"] for r in recs]), kind=np.array([r["kind"] for r in recs]),
                        speed=np.array([r["speed"] for r in recs]), trial=np.array([r["trial"] for r in recs]),
                        origin=A("origin"), tangent=A("tangent"), mirror=np.array([r["mirror"] for r in recs]),
                        step=np.array([r["step"] for r in recs]), heel_world=A("heel_world"))
    print(f"{len(log)} trials, {log.steps.sum()} steps, {len(recs)} samples; dropped "
          f"{ {k: int(log[k].sum()) for k in ('same_side', 'edge', 'implausible')} }")


if __name__ == "__main__":
    main(*sys.argv[1:])

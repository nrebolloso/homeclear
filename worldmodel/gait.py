"""World-model samples from PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0), see WORLD_MODEL.md "Data".

Footsteps and the route come from the Xsens world-frame sheets exactly as motion/gait_data.py builds them (stance
detection, smoothed-CoM route). New here: the WALKER POSE. The processed `aligned_skeleton_3d.csv` is the same 23-segment
skeleton in the frame of the camera mounted on the walker; `synchronized_data_idx.csv` gives the Xsens row of each camera
frame. A rigid fit (Kabsch) of the camera skeleton onto the Xsens skeleton gives the camera's pose in the world, i.e. the
walker's: point = camera xy, heading = minus the camera's optical axis on the floor (it looks back at the user).

Each sample is taken when step i lands (state) and predicts step i+1 and the walker when it lands, with the action the
rollout engine uses: route points 0.25 / 0.5 / 1.0 m past the route point nearest the mid-heels.

usage: python -I worldmodel/gait.py <dataset_dir> <out.npz>   (dataset_dir holds raw/ and processed/ participantNN/...)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "motion"))

import numpy as np
import pandas as pd

from gait_data import FPS, steps_of, route_of

FIT_MAX_M = 0.05        # mean joint residual above this = a bad camera skeleton frame, no walker pose
SYNC_MAX = 2            # Xsens frames (60 Hz) between a step landing and the nearest camera frame (30 Hz)


def kabsch(a, b):
    """R, t with R @ a_i + t ~ b_i."""
    ca, cb = a.mean(0), b.mean(0)
    U, _, Vt = np.linalg.svd((a - ca).T @ (b - cb))
    R = Vt.T @ np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))]) @ U.T
    return R, cb - R @ ca


def walker_track(proc_dir, seg):
    """(n_xsens, 3) walker x, y, yaw per Xsens frame (NaN where no camera frame is within SYNC_MAX), and fit residuals."""
    P = pd.read_csv(proc_dir / "aligned_skeleton_3d.csv", index_col=0).to_numpy().reshape(-1, 23, 3)
    idx = pd.read_csv(proc_dir / "synchronized_data_idx.csv", index_col=0)["xsense_idx"].to_numpy()
    if len(P) != len(idx):
        raise ValueError(f"{len(P)} camera skeleton rows vs {len(idx)} index rows")
    X = seg.iloc[:, 1:70].to_numpy().reshape(-1, 23, 3)           # 23 body segments; the 24th is a prop tracker
    pose, res = np.full((len(X), 3), np.nan), []
    for f, xi in enumerate(idx):
        if xi >= len(X):
            continue
        R, t = kabsch(P[f], X[xi])
        r = np.linalg.norm(P[f] @ R.T + t - X[xi], axis=1).mean()
        res.append(r)
        if r < FIT_MAX_M:
            pose[xi] = [t[0], t[1], np.arctan2(-R[1, 2], -R[0, 2])]
    ok = np.flatnonzero(~np.isnan(pose[:, 0]))
    out = np.full_like(pose, np.nan)
    if len(ok):
        near = ok[np.clip(np.searchsorted(ok, np.arange(len(X))), 0, len(ok) - 1)]
        prev = ok[np.clip(np.searchsorted(ok, np.arange(len(X))) - 1, 0, len(ok) - 1)]
        near = np.where(np.abs(prev - np.arange(len(X))) < np.abs(near - np.arange(len(X))), prev, near)
        keep = np.abs(near - np.arange(len(X))) <= SYNC_MAX
        out[keep] = pose[near[keep]]
    return out, np.array(res)


def trial_samples(seg, com, wk):
    st = steps_of(seg)
    com_xy = com[["CoM x", "CoM y"]].to_numpy()
    head = seg[["Head x", "Head y", "Head z"]].to_numpy()       # what a headset tracks (gait personalization, persona.py)
    route = route_of(com_xy)
    rows, drop = [], {"same_side": 0, "edge": 0, "implausible": 0, "no_walker": 0}
    for i in range(2, len(st) - 2):            # first two and last steps: starting / stopping, not walking
        (s0, t0, h0, _), (s1, t1, h1, _) = st[i], st[i + 1]
        if s1 == s0 or st[i - 1][0] == s0 or st[i - 2][0] != s0:
            drop["same_side"] += 1
            continue
        heels = np.array([h0, st[i - 1][2], st[i - 2][2]])
        k = int(np.argmin(np.linalg.norm(route - heels[:2].mean(0), axis=1)))
        if k + 150 >= len(route):              # the last 2 m of `route` is a straight extension, not walked
            drop["edge"] += 1
            continue
        step = np.linalg.norm(h1 - h0)
        if not 0.05 < step < 1.0:              # detection glitch (merged / split stance)
            drop["implausible"] += 1
            continue
        if np.isnan(wk[t0, 0]) or np.isnan(wk[t1, 0]):
            drop["no_walker"] += 1
            continue
        rows.append({"heels": heels, "sides": np.array([s0, -s0, s0]), "action": route[[k + 25, k + 50, k + 100]],
                     "walker0": wk[t0], "heel1": h1, "walker1": wk[t1], "com": com_xy[t0], "dt": (t1 - t0) / FPS,
                     "route_k": k, "step": i, "head0": head[t0], "head1": head[t1]})
    return rows, drop, len(st), route


def main(ds, out):
    ds = Path(ds)
    recs, log, routes = [], [], {}
    for csvdir in sorted(ds.glob("raw/participant*/participant*_*/participant*/*_csv")):
        trial = csvdir.parent.name
        if csvdir.name != trial + "_csv":      # P02 left_0.3_corner1 holds a stray csv matching neither trial
            print("skip mislabelled", csvdir.relative_to(ds))
            continue
        pid, kind, speed, place = trial.split("_")
        proc = ds / "processed" / csvdir.parent.relative_to(ds / "raw")
        if not (proc / "aligned_skeleton_3d.csv").exists():
            print("no camera skeleton", trial)
            continue
        seg = pd.read_csv(csvdir / "Segment Position.csv", sep=";")
        com = pd.read_csv(csvdir / "Center of Mass.csv", sep=";")
        try:
            wk, res = walker_track(proc, seg)
        except (ValueError, pd.errors.EmptyDataError) as e:   # 2 trials ship truncated / empty camera files
            print("bad camera files", trial, e)
            continue
        rows, drop, n_steps, route = trial_samples(seg, com, wk)
        routes[trial] = route
        log.append({"trial": trial, "frames": len(seg), "camera_frames": len(res), "fit_res_median_m": round(float(np.median(res)), 4),
                    "fit_bad_frames": int((res >= FIT_MAX_M).sum()), "steps": n_steps, "samples": len(rows), **drop})
        recs += [{**r, "pid": int(pid[-2:]), "kind": kind, "speed": float(speed), "trial": trial} for r in rows]
    log = pd.DataFrame(log)
    log.to_csv(Path(out).with_suffix(".trials.csv"), index=False)
    A = lambda k: np.stack([r[k] for r in recs])
    np.savez_compressed(out, **{k: A(k) for k in ("heels", "sides", "action", "walker0", "heel1", "walker1", "com", "dt",
                                                    "route_k", "step", "pid", "kind", "speed", "trial", "head0", "head1")})
    np.savez_compressed(Path(out).with_suffix(".routes.npz"), **routes)
    print(f"{len(log)} trials, {log.steps.sum()} steps, {len(recs)} samples; camera fit median "
          f"{1000 * log.fit_res_median_m.median():.1f} mm, bad frames {log.fit_bad_frames.sum()} / {log.camera_frames.sum()}; dropped "
          f"{ {k: int(log[k].sum()) for k in ('same_side', 'edge', 'implausible', 'no_walker')} }")


if __name__ == "__main__":
    main(*sys.argv[1:])

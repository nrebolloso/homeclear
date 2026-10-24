"""Closed-loop pieces shared by train.py (which needs torch) and horizon.py (which does not): the participant split, the
hand-rule fit, route coordinates, and one closed-loop walk of a model along a held-out trial's route."""
import numpy as np

from .models import State, TripNoise, unit, left

SPLIT = {"train": list(range(10)), "val": [10, 11], "test": [12, 13]}


def state(z, i, walker=None):
    h = z["heels"][i]
    return State(h, h, z["sides"][i], h[:2].mean(0), np.zeros(2), z["walker0"][i] if walker is None else walker, np.full(8, 2.0))


def shift(w, d):
    """Walker point moved d metres along its heading (camera point <-> sim frame centre)."""
    w = np.array(w, float)
    w[..., :2] += d * np.stack([np.cos(w[..., 2]), np.sin(w[..., 2])], -1)
    return w


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


def frenet(route, p):
    """Points (n, 2) -> arc length along the route and signed lateral offset (left +)."""
    k = np.linalg.norm(route[None] - p[:, None], axis=2).argmin(1)
    t = route[np.minimum(k + 5, len(route) - 1)] - route[np.maximum(k - 5, 0)]
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    q = p - route[k]
    return k * 0.01, t[:, 0] * q[:, 1] - t[:, 1] * q[:, 0]


def walk(mod, z, route, i0, n_steps, d_shift, cfg, rng, rho=0.0):
    """One closed-loop walk from sample i0: the model's own heels fed back as history, steering at the route points ahead,
    until it reaches the last 2 m of the route (the straight extension) or n_steps. rho: within-trip step-noise
    persistence (models.TripNoise); 0 = independent draws, as train.py scores. Returns heels (n, 2), sides (n,), walker poses (n, 3)."""
    end = len(route) - 200
    s, k, H, S, P = state(z, i0, shift(z["walker0"][i0], d_shift)), 0, [], [], []
    noise = TripNoise(rho) if rho else None
    for _ in range(n_steps):
        k += int(np.argmin(np.linalg.norm(route[k:k + 120] - s.heels[:2].mean(0), axis=1)))
        if k >= end - 16:
            break
        a = route[[k + 25, k + 50, k + 100]]
        heel = mod.predict(s, a).sample(rng, z=noise.next(rng) if noise else None)
        pose = mod.walker_pose(s, heel, a, cfg["walker"], s.walker)
        H.append(heel); S.append(-s.sides[0]); P.append(pose)
        s = State(np.r_[[heel], s.heels[:2]], np.r_[[heel], s.heels[:2]], np.r_[-s.sides[0], s.sides[:2]],
                  (heel + s.heels[0]) / 2, np.zeros(2), pose, s.obstacle_dist)
    return np.array(H), np.array(S), np.array(P)

"""Learned world model (INTERFACE.md section 2): an MLP with two heads, trained on Multi-Gait-Posture (worldmodel/gait.py).

Inputs are only what the rollout engine has at every step, so training and simulation see the same quantities:
the last 3 heels and the route points 0.25 / 0.5 / 1.0 m ahead (the action). Everything is in a
local frame: origin = the stance heel, x = from the mid-heels toward the 0.25 m route point, y = left, mirrored when the
swing foot is the right one (one model for both feet). The previous walker pose is deliberately NOT an input: fed back in
closed loop it compounded its own errors on the synthetic kitchen's sharper A* bends (walker 4 m off, yaw flipping 180°,
WORLD_MODEL.md "Walker feedback"); without it the walker follows the feet and the route and cannot drift on its own.

heel head:   mixture of K Gaussians (diagonal in the local frame) over the next heel.
walker head: Gaussian over the walker pose when that heel lands (x, y, yaw in the local frame). In the data the walker
             point is the walker-mounted camera (recovered by fitting its skeleton to the Xsens one); the distance from the
             user to it belongs to that research walker, so the sim keeps its own walker geometry and takes from the model
             only the change around the training mean (`gap_shift`).
"""
import json
from pathlib import Path

import numpy as np

from .models import StepDist, left, unit

K = 5
D_IN = 10
# Components under this weight (about 1% of the mass in all) are wide "glitch" components that absorb the stance-detection
# errors in the training steps. Fine for a density, but drawn in a 400-step closed loop they place a heel 0.7 m backward and
# the history never recovers (WORLD_MODEL.md "Closed-loop stability"). The simulation drops them; one-step scores keep them.
MIN_W = 0.02
WEIGHTS = Path(__file__).with_name("weights") / "learned.npz"   # committed copy of train.py output (small MLP)


def frame(heels, sides, action):
    """Origin, x axis, mirror (+1 when the swing foot is left) for one state; heels (3, 2) newest first, action (3, 2)."""
    o = heels[0]
    t = unit(action[0] - (heels[0] + heels[1]) / 2)
    return o, t, -sides[0]


def to_local(p, o, t, mir):
    q = np.asarray(p, float) - o
    return np.stack([q @ t, mir * (q @ left(t))], -1)


def to_world(p, o, t, mir):
    p = np.asarray(p, float)
    return o + p[..., :1] * t + (mir * p[..., 1:]) * left(t)


def features(heels, sides, action):
    """(10,) model input for one state."""
    o, t, mir = frame(heels, sides, action)
    return np.concatenate([to_local(heels[1:], o, t, mir).ravel(), to_local(action, o, t, mir).ravel()]).astype(np.float32)


def targets(heels, sides, action, heel1, walker1):
    """(5,) next heel (local xy) + walker pose when it lands (local xy, yaw vs the frame x axis)."""
    o, t, mir = frame(heels, sides, action)
    d = np.array([np.cos(walker1[2]), np.sin(walker1[2])])
    return np.r_[to_local(heel1, o, t, mir), to_local(walker1[:2], o, t, mir), np.arctan2(mir * (d @ left(t)), d @ t)].astype(np.float32)


def mlp(W, x):
    """Numpy forward of the exported net (x normalised inside): returns log weights (K,), means (K, 2), log sds (K, 2),
    walker mean (3,), walker log sd (3,)."""
    h = (x - W["x_mean"]) / W["x_std"]
    n = sum(1 for k in W if k.startswith("W"))
    for i in range(n):
        h = h @ W[f"W{i}"].T + W[f"b{i}"]
        if i < n - 1:
            h = h / (1 + np.exp(-h))                       # SiLU
    o = h[:K * 5].reshape(K, 5)
    lw = o[:, 0] - np.logaddexp.reduce(o[:, 0])
    return lw, o[:, 1:3], np.clip(o[:, 3:5], -7, 2), h[K * 5:K * 5 + 3], np.clip(h[K * 5 + 3:], -7, 2)


class Learned:
    name = "learned"

    def __init__(self, cfg, path=WEIGHTS, min_w=MIN_W):
        self.min_w = min_w
        self.W = dict(np.load(path))
        meta = json.loads(str(self.W.pop("meta")))
        # sim walker centre = learned walker point moved this far along the walker heading (see module doc)
        self.shift = cfg["walker"]["user_gap_m"] + cfg["walker"]["depth_m"] / 2 - meta["mean_gap_m"]
        self.lo, self.hi = self.W.pop("x_min"), self.W.pop("x_max")
        self._last = None

    def _run(self, s, action):
        # the sim's own steps feed back as history: keep inputs inside the training range
        x = np.clip(features(s.heels, s.sides, np.asarray(action)), self.lo, self.hi)
        return mlp(self.W, x), frame(s.heels, s.sides, np.asarray(action))

    def predict(self, s, action):
        (lw, mu, ls, *_), (o, t, mir) = self._run(s, action)
        R = np.stack([t, mir * left(t)], 1)
        w = np.exp(lw.astype(float))
        k = w >= min(self.min_w, w.max())
        return StepDist(w[k] / w[k].sum(), to_world(mu[k], o, t, mir), np.exp(ls[k]), [R] * int(k.sum()))

    def walker_pose(self, s, heel, action, walker, prev=None):
        """Mean walker pose from the walker head (does not condition on the drawn heel)."""
        (*_, wm, _), (o, t, mir) = self._run(s, action)
        a = np.arctan2(t[1], t[0]) + mir * wm[2]
        c = to_world(wm[:2], o, t, mir) + self.shift * np.array([np.cos(a), np.sin(a)])
        return np.array([c[0], c[1], a])


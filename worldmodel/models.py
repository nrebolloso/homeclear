"""World model call (INTERFACE.md section 2): State + action -> StepDist over the next heel, plus the walker pose rule."""
from dataclasses import dataclass

import numpy as np


@dataclass
class State:
    heels: np.ndarray          # (3, 2) newest first
    toes: np.ndarray           # (3, 2)
    sides: np.ndarray          # (3,) +1 left / -1 right
    com: np.ndarray            # (2,)
    com_v: np.ndarray          # (2,)
    walker: np.ndarray         # (3,) x, y, yaw
    obstacle_dist: np.ndarray  # (8,) rays from the CoM at heading + k*45 deg, capped 2 m


def left(u):
    return np.array([-u[1], u[0]])


def unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


class StepDist:
    """Mixture of K Gaussians over the next heel (world xy). Component k has sd (along, across) in frame R[k] = [u, left(u)]."""

    def __init__(self, w, mean, sd, R):
        self.w, self.mu, self.sd, self.R = np.asarray(w, float), np.asarray(mean, float), np.asarray(sd, float), np.asarray(R, float)

    def mean(self):
        return self.w @ self.mu

    def sample(self, rng, n=None):
        k = rng.choice(len(self.w), size=n, p=self.w)
        z = rng.standard_normal((1 if n is None else n, 2)) * self.sd[k].reshape(-1, 2)
        x = self.mu[k].reshape(-1, 2) + np.einsum("nij,nj->ni", self.R[k].reshape(-1, 2, 2), z)
        return x[0] if n is None else x

    def logpdf(self, x):
        """x (2,) -> float, or (n, 2) -> (n,)."""
        x = np.asarray(x, float)
        z = np.einsum("kji,nkj->nki", self.R, x.reshape(-1, 1, 2) - self.mu) / self.sd   # R^T (x - mu)
        lp = np.log(np.sum(self.w * np.exp(-0.5 * (z ** 2).sum(2)) / (2 * np.pi * self.sd.prod(1)), 1) + 1e-300)
        return float(lp[0]) if x.ndim == 1 else lp


class Baseline:
    """Hand rule: the swing heel lands one step length L ahead of the gait midline, toward the 1 m route point, at +-W/2.
    Spread: stride_cv * L along, step_jitter_m across. K = 1."""
    name = "baseline"

    def __init__(self, persona, risk):
        self.L, self.W = persona["stride_m"], persona["foot_sep_m"]
        self.sd = np.array([persona["stride_cv"] * self.L, risk["step_jitter_m"]])

    def predict(self, s: State, action, stride_scale=1.0):
        h0, side0, target = s.heels[0], s.sides[0], np.asarray(action)[-1]
        u = unit(target - h0)
        m = h0 - side0 * self.W / 2 * left(u)          # gait midline beside the stance heel
        u = unit(target - m)
        mu = m + self.L * stride_scale * u - side0 * self.W / 2 * left(u)
        return StepDist([1.0], [mu], [self.sd * [stride_scale, 1]], [np.stack([u, left(u)], 1)])

    def walker_pose(self, s, heel, action, walker, prev=None):
        return walker_pose(s, heel, action, walker, prev)


def walker_pose(s: State, heel, action, walker, prev=None):
    """Geometric walker rule (baseline): the frame centre sits user_gap + depth/2
    ahead of the body (mid-heels), pointing at the 1 m route point; yaw eases 50% per step toward that direction."""
    com = (heel + s.heels[0]) / 2
    u = unit(np.asarray(action)[-1] - com)
    yaw = np.arctan2(u[1], u[0])
    if prev is not None:
        yaw = prev[2] + 0.5 * np.angle(np.exp(1j * (yaw - prev[2])))
    d = np.array([np.cos(yaw), np.sin(yaw)])
    c = com + (walker["user_gap_m"] + walker["depth_m"] / 2) * d
    return np.array([c[0], c[1], yaw])


def walker_legs(pose, walker):
    """(4, 2) leg positions: front-left, front-right (wheels), rear-left, rear-right (glides)."""
    d = np.array([np.cos(pose[2]), np.sin(pose[2])])
    a, b = walker["depth_m"] / 2, walker["width_m"] / 2 - walker["leg_radius_m"]
    return pose[:2] + np.array([a * d + b * left(d), a * d - b * left(d), -a * d + b * left(d), -a * d - b * left(d)])

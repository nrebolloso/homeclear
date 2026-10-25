"""How persistent is the step noise within a trip? Measured, so rollout.py's step_corr (TripNoise) is not a guess.

A model's one-step residual is turned into (along, across) z-scores in the frame of its most responsible mixture
component. If the model captured everything about the walker, consecutive z-scores would be independent (lag-1 = 0);
a walker who keeps landing long or wide shows up as a positive lag-1 correlation. The rollout feeds the model its own heels
as history, so the number that matters is the residual correlation AFTER the model has seen that history, which is what
this measures. Pairs are consecutive steps (`step` differs by `lag`) of the same trial; the interval is a bootstrap over
trials (steps of one trial are not independent).
"""
import numpy as np


def component_zscores(dist, y):
    """(2,) z-score (along, across) of y in the frame of the mixture component with the highest responsibility."""
    d = y - dist.mu                                           # (K, 2)
    z = np.einsum("kji,kj->ki", dist.R, d) / dist.sd          # R^T d / sd
    lp = np.log(dist.w) - 0.5 * (z ** 2).sum(1) - np.log(dist.sd.prod(1))
    return z[int(np.argmax(lp))]


def lag_pairs(trial, step, lag):
    """Index pairs (i, j) with the same trial and step[j] = step[i] + lag."""
    at = {(t, s): i for i, (t, s) in enumerate(zip(trial, step))}
    pairs = [(i, at[(t, s + lag)]) for i, (t, s) in enumerate(zip(trial, step)) if (t, s + lag) in at]
    return np.array(pairs, int).reshape(-1, 2)


def lag_corr(zs, trial, step, lag=1, boots=500, seed=0):
    """Per-axis Pearson correlation of z-scores `lag` steps apart, with a 90% trial-bootstrap interval."""
    zs, trial = np.asarray(zs, float), np.asarray(trial)
    pairs = lag_pairs(trial, step, lag)
    if len(pairs) < 10:
        return None
    pt = trial[pairs[:, 0]]
    names = list(dict.fromkeys(pt))
    by = {t: pairs[pt == t] for t in names}
    r = lambda P: [float(np.corrcoef(zs[P[:, 0], c], zs[P[:, 1], c])[0, 1]) for c in (0, 1)]
    rng, out = np.random.default_rng(seed), []
    for _ in range(boots):
        out.append(r(np.concatenate([by[names[k]] for k in rng.integers(0, len(names), len(names))])))
    lo, hi = np.percentile(out, [5, 95], axis=0)
    est = r(pairs)
    return {ax: {"rho": round(est[c], 3), "ci90": [round(float(lo[c]), 3), round(float(hi[c]), 3)]} for c, ax in enumerate(("along", "across"))} | \
           {"pairs": int(len(pairs)), "trials": len(names)}

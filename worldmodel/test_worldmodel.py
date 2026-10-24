"""Self-checks: python -m pytest worldmodel/test_worldmodel.py  (SYNTHETIC map only)."""
import tempfile

import numpy as np

from worldmodel.maps import Map, write_synthetic
from worldmodel.models import Baseline, State, StepDist
from worldmodel.rollout import load_cfg, plan_route, run

D = write_synthetic(tempfile.mkdtemp())


def test_map_ids_and_gap():
    m = Map(D)
    assert m.at(m.ids, np.array([2.0, 3.0])) == "bump:sink_mat"
    assert m.at(m.ids, np.array([3.5, 1.4])) == "obst:chair_W"
    assert 0.33 < m.at(m.free_dist, np.array([2.99, 1.4])) < 0.45     # the tight gap fits a 0.66 m walker, barely


def test_route_avoids_obstacles():
    cfg = load_cfg()
    m = Map(D)
    r = plan_route(m, [[1.0, -0.8], [2.99, 1.4], [2.05, 3.0]], cfg["walker"])
    assert (m.at(m.free_dist, r) > cfg["walker"]["width_m"] / 2 - 0.03).all()


def test_stepdist_moments_and_density():
    u = np.array([np.cos(0.7), np.sin(0.7)])
    d = StepDist([0.3, 0.7], [[0, 0], [1, 1]], [[0.1, 0.05], [0.2, 0.1]], [np.stack([u, [-u[1], u[0]]], 1)] * 2)
    x = d.sample(np.random.default_rng(0), 40000)
    assert np.allclose(x.mean(0), d.mean(), atol=0.01)
    g = np.mgrid[-1:2.5:0.01, -1:2.5:0.01].reshape(2, -1).T
    assert abs(np.exp([d.logpdf(p) for p in g[::7]]).sum() * 7e-4 - 1) < 0.02   # integrates to 1


def test_baseline_alternates_and_steers():
    cfg = load_cfg()
    b = Baseline(cfg["persona"], cfg["risk"])
    s = State(np.array([[0.1, 0], [-0.25, -0.2], [-0.6, 0]]), np.zeros((3, 2)), np.array([1, -1, 1]), np.zeros(2),
              np.array([0.4, 0]), np.zeros(3), np.full(8, 2.0))
    mu = b.predict(s, np.array([[0.25, 0], [0.5, 0], [1.0, -0.1]])).mean()
    assert mu[1] < 0 and 0.25 < mu[0] < 0.6                           # right foot next, ahead
    mu_l = b.predict(s, np.array([[0.25, 0.2], [0.5, 0.4], [0.7, 0.8]])).mean()
    assert mu_l[1] > mu[1] + 0.1                                       # route turning left pulls the step left


def test_rollout_and_remove_mat():
    s0, *_ = run(D, tempfile.mkdtemp(), "baseline", nights=10)
    s1, *_ = run(D, tempfile.mkdtemp(), "baseline", nights=10, remove=["bump:sink_mat"])
    assert s0["per_hazard_per_month"]["bump:sink_mat"]["swings_over"] > 0
    assert "bump:sink_mat" not in s1["per_hazard_per_month"]
    assert s0["sanity"]["final_feet_in_obstacle_pct"] == 0


def test_learned_features_mirror():
    from worldmodel.learned import features, targets
    rng = np.random.default_rng(1)
    h, a, h1, w1 = rng.normal(size=(3, 2)), rng.normal(size=(3, 2)), rng.normal(size=2), rng.normal(size=3)
    F = np.array([1, -1])                                              # mirror the world in y, swap the feet
    sd = np.array([1, -1, 1])
    assert np.allclose(features(h, sd, a), features(h * F, -sd, a * F), atol=1e-6)
    assert np.allclose(targets(h, sd, a, h1, w1), targets(h * F, -sd, a * F, h1 * F, w1 * [1, -1, -1]), atol=1e-5)


def test_kabsch_recovers_pose():
    from worldmodel.gait import kabsch
    c, s = np.cos(0.8), np.sin(0.8)
    R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    a = np.random.default_rng(2).normal(size=(23, 3))
    R2, t = kabsch(a, a @ R.T + [1, 2, 3])
    assert np.allclose(R2, R) and np.allclose(t, [1, 2, 3])


def test_learned_prunes_glitches_and_stays_stable():
    from worldmodel.learned import Learned
    cfg = load_cfg()
    L, s = Learned(cfg), State(np.array([[0.1, 0], [-0.25, -0.2], [-0.6, 0]]), np.zeros((3, 2)), np.array([1, -1, 1]),
                               np.zeros(2), np.array([0.4, 0]), np.zeros(3), np.full(8, 2.0))
    assert (L.predict(s, np.array([[0.25, 0], [0.5, 0], [1.0, 0]])).w >= 0.02).all()
    r, *_ = run(D, tempfile.mkdtemp(), "learned", nights=10)
    assert r["sanity"]["impossible_step_len_pct"] < 2 and r["sanity"]["final_feet_in_obstacle_pct"] < 0.1


def test_tripnoise_keeps_marginal_and_sets_lag1():
    from worldmodel.models import TripNoise
    rng = np.random.default_rng(3)
    for rho in (0.6, -0.4):
        n = TripNoise(rho)
        Z = np.array([n.next(rng) for _ in range(60000)])
        assert np.allclose(Z.mean(0), 0, atol=0.03) and np.allclose(Z.std(0), 1, atol=0.03)
        assert np.allclose([np.corrcoef(Z[:-1, c], Z[1:, c])[0, 1] for c in (0, 1)], rho, atol=0.03)
        assert abs(np.corrcoef(Z[:, 0], Z[:, 1])[0, 1]) < 0.03


def test_stepdist_given_z_is_deterministic_gaussian_draw():
    u = np.array([np.cos(0.7), np.sin(0.7)])
    R = np.stack([u, [-u[1], u[0]]], 1)
    d = StepDist([1.0], [[1.0, 2.0]], [[0.1, 0.05]], [R])
    x = d.sample(np.random.default_rng(0), z=[1.0, -2.0])
    assert np.allclose(x, [1.0, 2.0] + R @ [0.1 * 1.0, 0.05 * -2.0])


def test_step_corr_zero_changes_nothing_and_raises_persistence():
    def lag1(S):
        a, b = S[:-1, 10], S[1:, 10]
        same = (S[:-1, 1] == S[1:, 1]) & (S[:-1, 0] == S[1:, 0])        # same night and trip
        return np.corrcoef(a[same], b[same])[0, 1]
    out = []
    for c in (None, 0.0, 0.8):
        d = tempfile.mkdtemp()
        s, *_ = run(D, d, "baseline", nights=20, step_corr=c)
        out.append((np.load(f"{d}/rollout.npz")["steps"], s))
    assert np.array_equal(out[0][0], out[1][0])                          # 0 = the old independent draws, bit for bit
    assert out[2][1]["sanity"]["final_feet_in_obstacle_pct"] == 0 and out[2][1]["step_corr"] == 0.8
    assert lag1(out[2][0]) > lag1(out[1][0]) + 0.1


def test_trip_corr_recovers_rho_and_zscores():
    from worldmodel.models import TripNoise
    from worldmodel.trip_corr import component_zscores, lag_corr
    u = np.array([np.cos(0.7), np.sin(0.7)])
    R = np.stack([u, [-u[1], u[0]]], 1)
    d = StepDist([0.5, 0.5], [[0, 0], [3, 3]], [[0.1, 0.05], [0.1, 0.05]], [R, R])
    assert np.allclose(component_zscores(d, np.array([3, 3]) + R @ [0.2, -0.1]), [2.0, -2.0])   # nearer component, in its own frame
    rng, trial, step, z = np.random.default_rng(5), [], [], []
    for t in range(40):                                              # 40 trials x 60 steps of AR(1) noise
        n = TripNoise(0.5)
        for s in range(60):
            z.append(n.next(rng)); trial.append(f"t{t}"); step.append(s)
    r = lag_corr(np.array(z), trial, np.array(step), 1)
    assert r["pairs"] == 40 * 59 and r["trials"] == 40
    for ax in ("along", "across"):
        assert r[ax]["ci90"][0] < 0.5 < r[ax]["ci90"][1] and abs(r[ax]["rho"] - 0.5) < 0.08
    assert abs(lag_corr(np.array(z), trial, np.array(step), 2)["along"]["rho"] - 0.25) < 0.08       # rho^2 at lag 2

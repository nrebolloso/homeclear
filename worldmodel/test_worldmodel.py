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

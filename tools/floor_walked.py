"""Floor plane through the ground the capture walked on (config `floor.fit: walked`).

RANSAC takes the single biggest flat patch. On a large outdoor scene whose reconstruction is slightly tilted (night1: an
85 x 65 m plaza, 1.9 deg off), that patch is one end of the plaza and the far end floats 0.5-1.4 m below z=0, where stage 6
finds no floor. Here every camera votes the floor directly under it (the densest height band within `radius` of its foot,
well below the lens), and a plane is fitted through those votes, dropping outliers (steps, a planter beside the path)."""
import numpy as np
from scipy.spatial import cKDTree


def walked_plane(pts, centers, n, d, radius=1.0, min_drop=0.3, bin_m=0.02, iters=3):
    """(n, d) of the plane through the floor under each camera, starting from the plane n.x + d = 0 (n toward the cameras)."""
    for _ in range(iters):
        a = np.cross(n, [1.0, 0, 0] if abs(n[0]) < 0.9 else [0, 1.0, 0])
        a /= np.linalg.norm(a)
        uv = lambda x: np.c_[x @ a, x @ np.cross(n, a)]
        h, hc = pts @ n + d, centers @ n + d
        tree, votes = cKDTree(uv(pts)), []
        for c, top, near in zip(centers, hc, tree.query_ball_point(uv(centers), radius)):
            z = h[near]
            z = z[z < top - min_drop]
            if len(z) < 20:
                continue
            cnt, edges = np.histogram(z, bins=np.arange(z.min(), z.max() + 2 * bin_m, bin_m))
            votes.append(c - n * (top - edges[cnt.argmax()] - bin_m / 2))
        v = np.array(votes)
        keep = np.ones(len(v), bool)
        for _ in range(5):  # refit without votes far off the plane (a step down, the top of a planter)
            m = v[keep].mean(0)
            n2 = np.linalg.svd(v[keep] - m)[2][2]
            n2 = n2 if n2 @ n > 0 else -n2
            r = np.abs((v - m) @ n2)
            keep = r < max(3 * 1.4826 * np.median(r[keep]), bin_m)
        n, d = n2, -float(n2 @ m)
    return n, d

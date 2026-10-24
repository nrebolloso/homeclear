"""Depth and labels of the room shell (stage 5c shell.json) from a camera: what the Cosmos controls show where the
splat is empty. Floor plane z=0, ceiling plane, and each wall as a vertical rectangle (segment a-b, floor to ceiling).
numpy only (no GPU), so the laptop tests run it.  depth, label = shell_depth(w2c, K, W, H, shell)
label: 0 = nothing (sky through a window, or outside every wall), 1 = floor, 2 = wall, 3 = ceiling.
"""
import numpy as np

NONE, FLOOR, WALL, CEILING = 0, 1, 2, 3


def rays(w2c, K, W, H):
    """Camera centre and per-pixel unit-free ray directions (camera z = 1) in the floor frame."""
    w2c, K = np.asarray(w2c, float), np.asarray(K, float)
    R, t = w2c[:3, :3], w2c[:3, 3]
    eye = -R.T @ t
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    d = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1) @ R   # camera -> world (R^T applied per row)
    return eye, d


def shell_depth(w2c, K, W, H, shell):
    """z-depth (camera axis, metres; inf where nothing) and label per pixel."""
    eye, d = rays(w2c, K, W, H)
    depth = np.full((H, W), np.inf)
    label = np.zeros((H, W), np.uint8)

    def take(t, lab, ok):
        better = ok & (t > 1e-3) & (t < depth)
        depth[better] = t[better]
        label[better] = lab

    with np.errstate(divide="ignore", invalid="ignore"):
        for z, lab in ((0.0, FLOOR), (shell["ceiling_z"], CEILING)):
            t = (z - eye[2]) / d[..., 2]
            take(t, lab, np.isfinite(t))
        for wall in shell["walls"]:
            a, b = np.array(wall["a"], float), np.array(wall["b"], float)
            e = b - a
            n = np.array([-e[1], e[0]]) / (np.linalg.norm(e) + 1e-12)
            den = d[..., 0] * n[0] + d[..., 1] * n[1]
            t = ((a - eye[:2]) @ n) / den
            p = eye[None, None, :] + t[..., None] * d
            along = ((p[..., 0] - a[0]) * e[0] + (p[..., 1] - a[1]) * e[1]) / (e @ e)
            ok = np.isfinite(t) & (along >= 0) & (along <= 1) & (p[..., 2] >= 0) & (p[..., 2] <= shell["ceiling_z"])
            take(t, WALL, ok)
    # t is along a ray with camera-z component 1, so t is already the z-depth
    return depth, label


SEG_COLORS = {FLOOR: (0.55, 0.35, 0.15), WALL: (0.45, 0.45, 0.0), CEILING: (0.3, 0.3, 0.6)}


def load(path):
    """shell.json if the pipeline made one (stage 5c), else None: the renders then leave empty space empty, as before."""
    import json
    from pathlib import Path
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else None


def fill_empty(depth, seg, imagined, w2c, K, shell):
    """Where the splat rendered nothing (depth inf), put the shell's depth and class colour and mark it imagined.
    Returns (depth, seg, imagined, share of the frame filled). No shell: unchanged, 0."""
    if shell is None:
        return depth, seg, imagined, 0.0
    H, W = depth.shape
    sd, sl = shell_depth(w2c, K, W, H, shell)
    empty = ~np.isfinite(depth) & np.isfinite(sd)
    seg = seg.copy()
    for lab, col in SEG_COLORS.items():
        seg[empty & (sl == lab)] = col
    return np.where(empty, sd, depth), seg, imagined | empty, float(empty.mean())

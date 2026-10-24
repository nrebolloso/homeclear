"""Stage 12b: better fills for the floor (and wall) each movable object hid. Run after stage 12, on the laptop (CPU
backends) or on HiPerGator (lama). Writes viewer/public/scene/<run>/objects/fill_<name>_<backend>.ply + fills.json, and
points scene.json at the best fill made. Everything here is IMAGINED: the viewer tints it, nothing measures it.

  python stages/12b_fills.py <config.yaml> [--backends telea,ns,lama]

1. Orthographic image of the floor around the footprint (1 cm pixels, +0.4 m margin), drawn from the floor-band
   Gaussians of main.ply (the objects are already cut out): each one paints its DC colour over its footprint.
2. Mask = the footprint (+3 cm) and any pixel nothing painted. Inpaint with the backend:
     median  the old flat patch (stage 12), kept for comparison
     telea   cv2.inpaint TELEA: fast, CPU, smooth continuation of the floor's colours
     ns      cv2.inpaint Navier-Stokes: CPU, follows edges (board seams, tile lines) a little further
     lama    Big-LaMa (simple-lama-inpainting, GPU): continues texture, the best looking; only where installed
3. Every masked pixel becomes one flat Gaussian at z = 2 mm with the inpainted colour.
4. Tall objects (> 0.5 m) standing against a wall of the room shell (stage 5c) hid part of that wall too: the same, on
   the wall plane (along-wall x height image), from the Gaussians within 4 cm of it.
"""
import argparse, json, sys
from pathlib import Path
sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from common import read_ply, write_ply, ply_xyz, load_cfg, ROOT

import cv2
import numpy as np
from matplotlib.path import Path as Path2d

PX = 0.01            # 1 cm pixels
MARGIN = 0.4         # floor shown around the footprint, for the inpainting to continue
GROW = 0.03          # the footprint mask grows by this (blurry splat edges)
C0 = 0.28209479      # SH DC <-> RGB


def rgb_of(v):
    return np.clip(np.stack([v[f"f_dc_{k}"] for k in range(3)], 1) * C0 + 0.5, 0, 1)


def paint(uv, rgb, radius_px, shape):
    """Average colour of the Gaussians covering each pixel (a disc of radius_px each). uv in pixels. Returns img, hit."""
    H, W = shape
    acc, n = np.zeros((H, W, 3)), np.zeros((H, W))
    for r in np.unique(radius_px):
        sel = radius_px == r
        for du in range(-r, r + 1):
            for dv in range(-r, r + 1):
                if du * du + dv * dv > r * r:
                    continue
                x, y = uv[sel, 0] + du, uv[sel, 1] + dv
                ok = (x >= 0) & (y >= 0) & (x < W) & (y < H)
                np.add.at(acc, (y[ok], x[ok]), rgb[sel][ok])
                np.add.at(n, (y[ok], x[ok]), 1)
    hit = n > 0
    img = np.zeros((H, W, 3))
    img[hit] = acc[hit] / n[hit, None]
    return img, hit


def inpaint(img, mask, backend, ring):
    """img float RGB, mask bool (to fill). ring: pixels of real floor next to the hole, for the median backend."""
    u8 = (img * 255).astype(np.uint8)
    m8 = mask.astype(np.uint8) * 255
    if backend == "median":
        out = img.copy()
        out[mask] = np.median(img[ring], 0) if ring.any() else 0.5
        return out
    if backend in ("telea", "ns"):
        flag = cv2.INPAINT_TELEA if backend == "telea" else cv2.INPAINT_NS
        return cv2.inpaint(u8, m8, 15, flag).astype(np.float64) / 255
    if backend == "lama":
        from simple_lama_inpainting import SimpleLama   # GPU env on HiPerGator (requirements: simple-lama-inpainting)
        from PIL import Image
        res = SimpleLama()(Image.fromarray(u8), Image.fromarray(m8))
        return np.asarray(res.resize((img.shape[1], img.shape[0])), np.float64) / 255
    raise ValueError(f"unknown fill backend {backend}")


def gaussians(dtype, pts, rgb, normal_axis):
    """Flat 1 cm discs at pts (N,3), flat along normal_axis (0/1/2 in the floor frame), colour rgb (N,3)."""
    fv = np.zeros(len(pts), dtype)
    fv["x"], fv["y"], fv["z"] = pts.T
    dc = (rgb - 0.5) / C0
    for k in range(3):
        fv[f"f_dc_{k}"] = dc[:, k]
        fv[f"scale_{k}"] = np.log(0.001 if k == normal_axis else 0.007)
    fv["opacity"], fv["rot_0"] = 4.0, 1.0
    return fv


def floor_fill(v, xyz, floor_band, foot_world, backends):
    """Fills for the floor under one footprint (world polygon). Returns {backend: (pts, rgb)}, stats."""
    lo, hi = foot_world.min(0) - MARGIN, foot_world.max(0) + MARGIN
    W, H = int(np.ceil((hi[0] - lo[0]) / PX)), int(np.ceil((hi[1] - lo[1]) / PX))
    near = floor_band & (xyz[:, 0] >= lo[0]) & (xyz[:, 0] <= hi[0]) & (xyz[:, 1] >= lo[1]) & (xyz[:, 1] <= hi[1])
    uv = np.floor((xyz[near, :2] - lo) / PX).astype(int)
    r = np.clip(np.round(np.exp(np.max(np.stack([v["scale_0"][near], v["scale_1"][near]], 1), 1)) / PX), 0, 3).astype(int)
    img, hit = paint(uv, rgb_of(v[near]), r, (H, W))
    gx, gy = np.meshgrid(lo[0] + (np.arange(W) + 0.5) * PX, lo[1] + (np.arange(H) + 0.5) * PX)
    c = foot_world.mean(0)
    grown = c + (foot_world - c) * (1 + 2 * GROW / max(np.ptp(foot_world, 0).min(), 0.1))
    under = Path2d(grown).contains_points(np.stack([gx.ravel(), gy.ravel()], 1)).reshape(H, W)
    mask = under | ~hit
    ring = hit & ~under & (cv2.dilate(under.astype(np.uint8), np.ones((21, 21), np.uint8)) > 0)
    out = {}
    for b in backends:
        try:
            res = inpaint(img, mask, b, ring)
        except ImportError as e:
            print(f"  fill backend {b}: not installed here ({e.name}); skipped")
            continue
        pts = np.stack([gx[under], gy[under], np.full(under.sum(), 0.002)], 1)
        out[b] = (pts, res[under])
    return out, {"pixels": int(under.sum()), "seen_around_pct": round(100 * float(hit[~under].mean()), 1)}


def wall_fill(v, xyz, solid, wall, obj_world, height, backends):
    """Fills for the wall patch a tall object hid. wall: shell segment {a, b}. obj_world: footprint polygon."""
    a, b = np.array(wall["a"]), np.array(wall["b"])
    e = (b - a) / np.linalg.norm(b - a)
    n = np.array([-e[1], e[0]])
    s = (obj_world - a) @ e
    s0, s1 = s.min() - MARGIN, s.max() + MARGIN
    z1 = min(height + 0.1 + MARGIN, 2.3)
    W, H = int(np.ceil((s1 - s0) / PX)), int(np.ceil(z1 / PX))
    dist = (xyz[:, :2] - a) @ n
    along = (xyz[:, :2] - a) @ e
    near = solid & (np.abs(dist) < 0.04) & (along >= s0) & (along <= s1) & (xyz[:, 2] <= z1)
    uv = np.stack([np.floor((along[near] - s0) / PX), np.floor((z1 - xyz[near, 2]) / PX)], 1).astype(int)
    img, hit = paint(uv, rgb_of(v[near]), np.full(near.sum(), 1), (H, W))
    gs, gz = np.meshgrid(s0 + (np.arange(W) + 0.5) * PX, z1 - (np.arange(H) + 0.5) * PX)
    hidden = (gs >= s.min() - GROW) & (gs <= s.max() + GROW) & (gz <= height + GROW)
    mask = hidden | ~hit
    ring = hit & ~hidden & (cv2.dilate(hidden.astype(np.uint8), np.ones((21, 21), np.uint8)) > 0)
    out = {}
    side = np.sign(np.mean((obj_world - a) @ n)) or 1.0
    for bk in backends:
        try:
            res = inpaint(img, mask, bk, ring)
        except ImportError:
            continue
        xy = a + np.outer(gs[hidden], e) + side * 0.005 * n   # 5 mm in front of the wall, on the room side
        out[bk] = (np.column_stack([xy, gz[hidden]]), res[hidden])
    return out


def nearest_wall(shell, foot_world, max_d=0.15):
    """The shell wall a footprint side stands against (within max_d), or None."""
    best, bd = None, max_d
    for w in shell.get("walls", []) if shell else []:
        a, b = np.array(w["a"]), np.array(w["b"])
        e = b - a
        t = np.clip(((foot_world - a) @ e) / (e @ e), 0, 1)
        d = np.linalg.norm(foot_world - (a + t[:, None] * e), axis=1)
        k = np.argsort(d)[:2]                               # the two nearest corners: a side flush with the wall
        if d[k].max() < bd:
            best, bd = w, d[k].max()
    return best


def main(cfg_path, backends):
    cfg = load_cfg(cfg_path)
    w, g = cfg["work"], cfg["grid"]
    out = ROOT / "viewer" / "public" / "scene" / cfg["run_name"]
    sc = json.loads((out / "scene.json").read_text())
    v = read_ply(out / sc["splat"])
    xyz = ply_xyz(v)
    op = 1 / (1 + np.exp(-v["opacity"]))
    solid = op > g.get("min_opacity", 0.3)
    floor_band = solid & (np.abs(xyz[:, 2]) < g["floor_band_m"])
    shell = json.loads((w / "shell.json").read_text()) if (w / "shell.json").exists() else None
    report = {}
    for o in sc["objects"]:
        foot = np.array(o["footprint"]) + np.array(o["pivot"][:2])
        fills, stats = floor_fill(v, xyz, floor_band, foot, backends)
        wall = nearest_wall(shell, foot) if o["height_m"] > 0.5 else None
        walls = wall_fill(v, xyz, solid, wall, foot, o["height_m"], backends) if wall else {}
        o.setdefault("fills", {"median": o["fill"]})
        for b, (pts, rgb) in fills.items():
            parts = [gaussians(v.dtype, pts, rgb, 2)]
            if b in walls:
                wp, wr = walls[b]
                e = np.array(wall["b"]) - np.array(wall["a"])
                parts.append(gaussians(v.dtype, wp, wr, 1 if abs(e[0]) > abs(e[1]) else 0))   # flat across the wall
            fv = np.concatenate(parts)   # floor frame, like stage 12's patch: the viewer adds fills unmoved
            name = f"objects/fill_{o['name']}_{b}.ply"
            write_ply(out / name, fv)
            o["fills"][b] = name
        best = next((b for b in ("lama", "ns", "telea") if b in fills), None)
        if best:
            o["fill"] = o["fills"][best]
        report[o["name"]] = {**stats, "backends": sorted(o["fills"]), "wall_patch": bool(walls), "default": best or "median"}
    sc["fill_note"] = "imagined, not measured: floor and wall under/behind movable objects, inpainted (stage 12b)"
    (out / "scene.json").write_text(json.dumps(sc, indent=1))
    (out / "fills.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--backends", default="telea,ns")
    a = ap.parse_args()
    main(a.config, a.backends.split(","))

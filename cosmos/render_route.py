"""Splat -> Cosmos Transfer inputs along the planned walker route (gsplat + CUDA: runs in cosmos_splat.sbatch).
  python cosmos/render_route.py config.yaml        -> <work>/route/

Two 93-frame 1280x720 clips, each as RGB + depth + segmentation rendered from the splat:
  route_*        the route as captured (Cosmos: same geometry at 3 AM)
  route_moved_*  the piece of furniture nearest the route moved 0.6 m away from it; the floor it used to hide
                 was never filmed, so there depth comes from the fitted floor plane (z=0), seg says "floor", RGB is
                 black, and route_moved_mask.mp4 marks it as the area Cosmos has to imagine.
Depth: inverse depth, near = bright (the repo's robot_depth.mp4 convention). Seg: flat colour per object, objects =
connected components of the stage-6 obstacle layer, so the labels are splat geometry, not a segmentation model."""
import importlib, json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages")]
from common import run_stage, read_ply, ply_xyz, FFMPEG
sys.path.insert(0, str(ROOT / "cosmos"))
import shell_depth

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

N_FRAMES, W, H, F = 93, 1280, 720, 900.0   # Cosmos: 93 frames at 720p; F gives ~70 deg horizontal FOV
EYE_M, LOOK_AHEAD_M, MOVE_M = 1.2, 1.0, 0.6
NIGHT = ("The same room at 3 AM, lights off, lit only by a small warm nightlight near the floor; "
         "realistic home interior; camera moving slowly forward at walking pace.")
MOVED = "The same room in normal indoor lighting; realistic home interior, clear floor; camera moving slowly forward at walking pace."
FLOOR, RUG, OTHER = (0.55, 0.35, 0.15), (1.0, 0.55, 0.0), (0.45, 0.45, 0.0)


def route_views(xy):
    """Eye at EYE_M over the path, looking LOOK_AHEAD_M ahead and a little down; 93 views evenly spaced by distance."""
    look_at = importlib.import_module("09_fix_render").look_at
    xy = np.asarray(xy, float)
    d = xy[-1] - xy[-2]
    xy = np.vstack([xy, xy[-1] + 2 * LOOK_AHEAD_M * d / np.linalg.norm(d)])  # keep the last heading past the goal
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xy, axis=0), axis=1))]
    at = lambda u: np.array([np.interp(u, s, xy[:, 0]), np.interp(u, s, xy[:, 1])])
    L = s[-2]
    return [look_at(np.r_[at(u), EYE_M], np.r_[at(u + LOOK_AHEAD_M), EYE_M - 0.25]) for u in np.linspace(0, L, N_FRAMES)], L


def floor_depth(w2c):
    """z-depth of the z=0 floor plane per pixel (inf where the ray doesn't hit it)."""
    R, eye = w2c[:3, :3].T, -w2c[:3, :3].T @ w2c[:3, 3]
    u, v = np.meshgrid((np.arange(W) + 0.5 - W / 2) / F, (np.arange(H) + 0.5 - H / 2) / F)
    dz = (np.stack([u, v, np.ones_like(u)], -1) @ R.T)[..., 2]  # world z of each camera ray (camera z = 1)
    with np.errstate(divide="ignore"):
        t = -eye[2] / dz
    return np.where(dz < -1e-6, t, np.inf)


def write_mp4(path, frames):
    p = subprocess.Popen([FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "16",
                          "-i", "-", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f, np.uint8).tobytes())
    p.stdin.close()
    assert p.wait() == 0, path


def main(cfg):
    import torch
    from gsplat import rasterization
    w, g = cfg["work"], cfg["grid"]
    out = w / "route"
    out.mkdir(exist_ok=True)
    v = read_ply(w / "splat_aligned.ply")
    path = json.loads((w / "path.json").read_text())
    grid = json.loads((w / "grid.json").read_text())
    obst, bumps = np.load(w / "obstacles.npy"), np.load(w / "bumps.npy")

    # --- per-Gaussian labels from the occupancy grid
    xyz, z, N = ply_xyz(v), ply_xyz(v)[:, 2], len(v)
    ij = np.floor((xyz[:, :2] - grid["origin_xy"]) / grid["cell_m"]).astype(int)
    inside = (ij >= 0).all(1) & (ij < obst.shape).all(1)
    at_cell = lambda a: np.where(inside, a[tuple(np.clip(ij, 0, np.array(obst.shape) - 1).T)], 0)
    lab, n = ndimage.label(obst)
    comp = np.where((z >= g["obstacle_z"][0]) & (z <= g["obstacle_z"][1]), at_cell(lab), 0)
    palette = np.random.default_rng(0).uniform(0.1, 1.0, (n + 1, 3))
    seg = np.where(comp[:, None] > 0, palette[comp], OTHER)
    seg[(np.abs(z) < g["bump_z"][0]) & (comp == 0)] = FLOOR
    seg[(z >= g["bump_z"][0]) & (z < g["bump_z"][1]) & at_cell(bumps).astype(bool)] = RUG

    # --- the furniture to move: nearest obstacle component to the route that is object-sized (not a wall)
    cell = grid["cell_m"]
    areas = ndimage.sum(obst, lab, range(1, n + 1)) * cell ** 2
    tree = cKDTree(np.array(path["cells"]))
    cand = [(tree.query(np.argwhere(lab == k))[0].min(), k) for k in range(1, n + 1) if 0.05 <= areas[k - 1] <= 1.5]
    assert cand, "no object-sized obstacle near the route to move"
    dist_cells, k = min(cand)
    cells_k = np.argwhere(lab == k)
    centre = cells_k.mean(0)
    near = np.array(path["cells"])[tree.query(centre)[1]]
    away = (centre - near) / max(np.linalg.norm(centre - near), 1e-6)
    foot = ndimage.binary_dilation(lab == k, iterations=2)
    sel = inside & at_cell(foot).astype(bool) & (z > g["bump_z"][0]) & (z < g["obstacle_z"][1] + 0.5)
    offset = np.r_[MOVE_M * away, 0.0]

    # --- splat tensors (same layout as stage 9)
    t = lambda a: torch.tensor(np.ascontiguousarray(a), dtype=torch.float32, device="cuda")
    K_rest = len([p for p in v.dtype.names if p.startswith("f_rest_")]) // 3
    sh = np.concatenate([np.stack([v[f"f_dc_{i}"] for i in range(3)], 1)[:, None],
                         np.stack([v[f"f_rest_{i}"] for i in range(3 * K_rest)], 1).reshape(N, 3, K_rest).transpose(0, 2, 1)], 1)
    G = dict(quats=t(np.stack([v[f"rot_{i}"] for i in range(4)], 1)), scales=torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))),
             opacities=torch.sigmoid(t(v["opacity"])))
    means, sh, seg = t(xyz), t(sh), t(seg)
    moved = means.clone()
    moved[torch.from_numpy(sel).cuda()] += t(offset)
    Kmat = t([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])[None]
    sel_t = torch.from_numpy(sel).cuda()

    def render(mu, colors, sh_degree, view, only=None):
        m = slice(None) if only is None else only
        img, alpha, _ = rasterization(mu[m], G["quats"][m], G["scales"][m], G["opacities"][m], colors[m], t(view)[None], Kmat, W, H,
                                      sh_degree=sh_degree, render_mode="RGB+ED")
        return img[0, ..., :3].clamp(0, 1).cpu().numpy(), img[0, ..., 3].cpu().numpy(), alpha[0, ..., 0].cpu().numpy()

    views, L = route_views(path["xy"])
    deg = int(np.sqrt(K_rest + 1)) - 1
    V = {k: [] for k in ("rgb", "depth", "seg", "moved_rgb", "moved_depth", "moved_seg", "moved_mask")}
    cover, imagined = [], []
    shell = shell_depth.load(w / "shell.json")   # stage 5c: where the capture saw nothing, the walls continue
    with torch.no_grad():
        for view in views:
            rgb, d, a = render(means, sh, deg, view)
            s_img = render(means, seg, None, view)[0]
            mrgb, md, ma = render(moved, sh, deg, view)
            ms_img = render(moved, seg, None, view)[0]
            old_obj, new_obj = render(means, seg, None, view, sel_t)[2], render(moved, seg, None, view, sel_t)[2]
            mask = ((old_obj > 0.3) & (new_obj < 0.3)) | (ma < 0.5)    # space the camera never saw in the moved scene
            fd = floor_depth(view)
            hit = mask & np.isfinite(fd)
            md, ms_img, mrgb = np.where(hit, fd, md), np.where(hit[..., None], FLOOR, ms_img), np.where(mask[..., None], 0, mrgb)
            ma = np.where(hit, 1.0, ma)
            cover.append(float((a > 0.5).mean()))
            imagined.append(float(mask.mean()))
            u8 = lambda x: (x * 255).astype(np.uint8)
            V["rgb"].append(u8(rgb)); V["seg"].append(u8(s_img)); V["moved_rgb"].append(u8(mrgb)); V["moved_seg"].append(u8(ms_img))
            d0, s0, _, _ = shell_depth.fill_empty(np.where(a > 0.1, d, np.inf), V["seg"][-1] / 255.0, np.zeros(d.shape, bool), view, Kmat[0].cpu().numpy(), shell)
            V["seg"][-1] = (s0 * 255).astype(np.uint8)
            V["depth"].append(d0.astype(np.float32))
            md0, ms0, mm0, _ = shell_depth.fill_empty(np.where(ma > 0.1, md, np.inf), V["moved_seg"][-1] / 255.0, mask, view, Kmat[0].cpu().numpy(), shell)
            V["moved_seg"][-1] = (ms0 * 255).astype(np.uint8)
            V["moved_depth"].append(md0.astype(np.float32))
            V["moved_mask"].append(np.repeat(u8(mm0)[..., None], 3, -1))   # shell-filled space is imagined too

    disp = 1 / np.maximum(np.stack(V["depth"]), 0.1)                     # inf -> 0 = black, like the far end of the scale
    lo, hi = np.percentile(disp[disp > 0], [2, 98])
    to_gray = lambda d: np.repeat((255 * np.clip((1 / np.maximum(d, 0.1) - lo) / (hi - lo), 0, 1)).astype(np.uint8)[..., None], 3, -1)
    for name in ("depth", "moved_depth"):
        V[name] = [to_gray(d) for d in V[name]]
    for name, frames in V.items():
        write_mp4(out / f"route_{name}.mp4", frames)
    sheet = np.concatenate([np.concatenate([V[name][i] for i in (0, 46, 92)], 1) for name in V], 0)
    import cv2
    cv2.imwrite(str(out / "route_preview.jpg"), cv2.cvtColor(cv2.resize(sheet, None, fx=0.25, fy=0.25), cv2.COLOR_RGB2BGR))

    spec = lambda name, prompt, pre: {"name": name, "prompt": prompt, "video_path": str(out / f"route_{pre}rgb.mp4"), "guidance": 3,
                                      "depth": {"control_path": str(out / f"route_{pre}depth.mp4"), "control_weight": 1.0},
                                      "seg": {"control_path": str(out / f"route_{pre}seg.mp4"), "control_weight": 1.0}}
    (out / "route_night_spec.json").write_text(json.dumps(spec("route_night", NIGHT, ""), indent=1))
    (out / "route_moved_spec.json").write_text(json.dumps(spec("route_moved", MOVED, "moved_"), indent=1))
    m = {"route_length_m": round(L, 2), "frames": N_FRAMES, "splat_coverage_pct": round(100 * np.mean(cover), 1),
         "moved_object": {"component": int(k), "area_m2": round(float(areas[k - 1]), 2), "gaussians": int(sel.sum()),
                          "dist_to_route_m": round(float(dist_cells) * cell, 2), "offset_m": np.round(offset, 2).tolist()},
         "imagined_pct_moved": round(100 * np.mean(imagined), 1), "out": str(out)}
    return m["splat_coverage_pct"] > 60 and sel.sum() > 0, m


if __name__ == "__main__":
    run_stage("route_render", main)

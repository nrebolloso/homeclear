"""Walker-game export -> Cosmos Transfer controls (gsplat + CUDA: runs in slurm/cosmos_job.sbatch).
  python cosmos/render_controls.py viewer/public/exports/<job>      -> <job>/controls/

Reads cosmos_job.json (camera path, object transforms, prompt) and the scene it was made from
(viewer/public/scene/<run>/), and renders along the path at 1280x720:
  rgb      the splat with the exported layout (moved objects transformed, removed ones dropped, fill patches where
           furniture used to stand)
  depth    inverse depth, near = bright (same convention as render_route.py)
  seg      flat colour per class (floor, structure, low floor object, each object kind, walker)
  edge     Canny on the composited RGB
  mask     white where the content is imagined: fill patches (never filmed) - tint.py colours it magenta
The walker is composited by depth from the browser's walker/%06d.png frames (depth mm in RGB).
Hazard highlights are NEVER drawn into any of these: Cosmos would render them as real objects. Markers are overlays only.
The depth + seg here are exactly what the splat-rendered controls in the pitch need.
"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos")]
from common import read_ply, ply_xyz, transform_ply
from render_route import write_mp4, W, H
import shell_depth

import cv2
import numpy as np

SEG = {"floor": (0.55, 0.35, 0.15), "structure": (0.45, 0.45, 0.0), "floor_object": (1.0, 0.55, 0.0),
       "bed": (0.2, 0.4, 1.0), "nightstand": (0.6, 0.2, 0.8), "rug": (1.0, 0.55, 0.0), "nightlight": (1.0, 1.0, 0.3),
       "other": (0.1, 0.8, 0.6), "walker": (0.9, 0.9, 0.9)}
FLOOR_BAND_M, LOW_OBJECT_M = 0.015, 0.05


def project(w2c, K, pts):
    """OpenCV pinhole: floor-frame points (N,3) -> pixels (N,2), NaN behind the camera. The viewer's projectCV."""
    x = (np.asarray(w2c)[:3, :3] @ np.asarray(pts, float).T + np.asarray(w2c)[:3, 3:4])
    uv = (np.asarray(K) @ x)[:2] / np.where(x[2] > 1e-6, x[2], np.nan)
    return uv.T


def walker_depth(path):
    """walker/%06d.png -> metres (inf where there's no walker)."""
    rgb = cv2.cvtColor(cv2.imread(str(path), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.int64)
    mm = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    return np.where(mm > 0, mm / 1000.0, np.inf)


def assemble(job, scene_dir):
    """The exported layout as one splat + per-Gaussian seg colour + imagined flag."""
    sc = json.loads((scene_dir / "scene.json").read_text())
    main = read_ply(scene_dir / sc["splat"])
    z = ply_xyz(main)[:, 2]
    cls = np.where(z < FLOOR_BAND_M, "floor", np.where(z < LOW_OBJECT_M, "floor_object", "structure"))
    parts, seg, imag = [main], [np.array([SEG[c] for c in cls])], [np.zeros(len(main), bool)]
    by_name = {o["name"]: o for o in job["objects"]}
    for o in sc["objects"]:
        j = by_name[o["name"]]
        moved = j["removed"] or np.hypot(j["x"] - o["pivot"][0], j["y"] - o["pivot"][1]) > 0.01 or abs(j["yaw_deg"]) > 0.5
        if not j["removed"]:
            yaw = np.radians(j["yaw_deg"])
            R = np.array([[np.cos(yaw), -np.sin(yaw), 0], [np.sin(yaw), np.cos(yaw), 0], [0, 0, 1]])
            v = transform_ply(read_ply(scene_dir / o["splat"]), 1.0, R, np.array([j["x"], j["y"], 0.0]))
            parts.append(v); seg.append(np.tile(SEG.get(o["kind"], SEG["other"]), (len(v), 1))); imag.append(np.zeros(len(v), bool))
        if moved:   # the floor it covered was never filmed: placeholder patch, flagged imagined
            f = read_ply(scene_dir / o["fill"])
            parts.append(f); seg.append(np.tile(SEG["floor"], (len(f), 1))); imag.append(np.ones(len(f), bool))
    names = parts[0].dtype.names
    v = np.concatenate([p[[n for n in names]] if p.dtype.names == names else _like(p, parts[0].dtype) for p in parts])
    return v, np.concatenate(seg), np.concatenate(imag)


def _like(p, dtype):
    """Same Gaussians in another PLY layout (fills have no f_rest): missing fields are zero."""
    out = np.zeros(len(p), dtype)
    for n in dtype.names:
        if n in p.dtype.names:
            out[n] = p[n]
    return out


def main(job_dir):
    import torch
    from gsplat import rasterization
    job_dir = Path(job_dir)
    job = json.loads((job_dir / "cosmos_job.json").read_text())
    assert (job["width"], job["height"]) == (W, H), "render_route.write_mp4 is fixed at 1280x720"
    scene_dir = ROOT / "viewer" / "public" / "scene" / job["scene"]
    out = job_dir / "controls"
    out.mkdir(exist_ok=True)
    v, seg, imag = assemble(job, scene_dir)
    N = len(v)
    t = lambda a: torch.tensor(np.ascontiguousarray(a), dtype=torch.float32, device="cuda")
    K_rest = len([p for p in v.dtype.names if p.startswith("f_rest_")]) // 3
    dc = np.stack([v[f"f_dc_{i}"] for i in range(3)], 1)[:, None]
    sh = np.concatenate([dc, np.stack([v[f"f_rest_{i}"] for i in range(3 * K_rest)], 1).reshape(N, 3, K_rest).transpose(0, 2, 1)], 1) if K_rest else dc
    deg = int(np.sqrt(K_rest + 1)) - 1
    means, quats = t(ply_xyz(v)), t(np.stack([v[f"rot_{i}"] for i in range(4)], 1))
    scales, opac = torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))), torch.sigmoid(t(v["opacity"]))
    sh, seg_t, imag_t = t(sh), t(seg), t(np.repeat(imag[:, None].astype(np.float32), 3, 1))
    Kmat = t(job["K"])[None]

    def render(colors, sh_degree, view):
        img, alpha, _ = rasterization(means, quats, scales, opac, colors, t(view)[None], Kmat, W, H,
                                      sh_degree=sh_degree, render_mode="RGB+ED")
        return img[0, ..., :3].clamp(0, 1).cpu().numpy(), img[0, ..., 3].cpu().numpy(), alpha[0, ..., 0].cpu().numpy()

    V = {k: [] for k in ("rgb", "depth", "seg", "edge", "mask")}
    walker_px, shell_px = [], []
    shell = shell_depth.load(scene_dir / "shell.json")   # stage 5c: walls/ceiling where the capture saw nothing
    with torch.no_grad():
        for k, view in enumerate(job["cameras"]):
            rgb, d, a = render(sh, deg, view)
            s_img = render(seg_t, None, view)[0]
            m_img = render(imag_t, None, view)[0][..., 0] > 0.5
            d = np.where(a > 0.1, d, np.inf)   # MCMC floor is opacity 0.1-0.3 (same cut as stage 5): 0.5 left holes Cosmos drew as snow
            # never-filmed space gets the room shell's depth + a wall/ceiling label, not a void (Cosmos drew rock and sky there)
            d, s_img, m_img, f = shell_depth.fill_empty(d, s_img, m_img, view, job["K"], shell)
            shell_px.append(f)
            wd = walker_depth(job_dir / (job["walker"]["depth_frames"] % k))
            front = wd < d                                            # walker in front of the scene
            d, rgb, s_img, m_img = np.where(front, wd, d), np.where(front[..., None], 0.72, rgb), np.where(front[..., None], SEG["walker"], s_img), m_img & ~front
            walker_px.append(float(front.mean()))
            u8 = lambda x: (np.clip(x, 0, 1) * 255).astype(np.uint8)
            rgb8 = u8(rgb)
            V["rgb"].append(rgb8); V["seg"].append(u8(s_img)); V["depth"].append(d.astype(np.float32))
            V["edge"].append(np.repeat(cv2.Canny(cv2.cvtColor(rgb8, cv2.COLOR_RGB2GRAY), 100, 200)[..., None], 3, -1))
            V["mask"].append(np.repeat(u8(m_img.astype(float))[..., None], 3, -1))
    disp = 1 / np.maximum(np.stack(V["depth"]), 0.1)
    lo, hi = np.percentile(disp[disp > 0], [2, 98])
    V["depth"] = [np.repeat((255 * np.clip((1 / np.maximum(d, 0.1) - lo) / (hi - lo), 0, 1)).astype(np.uint8)[..., None], 3, -1) for d in V["depth"]]
    write_mp4(out / "mask.mp4", V["mask"])      # every frame, for tint.py after stitching
    specs = []
    for c, (a, b) in enumerate(job["chunks"]):
        name = f"{job['job']}_c{c:02d}"
        for k in ("rgb", "depth", "seg", "edge"):
            write_mp4(out / f"{name}_{k}.mp4", V[k][a:b])
        spec = {"name": name, "prompt": job["prompt"], "video_path": str(out / f"{name}_rgb.mp4"), "guidance": 3,
                **{k: {"control_path": str(out / f"{name}_{k}.mp4"), "control_weight": 1.0} for k in ("depth", "seg", "edge")}}
        (out / f"{name}_spec.json").write_text(json.dumps(spec, indent=1))
        specs.append(str(out / f"{name}_spec.json"))
    sheet = np.concatenate([np.concatenate([V[k][i] for i in (0, len(V["rgb"]) // 2, job["route_frames"] - 1)], 1) for k in V], 0)
    cv2.imwrite(str(out / "preview.jpg"), cv2.cvtColor(cv2.resize(sheet, None, fx=0.25, fy=0.25), cv2.COLOR_RGB2BGR))
    m = {"gaussians": N, "imagined_gaussians": int(imag.sum()), "frames": len(V["rgb"]), "chunks": len(specs),
         "walker_pixels_pct": round(100 * float(np.mean(walker_px)), 2), "shell_pixels_pct": round(100 * float(np.mean(shell_px)), 2),
         "specs": specs}
    (out / "render_controls.json").write_text(json.dumps(m, indent=1))
    print(json.dumps(m, indent=1))
    assert m["walker_pixels_pct"] > 0.5, "walker never visible: walker depth frames don't line up with the camera path"
    return specs


if __name__ == "__main__":
    main(sys.argv[1])

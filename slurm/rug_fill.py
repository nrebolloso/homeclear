"""Imagined floor under a rug: top-down orthographic render of the splat around the rug (gsplat), Qwen-Image-Edit-2511
removes the rug, the edit is colour-matched to the render on the floor ring around the rug and painted onto flat
Gaussians covering the cut-out (stage 12's fill points, resampled at 5 mm). IMAGINED, NOT MEASURED: nothing reads the
fill's colours for a measurement, and the viewer keeps its tint.
  python slurm/rug_fill.py <splat_aligned.ply> <fill_<rug>.ply (stage 12)> <out dir> [seeds=0,1]
    -> <out>/fill_s<seed>.ply, render.png, edit_s<seed>.png, composite_s<seed>.png
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, write_ply, ply_xyz

C0 = 0.28209479177387814   # SH degree-0 constant: colour = 0.5 + C0 * f_dc
PX, MARGIN, PITCH = 1024, 0.35, 0.005   # image size, floor shown around the rug (m), fill Gaussian spacing (m)
PROMPT = ("Remove the rug from the floor. Show the bare floor that was under it: the same floor as around it, continuing "
          "the plank lines, seams and grain, with the same lighting. Change nothing else. Top-down photo.")


def render_top(v, lo, m_per_px):
    """Orthographic view straight down at the floor; image x = +x, image y = -y (north up)."""
    from gsplat import rasterization
    t = lambda a: torch.tensor(np.ascontiguousarray(a), dtype=torch.float32, device="cuda")
    n, k = len(v), len([p for p in v.dtype.names if p.startswith("f_rest_")]) // 3
    sh = np.concatenate([np.stack([v[f"f_dc_{i}"] for i in range(3)], 1)[:, None],
                         np.stack([v[f"f_rest_{i}"] for i in range(3 * k)], 1).reshape(n, 3, k).transpose(0, 2, 1)], 1)
    eye = np.array([lo[0], lo[1] + PX * m_per_px, 3.0])   # top-left corner of the image, 3 m up
    w2c = np.eye(4); w2c[:3, :3] = np.diag([1.0, -1.0, -1.0]); w2c[:3, 3] = -w2c[:3, :3] @ eye
    f = 1 / m_per_px
    with torch.no_grad():
        img, _, _ = rasterization(t(ply_xyz(v)), t(np.stack([v[f"rot_{i}"] for i in range(4)], 1)),
                                  torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))), torch.sigmoid(t(v["opacity"])),
                                  t(sh), t(w2c)[None], t([[f, 0, 0], [0, f, 0], [0, 0, 1]])[None], PX, PX,
                                  sh_degree=int(np.sqrt(k + 1)) - 1, camera_model="ortho")
    return (img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)


def main():
    splat, fill_in, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    seeds = [int(s) for s in (sys.argv[4] if len(sys.argv) > 4 else "0,1").split(",")]
    out.mkdir(parents=True, exist_ok=True)
    fxy = ply_xyz(read_ply(fill_in))[:, :2]
    lo, hi = fxy.min(0) - MARGIN, fxy.max(0) + MARGIN
    m_per_px = float((hi - lo).max()) / PX
    to_px = lambda xy: np.stack([(xy[:, 0] - lo[0]) / m_per_px, (lo[1] + PX * m_per_px - xy[:, 1]) / m_per_px], 1)
    mask = np.zeros((PX, PX), np.uint8)   # the cut-out: stage 12's 2 cm fill points, each covering its cell
    for x, y in to_px(fxy).astype(int):
        cv2.circle(mask, (int(x), int(y)), int(np.ceil(0.012 / m_per_px)), 255, -1)
    ring = (cv2.dilate(mask, np.ones((121, 121), np.uint8)) > 0) & ~(cv2.dilate(mask, np.ones((21, 21), np.uint8)) > 0)
    render = render_top(read_ply(splat), lo, m_per_px)
    Image.fromarray(render).save(out / "render.png")

    from diffusers import QwenImageEditPlusPipeline   # same call as Deja View's genfill/models.py
    pipe = QwenImageEditPlusPipeline.from_pretrained("Qwen/Qwen-Image-Edit-2511", torch_dtype=torch.bfloat16, device_map="cuda")
    pipe.set_progress_bar_config(disable=True)
    # new Gaussians on a 5 mm grid inside the cut-out
    gx, gy = np.meshgrid(np.arange(lo[0], hi[0], PITCH), np.arange(lo[1], hi[1], PITCH), indexing="ij")
    g = np.stack([gx.ravel(), gy.ravel()], 1)
    gp = np.clip(to_px(g).round().astype(int), 0, PX - 1)
    g, gp = g[mask[gp[:, 1], gp[:, 0]] > 0], gp[mask[gp[:, 1], gp[:, 0]] > 0]
    for s in seeds:
        with torch.inference_mode():
            ed = pipe(image=Image.fromarray(render), prompt=PROMPT, negative_prompt=" ", true_cfg_scale=4.0, guidance_scale=1.0,
                      num_inference_steps=40, width=PX, height=PX, generator=torch.Generator("cpu").manual_seed(s)).images[0]
        ed = np.asarray(ed.convert("RGB").resize((PX, PX), Image.LANCZOS)).astype(np.float32)
        Image.fromarray(ed.astype(np.uint8)).save(out / f"edit_s{s}.png")
        r = render.astype(np.float32)   # the editor drifts in colour: match its floor ring to the render's, per channel
        drift = np.abs(ed[ring].mean(0) - r[ring].mean(0)).max()
        ed = (ed - ed[ring].mean(0)) / (ed[ring].std(0) + 1e-6) * r[ring].std(0) + r[ring].mean(0)
        a = cv2.GaussianBlur((mask > 0).astype(np.float32), (0, 0), 3)[..., None]
        comp = np.clip(a * ed + (1 - a) * r, 0, 255)
        Image.fromarray(comp.astype(np.uint8)).save(out / f"composite_s{s}.png")
        rgb = np.clip(ed[gp[:, 1], gp[:, 0]], 0, 255) / 255
        fv = np.zeros(len(g), read_ply(fill_in).dtype)
        fv["x"], fv["y"], fv["z"] = g[:, 0], g[:, 1], 0.002
        for k in range(3):
            fv[f"f_dc_{k}"] = (rgb[:, k] - 0.5) / C0
            fv[f"scale_{k}"] = np.log(0.6 * PITCH if k < 2 else 0.001)
        fv["opacity"], fv["rot_0"] = 4.0, 1.0
        write_ply(out / f"fill_s{s}.ply", fv)
        print(f"seed {s}: {len(fv)} imagined floor Gaussians, editor colour drift on the ring {drift:.1f}/255 (corrected)")


if __name__ == "__main__":
    main()

"""Stage 3: train a 3DGS splat with gsplat (short run), PSNR on held-out frames, export splat.ply (COLMAP frame)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage

import numpy as np


def main(cfg):
    import cv2, pycolmap, torch
    from gsplat import rasterization, export_splats
    from gsplat.strategy import DefaultStrategy
    from scipy.spatial import cKDTree
    sc, w, dev = cfg["splat"], cfg["work"], "cuda"
    torch.manual_seed(0)
    cams = json.loads((w / "cameras.json").read_text())
    rec = pycolmap.Reconstruction(str(w / "colmap" / "best"))
    pts = np.array([p.xyz for p in rec.points3D.values()])
    rgb = np.array([p.color for p in rec.points3D.values()]) / 255.0

    imgs = torch.stack([torch.from_numpy(cv2.imread(str(w / "images" / c["name"]))[..., ::-1].copy()) for c in cams]).to(dev)
    H, W = imgs.shape[1:3]
    viewmats = torch.tensor([c["w2c"] for c in cams], dtype=torch.float32, device=dev)
    Ks = torch.tensor([c["K"] for c in cams], dtype=torch.float32, device=dev)
    test = np.arange(0, len(cams), sc["test_every"])
    train = np.setdiff1d(np.arange(len(cams)), test)

    centers = torch.linalg.inv(viewmats)[:, :3, 3]
    scene_scale = 1.1 * (centers - centers.mean(0)).norm(dim=1).max().item()
    d = cKDTree(pts).query(pts, k=4)[0][:, 1:].mean(1)
    N = len(pts)
    t = lambda a: torch.tensor(a, dtype=torch.float32, device=dev)
    params = torch.nn.ParameterDict({
        "means": torch.nn.Parameter(t(pts)),
        "scales": torch.nn.Parameter(t(np.log(np.maximum(d, 1e-7)))[:, None].repeat(1, 3)),
        "quats": torch.nn.Parameter(torch.nn.functional.normalize(torch.randn(N, 4, device=dev), dim=-1)),
        "opacities": torch.nn.Parameter(torch.logit(torch.full((N,), 0.1, device=dev))),
        "sh0": torch.nn.Parameter(t((rgb - 0.5) / 0.28209479177387814)[:, None]),
        "shN": torch.nn.Parameter(torch.zeros(N, 15, 3, device=dev)),
    })
    # learning rates from gsplat examples/simple_trainer.py
    lrs = {"means": 1.6e-4 * scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
    opts = {k: torch.optim.Adam([{"params": params[k], "lr": lr, "name": k}], eps=1e-15) for k, lr in lrs.items()}
    sched = torch.optim.lr_scheduler.ExponentialLR(opts["means"], gamma=0.01 ** (1 / sc["steps"]))
    strategy = DefaultStrategy(verbose=False)
    strategy.check_sanity(params, opts)
    state = strategy.initialize_state(scene_scale=scene_scale)

    def render(idx, sh_degree):
        out, _, info = rasterization(params["means"], params["quats"], torch.exp(params["scales"]),
                                     torch.sigmoid(params["opacities"]), torch.cat([params["sh0"], params["shN"]], 1),
                                     viewmats[idx], Ks[idx], W, H, sh_degree=sh_degree, packed=False)
        return out, info

    for step in range(sc["steps"]):
        i = int(np.random.choice(train))
        out, info = render([i], min(step // 1000, 3))
        loss = (out[0] - imgs[i].float() / 255).abs().mean()  # shortcut: L1 only (no SSIM term), fine for a smoke test
        strategy.step_pre_backward(params, opts, state, step, info)
        loss.backward()
        for o in opts.values():
            o.step()
            o.zero_grad(set_to_none=True)
        sched.step()
        strategy.step_post_backward(params, opts, state, step, info, packed=False)
        if step % 1000 == 0:
            print(f"step {step} loss {loss.item():.4f} n={len(params['means'])}", flush=True)

    psnrs = []
    with torch.no_grad():
        for i in test:
            out, _ = render([int(i)], 3)
            mse = ((out[0].clamp(0, 1) - imgs[i].float() / 255) ** 2).mean()
            psnrs.append((-10 * torch.log10(mse)).item())
        out, _ = render([int(test[0])], 3)
        side = torch.cat([imgs[test[0]].float() / 255, out[0].clamp(0, 1)], 1)
        cv2.imwrite(str(w / "splat_heldout_gt_vs_render.jpg"), (side.cpu().numpy()[..., ::-1] * 255).astype(np.uint8))
        export_splats(params["means"], params["scales"], params["quats"], params["opacities"], params["sh0"],
                      params["shN"], save_to=str(w / "splat.ply"))
    m = {"gaussians": len(params["means"]), "steps": sc["steps"], "train_views": len(train), "heldout_views": len(test),
         "psnr_heldout": round(float(np.mean(psnrs)), 2), "image_size": f"{W}x{H}"}
    return m["psnr_heldout"] >= sc["min_psnr"], m


if __name__ == "__main__":
    run_stage("03_splat", main)

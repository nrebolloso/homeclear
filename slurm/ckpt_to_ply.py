"""gsplat checkpoint -> standard 3DGS PLY with gsplat's own export_splats (simple_trainer_2dgs.py saves only ckpts).
  python ckpt_to_ply.py <ckpt.pt> <out.ply>"""
import sys
import torch
from gsplat import export_splats

s = torch.load(sys.argv[1], map_location="cpu", weights_only=True)["splats"]
export_splats(means=s["means"], scales=s["scales"], quats=s["quats"], opacities=s["opacities"], sh0=s["sh0"], shN=s["shN"],
              format="ply", save_to=sys.argv[2])
print(len(s["means"]), "Gaussians ->", sys.argv[2])

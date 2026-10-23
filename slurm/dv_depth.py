"""Depth Anything V2 relative disparity for every training image, as Deja View's "depth term when rebuilding a place".
Images come through gsplat's own Dataset, so they are undistorted exactly as the trainer sees them.
usage (from third_party/gsplat/examples, PYTHONPATH=.): python dv_depth.py <data_dir> <out_dir>   -> <out_dir>/<stem>.npy (float16, HxW)
"""
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import pipeline

from datasets.colmap import Dataset, Parser

data, out = sys.argv[1], Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
p = Parser(data_dir=data, factor=1, normalize=True, test_every=8)
est = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Large-hf", device=0, torch_dtype=torch.float16)
n = 0
for split in ("train", "val"):
    ds = Dataset(p, split=split)
    for item in range(len(ds)):
        name = Path(p.image_names[ds.indices[item]]).stem
        if (out / f"{name}.npy").exists():
            continue
        img = ds._load_image(item)   # undistorted + cropped, as the trainer sees it
        d = est(Image.fromarray(img))["predicted_depth"]   # relative disparity: larger = closer
        d = F.interpolate(d.float().reshape(1, 1, *d.shape[-2:]), size=img.shape[:2], mode="bilinear", align_corners=False)[0, 0]
        np.save(out / f"{name}.npy", d.cpu().numpy().astype(np.float16))
        n += 1
print(f"depth maps written: {n}, total {len(list(out.glob('*.npy')))}")

"""Capture cameras in gsplat simple_trainer's normalised world (normalize_world_space=True, the frame its PLY is in)
-> our cameras.json (OpenCV w2c, K at data_factor 4 unless given). Run from gsplat/examples:  python gsplat_cameras.py <data_dir> <out.json> [factor]"""
import json, sys
from pathlib import Path
import numpy as np
from datasets.colmap import Parser

f = int(sys.argv[3]) if len(sys.argv) > 3 else 4   # 4: room photos are 3114 px; phone frames need 1
if f > 1 and not (Path(sys.argv[1]) / f"images_{f}").is_dir():   # phone-frame datasets only have images/ (trained at data_factor 1)
    f = 1
p = Parser(data_dir=sys.argv[1], factor=f,
           normalize=True, test_every=8)
cams = []
for name, c2w, cid in zip(p.image_names, p.camtoworlds, p.camera_ids):
    w, h = p.imsize_dict[cid]
    cams.append({"name": name, "K": p.Ks_dict[cid].tolist(), "w2c": np.linalg.inv(c2w).tolist(), "width": int(w), "height": int(h)})
json.dump(cams, open(sys.argv[2], "w"))
print(len(cams), "cameras; transform", p.transform.tolist())

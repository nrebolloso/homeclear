"""Deregister frames whose camera sits far outside the capture (GLOMAP put 1-3 kitchen frames metres away; gsplat sizes
its scene from the camera spread, so one stray camera blew kitchen1's scene_scale from 2.2 to 12 and the splat never fit).
  python slurm/drop_far_cams.py <model dir> [<out dir>, default: in place]   -> prints what it dropped
"""
import os, sys

import numpy as np
import pycolmap

src = sys.argv[1]
rec = pycolmap.Reconstruction(src)
ims = [i for i in rec.images.values() if i.has_pose]
c = np.array([i.projection_center() for i in ims])
d = np.linalg.norm(c - np.median(c, 0), axis=1)
far = d > 3 * np.percentile(d, 90)   # the filmed path is compact; a real camera is never 3x the p90 radius out
assert far.mean() < 0.05, f"{far.sum()} of {len(ims)} cameras flagged: not a few strays, check the model"
for i in np.flatnonzero(far):
    rec.deregister_frame(ims[i].frame_id)   # one camera per frame here
out = sys.argv[2] if len(sys.argv) > 2 else src
os.makedirs(out, exist_ok=True)   # pycolmap writes into an existing dir only
rec.write(out)
print(f"dropped {far.sum()} far cameras: {[ims[i].name for i in np.flatnonzero(far)]}; p90 radius {np.percentile(d, 90):.2f}")

"""Deregister blocks of frames that SfM placed at a fixed offset from the rest of the walk (repeated furniture matched to the
wrong copy: gator_lounge put 4 stretches 1.2 units off and back, so the trash cans showed up twice in the splat).
Frames are a continuous take in filename order, so the camera cannot teleport: a jump out followed by the opposite jump back
brackets a mis-placed block, and the longer side (the rest of the walk) is kept.
  python slurm/drop_jump_blocks.py <model dir> <out dir>   -> prints the blocks it dropped
"""
import os, sys

import numpy as np


def blocks(c, jump=8.0, back=0.3, max_frac=0.15):
    """c: (n, 3) camera centres in time order -> [(start, end)] index ranges (end exclusive) to drop."""
    d = np.diff(c, axis=0)
    n = np.linalg.norm(d, axis=1)
    J = [i for i in range(len(n)) if n[i] > jump * np.median(n)]
    out, k = [], 0
    while k < len(J):
        i = J[k]
        # the first later jump that undoes this one (within `back` of its length) closes the block
        m = next((m for m in range(k + 1, len(J)) if np.linalg.norm(d[i] + d[J[m]]) < back * n[i]), None)
        if m is not None and J[m] - i <= max_frac * len(c):
            out.append((i + 1, J[m] + 1))
            k = m + 1
        else:
            k += 1
    return out


def _selfcheck():
    t = np.linspace(0, 1, 200)[:, None] * [4, 0, 0]
    t[50:70] += [1, 0.5, 0]   # one block off and back
    t[120] += [1, 0.5, 0]     # one stray frame
    assert blocks(t) == [(50, 70), (120, 121)], blocks(t)
    assert blocks(np.linspace(0, 1, 200)[:, None] * [4, 0, 0]) == []


if __name__ == "__main__":
    _selfcheck()
    import pycolmap
    rec = pycolmap.Reconstruction(sys.argv[1])
    ims = sorted((i for i in rec.images.values() if i.has_pose), key=lambda i: i.name)
    c = np.array([i.projection_center() for i in ims])
    bad = blocks(c)
    for s, e in bad:
        for i in ims[s:e]:
            rec.deregister_frame(i.frame_id)   # one camera per frame here
        print(f"dropped {ims[s].name}..{ims[e - 1].name} ({e - s} frames)")
    os.makedirs(sys.argv[2], exist_ok=True)   # pycolmap writes into an existing dir only
    rec.write(sys.argv[2])
    print(f"kept {len(ims) - sum(e - s for s, e in bad)} of {len(ims)}")

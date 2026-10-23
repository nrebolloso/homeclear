"""gsplat simple_trainer with a monocular depth SHAPE term (the idea Deja View uses for rooms: rendered inverse depth must
correlate, tile by tile, with a Depth Anything V2 estimate; scale and shift free per tile, so the mono depth's unknown
scale never enters). gsplat's --depth_loss is reused as the hook: each image's sparse COLMAP points are replaced by a
regular pixel grid (every STRIDE px) carrying the mono disparity, and depth_l1_loss is swapped for the tile correlation.
(An absolute disparity fit of the mono map to the COLMAP points blows up to NaN at step 600.)
usage (from third_party/gsplat/examples): MONO_DEPTH_DIR=<dv_depth.py maps> python dv_train.py <simple_trainer args> --depth_loss --depth_lambda 0.1
"""
import os, runpy, sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.getcwd())   # examples/: simple_trainer imports datasets.* from there
import gsplat.losses
from datasets import colmap

DEPTH_DIR, STRIDE, TILE = Path(os.environ.get("MONO_DEPTH_DIR", ".")), 4, 16
GRID = None   # (rows, cols) of the sample grid; every image of a run has the same size (one camera)


def patch_pearson(a, b, valid, tile=TILE):
    """1 - mean Pearson correlation of a and b ([h, w]) over tile x tile blocks that are at least half valid."""
    h, w = a.shape[0] // tile * tile, a.shape[1] // tile * tile
    A, B, M = (F.unfold(x[None, None, :h, :w].float(), tile, stride=tile)[0] for x in (a, b, valid))
    n = M.sum(0); keep = n > 0.5 * tile * tile
    if not bool(keep.any()):
        return a.sum() * 0
    A, B, M, n = A[:, keep], B[:, keep], M[:, keep], n[keep]
    da, db = (A - (A * M).sum(0) / n) * M, (B - (B * M).sum(0) / n) * M
    return (1 - (da * db).sum(0) / torch.sqrt((da * da).sum(0) * (db * db).sum(0) + 1e-12)).mean()


def shape_loss(pred_depth, gt_disp, scene_scale=1.0):
    """Stands in for gsplat's depth_l1_loss: pred_depth = rendered depth at the grid, gt_disp = mono disparity there."""
    p, g = pred_depth.reshape(GRID), gt_disp.reshape(GRID)
    ok = p > 1e-3   # nothing rendered there yet
    return patch_pearson(torch.where(ok, 1 / p.clamp_min(0.05), 0), g, ok)


def getitem(self, item):
    d = _orig(self, item)
    if not self.load_depths:
        return d
    disp = np.load(DEPTH_DIR / f"{Path(self.parser.image_names[self.indices[item]]).stem}.npy").astype(np.float32)
    H, W = d["image"].shape[:2]
    assert disp.shape == (H, W) and (H // STRIDE, W // STRIDE) == GRID, (disp.shape, (H, W), GRID)
    g = disp[: GRID[0] * STRIDE, : GRID[1] * STRIDE].reshape(GRID[0], STRIDE, GRID[1], STRIDE).mean((1, 3))
    v, u = np.mgrid[: GRID[0], : GRID[1]] * STRIDE + (STRIDE - 1) / 2   # cell centres, pixel coords
    d["points"] = torch.from_numpy(np.c_[u.ravel(), v.ravel()].astype(np.float32))
    d["depths"] = torch.from_numpy(g.ravel())
    return d


_orig = colmap.Dataset.__getitem__

if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        a = torch.rand(64, 64); ok = torch.ones(64, 64, dtype=torch.bool)
        assert patch_pearson(a, 3 * a + 2, ok) < 1e-5 and abs(patch_pearson(a, -a, ok) - 2) < 1e-5
        GRID = (64, 64); assert shape_loss(1 / (a + 0.5), 7 * (a + 0.5)) < 1e-5   # depth vs any-scale disparity
        print("selftest OK"); sys.exit()
    GRID = tuple(s // STRIDE for s in np.load(next(DEPTH_DIR.glob("*.npy")), mmap_mode="r").shape)
    colmap.Dataset.__getitem__ = getitem
    gsplat.losses.depth_l1_loss = shape_loss   # simple_trainer does `from gsplat.losses import depth_l1_loss` at run time
    sys.argv = ["simple_trainer.py"] + sys.argv[1:]
    runpy.run_path(os.path.join(os.getcwd(), "simple_trainer.py"), run_name="__main__")

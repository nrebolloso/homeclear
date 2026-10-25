"""Apply lighter_clean's crop/air/camera-path/carve rules to an already exported viewer scene, in place, without rebuilding it (hand fixes,
object splits and fills stay as they are). Trims main.ply; object splats (shifted back by
its pivot) get the crop only: the air rule ate solid furniture (aleroom bed kept 5%).
  python tools/lighter_trim.py <config.yaml> viewer/public/scene/<run>_lighter
Keeps each input once as <name>.untrimmed (not a .ply, so nothing loads it); running again starts from those.
"""
import json, shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, write_ply, ply_xyz
from tools.lighter_clean import crop_air_drop
from tools.freespace import camera_path, carve, solid
from scipy.spatial import cKDTree
import numpy as np
import yaml


def surfaces(dst, f, pivot):
    """Floor-frame solid Gaussians of one untrimmed (or not yet trimmed) splat."""
    src = dst / (f + ".untrimmed")
    v = read_ply(src if src.exists() else dst / f)
    p = ply_xyz(v); p[:, :2] += pivot
    return p[solid(v)]


def main():
    cfg, dst = yaml.safe_load(open(sys.argv[1])), Path(sys.argv[2])
    sc = json.loads((dst / "scene.json").read_text())
    files = [("main.ply", (0, 0))] + [(o["splat"], o["pivot"][:2]) for o in sc["objects"]]
    for f, pivot in files:
        src = dst / (f + ".untrimmed")
        if not src.exists():
            shutil.copy2(dst / f, src)
        v = read_ply(src)
        p = ply_xyz(v); p[:, :2] += pivot   # object splats are stored relative to their pivot
        drop = crop_air_drop(v, p, cfg["clean"] if f == "main.ply" else {**cfg["clean"], "lighter_air": None, "lighter_support": None}, sc["grid"])
        if f == "main.ply" and cfg["clean"].get("lighter_camera_clear_m"):   # same camera-path rule as lighter_clean
            drop |= cKDTree(camera_path(Path(cfg["work_dir"]))).query(p)[0] < cfg["clean"]["lighter_camera_clear_m"]
        if f == "main.ply" and cfg["clean"].get("lighter_carve") is not None:   # surfaces include the objects cut out of main
            drop |= carve(Path(cfg["work_dir"]), p, np.vstack([surfaces(dst, g, pv) for g, pv in files]), **cfg["clean"]["lighter_carve"])
        write_ply(dst / f, v[~drop])
        print(f"{dst / f}: kept {int((~drop).sum())} of {len(v)} Gaussians")

if __name__ == "__main__":
    main()

"""Apply lighter_clean's crop/air rules to an already exported viewer scene, in place, without rebuilding it (hand fixes,
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
import yaml


def main():
    cfg, dst = yaml.safe_load(open(sys.argv[1])), Path(sys.argv[2])
    sc = json.loads((dst / "scene.json").read_text())
    for f, pivot in [("main.ply", (0, 0))] + [(o["splat"], o["pivot"][:2]) for o in sc["objects"]]:
        src = dst / (f + ".untrimmed")
        if not src.exists():
            shutil.copy2(dst / f, src)
        v = read_ply(src)
        p = ply_xyz(v); p[:, :2] += pivot   # object splats are stored relative to their pivot
        drop = crop_air_drop(v, p, cfg["clean"] if f == "main.ply" else {**cfg["clean"], "lighter_air": None}, sc["grid"])
        write_ply(dst / f, v[~drop])
        print(f"{dst / f}: kept {int((~drop).sum())} of {len(v)} Gaussians")

if __name__ == "__main__":
    main()

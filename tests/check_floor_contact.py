"""Walker floor contact on a real splat: local splat floor height under each leg at poses along the recorded walk.
The walker is drawn with its feet at z = 0; this measures how far the splat's floor surface is from that.
  python tests/check_floor_contact.py viewer/public/scene/<scene> proof/.../walk.frames.json"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, ply_xyz, solid_mask
import numpy as np
from scipy.spatial import cKDTree

scene, frames = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())
v = read_ply(scene / "main.ply")
p = ply_xyz(v)[solid_mask(v, min_opacity=0.1)]
p = p[np.abs(p[:, 2]) < 0.10]                       # the floor band (bumps up to 5 cm, rugs included)
tree = cKDTree(p[:, :2])
legs = np.array(json.loads((scene / "walker.json").read_text())["legs"])
rows = []
for t in np.arange(0.5, frames[-1]["t"], 0.5):
    f = min(frames, key=lambda r: abs(r["t"] - t))
    c, s = np.cos(f["yaw"]), np.sin(f["yaw"])
    for lx, ly in legs:
        xy = (f["x"] + c * lx - s * ly, f["y"] + s * lx + c * ly)
        idx = tree.query_ball_point(xy, 0.05)
        rows.append((round(t, 1), *np.round(xy, 2), len(idx), float(np.median(p[idx, 2])) if len(idx) >= 5 else np.nan))
z = np.array([r[4] for r in rows])
for r in rows:
    print(f"t={r[0]:>4}s leg at ({r[1]:+.2f}, {r[2]:+.2f})  n={r[3]:>4}  splat floor z = {r[4] * 100:+.2f} cm")
ok = z[~np.isnan(z)]
print(json.dumps({"legs_measured": int(len(ok)), "legs_unmeasured": int(np.isnan(z).sum()),
                  "median_cm": round(100 * float(np.median(ok)), 2), "max_abs_cm": round(100 * float(np.abs(ok).max()), 2),
                  "p90_abs_cm": round(100 * float(np.percentile(np.abs(ok), 90)), 2)}))

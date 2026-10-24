"""Cosmos-imagined floor where a movable object stood, as Gaussians you can walk around (B200; cosmos/slurm/cosmos_fill.sbatch).

  python cosmos/fill_object.py render <scene> <object>   orbit around the object's spot with it removed: rgb (hole
                                                         black), depth (fill + shell), seg, edge, mask -> Transfer spec
  (Cosmos Transfer runs on the spec: run_infer in the sbatch)
  python cosmos/fill_object.py lift <scene> <object> <cosmos.mp4>
                                                         paste Cosmos's pixels into the hole only (colour-matched to
                                                         the real frame around it); each hole Gaussian takes the median
                                                         of the pixels it lands on across the orbit (CPU)
                                                         -> viewer/public/scene/<scene>/objects/fill_<object>_cosmos.ply

Starts from the stage 12b fill (flat Gaussians on the floor under the object); only their colours change. Imagined,
tinted in the viewer, never measured; scene.json gets fills.cosmos for the viewer's fill selector.
"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos"), str(ROOT / "stages")]

import numpy as np

N, W, H, F = 93, 1280, 720, 900.0
RADIUS, EYE = 1.7, 1.3
PROMPT = ("The same room in soft daylight, the floor where furniture used to stand is bare and continuous with the floor "
          "around it; realistic home interior; camera circling slowly.")


def composite(render, cosmos, mask, ring_px=25):
    """Real frame outside the mask, Cosmos inside; Cosmos's colours shifted so a ring just outside the hole matches the
    real frame there (Cosmos repaints with its own exposure), and a soft edge. Arrays HxWx3 float 0-1, mask HxW bool."""
    import cv2
    m8 = mask.astype(np.uint8)
    ring = (cv2.dilate(m8, np.ones((2 * ring_px + 1,) * 2, np.uint8)) > 0) & ~mask
    out = cosmos.astype(np.float64).copy()
    if ring.any():
        for c in range(3):
            a, b = cosmos[..., c][ring], render[..., c][ring]
            gain = np.clip(b.std() / max(a.std(), 1e-3), 0.5, 2.0)   # match exposure, keep most of the texture
            out[..., c] = (out[..., c] - a.mean()) * gain + b.mean()
    soft = cv2.GaussianBlur(m8.astype(np.float32), (0, 0), 3)[..., None]
    soft = np.maximum(soft, m8[..., None].astype(np.float32))   # fully Cosmos inside, blended only at the edge
    return np.clip(render * (1 - soft) + out * soft, 0, 1)


def free_floor(sc, d, skip, clear_m=0.25):
    """free(x, y): open floor at least clear_m from walls and from the other objects (at their exported poses)."""
    from scipy import ndimage
    g = sc["grid"]
    nx, ny = g["shape"]
    floor = np.fromfile(d / g["floor"], np.uint8).reshape(nx, ny) > 0
    blocked = ~floor | (np.fromfile(d / g["obstacles"], np.uint8).reshape(nx, ny) > 0)
    import cv2
    stamp = np.zeros((ny, nx), np.uint8)   # cv2 wants (row = j, col = i)
    for o in sc["objects"]:
        if o["name"] != skip and o.get("layer") == "obstacle":
            poly = (np.array(o["footprint"]) + o["pivot"][:2] - g["origin_xy"]) / g["cell_m"]
            cv2.fillPoly(stamp, [poly.astype(np.int32)], 1)
    clear = ndimage.distance_transform_edt(~(blocked | (stamp.T > 0))) * g["cell_m"]
    def free(x, y):
        i, j = int((x - g["origin_xy"][0]) / g["cell_m"]), int((y - g["origin_xy"][1]) / g["cell_m"])
        return 0 <= i < nx and 0 <= j < ny and clear[i, j] >= clear_m
    return free


def orbit(center, free, n=N, max_arc=np.radians(240)):
    """Cameras circling the spot at eye height, looking at it, on the longest arc where every eye stands on open floor
    (a fixed half circle put the end of the orbit behind a wall). One radius for the whole arc, as large as fits."""
    look_at = __import__("importlib").import_module("09_fix_render").look_at
    cand = np.linspace(0, 2 * np.pi, 360, endpoint=False)
    for r in np.arange(RADIUS, 0.85, -0.1):
        ok = np.array([free(center[0] + r * np.cos(a), center[1] + r * np.sin(a)) for a in cand])
        if not ok.any():
            continue
        if ok.all():
            a0, a1 = 0.0, max_arc
        else:   # longest circular run of free angles
            k0 = int(np.argmin(ok))
            run, best, cur = np.roll(ok, -k0), (0, 0), 0
            for k, v in enumerate(run):
                cur = cur + 1 if v else 0
                if cur > best[1]:
                    best = (k - cur + 1, cur)
            a0 = cand[(best[0] + k0) % 360]
            a1 = a0 + min(best[1] - 1, 359) * 2 * np.pi / 360
        if a1 - a0 >= np.radians(90):
            a1 = min(a1, a0 + max_arc)
            break
    else:
        raise RuntimeError("no open floor around the spot for an orbit")
    out = []
    for a in np.linspace(a0, a1, n):
        eye = np.array([center[0] + r * np.cos(a), center[1] + r * np.sin(a), EYE])
        out.append(look_at(eye, np.array([center[0], center[1], 0.0])))
    return out


def _gs(v):
    import torch
    t = lambda x: torch.tensor(np.ascontiguousarray(x), dtype=torch.float32, device="cuda")
    from common import ply_xyz
    return dict(means=t(ply_xyz(v)), quats=t(np.stack([v[f"rot_{i}"] for i in range(4)], 1)),
                scales=torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))), opacities=torch.sigmoid(t(v["opacity"])),
                dc=t(np.stack([v[f"f_dc_{k}"] for k in range(3)], 1)))


def render_phase(scene, name):
    import torch, cv2
    from gsplat import rasterization
    from common import read_ply
    from render_route import write_mp4
    import shell_depth
    d = ROOT / "viewer" / "public" / "scene" / scene
    sc = json.loads((d / "scene.json").read_text())
    o = next(x for x in sc["objects"] if x["name"] == name)
    main, fill = read_ply(d / sc["splat"]), read_ply(d / o["fill"])
    names = main.dtype.names
    fz = np.zeros(len(fill), main.dtype)
    for n in names:
        if n in fill.dtype.names:
            fz[n] = fill[n]
    both = np.concatenate([main, fz])
    G = _gs(both)
    rgb_c = torch.clamp(G["dc"] * 0.28209479 + 0.5, 0, 1)
    K = torch.tensor([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]], dtype=torch.float32, device="cuda")[None]
    shell = shell_depth.load(d / "shell.json")
    out = d / "cosmos_fill" / name
    out.mkdir(parents=True, exist_ok=True)
    V = {k: [] for k in ("rgb", "depth", "seg", "edge", "mask")}
    cams = orbit(o["pivot"], free_floor(sc, d, name))
    Kn = K[0].cpu().numpy()
    foot = np.array(o["footprint"]) * (1 + 0.03 / np.maximum(np.abs(np.array(o["footprint"])).max(0), 1e-3)) + o["pivot"][:2]   # +3 cm, as the fill
    for w2c in cams:
        with torch.no_grad():
            img, alpha, _ = rasterization(G["means"], G["quats"], G["scales"], G["opacities"], rgb_c, torch.tensor(w2c, dtype=torch.float32, device="cuda")[None],
                                          K, W, H, render_mode="RGB+ED")
        rgb, dep, a = img[0, ..., :3].cpu().numpy(), img[0, ..., 3].cpu().numpy(), alpha[0, ..., 0].cpu().numpy()
        # the hole: the object's footprint on the floor, projected, where the floor itself is what shows (rendered depth
        # reaches the floor plane, or nothing rendered), so whatever stands in front still occludes it. A rendered "fill
        # share" missed the fill's own rows (partly transparent Gaussians) and any floor the splat has under the object.
        pc = (w2c @ np.c_[foot, np.full(len(foot), 0.002), np.ones(len(foot))].T)[:3]
        poly = np.zeros((H, W), np.uint8)
        if (pc[2] > 0.05).all():
            uv = (Kn @ (pc / pc[2]))[:2].T
            cv2.fillPoly(poly, [np.round(uv).astype(np.int32)], 1)
        ray = np.linalg.inv(Kn) @ np.stack([*np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5), np.ones((H, W))]).reshape(3, -1)
        Rt, eye = w2c[:3, :3].T, -w2c[:3, :3].T @ w2c[:3, 3]
        dz = (Rt @ ray)[2].reshape(H, W)
        floor_depth = np.where(dz < -1e-6, -eye[2] / np.minimum(dz, -1e-6), np.inf)   # z-depth: rays have camera z = 1
        hole = (poly > 0) & ((a < 0.1) | (dep >= floor_depth - 0.05))
        hole = cv2.dilate(hole.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        dep = np.where(a > 0.1, dep, np.inf)
        seg = np.where(hole[..., None], shell_depth.SEG_COLORS[shell_depth.FLOOR], 0.45)
        dep, seg, imag, _ = shell_depth.fill_empty(dep, seg, hole, w2c, Kn, shell)
        rgb = np.where(imag[..., None], 0, rgb)
        u8 = lambda x: (np.clip(x, 0, 1) * 255).astype(np.uint8)
        edge = cv2.Canny(cv2.cvtColor(u8(rgb), cv2.COLOR_RGB2GRAY), 100, 200)
        edge[cv2.dilate(imag.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0] = 0   # no outline of the hole for Cosmos to draw
        V["rgb"].append(u8(rgb)); V["seg"].append(u8(seg)); V["depth"].append(dep)
        V["edge"].append(np.repeat(edge[..., None], 3, -1))
        V["mask"].append(np.repeat(u8(imag.astype(float))[..., None], 3, -1))
    disp = 1 / np.maximum(np.stack(V["depth"]), 0.1)
    lo, hi = np.percentile(disp[disp > 0], [2, 98])
    V["depth"] = [np.repeat((255 * np.clip((1 / np.maximum(x, 0.1) - lo) / (hi - lo), 0, 1)).astype(np.uint8)[..., None], 3, -1) for x in V["depth"]]
    for k, frames in V.items():
        write_mp4(out / f"{k}.mp4", frames)
    (out / "cameras.json").write_text(json.dumps([c.tolist() for c in cams]))
    spec = {"name": f"fill_{scene}_{name}", "prompt": PROMPT, "video_path": str(out / "rgb.mp4"), "guidance": 3,
            **{k: {"control_path": str(out / f"{k}.mp4"), "control_weight": 1.0} for k in ("depth", "seg", "edge")}}
    (out / "spec.json").write_text(json.dumps(spec, indent=1))
    print(out / "spec.json")


def lift_phase(scene, name, cosmos_mp4, min_views=3):
    """Back-project: every fill Gaussian is projected into each orbit frame and samples the colour-matched Cosmos pixel
    there (inside the hole mask only); its colour becomes the median over the frames that saw it. Gaussians seen in
    fewer than min_views frames keep their 12b colour. (Fitting each Gaussian's colour by gradient descent gave
    glittery red/green speckle: the frames disagree in detail, and nothing tied neighbours together.)"""
    import cv2
    from common import read_ply, write_ply, ply_xyz
    d = ROOT / "viewer" / "public" / "scene" / scene
    sc = json.loads((d / "scene.json").read_text())
    o = next(x for x in sc["objects"] if x["name"] == name)
    out = d / "cosmos_fill" / name
    cams = [np.array(c) for c in json.loads((out / "cameras.json").read_text())]
    fill = read_ply(d / o["fill"])
    xyz = ply_xyz(fill)
    K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]])
    cols = np.full((len(cams), len(fill), 3), np.nan, np.float32)
    rd, md, gd = (cv2.VideoCapture(str(p)) for p in (out / "rgb.mp4", out / "mask.mp4", cosmos_mp4))
    for k, w2c in enumerate(cams):
        ok = [c.read() for c in (rd, md, gd)]
        if not all(r for r, _ in ok):
            break
        rgb, mask, gen = (cv2.cvtColor(f, cv2.COLOR_BGR2RGB) for _, f in ok)
        m = mask[..., 0] > 127
        t = composite(rgb / 255, cv2.resize(gen, (W, H)) / 255, m)
        pc = w2c[:3, :3] @ xyz.T + w2c[:3, 3:]
        z = np.maximum(pc[2], 1e-6)
        u, v = np.round(K[0, 0] * pc[0] / z + K[0, 2]).astype(int), np.round(K[1, 1] * pc[1] / z + K[1, 2]).astype(int)
        vis = (pc[2] > 0.05) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
        vis[vis] &= m[v[vis], u[vis]]
        cols[k, vis] = t[v[vis], u[vis]]
    n = np.sum(~np.isnan(cols[..., 0]), 0)
    med = np.nanmedian(np.where(n[None, :, None] >= min_views, cols, 0), 0) if (n >= min_views).any() else None
    old = np.stack([fill[f"f_dc_{c}"] for c in range(3)], 1) * 0.28209479 + 0.5
    new = np.where((n >= min_views)[:, None], med, old) if med is not None else old
    fv = fill.copy()
    for c in range(3):
        fv[f"f_dc_{c}"] = (new[:, c] - 0.5) / 0.28209479
    rel = f"objects/fill_{name}_cosmos.ply"
    write_ply(d / rel, fv)
    o.setdefault("fills", {"median": o["fill"]})["cosmos"] = rel
    (d / "scene.json").write_text(json.dumps(sc, indent=1))
    print(d / rel, f"{(n >= min_views).mean():.0%} of {len(fill)} Gaussians from Cosmos, median {int(np.median(n))} views each")


if __name__ == "__main__":
    {"render": lambda: render_phase(sys.argv[2], sys.argv[3]),
     "lift": lambda: lift_phase(sys.argv[2], sys.argv[3], sys.argv[4])}[sys.argv[1]]()

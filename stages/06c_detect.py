"""Stage 6c: propose the movable objects and fixtures from the capture, instead of drawing every box by hand.
Writes <work>/objects_proposed.yaml in the config's own format (game.objects / game.fixtures entries). A person
accepts what is right into the config: hand-drawn boxes stay the authority, this only saves the drawing.

  python stages/06c_detect.py <config.yaml> [--frames 60]          (GPU: HiPerGator, slurm/detect.sbatch)

1. Grounding DINO finds boxes for a home-safety vocabulary in capture frames; SAM 2 turns each box into a mask.
2. Every solid Gaussian is projected into those frames (a point z-buffer decides what each frame actually sees) and
   votes for the label of the mask it lands in; a label sticks when >= half of the frames that saw it agree.
3. Each label's Gaussians are split into pieces on a 5 cm floor grid; each piece becomes a rotated footprint
   (poly_xy) with its height band, i.e. a config entry.
Models (pinned revisions in pipeline/models.lock.json-style, see MODELS below): text -> boxes, boxes -> masks.
"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import load_cfg, read_ply, ply_xyz, solid_mask

import numpy as np

MODELS = {   # text prompts -> boxes; boxes -> masks (Apache-2.0 both)
    "detector": ("IDEA-Research/grounding-dino-tiny", "a2bb814dd30d776dcf7e30523b00659f4f141c71"),
    "segmenter": ("facebook/sam2.1-hiera-large", "665f8e2ad61cf5f53d65644ff27c8ee525124610"),
}
# vocabulary -> (kind, objects or fixtures)
VOCAB = {"bed": ("bed", "objects"), "nightstand": ("nightstand", "objects"), "bedside table": ("nightstand", "objects"),
         "rug": ("rug", "objects"), "bath mat": ("rug", "objects"), "chair": ("chair", "objects"), "table": ("other", "objects"),
         "lamp": ("other", "objects"), "door": ("door", "objects"), "toilet": ("toilet", "fixtures"),
         "power cable": ("cable", "objects"), "light switch": ("switch", "fixtures")}
CELL = 0.05


def zbuffer_visible(xyz, w2c, K, W, H, step=4, slack=0.05):
    """Which points this camera sees: nearest depth per (step x step) pixel block wins; within `slack` m of it counts."""
    x = (w2c[:3, :3] @ xyz.T + w2c[:3, 3:4]).T
    z = x[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u, v = K[0, 0] * x[:, 0] / z + K[0, 2], K[1, 1] * x[:, 1] / z + K[1, 2]
    ok = (z > 0.05) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
    bu, bv = (u[ok] // step).astype(int), (v[ok] // step).astype(int)
    zb = np.full((H // step + 1, W // step + 1), np.inf)
    np.minimum.at(zb, (bv, bu), z[ok])
    vis = np.zeros(len(xyz), bool)
    vis[np.flatnonzero(ok)] = z[ok] <= zb[bv, bu] + slack
    return vis, u, v


def vote(xyz, frames, labels):
    """frames: [{w2c, K, width, height, masks: [(label_index, bool HxW)]}]. Returns per-point label (-1 = none)."""
    L = len(labels)
    seen, votes = np.zeros(len(xyz), int), np.zeros((len(xyz), L), int)
    for f in frames:
        w2c, K = np.asarray(f["w2c"], float), np.asarray(f["K"], float)
        vis, u, v = zbuffer_visible(xyz, w2c, K, f["width"], f["height"])
        seen += vis
        iu, iv = np.clip(u, 0, f["width"] - 1).astype(int), np.clip(v, 0, f["height"] - 1).astype(int)
        for li, m in f["masks"]:
            hit = vis.copy()
            hit[vis] = m[iv[vis], iu[vis]]
            votes[hit, li] += 1
    best = votes.argmax(1)
    share = votes[np.arange(len(xyz)), best] / np.maximum(seen, 1)
    return np.where((seen >= 3) & (share >= 0.5), best, -1)


def on_walls(xyz, shell, tol=0.03):
    """Points on the room shell's walls (stage 5c): a mask edge that spills onto the wall behind the bed votes the wall
    'bed'; walls are never furniture."""
    hit = np.zeros(len(xyz), bool)
    for w in (shell or {}).get("walls", []):
        a, b = np.array(w["a"]), np.array(w["b"])
        e = b - a
        t = np.clip(((xyz[:, :2] - a) @ e) / (e @ e), 0, 1)
        hit |= np.linalg.norm(xyz[:, :2] - (a + t[:, None] * e), axis=1) < tol
    return hit


def propose(xyz, lab, labels, min_points=200, shell=None):
    """Per label: connected pieces on a 5 cm floor grid -> config entries with a rotated footprint and height band."""
    import cv2
    from scipy import ndimage
    out = {"objects": [], "fixtures": []}
    lab = np.where(on_walls(xyz, shell), -1, lab)
    for li, name in enumerate(labels):
        pts = xyz[lab == li]
        if len(pts) < min_points:
            continue
        lo = pts[:, :2].min(0)
        ij = np.floor((pts[:, :2] - lo) / CELL).astype(int)
        occ = np.zeros(ij.max(0) + 1, bool)
        occ[tuple(ij.T)] = True
        comp, n = ndimage.label(ndimage.binary_closing(occ, iterations=1))
        for k in range(1, n + 1):
            sel = comp[tuple(ij.T)] == k
            if sel.sum() < min_points:
                continue
            p = pts[sel]
            rect = cv2.minAreaRect(p[:, :2].astype(np.float32))
            poly = np.round(cv2.boxPoints(rect).astype(float), 3).tolist()
            kind, where = VOCAB.get(name, ("other", "objects"))
            z = np.percentile(p[:, 2], [2, 99])
            entry = {"name": f"{kind}{'' if not out[where] or all(e['kind'] != kind for e in out[where]) else len(out[where])}",
                     "kind": kind, "poly_xy": poly, "points": int(sel.sum()), "detected_as": name}
            if where == "objects":
                xs, ys = [q[0] for q in poly], [q[1] for q in poly]
                entry.update(box_xy=[[round(min(xs), 3), round(min(ys), 3)], [round(max(xs), 3), round(max(ys), 3)]],
                             z_max=round(float(z[1]) + 0.02, 3),
                             parts=[{"poly_xy": poly, "z": [round(max(float(z[0]), -0.5), 3), round(float(z[1]) + 0.02, 3)]}])
            out[where].append(entry)
    return out


def detect(images, labels, boxes_threshold=0.3):
    """Grounding DINO + SAM 2 on PIL images -> per image [(label_index, mask)] (GPU)."""
    import torch
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection, Sam2Processor, Sam2Model
    did, drev = MODELS["detector"]
    sid, srev = MODELS["segmenter"]
    dp, dm = AutoProcessor.from_pretrained(did, revision=drev), AutoModelForZeroShotObjectDetection.from_pretrained(did, revision=drev).cuda().eval()
    sp, sm = Sam2Processor.from_pretrained(sid, revision=srev), Sam2Model.from_pretrained(sid, revision=srev).cuda().eval()
    text = ". ".join(labels) + "."
    out = []
    for img in images:
        with torch.no_grad():
            inp = dp(images=img, text=text, return_tensors="pt").to("cuda")
            det = dp.post_process_grounded_object_detection(dm(**inp), inp.input_ids, threshold=boxes_threshold, text_threshold=0.25,
                                                            target_sizes=[img.size[::-1]])[0]
        masks = []
        if len(det["boxes"]):
            with torch.no_grad():
                si = sp(images=img, input_boxes=[det["boxes"].tolist()], return_tensors="pt").to("cuda")
                mo = sm(**si, multimask_output=False)
                mk = sp.post_process_masks(mo.pred_masks.cpu(), si["original_sizes"])[0][:, 0].numpy() > 0.5
            for lab, m in zip(det["text_labels"], mk):
                name = next((l for l in labels if l in str(lab)), None)
                if name:
                    masks.append((labels.index(name), m))
        out.append(masks)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--frames", type=int, default=60)
    a = ap.parse_args()
    import yaml
    from PIL import Image
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "cosmos"))
    from reason import floor_cameras
    cfg = load_cfg(a.config)
    w = cfg["work"]
    v = read_ply(w / "splat_aligned.ply")
    solid = solid_mask(v, min_opacity=cfg["grid"].get("min_opacity", 0.3))
    xyz = ply_xyz(v)[solid]
    cams = floor_cameras(w)
    cams = [cams[int(k)] for k in np.linspace(0, len(cams) - 1, min(a.frames, len(cams)))]
    labels = list(VOCAB)
    imgs, frames = [], []
    for c in cams:
        p = w / "images" / c["name"]
        if not p.exists():
            continue
        img = Image.open(p).convert("RGB")
        W, H = img.size
        imgs.append(img)
        frames.append({"w2c": c["w2c"], "K": np.array(c["K"], float) * [[W / c["width"]], [H / c["height"]], [1]], "width": W, "height": H})
    for f, m in zip(frames, detect(imgs, labels)):
        f["masks"] = m
    lab = vote(xyz, frames, labels)
    shell = json.loads((w / "shell.json").read_text()) if (w / "shell.json").exists() else None
    prop = propose(xyz, lab, labels, shell=shell)
    prop["note"] = ("PROPOSED by Grounding DINO + SAM 2 votes (stage 6c), floor frame. Check each against the splat and copy "
                    "the right ones into game.objects / game.fixtures; hand-drawn boxes stay the authority.")
    (w / "objects_proposed.yaml").write_text(yaml.safe_dump(prop, sort_keys=False))
    print(json.dumps({k: [e["name"] for e in prop[k]] for k in ("objects", "fixtures")}))


if __name__ == "__main__":
    main()

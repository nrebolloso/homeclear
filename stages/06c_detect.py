"""Stage 6c: propose the movable objects and fixtures from the capture, instead of drawing every box by hand.
Writes <work>/objects_proposed.yaml in the config's own format (game.objects / game.fixtures entries). A person
can copy entries into the config, or set `game.objects: auto` to make every detected object movable (stage 12 then cuts
each one out of the splat by <work>/objects_points.npz). Doors are left out of auto.

  python stages/06c_detect.py <config.yaml> [--frames 60]          (GPU: HiPerGator, slurm/detect.sbatch)

1. Grounding DINO finds boxes for a home-safety vocabulary in capture frames; SAM 2 turns each box into a mask.
2. Every solid Gaussian is projected into those frames (a point z-buffer decides what each frame actually sees) and
   votes for the label of the mask it lands in; a label sticks when >= half of the frames that saw it agree.
3. instances() splits the labelled Gaussians into separate objects (3D connectivity, then labels inside touching
   pieces); each becomes a rotated footprint (poly_xy) with its height band, i.e. a config entry.
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
         "power cable": ("cable", "objects"),
         "trash can": ("other", "objects"), "stool": ("chair", "objects"), "bench": ("other", "objects"), "box": ("other", "objects"),
         "bag": ("other", "objects"), "basket": ("other", "objects"), "potted plant": ("other", "objects"), "sofa": ("other", "objects"), "light switch": ("switch", "fixtures")}
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


def vote(xyz, frames, labels, with_hits=False, zstep=4):
    """frames: [{w2c, K, width, height, masks: [(label_index, bool HxW)]}]. Returns per-point label (-1 = none), and with
    with_hits the per-frame (point index, mask index) pairs. Where masks overlap a pixel goes to the smallest: a chair
    box's mask that spills over the table must not out-vote the table's own mask."""
    L = len(labels)
    seen, votes, hits = np.zeros(len(xyz), int), np.zeros((len(xyz), L), int), []
    for f in frames:
        w2c, K = np.asarray(f["w2c"], float), np.asarray(f["K"], float)
        vis, u, v = zbuffer_visible(xyz, w2c, K, f["width"], f["height"], step=zstep)
        seen += vis
        owner = np.full((f["height"], f["width"]), -1)
        for k in np.argsort([-m.sum() for _, m in f["masks"]]):
            owner[f["masks"][k][1]] = k
        idx = np.flatnonzero(vis)
        o = owner[np.clip(v[idx], 0, f["height"] - 1).astype(int), np.clip(u[idx], 0, f["width"] - 1).astype(int)]
        idx, o = idx[o >= 0], o[o >= 0]
        np.add.at(votes, (idx, np.array([li for li, _ in f["masks"]], int)[o] if len(o) else idx[:0]), 1)
        hits.append((idx, o))
    best = votes.argmax(1)
    share = votes[np.arange(len(xyz)), best] / np.maximum(seen, 1)
    lab = np.where((seen >= 3) & (share >= 0.5), best, -1)
    return (lab, hits) if with_hits else lab


def lift(v, solid, frames, labels, min_weight=0.1):
    """vote() by rendering instead of point projection: each solid Gaussian votes with the alpha-blending weight it really puts
    inside each mask (d/dX sum(regions * render(X)) = each Gaussian's weight in each region), so the splat's own occlusion and
    a leg's whole footprint decide, not its centre pixel against a point z-buffer. Same returns as vote(..., with_hits=True) (GPU)."""
    import torch
    from gsplat import rasterization
    t = lambda x: torch.tensor(np.ascontiguousarray(x), dtype=torch.float32, device="cuda")
    G = dict(means=t(ply_xyz(v)), quats=t(np.stack([v[f"rot_{i}"] for i in range(4)], 1)),
             scales=torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))), opacities=torch.sigmoid(t(v["opacity"])))
    sid = torch.from_numpy(np.flatnonzero(solid)).cuda()
    n, L = len(sid), len(labels)
    seen, votes, hits = np.zeros(n, int), np.zeros((n, L), int), []
    for f in frames:
        owner = np.full((f["height"], f["width"]), -1)
        for k in np.argsort([-m.sum() for _, m in f["masks"]]):   # overlaps go to the smallest mask, as in vote()
            owner[f["masks"][k][1]] = k
        D = len(f["masks"]) + 1   # region 0 = no mask
        C = next(c for c in (1, 2, 3, 4, 5, 6, 8, 9, 16, 17, 21, 23, 24, 32, 33, 64, 65, 128) if c >= D)   # gsplat's compiled channel counts
        X = torch.zeros(len(v), C, device="cuda", requires_grad=True)
        img, _, _ = rasterization(G["means"], G["quats"], G["scales"], G["opacities"], X, t(f["w2c"])[None], t(f["K"])[None],
                                  f["width"], f["height"], packed=False)
        (img[0] * torch.nn.functional.one_hot(torch.from_numpy(owner + 1).cuda(), C)).sum().backward()
        m = X.grad[sid, :D].cpu().numpy()
        vis = m.sum(1) > min_weight
        dom = m.argmax(1)
        seen += vis
        idx = np.flatnonzero(vis & (dom > 0) & (m.max(1) >= 0.5 * m.sum(1)))
        o = dom[idx] - 1
        np.add.at(votes, (idx, np.array([li for li, _ in f["masks"]], int)[o] if len(o) else idx[:0]), 1)
        hits.append((idx, o))
    best = votes.argmax(1)
    share = votes[np.arange(n), best] / np.maximum(seen, 1)
    return np.where((seen >= 3) & (share >= 0.5), best, -1), hits


def pieces3d(p, vox):
    """26-connected pieces of points on a vox grid -> piece id per point."""
    from scipy import ndimage
    q = np.floor((p - p.min(0)) / vox).astype(int)
    grid = np.zeros(q.max(0) + 1, bool)
    grid[tuple(q.T)] = True
    return ndimage.label(grid, np.ones((3, 3, 3)))[0][tuple(q.T)] - 1


def instances(xyz, lab, hits, vox=0.02, min_points=200, min_share=0.25, min_frames=3, min_pts=20, attach_m=0.1, join_m=0.1, fragment=0.25):
    """Labelled points -> one id per object (-1 = none), robust to masks that spill:
    1. pieces = 2 cm connected pieces of ALL labelled points: separate things have a gap (a chair pushed in under a table
       is its own piece even where the table's mask covered its seat);
    2. a piece holding two things that touch (an end chair against the table) splits by label, where a label holds
       >= min_share of it; a smaller label share is mask spill and goes to its nearest kept neighbour;
    3. pieces of one label within join_m of each other that the masks keep in ONE mask in most frames seeing both are
       joined (a chair's back and seat; two chairs one mask took together are further apart);
    4. a fragment (under min_points, or under fragment x the object it touches) joins the nearest object within attach_m
       (a chair's feet, its seat under the table's mask), smallest first; a lone one under min_points is dropped."""
    from scipy.spatial import cKDTree
    sel = np.flatnonzero(lab >= 0)
    piece, l = pieces3d(xyz[sel], vox), lab[sel]
    ids, nxt = np.full(len(sel), -1), 0
    for k in np.unique(piece):
        i = np.flatnonzero(piece == k)
        ls, cnt = np.unique(l[i], return_counts=True)
        keep = ls[cnt >= max(min_points, min_share * len(i))]
        keep = keep if len(keep) else ls[[cnt.argmax()]]
        kept = i[np.isin(l[i], keep)]
        for li in keep:
            j = i[l[i] == li]
            c = pieces3d(xyz[sel[j]], vox)
            ids[j] = nxt + c
            nxt += c.max() + 1
        rest = i[~np.isin(l[i], keep)]
        if len(rest):
            ids[rest] = ids[kept[cKDTree(xyz[sel[kept]]).query(xyz[sel[rest]])[1]]]
            l[rest] = l[kept[cKDTree(xyz[sel[kept]]).query(xyz[sel[rest]])[1]]]
    inst = np.full(len(xyz), -1)
    inst[sel] = ids
    lab = lab.copy()
    lab[sel] = l
    # 3. join same-label pieces that share a mask in most frames
    n = nxt
    same, both = np.zeros((n, n)), np.zeros((n, n))
    for idx, o in hits:   # each piece's dominant mask in this frame
        c = inst[idx]
        dom = {}
        for k in np.unique(c[c >= 0]):
            mk, cnt = np.unique(o[c == k], return_counts=True)
            if cnt.max() >= min_pts:
                dom[k] = mk[cnt.argmax()]
        ks = np.array(list(dom), int)
        d = np.array([dom[k] for k in ks])
        both[np.ix_(ks, ks)] += 1
        same[np.ix_(ks, ks)] += d[:, None] == d[None, :]
    plab = np.full(n, -1)
    plab[inst[sel]] = lab[sel]
    root = list(range(n))
    find = lambda i: i if root[i] == i else find(root[i])
    pts = [xyz[sel[inst[sel] == k]] for k in range(n)]
    for i, j in zip(*np.nonzero((both >= min_frames) & (same >= 0.5 * both) & (plab[:, None] == plab[None, :]))):
        if i < j and find(i) != find(j) and cKDTree(pts[i]).query(pts[j], distance_upper_bound=join_m)[0].min() <= join_m:
            root[find(i)] = find(j)
    inst[sel] = np.array([find(i) for i in range(n)])[inst[sel]]
    # 4. fragments join the object they touch, smallest first
    for k in sorted(np.unique(inst[sel]), key=lambda k: (inst[sel] == k).sum()):
        mine, other = sel[inst[sel] == k], sel[inst[sel] != k]
        if not len(other):
            break
        d, j = cKDTree(xyz[other]).query(xyz[mine], distance_upper_bound=attach_m)
        near = inst[other[j[d <= attach_m]]]
        if len(near):
            to = np.bincount(near).argmax()
            if len(mine) < min_points or len(mine) < fragment * (inst[sel] == to).sum():
                inst[mine] = to
                continue
        if len(mine) < min_points:
            inst[mine] = -1
            sel = sel[inst[sel] >= 0]
    _, inst[inst >= 0] = np.unique(inst[inst >= 0], return_inverse=True)
    return inst, lab


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


def propose(xyz, lab, labels, min_points=200, shell=None, inst=None):
    """Per object (instances(); without them, connected pieces of each label on a 5 cm floor grid) -> config entries with a
    rotated footprint and height band. Entries carry `instance` (the id in inst) when inst is given."""
    import cv2
    from scipy import ndimage
    out = {"objects": [], "fixtures": []}
    walls = on_walls(xyz, shell)
    lab = np.where(walls, -1, lab)
    pieces = []   # (label index, point indices, instance id)
    if inst is not None:
        for k in np.unique(inst[(inst >= 0) & ~walls]):
            i = np.flatnonzero((inst == k) & ~walls)
            pieces.append((np.bincount(lab[i][lab[i] >= 0]).argmax() if (lab[i] >= 0).any() else -1, i, int(k)))
    else:
        for li in range(len(labels)):
            i = np.flatnonzero(lab == li)
            if len(i) < min_points:
                continue
            lo = xyz[i, :2].min(0)
            ij = np.floor((xyz[i, :2] - lo) / CELL).astype(int)
            occ = np.zeros(ij.max(0) + 1, bool)
            occ[tuple(ij.T)] = True
            comp, n = ndimage.label(ndimage.binary_closing(occ, iterations=1))
            pieces += [(li, i[comp[tuple(ij.T)] == k], None) for k in range(1, n + 1)]
    for li, sel, k in pieces:
        if li < 0 or len(sel) < min_points:
            continue
        name = labels[li]
        p = xyz[sel]
        rect = cv2.minAreaRect(p[:, :2].astype(np.float32))
        poly = np.round(cv2.boxPoints(rect).astype(float), 3).tolist()
        kind, where = VOCAB.get(name, ("other", "objects"))
        z = np.percentile(p[:, 2], [2, 99])
        base = name.replace(" ", "_")   # chair, chair2, ... trash_can
        n_same = sum(e["detected_as"] == name for e in out["objects"] + out["fixtures"])
        entry = {"name": f"{base}{n_same + 1 if n_same else ''}",
                 "kind": kind, "poly_xy": poly, "points": int(len(sel)), "detected_as": name}
        if k is not None:
            entry["instance"] = k
        if where == "objects":
            xs, ys = [q[0] for q in poly], [q[1] for q in poly]
            entry.update(box_xy=[[round(min(xs), 3), round(min(ys), 3)], [round(max(xs), 3), round(max(ys), 3)]],
                         z_max=round(float(z[1]) + 0.02, 3),
                         parts=[{"poly_xy": poly, "z": [round(max(float(z[0]), -0.5), 3), round(float(z[1]) + 0.02, 3)]}])
        out[where].append(entry)
    return out


def label_of(text, labels):
    """Detector phrase -> vocabulary word: the longest word inside it ('bedside table' is not 'bed'); a phrase naming two
    different things ('chair table') is dropped."""
    hits = [l for l in labels if l in text]
    best = max(hits, key=len, default=None)
    return best if all(h in best for h in hits) else None


def boxes_finder(labels, boxes_threshold=0.3):
    """Grounding DINO: PIL image -> (boxes, label indices) of the vocabulary words it finds (GPU)."""
    import torch
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
    did, drev = MODELS["detector"]
    dp, dm = AutoProcessor.from_pretrained(did, revision=drev), AutoModelForZeroShotObjectDetection.from_pretrained(did, revision=drev).cuda().eval()
    text = ". ".join(labels) + "."

    def find(img):
        with torch.no_grad():
            inp = dp(images=img, text=text, return_tensors="pt").to("cuda")
            det = dp.post_process_grounded_object_detection(dm(**inp), inp.input_ids, threshold=boxes_threshold, text_threshold=0.25,
                                                            target_sizes=[img.size[::-1]])[0]
        keep = [(b, label_of(str(lab), labels)) for b, lab in zip(det["boxes"].tolist(), det["text_labels"])]
        keep = [(b, labels.index(n)) for b, n in keep if n]
        return [b for b, _ in keep], [li for _, li in keep]
    return find


def detect(images, labels, boxes_threshold=0.3):
    """Grounding DINO + SAM 2 on PIL images -> per image [(label_index, mask)] (GPU)."""
    import torch
    from transformers import Sam2Processor, Sam2Model
    find = boxes_finder(labels, boxes_threshold)
    sid, srev = MODELS["segmenter"]
    sp, sm = Sam2Processor.from_pretrained(sid, revision=srev), Sam2Model.from_pretrained(sid, revision=srev).cuda().eval()
    out = []
    for img in images:
        boxes, lis = find(img)
        masks = []
        if boxes:
            with torch.no_grad():
                si = sp(images=img, input_boxes=[boxes], return_tensors="pt").to("cuda")
                mo = sm(**si, multimask_output=False)
                mk = sp.post_process_masks(mo.pred_masks.cpu(), si["original_sizes"])[0][:, 0].numpy() > 0.5
            masks = list(zip(lis, mk))
        out.append(masks)
    return out


def detect_video(clips, labels, boxes_threshold=0.3):
    """Grounding DINO on each clip's first image, SAM 2 tracks those boxes through the clip's frames: masks that agree
    from frame to frame, so a thin leg one frame misses still wins its votes. -> per image (clips flattened) [(label_index, mask)]."""
    import torch
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    find = boxes_finder(labels, boxes_threshold)
    sid, srev = MODELS["segmenter"]
    vp, vm = Sam2VideoProcessor.from_pretrained(sid, revision=srev), Sam2VideoModel.from_pretrained(sid, revision=srev).cuda().eval()
    out = []
    for clip in clips:
        boxes, lis = find(clip[0])
        res = [[] for _ in clip]
        if boxes:
            ses = vp.init_video_session(video=clip, inference_device="cuda")
            vp.add_inputs_to_inference_session(inference_session=ses, frame_idx=0, obj_ids=list(range(1, len(boxes) + 1)), input_boxes=[boxes])
            with torch.no_grad():
                for o in vm.propagate_in_video_iterator(ses, start_frame_idx=0):
                    mk = vp.post_process_masks([o.pred_masks], original_sizes=[[ses.video_height, ses.video_width]])[0]
                    res[o.frame_idx] = list(zip(lis, np.asarray(mk.cpu()).reshape(len(boxes), ses.video_height, ses.video_width).astype(bool)))
        out += res
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--cached", action="store_true", help="reuse <work>/detect_masks.npz instead of running the models")
    ap.add_argument("--mask_step", type=int, default=4, help="cache masks at 1/N res (1 = full: thin legs survive)")
    ap.add_argument("--zstep", type=int, default=4, help="z-buffer pixel block for what a frame sees")
    ap.add_argument("--lift", choices=("points", "render"), default="points", help="how masks become Gaussian labels: vote() or lift()")
    ap.add_argument("--video", type=int, default=0, help="N > 0: SAM 2 tracks each keyframe's boxes through every Nth frame to the next keyframe")
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
    if a.video:   # capture order, every Nth frame; a clip starts at each keyframe
        cams = sorted([c for c in cams if (w / "images" / c["name"]).exists()], key=lambda c: c["name"])[::a.video]
        key = np.linspace(0, len(cams) - 1, min(a.frames, len(cams))).astype(int)
        clip_len = np.diff(np.r_[key, len(cams)])
    else:
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
    cache = w / "detect_masks.npz"   # masks at 1/mask_step res: re-vote on CPU with --cached
    if a.cached:
        z = np.load(cache)
        for i, f in enumerate(frames):
            h, wd = z[f"s{i}"]
            st = -(-f["height"] // h)   # the step the cache was written at
            f["masks"] = [(int(li), np.unpackbits(z[f"m{i}_{k}"], count=h * wd).reshape(h, wd).astype(bool)
                           .repeat(st, 0).repeat(st, 1)[:f["height"], :f["width"]]) for k, li in enumerate(z[f"l{i}"])]
    else:
        if a.video:
            ends = np.cumsum(clip_len)
            masks = detect_video([imgs[e - n:e] for e, n in zip(ends, clip_len)], labels)
        else:
            masks = detect(imgs, labels)
        for f, m in zip(frames, masks):
            f["masks"] = m
        out = {}
        for i, f in enumerate(frames):
            out[f"l{i}"] = np.array([li for li, _ in f["masks"]], int)
            out[f"s{i}"] = np.array((len(range(0, f["height"], a.mask_step)), len(range(0, f["width"], a.mask_step))))
            for k, (_, m) in enumerate(f["masks"]):
                out[f"m{i}_{k}"] = np.packbits(m[::a.mask_step, ::a.mask_step])
        np.savez_compressed(cache, **out)
    lab, hits = lift(v, solid, frames, labels) if a.lift == "render" else vote(xyz, frames, labels, with_hits=True, zstep=a.zstep)
    inst, lab = instances(xyz, lab, hits)
    shell = json.loads((w / "shell.json").read_text()) if (w / "shell.json").exists() else None
    prop = propose(xyz, lab, labels, shell=shell, inst=inst)
    keep = inst >= 0   # stage 12 (game.objects: auto) gives each Gaussian the object of its nearest labelled point
    np.savez_compressed(w / "objects_points.npz", xyz=xyz[keep].astype(np.float32), instance=inst[keep])
    prop["note"] = ("PROPOSED by Grounding DINO + SAM 2 votes (stage 6c), floor frame. Check each against the splat and copy "
                    "the right ones into game.objects / game.fixtures, or set game.objects: auto.")
    (w / "objects_proposed.yaml").write_text(yaml.safe_dump(prop, sort_keys=False))
    print(json.dumps({k: [e["name"] for e in prop[k]] for k in ("objects", "fixtures")}))


if __name__ == "__main__":
    main()

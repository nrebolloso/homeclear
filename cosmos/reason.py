"""Cosmos Reason 2 on the real capture frames along the route (B200; cosmos/slurm/cosmos_reason.sbatch).
  python cosmos/reason.py <config.yaml> [--frames 24] [--model nvidia/Cosmos-Reason2-8B]   -> <work>/reason.json

1. Frames: the capture photos whose camera stood within 1.2 m of the planned route (stage 7), spread along it.
2. The model sees each photo with the patient's situation and lists hazards as JSON (kind, a point, why).
   Qwen3-VL-based models point in 0-1000 normalised image coordinates; they are scaled to pixels here.
3. Each point is lifted to 3-D with the splat's depth rendered at that photo's camera (floor frame), checked against
   the measured grids (reason_lift.verdict), and repeats across photos are merged.
Nothing here becomes a number: confirmed items already have their measured hazard; the rest is "OT to verify".
Stage 12 merges reason.json into the viewer's hazards as source "cosmos_reason".
"""
import argparse, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos")]
from common import load_cfg, read_ply, ply_xyz
import reason_lift as rl

import numpy as np

KINDS = "floor_bump, cable, threshold, clutter, rug, grab_bar, slippery, lighting, handrail, other"


def prompt(cfg):
    p = cfg["game"]["persona"]
    who = (f"An older adult going home from hospital after a hip replacement, walking with a {cfg['game']['walker']['width_m']:.2f} m "
           f"wide wheeled walker{', with hip precautions' if p.get('hip_precautions') else ''}, who will walk this route at night.")
    return (f"{who} This photo is part of the route from the bed to the bathroom. List everything in the photo that could "
            f"make them trip, snag the walker, slip, or struggle to sit down or stand up: raised rug edges, cords and cables, "
            f"door thresholds, clutter on the floor, missing grab bars, slippery mats, dark spots. For each one answer with a "
            f"JSON list of objects: {{\"hazard\": short name, \"kind\": one of [{KINDS}], \"pixel\": [x, y] the point on the "
            f"hazard in 0-1000 normalised image coordinates, \"why\": one sentence, \"confidence\": 0 to 1}}. "
            f"Answer [] if there is nothing. Only the JSON list.")


def floor_cameras(work):
    """cameras.json (COLMAP frame) -> OpenCV w2c in the metric floor frame (align.json: X_floor = s R X + t)."""
    T = np.array(json.loads((work / "align.json").read_text())["T_colmap_to_floor"])
    s = np.cbrt(np.linalg.det(T[:3, :3]))
    R, t = T[:3, :3] / s, T[:3, 3]
    out = []
    for c in json.loads((work / "cameras.json").read_text()):
        w = np.array(c["w2c"])
        Rc, tc = w[:3, :3], w[:3, 3]
        w2c = np.eye(4)
        w2c[:3, :3] = Rc @ R.T
        w2c[:3, 3] = -Rc @ R.T @ t + s * tc
        out.append({**c, "w2c": w2c, "eye": -w2c[:3, :3].T @ w2c[:3, 3]})
    return out


def pick(cams, route_xy, n):
    """Cameras within 1.2 m of the route, evenly spread by where along the route they are."""
    xy = np.asarray(route_xy)
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xy, axis=0), axis=1))]
    near = []
    for c in cams:
        d = np.linalg.norm(xy - c["eye"][:2], axis=1)
        if d.min() < 1.2:
            near.append((s[np.argmin(d)], c))
    near.sort(key=lambda x: x[0])
    if len(near) <= n:
        return [c for _, c in near]
    return [near[int(k)][1] for k in np.linspace(0, len(near) - 1, n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--model", default="nvidia/Cosmos-Reason2-8B")
    a = ap.parse_args()
    import torch
    from PIL import Image
    from gsplat import rasterization
    from transformers import AutoProcessor, AutoModelForImageTextToText

    cfg = load_cfg(a.config)
    w = cfg["work"]
    path = json.loads((w / "path.json").read_text())
    cams = pick(floor_cameras(w), path["xy"], a.frames)
    assert cams, "no capture camera within 1.2 m of the route"
    proc = AutoProcessor.from_pretrained(a.model)
    model = AutoModelForImageTextToText.from_pretrained(a.model, torch_dtype=torch.bfloat16, device_map="cuda").eval()

    v = read_ply(w / "splat_aligned.ply")
    t = lambda x: torch.tensor(np.ascontiguousarray(x), dtype=torch.float32, device="cuda")
    G = dict(means=t(ply_xyz(v)), quats=t(np.stack([v[f"rot_{i}"] for i in range(4)], 1)),
             scales=torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1))), opacities=torch.sigmoid(t(v["opacity"])))
    white = torch.ones(len(v), 3, device="cuda")
    grid = json.loads((w / "grid.json").read_text())
    bump, obst = np.load(w / "bump_height_m.npy"), np.load(w / "obstacles.npy")
    est = np.load(w / "bump_estimated.npy") if (w / "bump_estimated.npy").exists() else None
    text = prompt(cfg)
    items, raw = [], []
    for c in cams:
        img_path = w / "images" / c["name"]
        if not img_path.exists():
            continue
        img = Image.open(img_path).convert("RGB")
        W, H = img.size
        msgs = [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": text}]}]
        inputs = proc.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt").to("cuda")
        with torch.no_grad():
            ids = model.generate(**inputs, max_new_tokens=1024, do_sample=False)
        answer = proc.batch_decode(ids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
        props = rl.parse(answer)
        raw.append({"frame": c["name"], "answer": answer, "parsed": len(props)})
        if not props:
            continue
        K = np.array(c["K"], float) * [[W / c["width"]], [H / c["height"]], [1]]   # cameras.json K may be at another resolution
        with torch.no_grad():
            out, alpha, _ = rasterization(G["means"], G["quats"], G["scales"], G["opacities"], white, t(c["w2c"])[None], t(K)[None], W, H,
                                          render_mode="RGB+ED")
        depth = np.where(alpha[0, ..., 0].cpu().numpy() > 0.1, out[0, ..., 3].cpu().numpy(), np.inf)
        for p in props:
            px = [p["pixel"][0] / 1000 * W, p["pixel"][1] / 1000 * H]
            X = rl.lift(px, depth, c["w2c"], K)
            if X is None:
                continue
            items.append({**p, "position_m": [round(float(x), 3) for x in X], "frames": [c["name"]],
                          **rl.verdict(X, p["kind"], grid, bump, obst, est)})
    merged = rl.merge(items)
    res = {"model": a.model, "frames": len(raw), "proposals": len(items), "hazards": merged,
           "counts": {k: sum(m["verdict"].startswith(k) for m in merged) for k in ("confirmed", "dismissed", "unmeasurable", "not seen")},
           "label": "proposed by Cosmos Reason, checked against the measured grids; never a measurement itself"}
    key = ROOT / "proof" / "reason" / f"answer_key_{cfg['run_name']}.yaml"
    if key.exists():
        import yaml
        truth = yaml.safe_load(key.read_text()).get("items") or []
        # an empty key (the template, not filled in yet) would score every claim as a false positive: no score at all
        res["evaluation"] = rl.evaluate(merged, truth) if truth else {"note": f"{key.name} has no items yet: not scored"}
    (w / "reason.json").write_text(json.dumps(res, indent=1))
    (w / "reason_raw.json").write_text(json.dumps(raw, indent=1))
    print(json.dumps({k: v for k, v in res.items() if k != "hazards"}, indent=1))


if __name__ == "__main__":
    main()

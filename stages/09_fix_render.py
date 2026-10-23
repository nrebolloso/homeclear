"""Stage 9: render the splat at each hazard, send it to a pluggable image-editing backend, save before/after.

Every 'after' image is stamped VISUALIZATION: generated pixels are never used for measurement.
"""
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, read_ply, ply_xyz

import numpy as np
from PIL import Image, ImageDraw, ImageFont

PROMPTS = {
    "tight_clearance": "Rearrange the furniture so there is a wide, clear walking path for a person using a walker. Keep the room otherwise unchanged.",
    "floor_bump": "Remove the rug or raised threshold from the floor so the floor is flat and continuous. Keep the room otherwise unchanged.",
}


class ImageEditor:
    """Backend interface: return an edited copy of `image` following `prompt`."""
    needs_env = None  # env var holding an API key, if any

    def edit(self, image: Image.Image, prompt: str) -> Image.Image:
        raise NotImplementedError


class StubEditor(ImageEditor):
    def edit(self, image, prompt):
        return image.copy()


BACKENDS = {"stub": StubEditor}  # add real backends here, e.g. {"my_api": MyApiEditor}


def watermark(img, text="VISUALIZATION - generated, not measured"):
    img = img.convert("RGB")
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=max(14, img.width // 30))
    box = d.textbbox((0, 0), text, font=font)
    d.rectangle([0, 0, img.width, box[3] + 16], fill=(180, 0, 0))
    d.text((8, 8), text, fill="white", font=font)
    return img


def look_at(eye, target):
    fwd = (target - eye) / np.linalg.norm(target - eye)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    R = np.stack([right, np.cross(fwd, right), fwd], 1)  # cam->world, OpenCV axes (x right, y down, z fwd)
    w2c = np.eye(4)
    w2c[:3, :3], w2c[:3, 3] = R.T, -R.T @ eye
    return w2c


def main(cfg):
    import torch
    from gsplat import rasterization
    w, fc = cfg["work"], cfg["fix"]
    hazards = json.loads((w / "hazards.json").read_text())["hazards"][:fc["max_renders"]]
    if not hazards:
        return None, {"note": "no hazards to render"}
    name = fc["backend"]
    cls = BACKENDS.get(name, StubEditor)
    if cls.needs_env and not os.environ.get(cls.needs_env):
        cls = StubEditor
    editor = cls()

    v = read_ply(w / "splat_aligned.ply")
    t = lambda a: torch.tensor(np.ascontiguousarray(a), dtype=torch.float32, device="cuda")
    N = len(v)
    K_rest = len([p for p in v.dtype.names if p.startswith("f_rest_")]) // 3
    sh = np.concatenate([np.stack([v[f"f_dc_{i}"] for i in range(3)], 1)[:, None],
                         np.stack([v[f"f_rest_{i}"] for i in range(3 * K_rest)], 1).reshape(N, 3, K_rest).transpose(0, 2, 1)], 1)
    means = t(ply_xyz(v))
    quats = t(np.stack([v[f"rot_{i}"] for i in range(4)], 1))
    scales = torch.exp(t(np.stack([v[f"scale_{i}"] for i in range(3)], 1)))
    opac = torch.sigmoid(t(v["opacity"]))
    Wd, Hd, f = 960, 720, 600.0
    K = t([[f, 0, Wd / 2], [0, f, Hd / 2], [0, 0, 1]])

    out_dir = w / "renders"
    out_dir.mkdir(exist_ok=True)
    renders, alphas = [], []
    for h in hazards:
        pos = np.array(h["position_m"])
        back = np.array([*h["heading_xy"], 0.0])
        eye = pos - fc["camera_back_m"] * back + [0, 0, fc["camera_height_m"]]
        with torch.no_grad():
            img, alpha, _ = rasterization(means, quats, scales, opac, t(sh), t(look_at(eye, pos))[None], K[None], Wd, Hd,
                                          sh_degree=int(np.sqrt(K_rest + 1)) - 1)
        before = Image.fromarray((img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
        after = watermark(editor.edit(before, PROMPTS[h["type"]]))
        b, a = out_dir / f"hazard_{h['id']}_before.png", out_dir / f"hazard_{h['id']}_after.png"
        before.save(b)
        after.save(a)
        alphas.append(alpha.mean().item())
        renders.append({"hazard_id": h["id"], "before": str(b.relative_to(w)), "after": str(a.relative_to(w)),
                        "backend": type(editor).__name__, "prompt": PROMPTS[h["type"]], "label": "VISUALIZATION"})
    (w / "renders.json").write_text(json.dumps(renders, indent=2))
    m = {"renders": len(renders), "backend": type(editor).__name__, "min_alpha_coverage": round(min(alphas), 2)}
    return min(alphas) > 0.5, m


if __name__ == "__main__":
    run_stage("09_fix_render", main)

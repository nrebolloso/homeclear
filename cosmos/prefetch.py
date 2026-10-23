"""Step 3: download every checkpoint the single-view runs need into HF_HUB_CACHE (CPU job, no GPU time wasted).
Uses the repo's own checkpoint registry so the pinned revisions match what inference will ask for."""
import json, os, sys, time
from huggingface_hub import snapshot_download
from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
from cosmos_transfer2.config import BASE_MODEL_VARIANTS, MODEL_CHECKPOINTS
from cosmos_transfer2._src.imaginaire.utils.checkpoint_db import _CHECKPOINTS
from cosmos_transfer2._src.imaginaire.auxiliary.guardrail.common.core import GUARDRAIL1_CHECKPOINT

todo = [(c.full_name, c.hf.repository, c.download) for k, c in MODEL_CHECKPOINTS.items()
        if k.variant in BASE_MODEL_VARIANTS and not k.distilled]           # edge, blur(vis), depth, seg
shared = {c.uuid: c for c in _CHECKPOINTS.values() if c.name in ("Qwen/Qwen2.5-VL-7B-Instruct", "Wan2.1/vae", "nvidia/Cosmos-Reason1.1-7B")}
todo += [(c.full_name, c.hf.repository, c.download) for c in shared.values()]
todo += [("guardrail1", GUARDRAIL1_CHECKPOINT.repository, GUARDRAIL1_CHECKPOINT.download),
         ("qwen3guard", "Qwen/Qwen3Guard-Gen-0.6B", lambda: snapshot_download("Qwen/Qwen3Guard-Gen-0.6B"))]

r, ok = {"step": "download", "items": []}, True
t0 = time.time()
for name, repo, fn in todo:
    t = time.time()
    try:
        path = fn()
        r["items"].append({"name": name, "path": str(path), "s": round(time.time() - t)})
    except (GatedRepoError, RepositoryNotFoundError) as e:
        ok = False
        r["items"].append({"name": name, "error": f"accept the license at https://huggingface.co/{repo} (and be logged in): {type(e).__name__}"})
    except Exception as e:
        ok = False
        r["items"].append({"name": name, "error": f"{type(e).__name__}: {e}"[:400]})
    print(json.dumps(r["items"][-1]), flush=True)
r.update(status="PASS" if ok else "FAIL", total_s=round(time.time() - t0),
         cache_gb=round(sum(f.stat().st_size for f in __import__("pathlib").Path(os.environ["HF_HUB_CACHE"]).rglob("*") if f.is_file() and not f.is_symlink()) / 1e9, 1))
open(os.environ["RESULT"], "w").write(json.dumps(r, indent=1))
sys.exit(0 if ok else 1)

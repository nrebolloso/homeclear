#!/bin/bash
#SBATCH --job-name=cosmos-envcheck
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=2
#SBATCH --mem=16gb
#SBATCH --time=00:15:00
#SBATCH --output=logs/%x-%j.log
# Step 2b: does torch inside the container see the B200, with BF16, and do the repo's CUDA libraries import?
set -uo pipefail
cd $HPG_ROOT/cosmos && source env.sh
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
ct python - <<'PY'
import json, importlib, os, torch
r = {"step": "envcheck", "device": torch.cuda.get_device_name(0), "capability": torch.cuda.get_device_capability(0),
     "torch": torch.__version__, "torch_cuda": torch.version.cuda, "bf16": torch.cuda.is_bf16_supported(),
     "arch_list": torch.cuda.get_arch_list()}
x = torch.randn(4096, 4096, device="cuda", dtype=torch.bfloat16)
r["bf16_matmul_ok"] = bool(torch.isfinite(x @ x).all())
for m in ["flash_attn", "transformer_engine", "natten", "decord", "cosmos_transfer2.inference"]:
    try:
        mod = importlib.import_module(m); r[m] = getattr(mod, "__version__", "ok")
    except Exception as e:
        r[m] = f"FAIL: {type(e).__name__}: {e}"[:300]
r["status"] = "PASS" if "B200" in r["device"] and r["bf16"] and r["bf16_matmul_ok"] and not str(r["cosmos_transfer2.inference"]).startswith("FAIL") else "FAIL"
print(json.dumps(r, indent=1)); open(os.environ["HPG_ROOT"] + "/cosmos/results/envcheck.json", "w").write(json.dumps(r, indent=1))
raise SystemExit(r["status"] != "PASS")   # non-zero exit so afterok dependents don't start
PY

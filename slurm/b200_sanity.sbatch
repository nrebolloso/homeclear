#!/bin/bash
#SBATCH --job-name=hc-b200check
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=2
#SBATCH --mem=16gb
#SBATCH --time=00:15:00
#SBATCH --output=logs/%x-%j.log
# Short B200 check before GPU jobs: driver, torch build, BF16 matmul, gsplat + fused-ssim CUDA kernels forward/backward.
set -euo pipefail
cd $HPG_ROOT/Homeclear
source slurm/env.sh
hostname; nvidia-smi; nvcc --version | tail -2
python -I - <<'EOF'
import json, time, torch, gsplat
from importlib.metadata import version
r = {"torch": torch.__version__, "torch_cuda": torch.version.cuda, "cudnn": torch.backends.cudnn.version(),
     "device": torch.cuda.get_device_name(0), "capability": torch.cuda.get_device_capability(0),
     "torch_arch_list": torch.cuda.get_arch_list(), "gsplat": gsplat.__version__}
cap = "sm_%d%d" % r["capability"]
assert cap in r["torch_arch_list"], f"torch build lacks {cap}"

# BF16 matmul: compare with FP32 and time it
a, b = (torch.randn(8192, 8192, device="cuda") for _ in range(2))
ref = a @ b
ab, bb = a.bfloat16(), b.bfloat16()
ab @ bb; torch.cuda.synchronize(); t = time.time()
for _ in range(20): c = ab @ bb
torch.cuda.synchronize(); dt = (time.time() - t) / 20
r["bf16_matmul_tflops"] = round(2 * 8192 ** 3 / dt / 1e12, 1)
r["bf16_rel_err_vs_fp32"] = round(((c.float() - ref).norm() / ref.norm()).item(), 5)
assert r["bf16_rel_err_vs_fp32"] < 0.02

# gsplat: render 100k random Gaussians, backprop to every parameter (runs the forward and backward CUDA kernels)
d, n = "cuda", 100_000
means = (torch.randn(n, 3, device=d) * 0.5 + torch.tensor([0, 0, 3.0], device=d)).requires_grad_()
quats = torch.randn(n, 4, device=d).requires_grad_()
scales = torch.full((n, 3), -4.0, device=d).requires_grad_()
opac = torch.zeros(n, device=d).requires_grad_()
cols = torch.rand(n, 3, device=d).requires_grad_()
K = torch.tensor([[500.0, 0, 320], [0, 500, 240], [0, 0, 1]], device=d)[None]
torch.cuda.synchronize(); t = time.time()
img, alpha, _ = gsplat.rasterization(means, torch.nn.functional.normalize(quats, dim=-1), scales.exp(), opac.sigmoid(),
                                     cols, torch.eye(4, device=d)[None], K, 640, 480)
img.sum().backward(); torch.cuda.synchronize()
r["gsplat_fwd_bwd_s"] = round(time.time() - t, 3)
r["gsplat_alpha_mean"] = round(alpha.mean().item(), 3)
r["gsplat_grads_finite"] = all(torch.isfinite(p.grad).all().item() and p.grad.abs().sum().item() > 0 for p in (means, quats, scales, opac, cols))
assert r["gsplat_alpha_mean"] > 0 and r["gsplat_grads_finite"]

# fused-ssim (used by gsplat's trainer); compiled ahead of time, so a missing arch shows up here
try:
    from fused_ssim import fused_ssim
    x = torch.rand(1, 3, 256, 256, device=d, requires_grad=True)
    s = fused_ssim(x, x.detach() * 0.9); s.backward()
    r["fused_ssim"] = {"version": version("fused_ssim"), "ssim": round(s.item(), 4), "grad_finite": bool(torch.isfinite(x.grad).all())}
except Exception as e:
    r["fused_ssim"] = f"FAILED: {e!r}"
r["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 2)
print("SANITY " + json.dumps(r))
print("B200 SANITY PASS" if isinstance(r["fused_ssim"], dict) else "B200 SANITY PARTIAL (fused-ssim)")
EOF

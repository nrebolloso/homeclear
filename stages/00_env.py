"""Stage 0: GPU visible, torch.cuda works, gsplat CUDA kernels compile/run, COLMAP + ffmpeg available."""
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, FFMPEG


def main(cfg):
    import torch, gsplat, pycolmap, cv2
    m = {"torch": torch.__version__, "torch_cuda": torch.version.cuda, "gsplat": gsplat.__version__,
         "pycolmap": pycolmap.__version__, "opencv": cv2.__version__}
    m[FFMPEG] = subprocess.run([FFMPEG, "-version"], capture_output=True, text=True).stdout.split("\n")[0]
    m["driver"] = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                                 capture_output=True, text=True).stdout.strip()
    assert torch.cuda.is_available(), "torch.cuda.is_available() is False"
    major, minor = torch.cuda.get_device_capability(0)
    m["gpu"] = f"{torch.cuda.get_device_name(0)} (sm_{major}{minor})"
    assert f"sm_{major}{minor}" in torch.cuda.get_arch_list(), f"torch build lacks sm_{major}{minor}: {torch.cuda.get_arch_list()}"
    # tiny render forces gsplat's CUDA extension to load (or JIT-compile)
    d = "cuda"
    N = 1000
    img, alpha, _ = gsplat.rasterization(
        torch.randn(N, 3, device=d) + torch.tensor([0, 0, 5.0], device=d),
        torch.nn.functional.normalize(torch.randn(N, 4, device=d), dim=-1),
        torch.full((N, 3), 0.05, device=d), torch.ones(N, device=d), torch.rand(N, 3, device=d),
        torch.eye(4, device=d)[None], torch.tensor([[200.0, 0, 64], [0, 200, 64], [0, 0, 1]], device=d)[None], 128, 128)
    m["gsplat_render_alpha_mean"] = round(alpha.mean().item(), 3)
    return alpha.mean().item() > 0 and m[FFMPEG].startswith("ffmpeg"), m


if __name__ == "__main__":
    run_stage("00_env", main)

# Third-party notices

Homeclear's own code is under the MIT License (`LICENSE`). It uses the software, models and assets below, each under
its own licence. Nothing listed here is relicensed by this project.

## Viewer (`viewer/`, npm)

| Package | Version | Licence | Used for |
|---|---|---|---|
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | 3D rendering, WebXR |
| [@sparkjsdev/spark](https://github.com/sparkjsdev/spark) | 2.4.0 | MIT | Gaussian splat rendering |
| [@dimforge/rapier3d-compat](https://github.com/dimforge/rapier.js) | 0.21.0 | Apache-2.0 | walker physics |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | the fix card's QR code |
| [vite](https://github.com/vitejs/vite) (dev) | 8.3.5 | MIT | dev server and build |
| [typescript](https://github.com/microsoft/TypeScript) (dev) | 7.0.2 | Apache-2.0 | type checking |
| [iwer](https://github.com/meta-quest/immersive-web-emulation-runtime) (dev) | 2.5.0 | MIT | emulated headset for tests |
| [playwright-core](https://github.com/microsoft/playwright) (dev) | 1.64.1 | Apache-2.0 | end-to-end tests |

## Pipeline (Python, laptop and HiPerGator)

| Package | Licence | Notes |
|---|---|---|
| numpy, scipy, pandas | BSD-3-Clause | |
| opencv-python | Apache-2.0 | |
| pillow | MIT-CMU (HPND) | |
| pyyaml | MIT | |
| matplotlib | Matplotlib License (PSF-based) | |
| [plyfile](https://github.com/dranjan/python-plyfile) | **GPL-3.0** | Imported by the pipeline, not bundled. Anyone redistributing the pipeline together with plyfile must follow GPL-3.0 for that combined work. |
| PyTorch, torchvision | BSD-3-Clause | |
| [COLMAP / pycolmap](https://github.com/colmap/colmap) (with GLOMAP global mapping) | BSD-3-Clause | structure from motion |
| [gsplat](https://github.com/nerfstudio-project/gsplat), [nerfview](https://github.com/nerfstudio-project/nerfview) | Apache-2.0 | splat training |
| [fused-ssim](https://github.com/rahul-goel/fused-ssim) | see its repository | splat training loss |
| transformers, accelerate | Apache-2.0 | |
| [simple-lama-inpainting](https://github.com/enesmsahin/simple-lama-inpainting) | see its repository | wrapper around LaMa |
| tyro, viser, jaxtyping, rich, fire, tensorly, ninja, nvtx | permissive (MIT / Apache-2.0 / BSD) | see each project |

## Models

| Model | Licence | Notes |
|---|---|---|
| NVIDIA Cosmos-Transfer2.5-2B, Cosmos-Predict2.5-2B, Cosmos-Reason1.1-7B, Cosmos-Reason2-8B, Cosmos-Guardrail1 | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreement/ai/nvidia-open-model-license/) | downloaded from Hugging Face after accepting the licence; not redistributed here |
| Qwen2.5-VL-7B-Instruct | Apache-2.0 | used by the Cosmos pipeline |
| Wan2.1 VAE | Apache-2.0 | used by the Cosmos pipeline |
| [Depth Anything V2 Large](https://huggingface.co/depth-anything/Depth-Anything-V2-Large-hf) | **CC BY-NC 4.0 (non-commercial)** | depth priors for splat training. For commercial use, swap in Depth Anything V2 Small (Apache-2.0). |
| [LaMa / Big-LaMa](https://github.com/advimman/lama) | Apache-2.0 | inpainting where furniture was removed |

## Assets and data

| Asset | Licence | Notes |
|---|---|---|
| `viewer/public/models/mannequin/CesiumMan.glb`, Cesium 2017 ([glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan)) | CC BY 4.0 | unchanged; credits in `viewer/public/models/mannequin/CREDITS.md`. The Cesium logo on its texture is a Cesium trademark, not covered by the licence. |
| `viewer/public/models/hands/` ([WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles)) | MIT | tracked-hand models |
| Mip-NeRF 360 "room" scene (public smoke test only, fetched by `slurm/fetch_public.sbatch`) | see the [Mip-NeRF 360 project page](https://jonbarron.info/mipnerf360/) | not redistributed here |
| Home scans in `data/` and `out/` | the team's own captures | |

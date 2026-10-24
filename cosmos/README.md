# Cosmos-Transfer2.5-2B smoke test on HiPerGator

Goal: prove a Cosmos-Transfer2.5-2B video can be generated on a B200, and measure time and peak VRAM.
Separate from the discharge pipeline; nothing here feeds a measurement (outputs are visualizations).

Source: `nvidia-cosmos/cosmos-transfer2.5` @ `2ff49d0`. Note: the repo says it gets only
limited maintenance and points to Cosmos 3 (github.com/NVIDIA/Cosmos).

## Why a container
The repo's plain install wants glibc >= 2.35; HiPerGator is RHEL 9 (glibc 2.34). The repo's Blackwell
Docker path (`docker/nightly.Dockerfile`) is `nvcr.io/nvidia/pytorch:25.10-py3` + `docker/nightly-requirements.txt`
+ the repo's own packages. We pull that base image with Apptainer and do the same installs into a venv on /blue.

## Layout on HPG (`$HPG_ROOT/cosmos`)
`cosmos-transfer2.5/` repo · `containers/pytorch_25.10-py3.sif` · `venv/` · `hf/hub/` checkpoints ·
`outputs/<run>/` · `results/<step>.json` · `logs/` · `cosmos_smoke_report.md`

## One-time: Hugging Face
1. Accept the licenses (logged in to HF, click "Agree" on each):
   - https://huggingface.co/nvidia/Cosmos-Transfer2.5-2B
   - https://huggingface.co/nvidia/Cosmos-Predict2.5-2B (the video tokenizer comes from here)
   - https://huggingface.co/nvidia/Cosmos-Guardrail1
2. Log in on the HPG login node (writes `~/.cache/huggingface/token`; nothing in this repo reads or stores it):
   `apptainer exec $HPG_ROOT/cosmos/containers/pytorch_25.10-py3.sif $HPG_ROOT/cosmos/venv/bin/hf auth login`

## Run order (from the laptop: `rsync -a cosmos/ hpg:$HPG_ROOT/cosmos/`, then on HPG in that dir)
```bash
sbatch slurm/cosmos_setup.sbatch        # 2a  CPU, burst QOS: pull image, install          results/setup.json
sbatch slurm/cosmos_envcheck.sbatch     # 2b  B200: device, CUDA, BF16, CUDA libs import    results/envcheck.json
sbatch slurm/cosmos_download.sbatch     # 3   CPU: checkpoints -> hf/hub (needs login)      results/download.json
sbatch slurm/cosmos_example.sbatch      # 4   B200: repo's robot edge example               outputs/example_edge/
# laptop: .venv/bin/python cosmos/prepare_hallway.py --start <sec>   (93 frames, 1280x720, 16 fps + spec), rsync cosmos/inputs
sbatch slurm/cosmos_hallway.sbatch      # 5   B200: hallway, edge + blur from RGB          outputs/hallway/
sbatch slurm/cosmos_splat.sbatch configs/home.yaml   # 6 B200: Cosmos on splat renders (see below)
python3 make_report.py                  # -> cosmos_smoke_report.md
```
Each inference job logs the exact command, model load vs generation wall time, peak VRAM (`nvidia-smi` at 2 Hz
and torch's own peak), and writes `results/<run>.json`.

Guardrails stay on: the NVIDIA Open Model License does not allow bypassing them.

## Cosmos on the splat (the hackathon path)
`sbatch slurm/cosmos_splat.sbatch configs/home.yaml` (from this folder, once stages 5-7 have run for that config):
1. `render_route.py` (pipeline env, gsplat) renders the splat along the stage-7 walker route at 1.2 m eye height,
   93 frames 1280x720: RGB, depth (inverse, near = bright) and segmentation (one colour per obstacle component of the
   stage-6 grid, floor, rug layer). It also moves the obstacle nearest the route 0.6 m away and renders that scene:
   the floor it uncovers was never filmed, so its depth comes from the floor plane and `route_moved_mask.mp4` marks it.
   Preview: `<work>/route/route_preview.jpg`.
2. Cosmos Transfer (depth + seg control) generates `route_night` (3 AM) and `route_moved` (revealed floor filled).
3. `tint.py` stamps both as VISUALIZATION and tints the imagined area magenta: `outputs/route_*/route_*_labeled.mp4`.
Nothing generated is measured: hazards and clearances stay with stages 6-8.

## Hook: depth + segmentation from the splat (for the kitchen clip)
Render 93-frame depth and segmentation videos along the same camera path from the splat, then
`prepare_hallway.py --depth depth.mp4 --seg seg.mp4` adds them to the spec as precomputed controls.

#!/bin/bash
#SBATCH --job-name=cosmos-setup
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=8
#SBATCH --mem=32gb
#SBATCH --time=02:00:00
#SBATCH --output=logs/%x-%j.log
# Step 2a: pull the NGC PyTorch 25.10 image (CUDA 13, Blackwell) and install the repo the way docker/nightly.Dockerfile does.
set -euo pipefail
cd $HPG_ROOT/cosmos && source env.sh
trap 'echo "{\"step\": \"setup\", \"status\": \"FAIL\", \"pull_s\": 0, \"install_s\": 0}" > results/setup.json' ERR
t0=$(date +%s)
mkdir -p $(dirname $SIF)
[ -f $SIF ] || apptainer pull $SIF docker://nvcr.io/nvidia/pytorch:25.10-py3
t1=$(date +%s)
apptainer exec -B /blue $SIF bash -c "set -e
  [ -d $VENV ] || python -m venv --system-site-packages $VENV
  source $VENV/bin/activate && cd $REPO
  pip install -q -r docker/nightly-requirements.txt
  pip install -q --no-deps packages/*
  pip install -q --no-deps -e .
  # The Dockerfile apt-installs libx11-dev + ffmpeg, which an Apptainer pull can't. libX11 is only needed by GUI
  # opencv-python; keep the headless build of the same pinned version, and expose imageio-ffmpeg's bundled ffmpeg.
  pip uninstall -q -y opencv-python opencv-python-headless && pip install -q --no-deps opencv-python-headless==4.12.0.88
  ln -sf \$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())') $VENV/bin/ffmpeg
  # full cosmos_transfer2.inference import needs a GPU (flash-attn check); cosmos_envcheck.sbatch does it on the B200
  python -c 'import cosmos_transfer2, cosmos_oss, cv2, torch; print(\"installed: torch\", torch.__version__, \"cv2\", cv2.__version__)'"
t2=$(date +%s)
echo "{\"step\": \"setup\", \"status\": \"PASS\", \"pull_s\": $((t1-t0)), \"install_s\": $((t2-t1))}" > results/setup.json
cat results/setup.json

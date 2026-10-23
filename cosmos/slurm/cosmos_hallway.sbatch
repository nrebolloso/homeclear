#!/bin/bash
#SBATCH --job-name=cosmos-hallway
#SBATCH --partition=hpg-b200
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32gb   # peak RSS 18 GB
#SBATCH --time=01:00:00
#SBATCH --output=logs/%x-%j.log
# Step 5: our hallway clip (inputs/hallway_spec.json from prepare_hallway.py): edge + blur auto-extracted from the RGB.
# Hook: re-run prepare_hallway.py with --depth/--seg <mp4 rendered from the splat> and the spec gains those controls.
set -uo pipefail
cd $HPG_ROOT/cosmos && source env.sh && source run_infer.sh
run_infer hallway $C/inputs/hallway_spec.json

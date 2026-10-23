#!/bin/bash
#SBATCH --job-name=hc-glomap-ba
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=64gb
#SBATCH --time=03:00:00
#SBATCH --output=logs/%x-%j.log
# Global bundle adjustment on glomap.sbatch's model (its raw poses gave kitchen1 a PSNR 14.6 splat vs 28.5 from the
# incremental poses), then deregister frames with no 3D points (gsplat's parser KeyErrors on them).
#   sbatch slurm/glomap_ba.sbatch <run>   -> out/<run>_glomap/colmap/best_ba, glomap_ba.json, datasets/<run>_glomap_ba
set -euo pipefail
RUN=$1
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
W=$R/out/${RUN}_glomap
python - $W <<'EOF'
import json, sys, time
from pathlib import Path
import pycolmap
w = Path(sys.argv[1]); col = w / "colmap"
rec = pycolmap.Reconstruction(col / "best")
e0, t0 = rec.compute_mean_reprojection_error(), time.time()
for it in range(3):   # BA, drop high-error observations, repeat (COLMAP's own final-BA loop)
    pycolmap.bundle_adjustment(rec)
    pycolmap.ObservationManager(rec).filter_all_points3D(4.0, 1.5)
empty = {i.frame_id for i in rec.images.values() if i.has_pose and i.num_points3D == 0}   # one camera per frame here
for f in empty:
    rec.deregister_frame(f)
(col / "best_ba").mkdir(exist_ok=True); rec.write(col / "best_ba")
m = {"registered": rec.num_reg_images(), "dropped_no_points": len(empty), "points3D": rec.num_points3D(),
     "reproj_err_px_before": round(e0, 3), "reproj_err_px": round(rec.compute_mean_reprojection_error(), 3), "ba_s": round(time.time() - t0)}
(w / "glomap_ba.json").write_text(json.dumps(m)); print("glomap_ba", m)
EOF
python slurm/drop_far_cams.py $W/colmap/best_ba
D=$HPG_ROOT/datasets/${RUN}_glomap_ba; mkdir -p $D/sparse
ln -sfn $W/images $D/images; ln -sfn $W/colmap/best_ba $D/sparse/0

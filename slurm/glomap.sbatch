#!/bin/bash
#SBATCH --job-name=hc-glomap
# CPU-only: submit with --qos=$HPG_GROUP-b (burst QOS, so it does not wait on the group CPU cap)
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=24
#SBATCH --mem=96gb
#SBATCH --time=06:00:00
#SBATCH --output=logs/%x-%j.log
# Global SfM (GLOMAP, merged into COLMAP 4 as pycolmap.global_mapping) on an existing run's features + matches, for
# comparison with stage 2's incremental mapper: same frames, same database, only the mapper differs.
#   sbatch slurm/glomap.sbatch <run>   -> out/<run>_glomap/{colmap/best, cameras.json, glomap.json}, datasets/<run>_glomap
set -euo pipefail
RUN=$1
R=$HPG_ROOT/Homeclear
cd $R && source slurm/env.sh
SRC=$R/out/$RUN; W=$R/out/${RUN}_glomap; mkdir -p $W/colmap
# SQLite on /blue (network FS) can SIGBUS when it maps its -shm file: read the database from node-local disk
DB=${TMPDIR:-/tmp}/glomap-$SLURM_JOB_ID.db; cp $SRC/colmap/database.db $DB
ln -sfn $SRC/images $W/images
python - $W $DB <<'EOF'
import json, sys, time
from pathlib import Path
import numpy as np, pycolmap
w = Path(sys.argv[1]); col = w / "colmap"
t0 = time.time()
recs = pycolmap.global_mapping(sys.argv[2], w / "images", col / "sparse")
dt = time.time() - t0
assert recs, "global mapping produced no reconstruction"
rec = max(recs.values(), key=lambda r: r.num_reg_images())
(col / "best").mkdir(exist_ok=True); rec.write(col / "best")
cams = []
for img in sorted(rec.images.values(), key=lambda i: i.name):
    if img.has_pose:
        c = img.camera; w2c = np.eye(4); w2c[:3] = img.cam_from_world().matrix()
        cams.append({"name": img.name, "K": c.calibration_matrix().tolist(), "w2c": w2c.tolist(), "width": c.width, "height": c.height})
(w / "cameras.json").write_text(json.dumps(cams))
n = len(list((w / "images").glob("*.jpg")))
m = {"frames": n, "registered": len(cams), "registered_pct": round(100 * len(cams) / n, 1), "models": len(recs),
     "points3D": rec.num_points3D(), "reproj_err_px": round(rec.compute_mean_reprojection_error(), 3), "mapping_s": round(dt)}
(w / "glomap.json").write_text(json.dumps(m)); print("glomap", m)
EOF
D=$HPG_ROOT/datasets/${RUN}_glomap; mkdir -p $D/sparse
ln -sfn $W/images $D/images; ln -sfn $W/colmap/best $D/sparse/0

"""Stage 2: COLMAP SfM via pycolmap. PASS if >= 80% of frames register. Writes cameras.json for later stages."""
import json, os, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage

import numpy as np
import pycolmap


def main(cfg):
    images = cfg["work"] / "images"
    col = cfg["work"] / "colmap"
    # HiPerGator cancels jobs that leave an allocated GPU idle, and the incremental mapper is CPU-only (bedroom2, killed 2h21m in):
    # SFM_MATCH_ONLY=1 stops after matching (GPU job), SFM_REUSE_DB=1 maps that run's colmap/database.db (CPU job)
    reuse = os.environ.get("SFM_REUSE_DB") == "1"
    if reuse:
        assert (col / "database.db").exists(), "SFM_REUSE_DB=1 but no colmap/database.db"
        for p in col.iterdir():
            if p.name != "database.db":
                shutil.rmtree(p) if p.is_dir() else p.unlink()
    else:
        shutil.rmtree(col, ignore_errors=True)
        col.mkdir()
    # SQLite on /blue (network FS) can SIGBUS when it maps its -shm file: work on a copy on node-local disk ($TMPDIR in a Slurm job)
    tmp = Path(tempfile.mkdtemp())
    db = tmp / "database.db"
    try:
        if reuse:
            shutil.copy2(col / "database.db", db)
        else:
            # shortcut: PINHOLE (no distortion) skips an undistort step; phone video is ISP-undistorted. Use OPENCV + undistort_images if PSNR is poor.
            reader = pycolmap.ImageReaderOptions(camera_model="PINHOLE")
            n = len(os.sched_getaffinity(0))  # the job's cores: pycolmap's default is every core on the node, and each SIFT thread costs RAM (400 frames OOMed 48 GB)
            pycolmap.extract_features(db, images, camera_mode=pycolmap.CameraMode.SINGLE, reader_options=reader,
                                      extraction_options=pycolmap.FeatureExtractionOptions(num_threads=n))
            match = pycolmap.FeatureMatchingOptions(num_threads=n)
            if cfg["colmap"]["matcher"] == "exhaustive":
                pycolmap.match_exhaustive(db, matching_options=match)
            else:
                pycolmap.match_sequential(db, matching_options=match)
            shutil.copy2(db, col / "database.db")   # before mapping, so a killed mapper keeps the matches (GLOMAP reuses them too)
            if os.environ.get("SFM_MATCH_ONLY") == "1":
                return None, {"frames": len(list(images.glob("*.jpg"))), "matched_only": True}
        recs = pycolmap.incremental_mapping(db, images, col / "sparse")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    assert recs, "COLMAP produced no reconstruction"
    rec = max(recs.values(), key=lambda r: r.num_reg_images())
    (col / "best").mkdir()
    rec.write(col / "best")
    n_total = len(list(images.glob("*.jpg")))
    cams = []
    for img in sorted(rec.images.values(), key=lambda i: i.name):
        if not img.has_pose:
            continue
        c = img.camera
        w2c = np.eye(4)
        w2c[:3] = img.cam_from_world().matrix()
        cams.append({"name": img.name, "K": c.calibration_matrix().tolist(), "w2c": w2c.tolist(),
                     "width": c.width, "height": c.height})
    (cfg["work"] / "cameras.json").write_text(json.dumps(cams))
    frac = len(cams) / n_total
    m = {"frames": n_total, "registered": len(cams), "registered_pct": round(100 * frac, 1),
         "models": len(recs), "points3D": rec.num_points3D(),
         "reproj_err_px": round(rec.compute_mean_reprojection_error(), 3)}
    return frac >= cfg["colmap"]["min_registered"], m


if __name__ == "__main__":
    run_stage("02_poses", main)

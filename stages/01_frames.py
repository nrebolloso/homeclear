"""Stage 1: extract ~target sharp frames from the video (3x oversample, keep sharpest per window)."""
import shutil, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, ROOT, FFMPEG

import cv2
import numpy as np

# HDR phone video (iPhone HLG/Dolby Vision, BT.2020) to SDR BT.709: without it the JPEGs come out flat and yellow-shifted
TONEMAP = "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"


def main(cfg):
    fc = cfg["frames"]
    video = ROOT / Path(cfg["video"]).expanduser()  # relative paths are from the repo root
    cand, out = cfg["work"] / "candidates", cfg["work"] / "images"
    # reuse_selection: <images dir of an earlier run>: re-extract those same frames (e.g. tone-mapped) so its poses still match
    names = {f.name for f in (ROOT / fc["reuse_selection"]).glob("*.jpg")} if fc.get("reuse_selection") else set()
    for d in (cand, out):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate:format=duration",
                            "-of", "default=nw=1:nk=1", str(video)], capture_output=True, text=True, check=True).stdout.split()
    native, dur = eval(probe[0]), float(probe[1])  # avg_frame_rate is a fraction like "30000/1001"
    fps = min(3 * fc["target"] / dur, native)  # never oversample past the real frames (duplicates)
    s = fc["max_side"]
    subprocess.run([FFMPEG, "-v", "error", "-i", str(video), "-vf",
                    f"{TONEMAP if fc.get('hdr_tonemap') else ''}fps={fps},scale='if(gt(iw,ih),min({s},iw),-2)':'if(gt(iw,ih),-2,min({s},ih))'",
                    "-q:v", "2", str(cand / "%05d.jpg")], check=True)
    files = sorted(cand.glob("*.jpg"))
    ex = fc.get("exclude_s", [])  # [[start, end], ...] seconds of footage to skip (a hand or person in frame)
    files = [f for n, f in enumerate(files) if not any(a <= n / fps <= b for a, b in ex)]
    sharp = np.array([cv2.Laplacian(cv2.imread(str(f), cv2.IMREAD_GRAYSCALE), cv2.CV_64F).var() for f in files])
    keep = [w[np.argmax(sharp[w])] for w in np.array_split(np.arange(len(files)), min(fc["target"], len(files)))]
    if names:
        keep = [i for i, f in enumerate(files) if f.name in names]
    for i in keep:
        shutil.copy(files[i], out / files[i].name)
    shutil.rmtree(cand)
    m = {"candidates": len(files), "frames": len(keep), "median_sharpness": round(float(np.median(sharp[keep])), 1),
         "median_sharpness_dropped": round(float(np.median(np.delete(sharp, keep))), 1) if len(files) > len(keep) else None}
    return len(keep) >= fc["min"], m


if __name__ == "__main__":
    run_stage("01_frames", main)

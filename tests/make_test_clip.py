"""Synthetic Cosmos-style clip for the clip-overlay test (no GPU, no Cosmos):
  .venv/bin/python tests/make_test_clip.py viewer/public/exports/<job>   -> viewer/public/clips/test_<job>.{mp4,json}
Each frame k has a green dot at cosmos/render_controls.project() of every hazard (the Python side's projection) and
frame number k as 12 black/white squares along the top-left (bit b at x = 8 + 20*b, y = 8). The viewer test seeks
to known frames and checks its overlay markers sit on the dots and its frame index matches the code.
"""
import json, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos")]
from render_controls import project
from common import FFMPEG

import cv2
import numpy as np

BITS, BIT_PX, BIT_Y = 12, 20, 8   # top edge: floor-level hazards project low in the frame


def main(job_dir):
    job = json.loads((Path(job_dir) / "cosmos_job.json").read_text())
    W, H = job["width"], job["height"]
    name = f"test_{job['job']}"
    out = ROOT / "viewer" / "public" / "clips"
    out.mkdir(parents=True, exist_ok=True)
    pos = np.array([h["position"] for h in job["hazards"]], float)
    p = subprocess.Popen([FFMPEG, "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(job["fps"]),
                          "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "1", "-pix_fmt", "yuv420p",
                          "-movflags", "+faststart", str(out / f"{name}.mp4")], stdin=subprocess.PIPE)
    expected = {}
    for k, w2c in enumerate(job["cameras"]):
        f = np.full((H, W, 3), 60, np.uint8)
        uv = project(w2c, job["K"], pos)
        vis = [(i, u) for i, u in enumerate(uv) if np.isfinite(u).all() and 0 <= u[0] < W and 0 <= u[1] < H]
        for b in range(BITS):
            cv2.rectangle(f, (8 + BIT_PX * b, BIT_Y), (8 + BIT_PX * b + 14, BIT_Y + 14), (255, 255, 255) if k >> b & 1 else (0, 0, 0), -1)
        for _, (x, y) in vis:   # after the bits, so a dot is never hidden under them
            cv2.circle(f, (int(round(x)), int(round(y))), 6, (0, 255, 0), -1)
        expected[k] = [[round(float(x), 2), round(float(y), 2), job["hazards"][i]["label"]] for i, (x, y) in vis]
        p.stdin.write(f.tobytes())
    p.stdin.close()
    assert p.wait() == 0
    json.dump({"file": f"{name}.mp4", "title": f"TEST overlay alignment ({job['job']})", "date": job["created"],
               "prompt": "synthetic test pattern: green dots = Python projection of each hazard", "layout": "test",
               "fps": job["fps"], "width": W, "height": H, "K": job["K"], "cameras": job["cameras"], "hazards": job["hazards"],
               "label": "test pattern", "test": {"bits": BITS, "bit_px": BIT_PX, "bit_y": BIT_Y, "expected": expected}},
              open(out / f"{name}.json", "w"))
    busy = [k for k, e in expected.items() if e]
    assert busy, "no hazard is ever in view: nothing to align"
    print(json.dumps({"clip": f"{name}.mp4", "frames": len(job["cameras"]), "frames_with_markers": len(busy)}))


if __name__ == "__main__":
    main(sys.argv[1])

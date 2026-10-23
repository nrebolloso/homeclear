"""Label a Cosmos output as generated: banner on every frame, plus a magenta tint where mask.mp4 is white
(space the camera never saw).  python cosmos/tint.py <cosmos_out.mp4> <out.mp4> [mask.mp4]"""
import sys
import cv2
import numpy as np

src, dst = cv2.VideoCapture(sys.argv[1]), sys.argv[2]
mask = cv2.VideoCapture(sys.argv[3]) if len(sys.argv) > 3 else None
fps = src.get(cv2.CAP_PROP_FPS) or 16
w, h = int(src.get(cv2.CAP_PROP_FRAME_WIDTH)), int(src.get(cv2.CAP_PROP_FRAME_HEIGHT))
out = cv2.VideoWriter(dst, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
n = 0
while True:
    ok, f = src.read()
    if not ok:
        break
    if mask is not None:
        ok_m, m = mask.read()
        if ok_m:
            m = cv2.resize(m, (w, h))[..., 0] > 127   # Cosmos may crop/resize (e.g. 704 rows); stretch the mask to match
            f[m] = (0.65 * f[m] + 0.35 * np.array([255, 0, 255])).astype(np.uint8)
    cv2.rectangle(f, (0, 0), (w, 34), (0, 0, 180), -1)
    label = "VISUALIZATION - generated, not measured" + ("   (magenta = imagined, never filmed)" if mask is not None else "")
    cv2.putText(f, label, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    out.write(f)
    n += 1
out.release()
assert n > 0, f"no frames read from {sys.argv[1]}"
print(f"{dst}: {n} frames")

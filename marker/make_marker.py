"""Make the scale marker: ArUco DICT_4X4_50 id 0 on a white border, as a PNG to show full-screen on a phone/tablet/laptop.

No printer needed. Show it full-screen at full brightness, then tape-measure the BLACK square's edge
and put that in config.yaml scale.marker_size_m. Also tape-measure floor -> marker centre (ground_truth marker_height).
"""
from pathlib import Path
import cv2
import numpy as np

side = 1200
m = cv2.aruco.generateImageMarker(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50), 0, side)
img = np.full((side + 400, side + 400), 255, np.uint8)  # white quiet zone around the black square
img[200:-200, 200:-200] = m
out = Path(__file__).with_name("aruco_4x4_50_id0.png")
cv2.imwrite(str(out), img)
print(out)

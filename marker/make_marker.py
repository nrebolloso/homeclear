"""Make the scale marker: ArUco DICT_4X4_50 id 0.

  python marker/make_marker.py            aruco_4x4_50_id0.png: to show full-screen on a phone/tablet/laptop. Its size
                                          depends on the screen: tape-measure the BLACK square's edge into
                                          scale.marker_size_m.
  python marker/make_marker.py --print    aruco_print_letter.pdf (--a4: aruco_print_a4.pdf): the black square is exactly
                                          150 mm when printed at 100% ("Actual size", not "Fit to page"), with a bank-card
                                          box and a 100 mm ruler on the sheet to check the printer didn't rescale it.
                                          No tape needed: marker_size_m: 0.150, marker_size_estimated: true until checked.
"""
import sys
from pathlib import Path
import cv2
import numpy as np

HERE = Path(__file__).parent
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def screen_png():
    side = 1200
    img = np.full((side + 400, side + 400), 255, np.uint8)  # white quiet zone around the black square
    img[200:-200, 200:-200] = cv2.aruco.generateImageMarker(DICT, 0, side)
    out = HERE / "aruco_4x4_50_id0.png"
    cv2.imwrite(str(out), img)
    return out


def print_pdf(a4=False):
    """One page at 254 dpi (1 mm = 10 px exactly): the marker's black square 150 mm (1500 px = 6 cells of 250 px),
    a bank-card box (ISO/IEC 7810 ID-1, 85.60 x 53.98 mm) and a 100 mm ruler with 1 cm ticks."""
    from PIL import Image, ImageDraw, ImageFont
    w_mm, h_mm = (210.0, 297.0) if a4 else (215.9, 279.4)
    px = lambda mm: int(round(mm * 10))
    page = Image.new("L", (px(w_mm), px(h_mm)), 255)
    d = ImageDraw.Draw(page)
    font = ImageFont.load_default(size=36)
    x0 = (px(w_mm) - 1500) // 2
    page.paste(Image.fromarray(cv2.aruco.generateImageMarker(DICT, 0, 1500)), (x0, px(18)))
    y = px(18) + 1500 + px(6)
    d.text((x0, y), "ArUco 4x4_50 id 0. Black square = 150 mm when printed at 100% (Actual size).", fill=0, font=font)
    y += px(9)
    cw, ch = px(85.60), px(53.98)
    d.rectangle([x0, y, x0 + cw, y + ch], outline=0, width=3)
    d.text((x0 + cw + px(6), y + px(4)), "A bank card must cover this box exactly.", fill=0, font=font)
    d.text((x0 + cw + px(6), y + px(12)), "If not, the printer rescaled: reprint at 100%.", fill=0, font=font)
    y += ch + px(10)
    d.line([x0, y, x0 + px(100), y], fill=0, width=3)
    for k in range(11):
        d.line([x0 + px(10 * k), y, x0 + px(10 * k), y + (px(5) if k % 5 == 0 else px(3))], fill=0, width=3)
    d.text((x0 + px(104), y - px(2)), "100 mm", fill=0, font=font)
    out = HERE / f"aruco_print_{'a4' if a4 else 'letter'}.pdf"
    page.save(out, resolution=254.0)
    return out


if __name__ == "__main__":
    print(print_pdf("--a4" in sys.argv) if "--print" in sys.argv else screen_png())

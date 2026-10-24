"""tools/score_proposals.py on SYNTHETIC proposals with known answers: found / fragmented / missed, kind, unmatched.
  .venv/bin/python tests/test_score_proposals.py"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from score_proposals import score, footprints, table


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def prop(name, kind, box, points=1000):
    return {"name": name, "kind": kind, "poly_xy": rect(*box), "points": points, "detected_as": kind}


truth = [
    {"name": "bed", "kind": "bed", "box_xy": [[0, 0], [2.0, 1.6]]},                          # detected in 3 slices
    {"name": "rug", "kind": "rug", "parts": [{"box_xy": [[3, 0], [4, 1]]}]},                 # detected well
    {"name": "stand", "kind": "nightstand", "poly_xy": rect(5, 0, 5.5, 0.5)},                # detected as a chair
    {"name": "chair", "kind": "chair", "box_xy": [[7, 0], [7.5, 0.5]]},                      # not detected at all
]
proposed = {"objects": [
    prop("bed", "bed", (0, 0, 0.7, 1.6)), prop("bed1", "bed", (0.7, 0, 1.4, 1.6)), prop("bed2", "bed", (1.4, 0, 2.0, 1.6)),   # three slices
    prop("rug", "rug", (3.05, 0.0, 4.0, 1.0)),
    prop("chair", "chair", (5.0, 0.0, 5.5, 0.5)),
    prop("junk", "other", (9, 9, 10, 10)),
], "fixtures": []}

assert footprints(truth[1]) == [rect(3, 0, 4, 1)], "parts take precedence"
s = score(proposed, truth)
by = {r["name"]: r for r in s["objects"]}
assert by["bed"]["status"] == "fragmented" and by["bed"]["pieces"] == 3 and by["bed"]["merged_iou"] > 0.95, by["bed"]
assert by["bed"]["best_iou"] < 0.5, "no single slice is the bed"
assert by["rug"]["status"] == "found" and by["rug"]["best_iou"] > 0.9 and by["rug"]["kind_ok"], by["rug"]
assert by["stand"]["status"] == "found" and not by["stand"]["kind_ok"] and by["stand"]["proposed_kind"] == "chair", by["stand"]
assert by["chair"]["status"] == "missed" and by["chair"]["pieces"] == 0, by["chair"]
assert (s["found"], s["fragmented"], s["missed"]) == (2, 1, 1), s
assert s["kind_ok"] == 2, "bed slices and rug are the right kind, the nightstand is not"
assert [u["name"] for u in s["unmatched"]] == ["junk"] and s["false_alarms"] is None, "junk overlaps nothing; not a false alarm unless the truth is complete"
assert score(proposed, truth, truth_complete=True)["false_alarms"] == 1
strict = {r["name"]: r["status"] for r in score(proposed, truth, iou_min=0.99)["objects"]}
assert strict["stand"] == "found" and strict["rug"] != "found", "a strict threshold keeps only the exact footprint (the rug is 5% off)"
try:
    score(proposed, [{"name": "x", "kind": "bed"}])
    raise SystemExit("an empty truth must be refused")
except ValueError:
    pass
assert "| bed | bed | fragmented |" in table(s)
print("SCORE PROPOSALS OK (SYNTHETIC)", {k: s[k] for k in ("found", "fragmented", "missed", "unmatched_proposals")})

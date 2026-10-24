"""Score stage 6c's proposals against boxes a person drew: did the detector find each object, in one piece, with the right kind?

  python -I tools/score_proposals.py out/<run>/objects_proposed.yaml --truth config.<scene>.yaml [-o score.json] [--iou 0.5] [--truth-complete]

--truth is a config (its game.objects / game.fixtures with box_xy or parts) or any yaml with an `objects:` list of the same
shape (e.g. the hand-labelled boxes for a capture). Footprints are compared on a 2 cm raster in the floor frame:

  found       one proposal covers the object with IoU >= --iou
  fragmented  no single piece does, but the pieces together would (a merge step would fix it): the bed in 7 pieces
  missed      neither
  kind        the kind of the proposal that overlaps most, against the truth's kind

A proposal that overlaps no truth object is listed as `unmatched`. That is only a false alarm if the truth lists everything in
the room (--truth-complete); a config with just a rug and a table says nothing about the nightstand the detector also found.
Heights are not scored here (only the floor footprint), and neither are fixtures, which have no footprint to compare.
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
import yaml

CELL = 0.02


def footprints(entry):
    """The polygons (floor frame, metres) one object covers: its parts, else poly_xy, else the box_xy rectangle."""
    def rect(b):
        (x0, y0), (x1, y1) = b
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    polys = []
    for p in entry.get("parts") or []:
        polys.append(p["poly_xy"] if p.get("poly_xy") else rect(p["box_xy"]) if p.get("box_xy") else None)
    polys = [p for p in polys if p]
    if polys:
        return polys
    if entry.get("poly_xy"):
        return [entry["poly_xy"]]
    return [rect(entry["box_xy"])] if entry.get("box_xy") else []


class Raster:
    """One shared grid over everything being compared, so every footprint is a boolean mask on it."""
    def __init__(self, polys_all):
        import cv2
        self.cv2 = cv2
        pts = np.array([q for polys in polys_all for p in polys for q in p], float)
        self.lo = pts.min(0) - 0.1
        hi = pts.max(0) + 0.1
        self.shape = tuple(np.ceil((hi - self.lo) / CELL).astype(int)[::-1])   # (rows = y, cols = x)

    def mask(self, polys):
        m = np.zeros(self.shape, np.uint8)
        for p in polys:
            ij = np.round((np.array(p, float) - self.lo) / CELL).astype(np.int32)
            self.cv2.fillPoly(m, [ij], 1)
        return m.astype(bool)


def score(proposed, truth_entries, iou_min=0.5, truth_complete=False):
    props = [(e, footprints(e)) for k in ("objects", "fixtures") for e in proposed.get(k, [])]
    props = [(e, f) for e, f in props if f]
    truth = [(e, footprints(e)) for e in truth_entries]
    skipped = [e.get("name") for e, f in truth if not f]
    truth = [(e, f) for e, f in truth if f]
    if not truth:
        raise ValueError("the truth has no object with a footprint (box_xy, poly_xy or parts)")
    R = Raster([f for _, f in props + truth])
    pm = [R.mask(f) for _, f in props]
    rows, covered = [], np.zeros(len(props), bool)
    for e, f in truth:
        t = R.mask(f)
        ta = int(t.sum())
        inter = [int((m & t).sum()) for m in pm]
        iou = [i / max(int(m.sum()) + ta - i, 1) for i, m in zip(inter, pm)]
        # a piece belongs to this object when at least half of it lies inside the object
        pieces = [k for k, m in enumerate(pm) if m.sum() and inter[k] / m.sum() >= 0.5]
        union = np.zeros(R.shape, bool)
        for k in pieces:
            union |= pm[k]
        merged = float((union & t).sum() / max((union | t).sum(), 1))
        best = int(np.argmax(iou)) if props else -1
        biggest = int(np.argmax(inter)) if props and max(inter) else -1
        covered[pieces] = True
        if best >= 0 and iou[best] >= iou_min:
            status = "found"
        elif merged >= iou_min:
            status = "fragmented"
        else:
            status = "missed"
        rows.append({"name": e.get("name"), "kind": e.get("kind"), "status": status,
                     "best_iou": round(iou[best], 3) if best >= 0 else 0.0, "merged_iou": round(merged, 3), "pieces": len(pieces),
                     "proposal": props[best][0].get("name") if best >= 0 and iou[best] > 0 else None,
                     "proposed_kind": props[biggest][0].get("kind") if biggest >= 0 else None,
                     "kind_ok": bool(biggest >= 0 and props[biggest][0].get("kind") == e.get("kind"))})
    unmatched = [{"name": e.get("name"), "kind": e.get("kind"), "detected_as": e.get("detected_as"), "points": e.get("points")}
                 for (e, _), c in zip(props, covered) if not c]
    kinds = {}
    for r in rows:
        k = kinds.setdefault(r["kind"], {"n": 0, "found": 0, "fragmented": 0, "missed": 0})
        k["n"] += 1
        k[r["status"]] += 1
    n = len(rows)
    return {"truth_objects": n, "proposals": len(props), "found": sum(r["status"] == "found" for r in rows),
            "fragmented": sum(r["status"] == "fragmented" for r in rows), "missed": sum(r["status"] == "missed" for r in rows),
            "kind_ok": sum(r["kind_ok"] for r in rows if r["status"] != "missed"),
            "mean_best_iou": round(float(np.mean([r["best_iou"] for r in rows])), 3),
            "mean_pieces_per_object": round(float(np.mean([r["pieces"] for r in rows])), 2),
            "unmatched_proposals": len(unmatched), "false_alarms": len(unmatched) if truth_complete else None,
            "truth_complete": truth_complete, "iou_min": iou_min, "truth_without_footprint": skipped,
            "by_kind": kinds, "objects": rows, "unmatched": unmatched}


def table(s):
    out = [f"| object | kind | status | best IoU | merged IoU | pieces | proposed kind |", "|---|---|---|---|---|---|---|"]
    for r in s["objects"]:
        out.append(f"| {r['name']} | {r['kind']} | {r['status']} | {r['best_iou']} | {r['merged_iou']} | {r['pieces']} | "
                   f"{r['proposed_kind']}{'' if r['kind_ok'] else ' (wrong)'} |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("proposed")
    ap.add_argument("--truth", required=True)
    ap.add_argument("-o", "--out")
    ap.add_argument("--iou", type=float, default=0.5)
    ap.add_argument("--truth-complete", action="store_true", help="the truth lists every object: unmatched proposals are false alarms")
    a = ap.parse_args()
    proposed = yaml.safe_load(Path(a.proposed).read_text())
    t = yaml.safe_load(Path(a.truth).read_text())
    entries = (t.get("game") or t).get("objects") or []
    s = score(proposed, entries, a.iou, a.truth_complete)
    print(table(s))
    print(f"\nfound {s['found']}/{s['truth_objects']}, fragmented {s['fragmented']}, missed {s['missed']}; kind right on {s['kind_ok']} of the "
          f"{s['truth_objects'] - s['missed']} located; {s['mean_pieces_per_object']} pieces per object; mean best IoU {s['mean_best_iou']}")
    print(f"{s['unmatched_proposals']} of {s['proposals']} proposals overlap no truth object" +
          ("" if a.truth_complete else " (not false alarms unless the truth is complete: --truth-complete)"))
    if a.out:
        Path(a.out).write_text(json.dumps(s, indent=1))


if __name__ == "__main__":
    sys.exit(main())

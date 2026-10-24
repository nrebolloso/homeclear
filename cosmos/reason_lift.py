"""Cosmos Reason proposals -> checked hazards (CPU only; cosmos/reason.py runs the model on the B200).

A proposal is a pixel in a capture frame plus a kind and a sentence. It only counts once geometry has looked:
  lift     pixel + rendered depth + camera -> a point in the floor frame
  verdict  floor kinds (bump, cable, threshold, clutter) are checked against the measured grids near that point:
             confirmed  (the grid has a bump / obstacle there; its measured height goes with it)
             dismissed  (flat, clear floor there: the model saw something the geometry doesn't)
           kinds no scan can measure (grab bar, slippery surface, lighting, other) -> unmeasurable, OT to verify
  merge    the same thing seen from several frames becomes one entry
  evaluate precision / recall against a hand-labelled answer key (proof/reason/answer_key.yaml)
"""
import json, re
import numpy as np

FLOOR_KINDS = {"floor_bump", "cable", "threshold", "clutter", "rug"}
UNMEASURABLE = {"grab_bar", "slippery", "lighting", "other", "handrail"}
SEARCH_M = 0.25          # how far from the lifted point to look for the measured thing (lifting + depth error)
MERGE_M = 0.35


def parse(text):
    """The model's answer -> list of proposals. Tolerates reasoning before the JSON, code fences, a dict wrapper."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    m = re.search(r"\[.*\]", text, flags=re.S) or re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = data.get("hazards", [data])
    out = []
    for d in data if isinstance(data, list) else []:
        try:
            u, v = (float(x) for x in d["pixel"][:2])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"kind": str(d.get("kind", "other")).lower().replace(" ", "_"), "pixel": [u, v],
                    "note": str(d.get("hazard") or d.get("note") or d.get("why") or ""), "why": str(d.get("why", "")),
                    "confidence": float(d.get("confidence", 0.5))})
    return out


def lift(pixel, depth, w2c, K):
    """Pixel (u, v) + z-depth image (metres, inf = nothing) + OpenCV w2c/K in the floor frame -> 3-D point or None.
    Uses the median depth of a 5x5 patch: one pixel of a splat render can be a floater."""
    u, v = int(round(pixel[0])), int(round(pixel[1]))
    H, W = depth.shape
    if not (0 <= u < W and 0 <= v < H):
        return None
    patch = depth[max(0, v - 2):v + 3, max(0, u - 2):u + 3]
    patch = patch[np.isfinite(patch)]
    if not len(patch):
        return None
    z = float(np.median(patch))
    K, w2c = np.asarray(K, float), np.asarray(w2c, float)
    xc = np.array([(u - K[0, 2]) / K[0, 0] * z, (v - K[1, 2]) / K[1, 1] * z, z])
    R, t = w2c[:3, :3], w2c[:3, 3]
    return R.T @ (xc - t)


def verdict(p, kind, grid, bump_h, obstacles, estimated=None):
    """Check one lifted proposal against the measured grids (floor frame; grid = grid.json dict)."""
    if kind in UNMEASURABLE or kind not in FLOOR_KINDS:
        return {"verdict": "unmeasurable, OT to verify", "measured": None}
    cell, lo = grid["cell_m"], np.array(grid["origin_xy"])
    r = int(np.ceil(SEARCH_M / cell))
    i, j = np.floor((np.asarray(p[:2]) - lo) / cell).astype(int)
    sl = (slice(max(0, i - r), i + r + 1), slice(max(0, j - r), j + r + 1))
    h = float(np.max(bump_h[sl])) if bump_h[sl].size else 0.0
    if kind == "clutter":
        if obstacles[sl].any():
            return {"verdict": "confirmed", "measured": "obstacle on the floor here"}
    if h > 0:
        est = bool(estimated is not None and estimated[sl].any())
        return {"verdict": "confirmed", "measured": f"{100 * h:.1f} cm {'(estimated, thin)' if est else 'bump'} within {SEARCH_M} m", "height_m": h}
    if kind == "clutter" or kind == "cable":
        # a cable thinner than the bump floor (4 mm) can be real and still invisible to the grid
        return {"verdict": "not seen in the scan, OT to verify", "measured": "flat, clear floor here"}
    return {"verdict": "dismissed", "measured": "flat floor here (no bump above 4 mm within 25 cm)"}


def merge(items):
    """Same kind within MERGE_M of each other -> one entry; keeps the most confident note and counts the frames."""
    out = []
    for it in sorted(items, key=lambda x: -x["confidence"]):
        for o in out:
            if o["kind"] == it["kind"] and np.hypot(*(np.array(o["position_m"][:2]) - it["position_m"][:2])) < MERGE_M:
                o["frames"] += it["frames"]
                break
        else:
            out.append({**it, "frames": list(it["frames"])})
    return out


def evaluate(found, key, radius=0.5):
    """found: merged entries (confirmed or unmeasurable count as claims); key: [{kind, xy}] from the answer key.
    A claim matches a key item of the same kind family within `radius` m. Returns precision, recall and the pairs."""
    fam = lambda k: "floor" if k in FLOOR_KINDS else k
    claims = [f for f in found if f["verdict"] != "dismissed"]
    used, tp = set(), 0
    for c in claims:
        for n, k in enumerate(key):
            if n not in used and fam(k["kind"]) == fam(c["kind"]) and np.hypot(*(np.array(k["xy"]) - c["position_m"][:2])) <= radius:
                used.add(n); tp += 1
                break
    return {"claims": len(claims), "key_items": len(key), "true_positives": tp,
            "precision": round(tp / len(claims), 3) if claims else None, "recall": round(tp / len(key), 3) if key else None}

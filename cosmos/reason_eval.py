"""Cosmos Reason evaluation (SPEC 4.10): against a hand-labelled answer key, what does Reason add to the measured geometry?
CPU only; reads the files the pipeline already writes. Arms:
  geometry          the measured hazards (stage 8's hazards.json, source geometry)
  reason            Cosmos Reason's claims alone (reason.json: confirmed, unmeasurable or not-seen entries; dismissed ones are not claims)
  geometry+reason   the union (a Reason claim of the same kind family within `radius` of a geometry claim is the same hazard, not a new one)
  general           a general vision model run the same way (cosmos/reason.py --model <other> --out reason_general.json), optional
  geometry+general  the union with the general model
A claim matches an unused key item of the same kind family within `radius` m, nearest pair first (one claim per item, one item per claim).
"Keep Reason only if it adds real catches": it adds a catch when geometry+reason finds a key item geometry alone missed.
Floor kinds (floor_bump, cable, threshold, clutter, rug) are one family; tight_clearance is what stage 8 flags for a squeeze;
grab_bar, slippery, lighting, handrail, other are what no scan can measure: reported separately, since that is where Reason can matter.

usage: python cosmos/reason_eval.py --key proof/reason/answer_key_<run>.yaml --hazards <work>/hazards.json --reason <work>/reason.json
           [--general <work>/reason_general.json] [--path <work>/path.json --corridor 1.2] [--radius 0.5] [--out proof/reason/eval_<run>]
Writes <out>.json and <out>.md. The answer key: items: [{kind, xy: [x, y], note}] in the floor frame (tools/label_hazards/index.html makes it)."""
import argparse, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos")]
import numpy as np
import reason_lift as rl

CLEARANCE = "tight_clearance"
MEASURABLE = rl.FLOOR_KINDS | {CLEARANCE}
KINDS = MEASURABLE | rl.UNMEASURABLE
DEFAULT_RADIUS = 0.5


def fam(kind):
    return "floor" if kind in rl.FLOOR_KINDS else kind


def load_key(items):
    """Validated key items [{kind, xy, note}]; an empty or malformed key is an error, not a zero score."""
    if not items:
        raise ValueError("the answer key has no items: not scored")
    out = []
    for n, it in enumerate(items):
        kind = str(it.get("kind", "")).lower().replace(" ", "_")
        xy = it.get("xy")
        if kind not in KINDS:
            raise ValueError(f"key item {n}: kind {kind!r} is not one of {sorted(KINDS)}")
        if not (isinstance(xy, (list, tuple)) and len(xy) >= 2 and all(isinstance(v, (int, float)) for v in xy[:2])):
            raise ValueError(f"key item {n}: xy must be [x, y] in metres")
        out.append({"kind": kind, "xy": [float(xy[0]), float(xy[1])], "note": str(it.get("note", ""))})
    return out


def geometry_claims(doc):
    """stage 8 / stage 12 hazards.json -> claims; only the measured geometry (a Reason entry that stage 12 merged in is not geometry)."""
    out = []
    for h in doc["hazards"]:
        if h.get("source", "geometry") != "geometry" or h["type"] not in ("floor_bump", CLEARANCE):
            continue
        out.append({"kind": h["type"], "xy": [float(v) for v in h["position_m"][:2]], "note": h.get("note") or h.get("verdict", "")})
    return out


def model_claims(doc):
    """reason.json (cosmos/reason.py) -> claims: everything the geometry check did not dismiss."""
    return [{"kind": h["kind"], "xy": [float(v) for v in h["position_m"][:2]], "note": h.get("note") or h.get("why", ""), "verdict": h["verdict"]}
            for h in doc["hazards"] if not h["verdict"].startswith("dismissed")]


def union(base, extra, radius):
    """base claims plus the `extra` ones that are not the same hazard (same family, within radius of a base claim)."""
    out = list(base)
    for c in extra:
        if not any(fam(b["kind"]) == fam(c["kind"]) and np.hypot(*(np.array(b["xy"]) - c["xy"])) <= radius for b in base):
            out.append(c)
    return out


def match(claims, key, radius):
    """Nearest-first one-to-one matching. Returns {key index: claim index}."""
    pairs = sorted((float(np.hypot(*(np.array(c["xy"]) - k["xy"]))), ci, ki) for ci, c in enumerate(claims) for ki, k in enumerate(key)
                   if fam(c["kind"]) == fam(k["kind"]))
    got, used = {}, set()
    for d, ci, ki in pairs:
        if d <= radius and ki not in got and ci not in used:
            got[ki] = ci; used.add(ci)
    return got


def score(claims, key, radius):
    got = match(claims, key, radius)
    tp, n, k = len(got), len(claims), len(key)
    meas = [i for i, it in enumerate(key) if it["kind"] in MEASURABLE]
    unmeas = [i for i, it in enumerate(key) if it["kind"] not in MEASURABLE]
    r = lambda ids: round(sum(i in got for i in ids) / len(ids), 3) if ids else None
    return {"claims": n, "key_items": k, "catches": tp, "misses": k - tp, "false_alarms": n - tp,
            "precision": round(tp / n, 3) if n else None, "recall": round(tp / k, 3),
            "recall_measurable": r(meas), "recall_unmeasurable": r(unmeas), "found": sorted(got),
            "false_alarm_list": [{"kind": c["kind"], "xy": [round(v, 2) for v in c["xy"]], "note": c.get("note", "")}
                                 for ci, c in enumerate(claims) if ci not in set(got.values())]}


def in_corridor(items, path_xy, corridor_m):
    """Only what any arm could have seen: within corridor_m of the planned route (geometry follows it, Reason's frames are within 1.2 m of it)."""
    P = np.asarray(path_xy, float)
    near = lambda xy: np.linalg.norm(P - np.asarray(xy[:2]), axis=1).min() <= corridor_m
    return [it for it in items if near(it["xy"])]


def compare(key, geometry, reason, general=None, radius=DEFAULT_RADIUS):
    arms = {"geometry": geometry, "reason": reason, "geometry+reason": union(geometry, reason, radius)}
    if general is not None:
        arms |= {"general": general, "geometry+general": union(geometry, general, radius)}
    res = {n: score(c, key, radius) for n, c in arms.items()}
    base = set(res["geometry"]["found"])
    out = {"radius_m": radius, "key_items": len(key), "arms": res, "verdict": {}}
    for n in ("geometry+reason", "geometry+general"):
        if n not in res:
            continue
        added = sorted(set(res[n]["found"]) - base)
        extra = res[n]["false_alarms"] - res["geometry"]["false_alarms"]
        out["verdict"][n] = {"catches_added": len(added), "added_items": [{"kind": key[i]["kind"], "xy": key[i]["xy"], "note": key[i]["note"]} for i in added],
                             "false_alarms_added": extra,
                             "keep": len(added) > 0,
                             "note": ("adds real catches" if added else "adds no catch beyond the geometry") + f", {extra} extra claim(s) that match nothing"}
    if general is not None:
        gr, gg = set(res["geometry+reason"]["found"]), set(res["geometry+general"]["found"])
        out["verdict"]["reason_vs_general"] = {"only_reason": len(gr - gg), "only_general": len(gg - gr), "both": len(gr & gg)}
    return out


def report(res, key, title="Cosmos Reason evaluation"):
    A = res["arms"]
    L = [f"# {title}", "", f"{res['key_items']} hand-labelled hazards; a claim counts when it is the same kind family within {res['radius_m']} m of an unmatched key item.", "",
         "| arm | claims | catches | misses | false alarms | precision | recall | recall: measurable kinds | recall: unmeasurable kinds |", "|---|---|---|---|---|---|---|---|---|"]
    f = lambda v: "n/a" if v is None else f"{v:.2f}"
    for n, a in A.items():
        L.append(f"| {n} | {a['claims']} | {a['catches']} | {a['misses']} | {a['false_alarms']} | {f(a['precision'])} | {f(a['recall'])} | {f(a['recall_measurable'])} | {f(a['recall_unmeasurable'])} |")
    L += ["", "**Does it add real catches?**", ""]
    for n, v in res["verdict"].items():
        if n == "reason_vs_general":
            L.append(f"- Reason vs the general model: {v['both']} items both find, {v['only_reason']} only Reason, {v['only_general']} only the general model.")
            continue
        L.append(f"- {n}: {'KEEP' if v['keep'] else 'DROP'}: {v['note']}.")
        for it in v["added_items"]:
            L.append(f"  - catches {it['kind']} at ({it['xy'][0]:.2f}, {it['xy'][1]:.2f}) that geometry alone missed" + (f": {it['note']}" if it["note"] else ""))
    L += ["", "**Key items and who found them**", "", "| # | kind | xy | note | " + " | ".join(A) + " |", "|---|---|---|---|" + "---|" * len(A)]
    for i, it in enumerate(key):
        L.append(f"| {i} | {it['kind']} | ({it['xy'][0]:.2f}, {it['xy'][1]:.2f}) | {it['note']} | " + " | ".join("yes" if i in a["found"] else "-" for a in A.values()) + " |")
    for n in ("reason", "general"):
        if n in A and A[n]["false_alarm_list"]:
            L += ["", f"**{n}: claims that match no key item**", ""]
            L += [f"- {c['kind']} at ({c['xy'][0]:.2f}, {c['xy'][1]:.2f}): {c['note']}" for c in A[n]["false_alarm_list"]]
    return "\n".join(L) + "\n"


def main(argv=None):
    import yaml
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True); ap.add_argument("--hazards", required=True); ap.add_argument("--reason", required=True)
    ap.add_argument("--general"); ap.add_argument("--path"); ap.add_argument("--corridor", type=float, default=1.2)
    ap.add_argument("--radius", type=float, default=DEFAULT_RADIUS); ap.add_argument("--out")
    a = ap.parse_args(argv)
    j = lambda p: json.loads(Path(p).read_text())
    key = load_key(yaml.safe_load(Path(a.key).read_text()).get("items"))
    geometry, reason = geometry_claims(j(a.hazards)), model_claims(j(a.reason))
    general = model_claims(j(a.general)) if a.general else None
    if a.path:
        P = j(a.path)["xy"]
        key = in_corridor(key, P, a.corridor)
        # claims outside the corridor can't match corridor key items anyway, but they would count as false alarms nobody could have judged
        geometry, reason = in_corridor(geometry, P, a.corridor), in_corridor(reason, P, a.corridor)
        general = in_corridor(general, P, a.corridor) if general is not None else None
        if not key:
            raise ValueError("no answer-key item lies within the route corridor: not scored")
    res = compare(key, geometry, reason, general, a.radius)
    res["inputs"] = {"key": a.key, "hazards": a.hazards, "reason": a.reason, "general": a.general, "corridor_m": a.corridor if a.path else None}
    md = report(res, key)
    if a.out:
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(str(a.out) + ".json").write_text(json.dumps(res, indent=1))
        Path(str(a.out) + ".md").write_text(md)
    print(md)


if __name__ == "__main__":
    main()

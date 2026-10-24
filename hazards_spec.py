"""hazards.json in the SPEC section 5 shape: [{id, type, pos, height_m, clearance_m, source, basis, borderline, ot_check, note}].
Stage 8's own fields (position_m, max_bump_height_cm, min_side_clearance_m, verdict, estimated, path_index ...) stay as they are:
the viewer, the OT report and the fix renders read them, so the spec's fields are added next to them (scene changes are additive).
`basis` is the spec's `measured|estimated`."""

REQUIRED = ("id", "type", "pos", "height_m", "clearance_m", "source", "basis", "borderline", "ot_check", "note")
SOURCES = ("geometry", "cosmos_reason")
BASES = ("measured", "estimated")


def add_spec_fields(h):
    """Idempotent. Needs `source`, `ot_check` and `note` already set (stage 12 does that); the rest comes from the entry itself."""
    verdict = h.get("verdict") or ""
    if "max_bump_height_cm" in h:
        height = round(h["max_bump_height_cm"] / 100, 3)
    else:
        height = h.get("height_m")
    h["pos"] = [round(float(v), 3) for v in h["position_m"][:2]]
    h["height_m"] = height
    h["clearance_m"] = h.get("min_side_clearance_m")
    # a cable (classified, not measured), or a Reason claim no scan could measure, is an estimate; everything the grids gave is measured
    h["basis"] = "estimated" if h.get("estimated") or verdict.startswith(("estimated", "unmeasurable", "not seen")) else "measured"
    h["borderline"] = verdict.startswith("borderline")
    return h


def validate(doc):
    """Problems with a hazards.json document, as a list of strings (empty = valid)."""
    out = []
    hz = doc.get("hazards")
    if not isinstance(hz, list):
        return ["hazards is not a list"]
    ids = [h.get("id") for h in hz]
    if len(set(ids)) != len(ids):
        out.append("duplicate ids")
    for k, h in enumerate(hz):
        miss = [f for f in REQUIRED if f not in h]
        if miss:
            out.append(f"#{k}: missing {', '.join(miss)}")
            continue
        if not (isinstance(h["pos"], list) and len(h["pos"]) == 2 and all(isinstance(v, (int, float)) for v in h["pos"])):
            out.append(f"#{k}: pos is not [x, y]")
        for f in ("height_m", "clearance_m"):
            if h[f] is not None and not isinstance(h[f], (int, float)):
                out.append(f"#{k}: {f} is neither a number nor null")
        if h["source"] not in SOURCES:
            out.append(f"#{k}: source {h['source']!r}")
        if h["basis"] not in BASES:
            out.append(f"#{k}: basis {h['basis']!r}")
        for f in ("borderline", "ot_check"):
            if not isinstance(h[f], bool):
                out.append(f"#{k}: {f} is not a bool")
        if not isinstance(h["note"], str) or not h["note"]:
            out.append(f"#{k}: empty note")
    return out

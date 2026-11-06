"""viewer/src/effort.ts v1 (TM2's move-effort model), mirrored so the GPU search prices a change the way the viewer does:
mass from the measured box (estimate_mass), effort from mass, distance and turn (move_effort), configured fixes that are
actions, not carries (intervention_effort). The numbers are TM2's: change them in effort.ts first, then here.
tests/test_effort_parity.py checks this against effort.ts (tests/fixtures/effort_parity.json, made by effort_parity.mjs)."""
import math
import re

# Team guesses (not measured), kg. bed = frame + mattress. Used when the scan gives no usable size.
DEFAULT_MASS_KG = {"rug": 3, "mat": 2, "cord": 0.2, "nightlight": 0.5, "chair": 6, "basket": 2, "trash_can": 5, "nightstand": 20,
                   "table": 30, "bed": 70, "dresser": 50, "sofa": 45, "other": 15}
NEVER_MOVE = {"bed", "refrigerator", "counter", "wardrobe", "toilet", "sofa"}
KIND_MASS = {
    "bed": (60, 30, 150), "nightstand": (120, 5, 40), "chair": (22, 4, 7), "table": (36, 20, 40),
    "basket": (6, 1, 3), "trash_can": (40, 2, 8), "rug": (400, 1, 5), "mat": (400, 1, 5), "cord": (500, 0.1, 0.5),
    "dresser": (150, 20, 100), "sofa": (50, 25, 100), "other": (50, 1, 60),
}   # kind: (kg per m³ of bounding box, min kg, max kg)
NOT_CARRIED = {"rug", "mat", "cord", "nightlight", "door"}
KG_PER_BASE = 20
PER_M = 0.3
TURN_PER_180 = 0.5
TWO_PERSON_KG = 25
MIN_SETUP, MIN_PER_BASE, TWO_PERSON_MIN = 10, 10, 30
ACTION_EFFORT = 0.3
AWKWARD = {"trash_can": 1.4}


def jround(x):
    return math.floor(x + 0.5)   # JS Math.round


def effort_kind(kind, name=None):
    """effortKind: an 'other' object's name says what it is ("trash_can", "chair2" -> chair), when it is a kind we know."""
    if kind != "other" or not name:
        return kind
    k = re.sub(r"\d+$", "", name.lower())
    return k if k in DEFAULT_MASS_KG else kind


def estimate_mass(o):
    """estimateMass: (mass_kg, from_size, flagged). Footprint area × height × kg/m³ for the kind, clamped to its range."""
    kind = effort_kind(o["kind"], o.get("name"))
    guess = DEFAULT_MASS_KG.get(kind, DEFAULT_MASS_KG["other"])
    f, h = o.get("footprint") or [], o.get("height_m")
    if len(f) < 3 or not (h is not None and h > 0) or kind not in KIND_MASS:
        return guess, False, False
    a, j = 0.0, len(f) - 1
    for i in range(len(f)):
        a += f[j][0] * f[i][1] - f[i][0] * f[j][1]
        j = i
    per_m3, lo, hi = KIND_MASS[kind]
    raw = (abs(a) / 2) * h * per_m3
    kg = min(hi, max(lo, raw))
    return jround(kg), True, kg != raw


def object_mass(o):
    """The mass main.ts gives an object before any move is priced: the config's, else the measured box's, else None (the
    kind's guess, inside move_effort)."""
    if o.get("mass_kg") is not None:
        return o["mass_kg"]
    kg, from_size, _ = estimate_mass(o)
    return kg if from_size else None


def move_effort(kind, distance_m, turn_deg, mass_kg=None, name=None):
    """moveEffort: {effort, minutes, people}."""
    kind = effort_kind(kind, name)
    kg = max(0, mass_kg if mass_kg is not None else DEFAULT_MASS_KG.get(kind, DEFAULT_MASS_KG["other"]))
    if kind in NOT_CARRIED:
        return {"effort": ACTION_EFFORT, "minutes": MIN_SETUP, "people": 1}
    base = (1 + kg / KG_PER_BASE) * AWKWARD.get(kind, 1)
    d = max(0, distance_m or 0)
    r = math.fmod(math.fmod(turn_deg or 0, 360) + 360, 360)   # JS ((t % 360) + 360) % 360
    turn = 360 - r if r > 180 else r
    two = kg > TWO_PERSON_KG
    effort = base * (1 + PER_M * d) + TURN_PER_180 * base * (turn / 180)
    minutes = max(MIN_SETUP + MIN_PER_BASE * base * (1 + d / 2), TWO_PERSON_MIN if two else 0)
    return {"effort": effort, "minutes": jround(minutes), "people": 2 if two else 1}


def intervention_effort(iv, kind=None):
    """interventionEffort: flattening, or moving/removing a not-carried thing, is an action; else the config's effort."""
    if iv["kind"] == "flatten" or (kind is not None and kind in NOT_CARRIED):
        return ACTION_EFFORT
    e = iv.get("effort")
    return 1 if e is None else e

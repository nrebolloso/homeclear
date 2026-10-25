"""cosmos/reason_eval.py on hand-made claims and keys (SYNTHETIC, no model): the arms, what Reason adds beyond the geometry,
nearest-first matching, key validation, the route corridor. Run:  .venv/bin/python tests/test_reason_eval.py"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "cosmos")]
import reason_eval as ev

key = ev.load_key([{"kind": "rug", "xy": [3.0, 1.6], "note": "raised rug edge"}, {"kind": "cable", "xy": [3.64, 1.5]},
                   {"kind": "grab_bar", "xy": [6.1, 1.3], "note": "none by the toilet"}, {"kind": "slippery", "xy": [0.8, 0.8]},
                   {"kind": "tight_clearance", "xy": [4.1, 1.5]}])
geometry = ev.geometry_claims({"hazards": [
    {"type": "floor_bump", "position_m": [3.05, 1.55, 0.015], "source": "geometry", "note": "1.5 cm bump"},
    {"type": "tight_clearance", "position_m": [4.09, 1.49, 0.0], "verdict": "fail"},
    {"type": "floor_bump", "position_m": [2.0, 0.2, 0.01], "source": "geometry"},
    {"type": "grab_bar", "position_m": [6.0, 1.5], "source": "cosmos_reason"}]})      # stage 12 merged a Reason entry in: not geometry
assert [c["kind"] for c in geometry] == ["floor_bump", "tight_clearance", "floor_bump"]
reason = ev.model_claims({"hazards": [
    {"kind": "floor_bump", "position_m": [2.95, 1.6, 0], "verdict": "confirmed", "note": "rug edge"},      # the geometry already has it
    {"kind": "cable", "position_m": [3.6, 1.5, 0], "verdict": "not seen in the scan, OT to verify"},       # too thin for the grid
    {"kind": "grab_bar", "position_m": [6.0, 1.5, 0], "verdict": "unmeasurable, OT to verify"},
    {"kind": "lighting", "position_m": [1.0, 1.0, 0], "verdict": "unmeasurable, OT to verify"},           # matches nothing
    {"kind": "floor_bump", "position_m": [1.5, 3.0, 0], "verdict": "dismissed"}]})                        # flat floor: not a claim
assert len(reason) == 4
general = ev.model_claims({"hazards": [{"kind": "grab_bar", "position_m": [6.2, 1.2, 0], "verdict": "unmeasurable, OT to verify"},
                                       {"kind": "floor_bump", "position_m": [5.0, 5.0, 0], "verdict": "confirmed"}]})
r = ev.compare(key, geometry, reason, general, 0.5)
A = r["arms"]
assert (A["geometry"]["catches"], A["geometry"]["false_alarms"], A["geometry"]["misses"]) == (2, 1, 3), A["geometry"]
assert A["geometry"]["recall_measurable"] == 0.667 and A["geometry"]["recall_unmeasurable"] == 0.0
u = A["geometry+reason"]
assert (u["claims"], u["catches"], u["false_alarms"]) == (6, 4, 2) and u["recall_unmeasurable"] == 0.5 and u["recall_measurable"] == 1.0, u
v = r["verdict"]["geometry+reason"]
assert v["keep"] and v["catches_added"] == 2 and v["false_alarms_added"] == 1
assert sorted(i["kind"] for i in v["added_items"]) == ["cable", "grab_bar"]
g = r["verdict"]["geometry+general"]
assert g["keep"] and g["catches_added"] == 1 and g["false_alarms_added"] == 1
assert r["verdict"]["reason_vs_general"] == {"only_reason": 1, "only_general": 0, "both": 3}
md = ev.report(r, key)
assert "KEEP" in md and "catches cable" in md and "lighting" in md and "geometry+general" in md

# Reason that only repeats the geometry adds nothing: drop
same = ev.compare(key, geometry, [{"kind": "floor_bump", "xy": [3.0, 1.6], "verdict": "confirmed"}], None, 0.5)
assert not same["verdict"]["geometry+reason"]["keep"] and same["verdict"]["geometry+reason"]["catches_added"] == 0
assert "geometry+general" not in same["verdict"] and "DROP" in ev.report(same, key)

# matching is nearest-first and one-to-one: claim order must not decide who gets which key item
k2 = ev.load_key([{"kind": "rug", "xy": [0.0, 0.0]}, {"kind": "rug", "xy": [0.5, 0.0]}])
assert ev.score([{"kind": "floor_bump", "xy": [0.25, 0.0]}, {"kind": "cable", "xy": [0.05, 0.0]}], k2, 0.3)["catches"] == 2
assert ev.score([{"kind": "cable", "xy": [0.05, 0.0]}, {"kind": "floor_bump", "xy": [0.25, 0.0]}], k2, 0.3)["catches"] == 2
assert ev.score([{"kind": "grab_bar", "xy": [0.0, 0.0]}], k2, 0.3)["catches"] == 0        # another family never matches
assert ev.score([{"kind": "floor_bump", "xy": [0.0, 0.0]}, {"kind": "floor_bump", "xy": [0.05, 0.0]}], k2, 0.3)["catches"] == 1   # two claims, one near item

# the key must be real
for bad, why in (([], "no items"), ([{"kind": "banana", "xy": [0, 0]}], "kind"), ([{"kind": "rug", "xy": [1]}], "xy"), ([{"kind": "rug"}], "xy")):
    try:
        ev.load_key(bad)
    except ValueError as e:
        assert why in str(e), (bad, e)
    else:
        raise AssertionError(f"accepted {bad}")

# only what an arm could have seen: within the corridor of the planned route
path = [[x / 10, 1.5] for x in range(0, 70)]
assert len(ev.in_corridor(key, path, 1.2)) == len(key)                                    # the slippery mat is 0.7 m off the route: inside
far = ev.in_corridor(key + [{"kind": "rug", "xy": [3.0, 5.0], "note": ""}], path, 1.2)
assert len(far) == len(key)                                                               # a rug 3.5 m off is not
assert [i["kind"] for i in ev.in_corridor(key, path, 0.5)] == ["rug", "cable", "grab_bar", "tight_clearance"]   # narrower: the mat drops out
print("REASON EVAL OK")

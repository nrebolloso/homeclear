"""planner/effort.py and engine.py's cost() price changes the way the viewer does (effort.ts, movecost.ts, planner.ts
cost()), within 1e-9, on kitchen4's objects, fixes and planner layouts (tests/fixtures/effort_parity.json, made by
tests/make_effort_parity.ts).   python tests/test_effort_parity.py"""
import json, sys, types
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.effort import estimate_mass, intervention_effort, move_effort

F = json.loads((ROOT / "tests/fixtures/effort_parity.json").read_text())
close = lambda a, b: abs(a - b) <= 1e-9

for m in F["mass"]:
    kg, from_size, flagged = estimate_mass(m)
    assert (kg, from_size, flagged) == (m["mass_kg"], m["from_size"], m["flagged"]), (m["name"], kg, from_size, flagged, m)
for m in F["moves"]:
    e = move_effort(m["kind"], m["distance_m"], m["turn_deg"], m["mass_kg"], m["name"])
    assert close(e["effort"], m["effort"]) and e["minutes"] == m["minutes"] and e["people"] == m["people"], (m, e)
for f in F["fixes"]:
    e = intervention_effort({"kind": f["kind"], "effort": f["effort_cfg"]}, f["target_kind"])
    assert close(e, f["effort"]), (f, e)
print(f"effort.py: {len(F['mass'])} masses, {len(F['moves'])} moves, {len(F['fixes'])} fixes match effort.ts")

# engine.py's move_cost and cost(); its GPU parts are not used here, so torch may be missing on a laptop
try:
    import torch  # noqa: F401
except ImportError:
    sys.modules["torch"] = types.ModuleType("torch")
from planner import engine as E

sc = json.loads((ROOT / "viewer/public/scene/kitchen4_lighter/scene.json").read_text())
S = types.SimpleNamespace(objects=sc["objects"], idx={o["name"]: k for k, o in enumerate(sc["objects"])},
                          interventions={iv["id"]: iv for iv in sc["interventions"]},
                          cfg=json.loads((ROOT / "configs/planner/kitchen4_lighter.json").read_text()))
for m in F["pose_moves"]:
    c = E.move_cost(S.objects[S.idx[m["name"]]], m["a"], m["b"])
    assert close(c["effort"], m["effort"]) and c["minutes"] == m["minutes"], (m, c)
for L in F["layouts"]:
    c, want = E.cost(S, F["from"], L["layout"]), L["cost"]
    assert c["items"] == [i["key"] for i in want["items"]], (c["items"], want["items"])
    assert close(c["effort"], want["effort"]) and c["usd"] == want["usd"] and c["minutes"] == want["minutes"], (L["layout"], c, want)
print(f"engine.py: {len(F['pose_moves'])} pose moves, {len(F['layouts'])} layouts match planner.ts cost()")
print("effort parity OK")

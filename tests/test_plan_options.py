"""planner/search.py option picking: pick() on a synthetic front (the knee, the lowest risk, None when nothing saves
toe catches), and the published search's options (Easiest / Keep my mat / Safest; the keep-mat ones never remove the
mat).   python tests/test_plan_options.py"""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.search import pick

pt = lambda c, e: {"confirm": {"risk": c, "contacts": c}, "cost": {"effort": e}}
front = [pt(1.0, 0), pt(0.1, 1), pt(0.05, 3), pt(0.0, 9)]
assert pick(front, 1.0) == [1, 3], pick(front, 1.0)
assert pick([pt(1.0, 0), pt(1.0, 2)], 1.0) == [None, None]   # nothing below the scanned room's toe catches

f = ROOT / "viewer/public/planner/kitchen4_lighter/search.json"
if f.exists():
    d = json.load(open(f))
    pf, n = d["pareto"], d["n_front"]
    assert [o["why"].split(":")[0] for o in d["options"]][0] == "Easiest" and d["options"][-1]["why"].startswith("Safest"), d["options"]
    keep = [o for o in d["options"] if o["why"].startswith("Keep my mat")] + d["options_keep_mat"]
    assert keep and all(pf[o["k"]]["layout"]["mat"] != "removed" for o in keep), keep
    assert all(o["k"] >= n for o in keep) and all(p["layout"]["mat"] != "removed" for p in pf[n:])
    c0 = pf[0]["confirm"]["contacts"]
    assert all(pf[o["k"]]["confirm"]["contacts"] < c0 for o in d["options"] + d["options_keep_mat"])
    print(f"{len(d['options'])} options + {len(d['options_keep_mat'])} keep-mat options OK")
print("option picking OK")

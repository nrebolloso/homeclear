"""planner/engine.py (the GPU search's evaluator) agrees with the viewer's planner.ts: same validity reasons, same snag
table lookups, and contacts/brushes within Monte Carlo noise on the same layouts.   python tests/test_planner.py"""
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner import engine as E

S = E.Scene("kitchen4_lighter")
scan = E.scanned(S)
fix = json.loads(json.dumps(scan)); fix["chairs"]["chair8"] = [0.85, -0.65, 0]; fix.update(mat="taped", cord="taped", nightlight="kitchen")
far = json.loads(json.dumps(scan)); far["chairs"]["chair8"] = [2.6, -1.9, 0]
moved = json.loads(json.dumps(scan)); moved.update(mat="removed", nightlight="off"); moved["chairs"]["chair8"] = [0.85, -0.7, 90]
pls = [scan, fix, far, moved]
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
    json.dump(pls, f)
N = 1000
ts = json.loads(subprocess.run(["node", str(ROOT / "planner/ts_score.ts"), "kitchen4_lighter", f.name, str(N)], capture_output=True, text=True, check=True).stdout)
py = E.score(S, pls, trips=N, seed=3)
for i, (a, b) in enumerate(zip(ts, py)):
    assert a["check"] == E.check(S, pls[i]), (i, a["check"], E.check(S, pls[i]))
    if a["check"]:
        continue   # score() trusts its caller to check() first (the search does)
    assert abs(a["snags"] - b["snags"]) < 1e-6 * max(1, a["snags"]), (i, a["snags"], b["snags"])
    for k, tol in (("contacts", 0.15), ("brushes", 0.08)):
        assert abs(a[k] - b[k]) <= tol * a[k] + 0.05, (i, k, a[k], b[k])
    print(f"layout {i}: risk ts {a['risk']:.1f} py {b['risk']:.1f}  contacts {a['contacts']:.3f}/{b['contacts']:.3f}  brushes {a['brushes']:.1f}/{b['brushes']:.1f}")
print(f"planner engine matches planner.ts on {len(pls)} layouts ({N} trips)")

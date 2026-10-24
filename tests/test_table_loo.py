"""tools/table_loo.py: a table whose splat dimensions are an exact multiple of the tape leaves no error in any fold; one bad
dimension shows in the folds that use it and in the one that predicts it; units don't matter; the checks from table_scale.py
round-trip. Run:  .venv/bin/python tests/test_table_loo.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from table_loo import DIMS, TAPE_M, fit, from_checks, from_table_scale, loo

near = lambda a, b, tol=1e-9: abs(a - b) <= tol

exact = {d: TAPE_M[d] / 1.7 for d in DIMS}   # a splat in some unit, 1.7 units per metre
r = loo(TAPE_M, exact)
assert all(near(f["err_cm"], 0) for f in r["folds"]) and near(r["scale_all"], 1.7) and near(r["mean_abs_err_cm"], 0)
assert [f["predicts"] for f in r["folds"]] == list(DIMS) and all(len(f["scale_from"]) == 2 for f in r["folds"])

# the splat table is 15 % narrow: the width fold shows it directly (predicted from the two good dimensions), and
# the folds that scale from the bad width are off the other way
bad = dict(exact, width=exact["width"] * 0.85)
b = {f["predicts"]: f for f in loo(TAPE_M, bad)["folds"]}
assert near(b["width"]["err_pct"], -15, 1e-6), b["width"]
assert b["length"]["err_pct"] > 0 and b["height"]["err_pct"] > 0
assert near(fit(TAPE_M, bad, ("length", "height")), 1.7)   # without the bad one the scale is still right

# kitchen4's checks (width -18.4 %, height -2.6 % at the length scale): the width fold is the big one, about -17 %
c = {f["predicts"]: f for f in loo(TAPE_M, from_checks(TAPE_M, -18.4, -2.6))["folds"]}
assert -18 < c["width"]["err_pct"] < -16 and abs(c["width"]["err_cm"]) > abs(c["height"]["err_cm"])
k = {f["predicts"]: f for f in loo(TAPE_M, from_checks(TAPE_M, 0.0, 0.0))["folds"]}
assert all(near(f["err_cm"], 0, 1e-7) for f in k.values())

# a table_scale.json written without tape_m still works: the tape length is correction * splat length
js = {"tabletop_splat_units": {"length": 1.2, "width": 0.8, "height": 0.55}, "correction": TAPE_M["length"] / 1.2,
      "check_width_m": {"tape": TAPE_M["width"]}, "check_height_m": {"tape": TAPE_M["height"]}}
tape, splat = from_table_scale(js)
assert near(tape["length"], TAPE_M["length"]) and splat["width"] == 0.8
print("TABLE LOO TEST OK")

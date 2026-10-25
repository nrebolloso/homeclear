"""Leave-one-out scale check on the tape-measured table (SPEC 4.3): set the scale from two table dimensions, predict the
third, for all three pairings; report each error in cm and the mean; the final scale comes from all three. A scale that is
right predicts every dimension, so the held-out errors say how much of the table's disagreement is the scale and how much
is the measurement (a tape reading, a tabletop patch cut off by the camera orbit).
Pure Python (no numpy): the same code runs on a laptop without the pipeline env.

usage:  python tools/table_loo.py <work>/table_scale.json ...      one run per tools/table_scale.py output
        python tools/table_loo.py --kitchens                       the four kitchen captures, from their config notes;
                                                                   writes proof/accuracy/table_loo.json and .md"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIMS = ("length", "width", "height")
TAPE_M = {"length": 1.5748, "width": 1.0414, "height": 0.7112}   # the kitchen table, 62 x 41 x 28 in (BLOCKERS #1)


def fit(tape, splat, dims=DIMS):
    """Scale (metres per splat unit) over `dims`, least squares on the relative errors: s*splat/tape = 1 for each, so a
    1.6 m side doesn't outweigh a 0.7 m one."""
    r = [splat[d] / tape[d] for d in dims]
    return sum(r) / sum(x * x for x in r)


def loo(tape, splat):
    """tape: the three tape lengths (m); splat: the same three measured in the splat (any one unit)."""
    folds = []
    for held in DIMS:
        used = tuple(d for d in DIMS if d != held)
        s = fit(tape, splat, used)
        pred = s * splat[held]
        folds.append({"scale_from": list(used), "predicts": held, "scale": s, "predicted_m": pred, "tape_m": tape[held],
                      "err_cm": 100 * (pred - tape[held]), "err_pct": 100 * (pred / tape[held] - 1)})
    s_all = fit(tape, splat)
    ab = [abs(f["err_cm"]) for f in folds]
    return {"folds": folds, "mean_abs_err_cm": sum(ab) / len(ab), "max_abs_err_cm": max(ab), "scale_all": s_all,
            "fit_err_pct": {d: 100 * (s_all * splat[d] / tape[d] - 1) for d in DIMS}}


def from_checks(tape, width_err_pct, height_err_pct):
    """The splat dimensions implied by tools/table_scale.py's checks. That tool scales on the length, so its width and height
    errors (in %) fix the ratios width/length and height/length, which is all the leave-one-out needs (it ignores units)."""
    return {"length": 1.0, "width": (1 + width_err_pct / 100) * tape["width"] / tape["length"],
            "height": (1 + height_err_pct / 100) * tape["height"] / tape["length"]}


def from_table_scale(js):
    """A tools/table_scale.py output file: the splat table measured in splat units, and the tape it was scaled to."""
    u, c = js["tabletop_splat_units"], js["correction"]
    tape = js.get("tape_m") or {"length": c * u["length"], "width": js["check_width_m"]["tape"], "height": js["check_height_m"]["tape"]}
    return tape, {d: u[d] for d in DIMS}


# the four kitchen captures that scaled on the table: width/height error (%) at the length scale, from the notes next to
# each config's scale.manual_factor (rounded to 0.1 %)
KITCHENS = {
    "kitchen1": (-14.5, 1.7, "configs/kitchen1.yaml"),
    "kitchen2_nofar": (-2.6, -2.3, "configs/kitchen2_nofar.yaml"),
    "kitchen3": (-17.5, -1.5, "configs/kitchen3.yaml; the tabletop patch was cut off on one side (one-sided orbit)"),
    "kitchen4": (-18.4, -2.6, "configs/kitchen4.yaml"),
}


def report(results):
    """Markdown for proof/accuracy/: every fold in cm, the mean, and what the numbers do and don't say."""
    L = ["# Table leave-one-out (SPEC 4.3)", "",
         "Scale set from two of the table's three tape dimensions (62 x 41 x 28 in), the third predicted from the splat; all three pairings.",
         "`tools/table_loo.py --kitchens` writes this file. The splat dimensions are recovered from the width and height checks noted",
         "next to each config's `scale.manual_factor` (0.1 % rounding), not re-measured. **REAL captures, tape rounded to the inch.**", "",
         "| capture | held out | scale from | predicted (cm) | tape (cm) | error (cm) | error (%) |", "|---|---|---|---|---|---|---|"]
    for name, r in results.items():
        for f in r["folds"]:
            L.append(f"| {name} | {f['predicts']} | {' + '.join(f['scale_from'])} | {100 * f['predicted_m']:.1f} | {100 * f['tape_m']:.1f} | "
                     f"{f['err_cm']:+.1f} | {f['err_pct']:+.1f} |")
    L += ["", "| capture | mean abs error (cm) | max abs error (cm) | final scale fit error: length / width / height (%) |", "|---|---|---|---|"]
    for name, r in results.items():
        e = r["fit_err_pct"]
        L.append(f"| {name} | {r['mean_abs_err_cm']:.1f} | {r['max_abs_err_cm']:.1f} | {e['length']:+.1f} / {e['width']:+.1f} / {e['height']:+.1f} |")
    L += ["", "**Reading it.** The height agrees with the length to about 3 % in every capture, so the scale and the floor plane hold.",
          "The width is 15-18 % short in three of the four: that is the same table measured the same way, so either the 41 in tape reading",
          "is wrong or the tabletop patch loses its edges in the splat (kitchen3's note: patch cut off on one side). Until the table is",
          "re-measured (BLOCKERS #1) the width fold is the large one and a scale from `length + height` is the one to trust; the",
          "final scale fits all three, so a bad width pulls it. Only kitchen2_nofar agrees within 3 % on every dimension."]
    return "\n".join(L) + "\n"


def main(argv):
    if argv[:1] == ["--kitchens"]:
        res = {n: loo(TAPE_M, from_checks(TAPE_M, ew, eh)) for n, (ew, eh, _) in KITCHENS.items()}
        out = ROOT / "proof" / "accuracy"
        out.mkdir(parents=True, exist_ok=True)
        (out / "table_loo.json").write_text(json.dumps({"tape_m": TAPE_M, "source": {n: v[2] for n, v in KITCHENS.items()}, "captures": res}, indent=1))
        (out / "table_loo.md").write_text(report(res))
        print(report(res))
        return
    for p in argv:
        r = loo(*from_table_scale(json.loads(Path(p).read_text())))
        print(p, json.dumps({k: r[k] for k in ("mean_abs_err_cm", "max_abs_err_cm", "scale_all", "fit_err_pct")}, indent=1))
        for f in r["folds"]:
            print(f"  {' + '.join(f['scale_from'])} -> {f['predicts']}: {f['predicted_m'] * 100:.1f} cm vs tape {f['tape_m'] * 100:.1f} ({f['err_cm']:+.1f} cm)")


if __name__ == "__main__":
    main(sys.argv[1:])

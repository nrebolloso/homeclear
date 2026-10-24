"""SYNTHETIC detected -> labelled -> merged -> exported -> loaded chain, before any real video exists.

Stage 6c's proposals are faked in its real schema (tests/fixtures/objects_proposed_synthetic.yaml: the sample scene's
objects plus junk modelled on the real bedroom file, e.g. a flat 'bed1' at z_max 0.034). A hand-written
objects_labeled.yaml stands in for the labelling tool's export (tools/label does not exist yet; when it does, feed its
export through the same steps). tools/merge_labels.py turns the two into config entries, stage 12 exports them from the
sample splat, and the viewer's own test loader reads the result.
  .venv/Scripts/python.exe tests/make_sample_objects.py   (first)
  .venv/Scripts/python.exe tests/test_detect_chain.py [--write-fixtures]
"""
import json, shutil, subprocess, sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "stages"), str(ROOT / "tests"), str(ROOT / "tools")]
from make_sample_objects import OBJECTS, FIXTURES
from merge_labels import merge

FIX = ROOT / "tests" / "fixtures"
WORK_SRC, RUN = ROOT / "out" / "sample_objects", "sample_chain"
NOTE = "SYNTHETIC: faked in stage 6c's schema from tests/make_sample_objects.py, not detected by any model"


def rect(box):
    (x0, y0), (x1, y1) = box
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def entry(name, kind, box, z_lo, z_hi, points, detected_as=None):
    return {"name": name, "kind": kind, "poly_xy": rect(box), "points": points, "detected_as": detected_as or kind, "box_xy": [list(box[0]), list(box[1])],
            "z_max": z_hi, "parts": [{"poly_xy": rect(box), "z": [z_lo, z_hi]}]}


def proposals():
    """The real objects (their boxes from the scene generator, as a detector would report them) plus the junk a detector adds."""
    real = {o["name"]: o for o in OBJECTS}
    def p(name, kind=None, z=(0.002, None), points=1000):
        o = real[name]
        return entry(name, kind or o["kind"], o["box_xy"], z[0], z[1] or o["z_max"], points)
    objs = [
        p("bed", points=57000), p("nightstand", points=9000), p("rug", z=(0.002, 0.03), points=18000), p("rug_curl", z=(0.002, 0.04), points=400),
        p("chair", points=6000), p("table", z=(0.05, 0.47), points=5000), p("nightlight", kind="other", points=300), p("door", points=2000),
        # junk, modelled on the real bedroom file: a flat 'bed' (z_max 0.034 m), a fragment of the bed, a cable, a room-sized blob
        entry("bed1", "bed", [[1.9, 0.3], [2.3, 0.5]], -0.016, 0.034, 331),
        entry("bed2", "bed", [[0.5, 2.5], [0.8, 2.8]], 0.002, 0.428, 820),
        entry("chair14", "chair", [[2.6, 3.0], [2.8, 3.2]], 0.002, 0.667, 250),
        entry("cable", "cable", [[3.6, 0.3], [3.68, 2.7]], 0.002, 0.071, 400),
        entry("other16", "other", [[0.2, 0.2], [3.9, 3.9]], 0.002, 1.871, 800, detected_as="table"),
    ]
    return {"objects": objs, "fixtures": [{"name": "toilet", "kind": "toilet", "poly_xy": rect([[5.9, 1.2], [6.45, 1.8]]), "points": 3000,
                                           "detected_as": "toilet", "box_xy": [[5.9, 1.2], [6.45, 1.8]]}], "note": NOTE}


def labels():
    keep = lambda name, kind, weight, movable=True: {"name": name, "kind": kind, "movable": movable, "weight": weight, "source": "synthetic"}
    return {"note": NOTE, "objects": [
        keep("bed", "bed", "heavy"), keep("nightstand", "nightstand", "medium"), keep("rug", "rug", "light"), keep("rug_curl", "rug", "light"),
        keep("chair", "chair", "medium"), keep("table", "other", "medium"), keep("nightlight", "nightlight", "light"), keep("door", "door", "heavy", False),
        {"name": "toilet", "kind": "toilet", "movable": False, "source": "synthetic"},
        *({"name": n, "kind": "junk"} for n in ("bed1", "bed2", "chair14", "cable", "other16"))]}


def main():
    FIX.mkdir(exist_ok=True)
    pr, lb = proposals(), labels()
    if "--write-fixtures" in sys.argv:
        (FIX / "objects_proposed_synthetic.yaml").write_text(f"# {NOTE}\n" + yaml.safe_dump(pr, sort_keys=False))
        (FIX / "objects_labeled_synthetic.yaml").write_text(f"# {NOTE}\n" + yaml.safe_dump(lb, sort_keys=False))
    # the committed fixtures are what the generators say: no drift between the files people read and what is tested
    assert yaml.safe_load((FIX / "objects_proposed_synthetic.yaml").read_text()) == pr, "run with --write-fixtures"
    assert yaml.safe_load((FIX / "objects_labeled_synthetic.yaml").read_text()) == lb, "run with --write-fixtures"
    real = ROOT / "out" / "bedroom" / "objects_proposed.yaml"
    if real.exists():   # same keys as a real stage 6c file
        r = yaml.safe_load(real.read_text())
        assert set(r) >= {"objects", "fixtures"} and set(r["objects"][0]) == set(pr["objects"][0]), (set(r["objects"][0]), set(pr["objects"][0]))

    # 1. merge: junk dropped, everything kept is labelled SYNTHETIC, nothing left unlabelled
    objs, fixs, dropped, unlabeled = merge(pr, lb)
    assert {o["name"] for o in objs} == {"bed", "nightstand", "rug", "rug_curl", "chair", "table", "nightlight", "door"}, objs
    areas = [(o["box_xy"][1][0] - o["box_xy"][0][0]) * (o["box_xy"][1][1] - o["box_xy"][0][1]) for o in objs]
    assert areas == sorted(areas), "smallest first, so the curl is listed before the rug it lies on (labels list the rug first)"
    assert [o["name"] for o in objs].index("rug_curl") < [o["name"] for o in objs].index("rug")
    assert [f["name"] for f in fixs] == ["toilet"] and fixs[0]["kind"] == "toilet"
    assert dropped == ["bed1", "bed2", "chair14", "cable", "other16"] and unlabeled == []
    assert all(e["source"] == "synthetic" for e in objs + fixs)
    assert {o["name"]: o["kind"] for o in objs}["nightlight"] == "nightlight", "the person's label wins over the detector's 'other'"
    for bad, why in [({"objects": [{"name": "bed", "kind": "bed"}]}, "source"), ({"objects": [{"name": "nope", "kind": "bed", "source": "real"}]}, "no such proposal"),
                     ({"objects": [{"name": "bed", "kind": "sofa", "source": "real"}]}, "unknown kind")]:
        try:
            merge(pr, bad)
        except ValueError as e:
            assert why in str(e), e
        else:
            raise AssertionError(f"merge accepted a bad label ({why})")
    left = merge(pr, {"objects": [lb["objects"][0]]})[3]   # only the bed labelled
    assert "bed" not in left and {"nightstand", "rug", "toilet"} <= set(left), "a proposal nobody labelled is reported, not guessed"

    # 2. stage 12 from those entries on the sample splat
    assert (WORK_SRC / "splat_aligned.ply").exists(), "run tests/make_sample_objects.py first"
    work = ROOT / "out" / RUN
    work.mkdir(parents=True, exist_ok=True)
    for f in ("splat_aligned.ply", "cameras.json", "align.json"):
        shutil.copy(WORK_SRC / f, work / f)
    cfg = yaml.safe_load((WORK_SRC / "config.yaml").read_text())
    cfg.update(run_name=RUN, work_dir=f"out/{RUN}")
    cfg["game"]["objects"] = objs
    cfg["game"]["fixtures"] = fixs + [f for f in FIXTURES if f["kind"] != "toilet"]
    (work / "config.yaml").write_text(yaml.safe_dump(cfg, sort_keys=False))
    for s in ("05c_shell", "06_occupancy", "06b_accuracy", "07_plan", "08_hazards", "12_export_scene"):
        subprocess.run([sys.executable, str(ROOT / "stages" / f"{s}.py"), str(work / "config.yaml")], check=True, capture_output=True)
    out = ROOT / "viewer" / "public" / "scene" / RUN
    chain = {o["name"]: o for o in json.loads((out / "scene.json").read_text())["objects"]}
    direct = {o["name"]: o for o in json.loads((ROOT / "viewer/public/scene/sample_objects/scene.json").read_text())["objects"]}
    assert set(chain) == {o["name"] for o in objs}, set(chain)
    assert not set(chain) & set(dropped), "junk reached the scene"
    for n, o in chain.items():   # the chain reproduces what the hand-written config gave
        d = direct[n]
        cen = lambda x: [sum(p[0] for p in x["footprint"]) / 4 + x["pivot"][0], sum(p[1] for p in x["footprint"]) / 4 + x["pivot"][1]]
        assert o["kind"] == d["kind"] and o["layer"] == d["layer"], (n, o["kind"], o["layer"], d["kind"], d["layer"])
        assert abs(o["height_m"] - d["height_m"]) < 0.05 and max(abs(a - b) for a, b in zip(cen(o), cen(d))) < 0.1, (n, o["height_m"], d["height_m"])

    # 3. the viewer's test loader reads it (node strips the types itself, as `node --test` does)
    r = subprocess.run(["node", "--input-type=module", "-e", "import { loadScene } from './tests/scene.ts'; const s = loadScene('%s'); console.log(JSON.stringify([s.sc.objects.map(o => o.name), s.init.fixtures.map(f => f.name)]))" % RUN],
                       cwd=ROOT / "viewer", capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    names, fx = json.loads(r.stdout.strip().splitlines()[-1])
    assert names == [o["name"] for o in objs] and "toilet" in fx, (names, fx)
    print("DETECT CHAIN OK (SYNTHETIC):", {"kept": names, "dropped": dropped})


if __name__ == "__main__":
    main()

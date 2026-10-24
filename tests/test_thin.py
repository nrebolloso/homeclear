"""tools/thin_scene.py on the synthetic game scene: the budget holds (objects' floors aside), the most important Gaussians
survive, every object keeps some, --sh 0 drops f_rest_*, and every non-splat file (grids, route, hazards) is byte-identical.
Run after tests/make_game_scene.py:  .venv/bin/python tests/test_thin.py"""
import json, shutil, subprocess, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
from common import read_ply
from thin_scene import importance

src = ROOT / "viewer" / "public" / "scene" / "game_synth"
dst = src.parent / "thin_test"
sc = json.loads((src / "scene.json").read_text())
total = sum(len(read_ply(src / f)) for f in [sc["splat"]] + [o["splat"] for o in sc["objects"]])
budget, minobj = 50_000, 500
subprocess.run([sys.executable, str(ROOT / "tools" / "thin_scene.py"), str(src), "--budget", str(budget), "--sh", "0",
                "--min-per-object", str(minobj), "--out", dst.name], check=True, capture_output=True)
out = json.loads((dst / "scene.json").read_text())
try:
    main_src, main_out = read_ply(src / sc["splat"]), read_ply(dst / sc["splat"])
    objs = [len(read_ply(dst / o["splat"])) for o in sc["objects"]]
    shown = len(main_out) + sum(objs)
    print(f"total {total:,} -> shown {shown:,} (budget {budget:,}); objects {objs}")
    assert shown == budget, shown                                          # exact: object floors come out of it
    assert all(n > 0 for n in objs)
    assert not any(n.startswith("f_rest_") for n in main_out.dtype.names) and "f_dc_0" in main_out.dtype.names
    s = importance(main_src)                                               # kept = the top of the main splat's ranking
    assert np.sort(s)[::-1][len(main_out) - 1] >= np.median(s)
    assert out["run"] == "thin_test" and out["thinned"]["budget"] == budget and out["thinned"]["of"] == total
    for f in src.rglob("*"):
        if f.is_file() and f.suffix != ".ply" and f.name != "scene.json":
            assert (dst / f.relative_to(src)).read_bytes() == f.read_bytes(), f
    print("THIN TEST OK")
finally:
    shutil.rmtree(dst, ignore_errors=True)

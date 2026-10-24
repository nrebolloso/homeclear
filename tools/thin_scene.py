"""Display copy of an exported viewer scene with fewer Gaussians, for headsets (Quest 2: ~7 fps in VR at 981K splats,
86 fps at 190K).

Only the splats change. Floor, obstacle, bump and coverage grids, route, hazards and walker are copied byte for byte,
so every measurement, clearance and hazard check is the same as in the source scene: thinning is for the eye only.

One global importance threshold over the main splat and the movable objects (an object's score is multiplied by
--object-boost, so the furniture people look at and grab stays sharper) keeps the top --budget Gaussians that show when
the scene opens. Importance ~ opacity x footprint (product of the two largest axes): faint and tiny ones go first.
Fills (shown only once an object moves) use the same threshold and are not counted. Each object keeps at least
--min-per-object of its best Gaussians so it never vanishes. --sh 0 also drops the view-dependent colour (f_rest_*).

usage: python tools/thin_scene.py viewer/public/scene/kitchen4_lighter --budget 250000 [--sh 0] [--out kitchen4_vr250]
writes viewer/public/scene/<out>/ (default <name>_vr<budget/1000>k) and prints what it kept.
"""
import argparse, json, shutil, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import read_ply, write_ply


def importance(v):
    op = 1 / (1 + np.exp(-v["opacity"].astype(np.float64)))
    s = np.sort(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1).astype(np.float64), 1)
    return op * np.exp(s[:, 1] + s[:, 2])   # log scales: the two largest axes' product ~ screen footprint


def drop_sh(v):
    keep = [n for n in v.dtype.names if not n.startswith("f_rest_")]
    out = np.empty(len(v), dtype=[(n, v.dtype[n]) for n in keep])
    for n in keep:
        out[n] = v[n]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("scene", type=Path)
    ap.add_argument("--budget", type=int, required=True, help="Gaussians shown when the scene opens (main + objects)")
    ap.add_argument("--object-boost", type=float, default=2.0)
    ap.add_argument("--min-per-object", type=int, default=2000)
    ap.add_argument("--sh", type=int, choices=(0, 3), default=3, help="0 drops view-dependent colour")
    ap.add_argument("--out")
    a = ap.parse_args()
    src = a.scene.resolve()
    sc = json.loads((src / "scene.json").read_text())
    name = a.out or f"{src.name}_vr{a.budget // 1000}k"
    dst = src.parent / name
    assert dst != src, "--out would overwrite the source scene"

    shown = [(sc["splat"], 1.0)] + [(o["splat"], a.object_boost) for o in sc["objects"]]
    hidden = [o["fill"] for o in sc["objects"] if o.get("fill")] + [sc[k] for k in ("imagined_ceiling", "removed_splat") if sc.get(k)]
    verts = {f: read_ply(src / f) for f, _ in shown}
    scores = {f: importance(verts[f]) * boost for f, boost in shown}
    total = sum(len(v) for v in verts.values())
    # each object's best --min-per-object first (so it never vanishes), then the rest of the budget by rank over
    # everything shown: exactly --budget, never `score >= threshold` (synthetic splats share scores and ties overshot)
    allsc = np.concatenate(list(scores.values()))
    starts = np.cumsum([0] + [len(verts[f]) for f, _ in shown])
    top = np.zeros(len(allsc), bool)
    for i, (f, _) in enumerate(shown[1:], 1):
        top[starts[i] + np.argsort(-scores[f])[:min(a.min_per_object, len(verts[f]))]] = True
    rest = np.flatnonzero(~top)
    n = min(len(rest), max(0, a.budget - int(top.sum())))
    if n:
        top[rest[np.argpartition(-allsc[rest], n - 1)[:n]]] = True
    picked = {f: top[starts[i]:starts[i + 1]] for i, (f, _) in enumerate(shown)}
    thr = allsc[top].min()   # fills (not in the budget) use the same bar

    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("*.ply"))   # grids, route, hazards, walker: unchanged
    kept, report = 0, []

    def write(f, v, keep):
        out = v[keep]
        (dst / f).parent.mkdir(parents=True, exist_ok=True)
        write_ply(dst / f, drop_sh(out) if a.sh == 0 else out)
        return int(keep.sum())

    for f, _ in shown:
        n = write(f, verts[f], picked[f])
        kept += n
        report.append((f, len(verts[f]), n))
    for f in hidden:   # same bar as what they stand in for; not part of the budget
        if not (src / f).exists():
            continue
        v = read_ply(src / f)
        s = importance(v) * a.object_boost
        keep = s >= thr
        if keep.sum() < min(a.min_per_object, len(v)):
            keep = np.zeros(len(v), bool)
            keep[np.argsort(-s)[:min(a.min_per_object, len(v))]] = True
        report.append((f + " (hidden until moved)", len(v), write(f, v, keep)))

    sc["run"] = name
    sc["thinned"] = {"source": src.name, "budget": a.budget, "kept": kept, "of": total, "object_boost": a.object_boost,
                     "sh_degree": a.sh, "note": "display only: grids, route and hazards are the source scene's, unchanged"}
    (dst / "scene.json").write_text(json.dumps(sc, indent=1))

    for f, n0, n in report:
        print(f"{n:>9,} / {n0:>9,}  {f}")
    mb = sum(p.stat().st_size for p in dst.rglob("*.ply")) / 1e6
    print(f"shown at start: {kept:,} of {total:,} ({100 * kept / total:.0f}%), budget {a.budget:,}; splat files {mb:.0f} MB -> {dst}")


if __name__ == "__main__":
    main()

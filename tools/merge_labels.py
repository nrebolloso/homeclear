"""Merge hand labels onto stage 6c's proposals: the accepted objects as a config snippet (game.objects / game.fixtures).

  python -I tools/merge_labels.py out/bedroom/objects_proposed.yaml objects_labeled.yaml [-o snippet.yaml]

objects_labeled.yaml is the labelling tool's export (tools/label, TEAMMATE_TASKS.md lane 4):
  objects:
    - {name: bed, kind: bed, movable: true, weight: heavy, source: real}
    - {name: bed1, kind: junk}            # dropped
`source` (real | synthetic) is required on every kept entry: nothing unlabelled as REAL or SYNTHETIC gets into a scene.
A proposal nobody labelled is left out and listed, never guessed. This does not touch any config file: it prints a snippet
to paste under `game:`.
Objects come out smallest footprint first: stage 12 gives each Gaussian to the FIRST object whose box holds it, so a thing
lying on or standing in another (a curled rug corner on a rug) must be listed before it or the big one swallows it.
"""
import argparse, sys
from pathlib import Path

import yaml

OBJECT_KINDS = {"bed", "rug", "door", "nightstand", "chair", "nightlight", "other"}   # what stage 12 knows
FIXTURE_KINDS = {"toilet", "switch", "phone", "outlet", "grab_bar_wall"}              # game.fixtures
SOURCES = {"real", "synthetic"}
KEEP = ("movable", "weight", "source")                                                # label fields carried onto the entry


def merge(proposed: dict, labeled: dict):
    """-> (objects, fixtures, dropped, unlabeled): config entries for what was accepted, names thrown out as junk, names
    nobody labelled. Raises ValueError on anything it cannot place."""
    props = {e["name"]: e for k in ("objects", "fixtures") for e in proposed.get(k, [])}
    was_fixture = {e["name"] for e in proposed.get("fixtures", [])}
    objects, fixtures, dropped, seen = [], [], [], set()
    for lab in labeled.get("objects", []):
        name, kind = lab["name"], lab["kind"]
        if name not in props:
            raise ValueError(f"label for {name!r}: no such proposal")
        if name in seen:
            raise ValueError(f"{name!r} labelled twice")
        seen.add(name)
        if kind == "junk":
            dropped.append(name)
            continue
        if lab.get("source") not in SOURCES:
            raise ValueError(f"{name!r}: source must be one of {sorted(SOURCES)} (REAL or SYNTHETIC), got {lab.get('source')!r}")
        p = props[name]
        extra = {k: lab[k] for k in KEEP if k in lab}
        if kind == "fixture":      # the generic label keeps the proposal's own fixture kind
            kind = p["kind"]
        if kind in FIXTURE_KINDS:
            fixtures.append({"name": name, "kind": kind, "box_xy": p["box_xy"], **extra})
        elif kind in OBJECT_KINDS:
            if name in was_fixture or "box_xy" not in p:
                raise ValueError(f"{name!r} is a fixture proposal, labelled {kind!r}")
            e = {"name": name, "kind": kind, "box_xy": p["box_xy"], "z_max": p["z_max"], **extra}
            if p.get("parts"):
                e["parts"] = p["parts"]
            objects.append(e)
        else:
            raise ValueError(f"{name!r}: unknown kind {kind!r} (objects {sorted(OBJECT_KINDS)}, fixtures {sorted(FIXTURE_KINDS)}, junk)")
    area = lambda e: (e["box_xy"][1][0] - e["box_xy"][0][0]) * (e["box_xy"][1][1] - e["box_xy"][0][1])
    return sorted(objects, key=area), fixtures, dropped, sorted(set(props) - seen)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("proposed"), ap.add_argument("labeled"), ap.add_argument("-o", "--out")
    a = ap.parse_args()
    objects, fixtures, dropped, unlabeled = merge(*(yaml.safe_load(Path(f).read_text()) for f in (a.proposed, a.labeled)))
    text = yaml.safe_dump({"game": {"objects": objects, **({"fixtures": fixtures} if fixtures else {})}}, sort_keys=False)
    Path(a.out).write_text(text) if a.out else sys.stdout.write(text)
    print(f"kept {len(objects)} objects, {len(fixtures)} fixtures; dropped as junk: {dropped}; NOT labelled (left out): {unlabeled}", file=sys.stderr)


if __name__ == "__main__":
    main()

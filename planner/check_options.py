"""Sanity check of a search's options (out/planner/<scene>/search.json): what each one changes, that nothing outside the
search space (chairs, mat, cord, nightlight, walker caps) moves, and its top 3 fixes by toe catches saved (each fix put back
on its own, re-scored with the confirm seed).
    python -m planner.check_options [--scene kitchen4_lighter] [--search out/planner/<scene>/search.json] [--trips 2000]"""
import argparse, copy, json

from planner import engine as E


def revert(pl, scan, item):
    q = copy.deepcopy(pl)
    if item in q["chairs"]:
        q["chairs"][item] = scan["chairs"][item]
    elif item == "mat":
        q["mat"], q["mat_at"] = scan["mat"], scan.get("mat_at")
    else:
        q[item] = scan.get(item)
    return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="kitchen4_lighter")
    ap.add_argument("--search")
    ap.add_argument("--trips", type=int, default=2000)
    a = ap.parse_args()
    data = json.load(open(a.search or E.ROOT / "out/planner" / a.scene / "search.json"))
    S = E.Scene(a.scene, device="cpu")
    scan = data["scanned"]["layout"]
    movable = {*S.cfg["chairs"], S.cfg["mat"], S.cfg["nightlight"]}
    p0 = E.to_poses(S, scan)[0]
    ok = True
    for o in data["options"]:
        pl, c = data["pareto"][o["k"]]["layout"], data["pareto"][o["k"]]["confirm"]
        p1 = E.to_poses(S, pl)[0]
        moved = [S.objects[k]["name"] for k in range(len(p0)) if p0[k] != p1[k]]
        bad = [n for n in moved if n not in movable]
        ok &= not bad and not E.check(S, pl)
        items = E.cost(S, scan, pl)["items"]
        say = lambda i: f"{i} -> {pl['chairs'][i]}" if i in pl["chairs"] else f"{i} -> {pl.get(i)}{' at ' + str(pl['mat_at']) if i == 'mat' and pl['mat'] == 'moved' else ''}"
        sc = E.score(S, [pl] + [revert(pl, scan, i) for i in items], trips=a.trips, seed=2)
        saved = sorted(((sc[j + 1]["contacts"] - sc[0]["contacts"], i) for j, i in enumerate(items)), reverse=True)
        print(f"{o['why']}: {c['contacts']:.3f} toe catches/month (scanned {data['pareto'][0]['confirm']['contacts']:.3f}); "
              f"effort {data['pareto'][o['k']]['cost']['effort']:.1f}, ${data['pareto'][o['k']]['cost']['usd']}; changes {[say(i) for i in items]}; "
              f"tie-breakers {c['snags']:.1f} snags + {c['brushes']:.1f} brushes")
        print(f"  moved {moved}{'  NEVER-MOVE TOUCHED: ' + str(bad) if bad else ''}{'  INVALID: ' + str(E.check(S, pl)) if E.check(S, pl) else ''}")
        for d, i in saved[:3]:
            print(f"  {say(i)}: {d:+.3f} toe catches/month saved")
    print("OPTIONS OK" if ok else "OPTIONS FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()

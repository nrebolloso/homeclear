"""Pre-render a scene's Cosmos scenarios (cosmos/prerender.yaml): export each layout headlessly from the walker game,
estimate the B200 time, and optionally submit them all as one Slurm array.

  python cosmos/prerender.py cosmos/prerender.yaml [--scene game_synth] [--only name,name] [--submit]

Needs the viewer dev server (cd viewer && npx vite --port 5179) for the exports. --submit uploads the exports and the
scene, then runs cosmos/slurm/cosmos_prerender.sbatch as an array (at most max_parallel at once); fetch the finished
clips with cosmos/fetch_cosmos.sh. The viewer then lists each clip as "this layout" whenever its layout is on screen.
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / "viewer" / "public" / "exports"


def export(scene, sc, prompts):
    """One scenario -> one export job (viewer/e2e/export.ts). Returns the job name and its export summary."""
    cmd = ["node", "e2e/export.ts", scene, "--scenario", sc["name"], "--condition", sc.get("condition", "night")]
    if sc.get("night"):
        cmd.append("--night")
    if sc.get("hero"):
        cmd.append("--hero")
    for k in ("persona", "route", "option"):
        if k in sc:
            cmd += [f"--{k}", str(sc[k])]
    if sc.get("fixes"):
        cmd += ["--fixes", ",".join(sc["fixes"])]
    if sc.get("condition") in prompts or sc.get("prompt"):
        cmd += ["--prompt", sc.get("prompt") or prompts[sc["condition"]]]
    r = subprocess.run(cmd, cwd=ROOT / "viewer", capture_output=True, text=True, shell=sys.platform == "win32")
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError(f"export {sc['name']} failed:\n{r.stderr[-2000:]}")
    job = r.stdout.strip().splitlines()[-1]
    return job, json.loads(r.stderr.strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--scene", default="game_synth")
    ap.add_argument("--only", default="")
    ap.add_argument("--submit", action="store_true")
    ap.add_argument("--parallel", type=int, default=0, help="array tasks at once (default max_parallel; lower it while other GPU jobs run)")
    a = ap.parse_args()
    cfg = yaml.safe_load(Path(a.config).read_text())
    scen = [s for s in cfg["scenes"][a.scene] if not a.only or s["name"] in a.only.split(",")]
    rows, jobs = [], []
    for sc in scen:
        job, info = export(a.scene, sc, cfg["prompts"])
        chunks = info["chunks"]
        secs = chunks * cfg["chunk_seconds"] + cfg["job_overhead_seconds"]
        rows.append((sc["name"], job, chunks, secs, info.get("layout_key", "?")))
        jobs.append(job)
        print(f"{sc['name']:32s} {chunks} chunk(s)  ~{secs / 60:5.1f} min  {info.get('layout_key')}", flush=True)
    total = sum(r[3] for r in rows)
    wall = total / cfg["max_parallel"]
    print(f"\n{len(rows)} clips, {sum(r[2] for r in rows)} chunks: ~{total / 3600:.2f} B200-hours, "
          f"~{wall / 3600:.2f} h wall at {cfg['max_parallel']} at a time (allocation time on HiPerGator, not money)")
    listing = EXPORTS / f"prerender_{a.scene}.txt"
    listing.write_text("\n".join(jobs) + "\n", newline="\n")
    (EXPORTS / f"prerender_{a.scene}.json").write_text(json.dumps(
        [{"scenario": n, "job": j, "chunks": c, "seconds": s, "layout_key": k} for n, j, c, s, k in rows], indent=1))
    if not a.submit:
        print(f"jobs listed in {listing.relative_to(ROOT)}; --submit to run them")
        return
    sh = (f'source ./hpg.sh && hpg_load configs/home.yaml && '
          f'hpg_ssh "mkdir -p $REPO/viewer/public/exports $REPO/viewer/public/scene" && '
          f'hpg_rsync -a common.py "$HOST:$REPO/" && hpg_rsync -a cosmos/ "$HOST:$REPO/cosmos/" && '
          f'hpg_rsync -a cosmos/ "$HOST:$HPG_ROOT/cosmos/" && '
          f'hpg_rsync -a viewer/public/scene/{a.scene} "$HOST:$REPO/viewer/public/scene/" && '
          + " && ".join(f'hpg_rsync -a viewer/public/exports/{j} "$HOST:$REPO/viewer/public/exports/"' for j in jobs) +
          f' && hpg_rsync -a viewer/public/exports/prerender_{a.scene}.txt "$HOST:$REPO/viewer/public/exports/" && '
          f'hpg_ssh "bash -lc \'cd $HPG_ROOT/cosmos && HPG_ROOT=$HPG_ROOT ENV=$ENV sbatch --parsable '
          f'--array=0-{len(jobs) - 1}%{a.parallel or cfg["max_parallel"]} slurm/cosmos_prerender.sbatch prerender_{a.scene}.txt\'"')
    # the bash on PATH (Git Bash on Windows): a bare "bash" there can resolve to WSL's System32ash.exe first
    r = subprocess.run([shutil.which("bash") or "bash", "-c", sh], cwd=ROOT)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()

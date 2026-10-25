"""proof/demo/real_vs_sim_rug.mp4 and proof/demo/broll/ from the real walker/rug clips and the calibrated cloth-rug sim.

real_vs_sim_rug.mp4 (1920x1080): the clearest real fold (floor + wide, synced by data/walker_rug/pairs.csv) above the
sim pass (physics/rug_calib.py, fitted arm) and a slot for a real glide-cap / tennis-ball pass (--caps clip.mp4 fills it).
broll/: the fold takes' last seconds (floor and wide), at speed and at 0.5x (the floor phone records 60 fps).
    MUJOCO_GL=egl python tools/rug_video.py [--caps data/walker_rug/floor/<tennis-ball pass>.mp4]
"""
import json, subprocess, sys, tempfile
from pathlib import Path

import mujoco
import numpy as np
import pandas as pd
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "physics"))
import rug_calib as RC

RUG = ROOT / "data/walker_rug"
OUT = ROOT / "proof/demo"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
HERO = "20261024_194349.mp4"   # 1000101382: the largest real fold (person B), audio sync sure
BROLL = {"382_large_fold": "20261024_194349.mp4", "387_fold_grows": "20261024_194745.mp4",
         "385_corner_flips": "20261024_194622.mp4", "extra_fold_behind_glide": "20261024_193828.mp4"}
TAIL_S, W, H = 5.0, 960, 540   # the folds happen in each take's last seconds (recording_notes.csv)


def ff(*a):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, a)], check=True)


def dur(f):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)],
                                capture_output=True, text=True, check=True).stdout)


def esc(s):
    return s.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace("%", "\\%")


def label(lines, size=26):
    return ",".join(f"drawtext=fontfile={FONT}:text='{esc(t)}':x=18:y={14 + k * (size + 8)}:fontsize={size}:fontcolor=white"
                    f":box=1:boxcolor=black@0.6:boxborderw=6" for k, t in enumerate(lines))


def sim_clip(path):
    """Render the fitted arm's most-dragged 'off' pass (the fitted arm drags where the real rug folds). Returns its info."""
    trials = json.load(open(ROOT / "physics/rug_calib_trials.json"))
    t = max((x for x in trials if x["arm"] == "fitted" and x["direction"] == "off" and x["outcome"] != "clean"), key=lambda x: x["drag_m"])
    p = {k: t[k] for k in ("E", "mpa", "v", "push", "load", "stride", "dy", "direction", "mu_gr", "mu_rf")}
    keep = []
    r = RC.trial(p, keep)
    M = mujoco.MjModel.from_xml_string(RC.model(p)); D = mujoco.MjData(M)
    M.vis.global_.offwidth, M.vis.global_.offheight = W, H
    M.flex_rgba[0] = [0.82, 0.74, 0.62, 1]; M.geom_rgba[0] = [0.62, 0.48, 0.34, 1]
    cam = mujoco.MjvCamera(); cam.lookat[:] = [RC.RUG_L * 0.75, 0, 0.0]; cam.distance, cam.azimuth, cam.elevation = 2.0, 210, -24
    M.vis.headlight.ambient[:], M.vis.headlight.diffuse[:] = [0.45] * 3, [0.6] * 3
    with mujoco.Renderer(M, H, W) as rd, tempfile.TemporaryDirectory() as d:
        for k, (_, q, mp) in enumerate(keep):
            D.qpos[:] = q; D.mocap_pos[:] = mp; mujoco.mj_forward(M, D)
            rd.update_scene(D, cam)
            Image.fromarray(rd.render()).save(f"{d}/{k:04d}.png")
        ff("-framerate", 30, "-i", f"{d}/%04d.png", "-pix_fmt", "yuv420p", path)
    return t, r, len(keep) / 30


def main():
    caps = sys.argv[sys.argv.index("--caps") + 1] if "--caps" in sys.argv else None
    pairs = pd.read_csv(RUG / "pairs.csv").set_index("floor")
    (OUT / "broll").mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        t, r, sim_s = sim_clip(f"{d}/sim.mp4")
        off = float(pairs.loc[HERO, "offset_s"])            # wide time = floor time + off
        f0, w0 = max(0.0, -off), max(0.0, off)
        L = min(dur(RUG / "floor" / HERO) - f0, dur(RUG / "wide" / pairs.loc[HERO, "wide"]) - w0)
        fold_at = dur(RUG / "floor" / HERO) - f0 - 2.5     # the fold shows ~2.5 s before the floor clip ends (by eye)
        lead = max(0.0, fold_at - (sim_s - 1.5))            # line the sim's end of push up with the real fold
        slot = (["-i", caps] if caps else ["-f", "lavfi", "-i", f"color=c=0x202020:s={W}x{H}:r=30:d={L}"])
        sim_txt = ["SIMULATED: MuJoCo cloth rug, fitted friction", f"glide-rug {t['mu_gr']:.2f}, rug-floor {t['mu_rf']:.2f}: rear glides drag the edge {100 * r['drag_m']:.0f} cm",
                   "sim drags where the real rug flips (fold under-predicted)"]
        slot_txt = ["REAL: glide caps / tennis balls pass"] if caps else ["SLOT: real glide-cap / tennis-ball pass", "not recorded yet (BLOCKERS.md)"]
        fc = (f"[0:v]scale={W}:{H},setsar=1,{label(['REAL floor camera (take 1000101382, person B)'])}[a];"
              f"[1:v]scale={W}:{H},setsar=1,{label([f'REAL wide view, audio-synced ({off:+.2f} s)'])}[b];"
              f"[2:v]scale={W}:{H},setsar=1,tpad=start_duration={lead:.2f}:start_mode=clone:stop_mode=clone:stop_duration={L},trim=duration={L},{label(sim_txt, 22)}[c];"
              f"[3:v]scale={W}:{H},setsar=1,{label(slot_txt)}[e];"
              "[a][b]hstack[top];[c][e]hstack[bot];[top][bot]vstack,fps=30[v]")
        ff("-ss", f0, "-t", L, "-i", RUG / "floor" / HERO, "-ss", w0, "-t", L, "-i", RUG / "wide" / pairs.loc[HERO, "wide"],
           "-i", f"{d}/sim.mp4", *slot, "-filter_complex", fc, "-map", "[v]", "-map", "0:a?", "-t", L,
           "-c:v", "libx264", "-crf", 20, "-pix_fmt", "yuv420p", "-c:a", "aac", OUT / "real_vs_sim_rug.mp4")
    for name, fl in BROLL.items():
        D_ = dur(RUG / "floor" / fl); s = D_ - TAIL_S
        srcs = [("floor", RUG / "floor" / fl, s)]
        if isinstance(pairs.loc[fl, "wide"], str):
            srcs.append(("wide", RUG / "wide" / pairs.loc[fl, "wide"], max(0.0, s + float(pairs.loc[fl, "offset_s"]))))
        for cam, f, ss in srcs:
            base = OUT / "broll" / f"{name}_{cam}"
            ff("-ss", ss, "-t", TAIL_S, "-i", f, "-vf", "scale=1920:1080", "-c:v", "libx264", "-crf", 20, "-pix_fmt", "yuv420p", "-an", f"{base}.mp4")
            ff("-ss", ss, "-t", TAIL_S, "-i", f, "-vf", "scale=1920:1080,setpts=2*PTS", "-r", 30,
               "-c:v", "libx264", "-crf", 20, "-pix_fmt", "yuv420p", "-an", f"{base}_slow.mp4")
    print(f"sim pass: {t['outcome']}, drag {r['drag_m']:.3f} m (stored {t['drag_m']:.3f}); lead {lead:.2f} s; wrote {OUT / 'real_vs_sim_rug.mp4'} and broll/")


if __name__ == "__main__":
    main()

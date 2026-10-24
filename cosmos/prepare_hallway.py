"""Step 5 input (laptop): cut a 93-frame 1280x720 16 fps clip from the hallway video and write the Cosmos spec.
  python cosmos/prepare_hallway.py [--video data/home.mp4] [--start 12.5] [--depth d.mp4] [--seg s.mp4]
Edge and blur controls are auto-extracted by Cosmos from the RGB clip. --depth/--seg are the hook for control
videos rendered from the splat (same 93 frames, same camera path); give them and the spec uses them too."""
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path
import yaml

HERE, ROOT, C = Path(__file__).resolve().parent, Path(__file__).resolve().parents[1], os.environ["HPG_ROOT"] + "/cosmos"
sys.path.insert(0, str(ROOT))
from common import FFMPEG
PROMPT = ("The same kitchen at 3 AM, lights off, lit only by a small warm nightlight near the floor; "
          "realistic home interior; camera moving slowly forward.")
ap = argparse.ArgumentParser()
ap.add_argument("--video", default=yaml.safe_load((ROOT / "config.yaml").read_text())["video"])
ap.add_argument("--start", type=float, default=0.0, help="seconds into the video")
ap.add_argument("--depth"); ap.add_argument("--seg")
a = ap.parse_args()
video = (ROOT / a.video).resolve()
assert video.exists(), f"{video} not found (set --video or config.yaml video)"

out = HERE / "inputs"; out.mkdir(exist_ok=True)
clip = out / "hallway_93.mp4"
# fill 1280x720 (crops a portrait phone video to its middle band), 16 fps = the model's output rate, exactly 93 frames
subprocess.run([FFMPEG, "-y", "-v", "error", "-ss", str(a.start), "-i", str(video),
                "-vf", "fps=16,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1",
                "-frames:v", "93", "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(clip)], check=True)
w, h, n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,nb_read_frames", "-of", "csv=p=0", str(clip)],
                         capture_output=True, text=True, check=True).stdout.strip().split(",")
assert (int(w), int(h), int(n)) == (1280, 720, 93), (w, h, n)

spec = {"name": "kitchen_3am", "prompt": PROMPT, "video_path": f"{C}/inputs/hallway_93.mp4", "guidance": 3,
        "edge": {"control_weight": 1.0}, "vis": {"control_weight": 0.5}}   # no control_path -> computed on the fly
for key, p in (("depth", a.depth), ("seg", a.seg)):
    if p:
        shutil.copy(p, out / f"hallway_{key}.mp4")
        spec[key] = {"control_path": f"{C}/inputs/hallway_{key}.mp4", "control_weight": 1.0}
(out / "hallway_spec.json").write_text(json.dumps(spec, indent=1))
print(f"{clip}: {w}x{h}, {n} frames @16 fps; controls: {[k for k in ('edge', 'vis', 'depth', 'seg') if k in spec]}")

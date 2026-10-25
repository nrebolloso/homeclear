"""Ingest check + pairing for the real walker/rug clips (data/walker_rug/{floor,wide}).

ingest.csv: resolution, fps, duration, ArUco ids seen (DICT_4X4_50, 8 sampled frames), motion (mean abs frame difference,
0-255, at 1/8 scale) and the recording start in local time. pairs.csv: each floor clip paired with the wide clip whose start
is nearest (phones' clocks agree to a few seconds), then the offset refined by cross-correlating the audio onset envelopes.
offset_s = wide time - floor time for the same instant. A clip with no partner within 30 s is listed with an empty wide.
    python tools/rug_ingest.py [data/walker_rug]
"""
import json, subprocess, sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import pandas as pd

HZ = 100           # sync signal rate (10 ms)
SR = 16000         # audio rate for sync (flux band reaches 7 kHz)
DET = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50))


def probe(f):
    j = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(f)],
                                  capture_output=True, text=True, check=True).stdout)
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    tags = j["format"].get("tags", {})
    if "com.apple.quicktime.creationdate" in tags:      # iPhone: local start time with zone
        start = datetime.fromisoformat(tags["com.apple.quicktime.creationdate"]).replace(tzinfo=None)
    else:                                                # Samsung: start time is the file name, YYYYMMDD_HHMMSS
        start = datetime.strptime(f.stem, "%Y%m%d_%H%M%S")
    rot = int(next((d.get("rotation", 0) for d in v.get("side_data_list", []) if "rotation" in d), 0))
    w, h = (v["height"], v["width"]) if rot % 180 else (v["width"], v["height"])
    num, den = map(int, v["avg_frame_rate"].split("/"))
    return {"w": w, "h": h, "fps": round(num / den, 2), "dur": float(j["format"]["duration"]), "start": start}


def frames_check(f, n=8):
    cap = cv2.VideoCapture(str(f))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    ids, diffs = set(), []
    for k in np.linspace(0, total - 2, n).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, k)
        ok, a = cap.read()
        ok2, b = cap.read()
        if not (ok and ok2):
            continue
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        _, found, _ = DET.detectMarkers(g)
        ids |= set() if found is None else set(found.ravel().tolist())
        sa, sb = (cv2.resize(cv2.cvtColor(x, cv2.COLOR_BGR2GRAY), None, fx=1 / 8, fy=1 / 8).astype(float) for x in (a, b))
        diffs.append(np.abs(sa - sb).mean())
    cap.release()
    # frame-to-frame diff at 30 fps is small even when the walker moves; also compare first vs middle frame for gross motion
    return sorted(ids), round(float(np.mean(diffs)), 2) if diffs else None


def cached(root, f, kind, fn):
    c = root / ".cache" / f"{f.name}.{kind}.npy"
    if not c.exists():
        c.parent.mkdir(exist_ok=True)
        np.save(c, fn(f))
    return np.load(c)


def onset_env(f):
    """Audio spectral flux, 1-7 kHz, at HZ: wheel clacks, footsteps and rug scuffs, the sync events both phones hear.
    Band-limited and whitened per band because a loudness envelope is dominated by room hum and each phone's mic EQ."""
    x = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-map", "0:a:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                                     capture_output=True, check=True).stdout, np.float32)
    n = 1024
    S = np.log1p(1e2 * np.abs(np.fft.rfft(np.lib.stride_tricks.sliding_window_view(x, n)[:: SR // HZ] * np.hanning(n))))
    fq = np.fft.rfftfreq(n, 1 / SR)
    S = S[:, (fq >= 1000) & (fq <= 7000)]
    S = S - np.median(S, 0)
    return np.maximum(np.diff(S, axis=0, prepend=S[:1]), 0).sum(1)


def motion_env(f):
    """Image motion energy at HZ/5 (mean abs frame difference at 96x54), repeated to HZ: the walker starting, stopping
    and the rug folding move both views at the same instants."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-vf", f"fps={HZ // 5},scale=96:54,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.uint8).reshape(-1, 54, 96).astype(float)
    m = np.abs(np.diff(x, axis=0)).mean((1, 2))
    return np.repeat(np.concatenate([m[:1], m]), 5)


def xcorr(a, b):
    """Best lag (s) of a inside b by normalized cross-correlation over every lag with enough overlap (the shorter clip's
    half, at least 3 s); returns (lag, peak corr, peak / best other peak more than 0.5 s away)."""
    minov = max(3 * HZ, min(len(a), len(b)) // 2)
    lags, cs = [], []
    for lag in range(minov - len(a), len(b) - minov + 1):
        i0, i1 = max(0, lag), min(len(b), lag + len(a))
        sa, sb = a[i0 - lag: i1 - lag], b[i0:i1]
        sa, sb = sa - sa.mean(), sb - sb.mean()            # normalize over the overlap only, so edges don't fake peaks
        cs.append(float((sa * sb).sum() / (np.linalg.norm(sa) * np.linalg.norm(sb) + 1e-9)))
        lags.append(lag)
    cs, lags = np.array(cs), np.array(lags)
    k = int(np.argmax(cs))
    other = cs[np.abs(lags - lags[k]) > HZ // 2]
    return lags[k] / HZ, round(float(cs[k]), 3), round(float(cs[k] / max(other.max(), 1e-3)), 2) if len(other) else 9.99


def sync(root, floor, wide):
    """offset_s = where the floor clip's t=0 falls in the wide clip. Audio first; image motion when audio is weak."""
    fa, wa = (cached(root, f, "flux", onset_env) for f in (floor, wide))
    fm, wm = (cached(root, f, "motion", motion_env) for f in (floor, wide))
    ao, ac, ar = xcorr(fa, wa)
    mo, mc, mr = xcorr(fm, wm)
    a_ok, m_ok = ac >= 0.5 and ar >= 1.4, mc >= 0.5 and mr >= 1.15
    agree = abs(ao - mo) <= 0.3
    if a_ok:
        off, method = ao, "audio"
    elif m_ok:
        off, method = mo, "motion"
    else:
        off, method = (ao if ac * ar >= mc * mr else mo), "weak"
    sure = (a_ok and (agree or not m_ok)) or (m_ok and agree) or (m_ok and not a_ok and mr >= 1.4)
    return {"offset_s": off, "method": method, "audio_off": ao, "audio_corr": ac, "audio_ratio": ar,
            "motion_off": mo, "motion_corr": mc, "motion_ratio": mr, "agree": agree, "unsure": not sure}


def main(root):
    root = Path(root)
    if (root / "ingest.csv").exists() and "--reingest" not in sys.argv:
        ing = pd.read_csv(root / "ingest.csv")
        print(ing.to_string(index=False))
    else:
        ing = ingest(root)
    pair(root, ing)


def ingest(root):
    rows = []
    for cam in ("floor", "wide"):
        for f in sorted((root / cam).glob("*")):
            p = probe(f)
            ids, motion = frames_check(f)
            rows.append({"file": f.name, "camera": cam, "res": f"{p['w']}x{p['h']}", "fps": p["fps"], "dur_s": round(p["dur"], 2),
                         "start": p["start"].isoformat(), "aruco_ids": " ".join(map(str, ids)), "motion": motion,
                         "ok": p["w"] * p["h"] >= 3840 * 2160 and bool(ids) and (motion or 0) > 0.5})
    ing = pd.DataFrame(rows)
    ing.to_csv(root / "ingest.csv", index=False)
    print(ing.to_string(index=False))
    return ing


def pair(root, ing):
    fl, wd = ing[ing.camera == "floor"], ing[ing.camera == "wide"]
    pairs = []
    for _, r in fl.iterrows():
        t0 = datetime.fromisoformat(r.start)
        # a wide clip qualifies if its span overlaps the floor clip's span (plus 30 s clock slack); prefer the shortest
        # (the trimmed pass rather than the long take it was cut from) among those with the nearest start
        cand = []
        for _, w in wd.iterrows():
            g = (t0 - datetime.fromisoformat(w.start)).total_seconds()   # floor start in wide time, by the clocks
            if -30 <= g <= w.dur_s + 30:
                cand.append((abs(g) if g < 0 else max(0.0, g - w.dur_s + r.dur_s), w.dur_s, w.file, g))
        if not cand:
            pairs.append({"floor": r.file, "wide": "", "clock_offset_s": "", "offset_s": "", "audio_corr": "", "method": "unpaired"})
            continue
        cand.sort()
        for _, _, wfile, g in cand[:2]:                 # the best match, and a runner-up (a duplicate export or the long take)
            pairs.append({"floor": r.file, "wide": wfile, "clock_offset_s": round(g, 1),
                          **sync(root, root / "floor" / r.file, root / "wide" / wfile)})
    pr = pd.DataFrame(pairs)
    pr.to_csv(root / "pairs_candidates.csv", index=False)
    pd.set_option("display.width", 250)
    print(pr.to_string(index=False))
    # one row per floor clip: the surest candidate, then the higher audio peak, then the shorter (trimmed) wide clip
    pr["_dur"] = pr.wide.map(dict(zip(wd.file, wd.dur_s)))
    best = pr.sort_values(["unsure", "audio_corr", "_dur"], ascending=[True, False, True], na_position="last").groupby("floor", sort=False).head(1)
    alt = pr.drop(best.index).groupby("floor").apply(lambda g: "; ".join(f"{w} at {o:+.2f} s" for w, o in zip(g.wide, g.offset_s)), include_groups=False)
    out = best.set_index("floor").reindex(fl.file).reset_index().rename(columns={"file": "floor"})
    out["alternates"] = out.floor.map(alt).fillna("")
    out = out[["floor", "wide", "offset_s", "method", "audio_corr", "audio_ratio", "motion_off", "motion_corr", "agree", "unsure", "clock_offset_s", "alternates"]]
    out.to_csv(root / "pairs.csv", index=False)
    print("\npairs.csv (offset_s = where floor t=0 falls in the wide clip)\n" + out.to_string(index=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/walker_rug")

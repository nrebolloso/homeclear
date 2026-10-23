"""Fetch PhysioNet Multi-Gait-Posture 1.0.0 (CC BY 4.0) without the depth frames:
processed_data/*.zip (skeleton CSVs) whole, and from each raw_data/*.zip ONLY the Xsens Segment Position and Center of Mass
sheets (world frame), read with HTTP range requests so the depth images never download.
usage: python motion/fetch_gait.py <dest_dir>"""
import hashlib, io, sys, zipfile, urllib.request
from pathlib import Path

# PhysioNet's own open-data S3 mirror: same files (checked against SHA256SUMS), physionet.org serves ~10 KB/s
BASE = "https://physionet-open.s3.amazonaws.com/multi-gait-posture/1.0.0/"

# of the 17 Xsens sheets per trial only world positions are needed (530 MB -> ~100 MB per participant)
KEEP = ("_csv/Segment Position.csv", "_csv/Center of Mass.csv", "_extrinsic_calibration.json", ".stamp")


class HttpRange(io.RawIOBase):
    """Seekable read-only file over HTTP range requests (enough for zipfile)."""
    def __init__(self, url):
        self.url, self.pos = url, 0
        # size from a 1-byte range GET: PhysioNet stalls on HEAD requests
        r = urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"}), timeout=60)
        self.size = int(r.headers["Content-Range"].split("/")[1])
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, off, whence=0):
        self.pos = {0: off, 1: self.pos + off, 2: self.size + off}[whence]
        return self.pos
    def readinto(self, b):
        if self.pos >= self.size:
            return 0
        end = min(self.pos + len(b), self.size) - 1
        data = urllib.request.urlopen(urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"}), timeout=120).read()
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)


def get(url, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        urllib.request.urlretrieve(url, dst)


def main(dest):
    dest = Path(dest)
    for f in ("LICENSE.txt", "SHA256SUMS.txt", "processed_data_description.txt", "raw_data_description.txt", "subject_metadata.csv"):
        get(BASE + f, dest / f)
    sha = {l.split()[1]: l.split()[0] for l in (dest / "SHA256SUMS.txt").read_text().splitlines() if l.strip()}
    for k in range(14):
        p = f"participant{k:02d}.zip"
        get(BASE + "processed_data/" + p, dest / "processed_zip" / p)
        assert sha[f"processed_data/{p}"] == hashlib.sha256((dest / "processed_zip" / p).read_bytes()).hexdigest(), p
        with zipfile.ZipFile(dest / "processed_zip" / p) as z:
            z.extractall(dest / "processed")
        with zipfile.ZipFile(io.BufferedReader(HttpRange(BASE + "raw_data/" + p), 1 << 20)) as z:
            want = [m for m in z.infolist() if m.filename.endswith(KEEP)]
            for m in want:
                if not (dest / "raw" / m.filename).exists():
                    z.extract(m, dest / "raw")
            print(p, "raw members kept", len(want), "of", len(z.infolist()),
                  f"({sum(m.file_size for m in want) / 1e6:.0f} MB of {sum(m.file_size for m in z.infolist()) / 1e9:.1f} GB)", flush=True)


if __name__ == "__main__":
    main(sys.argv[1])

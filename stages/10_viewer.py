"""Stage 10: check the Spark viewer loads the splat + hazards in headless Chrome; save its screenshot.

To use interactively: python3 -m http.server -d <repo> 8000, then open
http://localhost:8000/viewer/check.html?run=out/<run_name>
"""
import base64, functools, http.server, json, os, shutil, signal, subprocess, sys, tempfile, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import run_stage, ROOT

import cv2
import numpy as np


class Handler(http.server.SimpleHTTPRequestHandler):
    result, done = {}, threading.Event()

    def do_POST(self):  # the page posts {status, png, hazards} once the splat has rendered (or failed)
        Handler.result.update(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(204)
        self.end_headers()
        Handler.done.set()

    def log_message(self, *a):
        pass


def main(cfg):
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    chrome = shutil.which("google-chrome") or shutil.which("chromium") or (mac if Path(mac).exists() else None)
    assert chrome, "google-chrome/chromium not found"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    run = cfg["work"].relative_to(ROOT)
    url = f"http://127.0.0.1:{srv.server_address[1]}/viewer/check.html?run={run}&selftest=1"
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as prof:
        p = subprocess.Popen([chrome, "--headless=new", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
                              "--no-first-run", "--window-size=1280,800", "--remote-debugging-port=0",
                              f"--user-data-dir={prof}", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        Handler.done.wait(cfg["viewer"]["timeout_ms"] / 1000)
        os.killpg(p.pid, signal.SIGKILL)  # chrome's renderer/GPU children too
        p.wait()
    srv.shutdown()
    r = Handler.result
    m = {"status": r.get("status", "timeout"), "hazards_listed": r.get("hazards"),
         "url": f"http://localhost:8000/viewer/check.html?run={run}"}
    if r.get("png"):
        png = base64.b64decode(r["png"].split(",", 1)[1])
        (cfg["work"] / "viewer.png").write_bytes(png)
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
        m["splat_pixels_pct"] = round(100 * float((img > 10).mean()), 1)  # markers alone are well under 1%
    return m["status"] == "loaded" and m.get("splat_pixels_pct", 0) > 5, m


if __name__ == "__main__":
    run_stage("10_viewer", main)

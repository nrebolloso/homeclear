"""Runs the repo's examples/inference.py unchanged, but times model load (Control2WorldInference.__init__)
separately from generation (.generate) and records torch's peak allocated memory. Writes $TIMINGS (json)."""
import json, os, runpy, sys, time
import torch
import cosmos_transfer2.inference as ci

T = {}
def timed(name, f):
    def g(*a, **k):
        t = time.time()
        try:
            return f(*a, **k)
        finally:
            T[name] = round(time.time() - t, 1)
            T["torch_peak_allocated_gb"] = round(torch.cuda.max_memory_allocated() / 1e9, 1)
            open(os.environ["TIMINGS"], "w").write(json.dumps(T))
    return g

ci.Control2WorldInference.__init__ = timed("model_load_s", ci.Control2WorldInference.__init__)
ci.Control2WorldInference.generate = timed("generate_s", ci.Control2WorldInference.generate)
sys.argv = ["examples/inference.py"] + sys.argv[1:]
runpy.run_path("examples/inference.py", run_name="__main__")

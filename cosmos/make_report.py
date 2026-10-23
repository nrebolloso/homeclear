"""results/*.json -> cosmos_smoke_report.md.  python make_report.py [cosmos_dir]  (run on HPG or on a pulled copy)"""
import json, re, sys
from pathlib import Path

C = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
steps = [("setup", "2a env (Apptainer NGC 25.10 + repo install)"), ("envcheck", "2b torch sees B200, BF16"),
         ("download", "3 checkpoints to /blue"), ("example_edge", "4 repo example (edge)"), ("hallway", "5 our kitchen clip (edge + blur)"),
         ("route_night", "6a splat route at 3 AM (depth + seg from splat)"), ("route_moved", "6b splat route, furniture moved (fill)")]
R = {p.stem: json.loads(p.read_text()) for p in (C / "results").glob("*.json")}
steps += [(k, f"sweep {k} (edge weight {int(m[1]) / 10}, guidance {m[2]})")   # night_e<weight*10>_g<guidance>
          for k in sorted(R) if (m := re.fullmatch(r"night_e(\d+)_g(\d+)", k))]
L = ["# Cosmos-Transfer2.5-2B smoke test (HiPerGator B200)", "",
     "| Step | Status | Runtime | Peak VRAM | Notes |", "|---|---|---|---|---|"]
for key, label in steps:
    r = R.get(key)
    if r is None:
        L.append(f"| {label} | NOT RUN | | | |"); continue
    if key == "setup":
        rt, vram, note = f"pull {r['pull_s']} s, install {r['install_s']} s", "", ""
    elif key == "envcheck":
        rt, vram = "", ""
        note = f"{r['device']} sm_{''.join(map(str, r['capability']))}, torch {r['torch']} CUDA {r['torch_cuda']}, bf16={r['bf16']}; " + \
               ", ".join(f"{m}={r[m]}" for m in ("flash_attn", "transformer_engine", "natten") if m in r)
    elif key == "download":
        rt, vram = f"{r['total_s']} s", ""
        note = f"{r['cache_gb']} GB in cache; " + "; ".join(i["error"] for i in r["items"] if "error" in i)
    else:
        rt = f"wall {r['wall_s']} s (load {r.get('model_load_s', '?')} s, generate {r.get('generate_s', '?')} s)"
        vram = f"{r['peak_vram_gb_nvidia_smi']} GB (torch alloc {r.get('torch_peak_allocated_gb', '?')} GB)"
        note = "<br>".join(r["outputs"]) or f"exit {r['exit_code']}, see logs/"
    L.append(f"| {label} | {r['status']} | {rt} | {vram} | {note} |")
for key in ("example_edge", "hallway", "route_night", "route_moved"):
    if key in R:
        L += ["", f"`{key}` command: `{R[key]['command']}`"]
L += ["", "Wall time includes container start, control extraction (on-the-fly edge/blur for the hallway), guardrails and video decode.",
      "Peak VRAM from `nvidia-smi` every 0.5 s (whole process incl. CUDA context); torch alloc = `torch.cuda.max_memory_allocated()`.",
      "When torch alloc is the larger number, the 0.5 s sampling missed the spike: the true peak is at least the larger of the two.",
      "Errors: see `logs/` next to this file."]
(C / "cosmos_smoke_report.md").write_text("\n".join(L) + "\n")
print("\n".join(L))

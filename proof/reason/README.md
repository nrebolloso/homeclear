# Cosmos Reason evaluation (SPEC 4.10)

Question: does Cosmos Reason catch hazards the measured geometry misses, and at what cost in false alarms? Arms compared on one hand-labelled
answer key: geometry alone, geometry + Reason, and geometry + a general vision model (so a gain can't be put down to "any VLM helps").
Nothing here is a measurement: Reason's claims stay "proposed, OT to verify" whatever this says.

Status: the harness exists and is tested on synthetic claims (`tests/test_reason_eval.py`). **No real run yet**: there is no answer key and
no Reason output in this folder, so there is no result to report.

## Steps (one scene at a time; the scene must have stages 5-8 and 12 done, so it has `maps/` and `hazards.json`)
1. **Label the answer key first, before looking at what Reason or the geometry flagged.** Serve the repo and open the labeller:
   ```bash
   python -m http.server 8000      # from the repo root
   # http://localhost:8000/tools/label_hazards/index.html?dir=/viewer/public/scene/<run>
   ```
   Click each real hazard on the map from the capture photos or by walking the route in the viewer: raised rug edges, cables, thresholds,
   clutter, missing grab bars, slippery mats, dark spots, tight squeezes. Aim for 30-50 items spread along the route. "Download" gives
   `answer_key_<run>.yaml`; save it here (`proof/reason/answer_key_<run_name>.yaml`; `answer_key.template.yaml` shows the format).
   The orange rings are the geometry's own flags: label what is really there, which includes things it missed.
2. **Run Reason on HiPerGator** (Cosmos-Reason2-8B licence accepted, BLOCKERS.md): `sbatch cosmos/slurm/cosmos_reason.sbatch configs/<cfg>.yaml --frames 40`
   writes `<work>/reason.json` and copies it to `proof/reason/reason_<work>.json`.
3. **The general-model arm**, same frames and prompt, another Qwen3-VL-class instruct model (check the id loads on HPG, e.g. `Qwen/Qwen3-VL-8B-Instruct`):
   `OUT=reason_general.json sbatch cosmos/slurm/cosmos_reason.sbatch configs/<cfg>.yaml --frames 40 --model <model id>`.
   Stage 12 only reads `reason.json`, so this run never reaches the viewer. Optional: without it the table has no general arm.
4. **Score it** (CPU, anywhere):
   ```bash
   python cosmos/reason_eval.py --key proof/reason/answer_key_<run>.yaml --hazards <work>/hazards.json --reason proof/reason/reason_<work>.json \
       [--general proof/reason/reason_general_<work>.json] --path <work>/path.json --out proof/reason/eval_<run>
   ```
   `--path` keeps only hazards within 1.2 m of the planned route (what the geometry follows and Reason's frames cover), so no arm is
   charged for something it could not see. The report lists every key item and which arm found it, the extra claims each model made
   that match nothing, and the rule below.

## Reading it
- A claim matches a key item of the same kind family within 0.5 m (`--radius`), nearest pair first, one claim per item.
- **Reason is kept only if geometry + Reason finds key items the geometry alone missed.** The report also gives the extra false alarms it brings.
- Recall is split into kinds a scan can measure (bumps, rugs, cables, squeezes) and kinds no scan can (grab bars, slippery, lighting): the second group is
  where Reason can matter, since the geometry can never claim them.
- Limits to state with any result: one scene, one labeller, the lifted position of a Reason claim carries depth and pose error (hence the 0.5 m radius),
  and a small key gives wide uncertainty: report counts, not just ratios.

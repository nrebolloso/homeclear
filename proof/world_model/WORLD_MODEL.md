# World model (walker user) — proof

Branch `worldmodel`, code in `worldmodel/` (contract: `worldmodel/INTERFACE.md`). Verdict at the bottom is updated as
each step lands. Everything in this file is on the **SYNTHETIC** test map unless it says REAL.

## Step 1 — hand-rule baseline + rollout engine (tag `wm-baseline`)

`python -m worldmodel.rollout --map worldmodel/maps/synth_kitchen --out proof/world_model/baseline --plot`
(laptop CPU, 200 nights × 2 trips = 400 trips, 6,624 steps, 5.8 s). Outputs: `baseline/rollout.png`, `summary.json`,
`events.csv`, `rollout.npz`.

**The map** (`worldmodel/maps.py`, SYNTHETIC, stage-6 format, 2 cm cells): 5 × 4 m kitchen + hallway, 0.82 m doorway
with a 0.8 cm threshold, counter with a 1.2 cm sink mat, fridge, island, table with three chairs. The fridge closes the
west side of the island, so the only way to the sink is the **0.78 m gap** between the island and the west chair
(0.66 m walker → 6 cm per side). Route: hallway → doorway → gap → sink, 6.3 m, then back.

**Baseline step rule:** the swing heel lands one step length (persona `stride_m` 0.35) ahead of the gait midline,
toward the route point 1 m ahead, at ±`foot_sep_m`/2; Gaussian spread `stride_cv`·L along, `step_jitter_m` across.
Walker: geometric rule (frame centre `user_gap + depth/2` ahead of the body, aimed at the 1 m point, yaw eases 50%/step,
pulled back when the front bar would go through a counter or wall).

**Per month** (30 nights × 2 trips; contact table = PLACEHOLDER, not calibrated):

| hazard | toe contacts (expected) | sampled | swings over | snags | leg collisions | frame brushes |
|---|---|---|---|---|---|---|
| bump:sink_mat (1.2 cm) | 0.644 | 0.45 | 61.2 | 32.4 | 0 | 0 |
| bump:threshold (0.8 cm) | 0.475 | 0.30 | 120 | 0 | 0 | 0 |
| obst:chair_W (tight gap) | 0 | 0 | 0 | 0 | 1.65 | 52.8 |
| obst:counter | 0 | 0 | 0 | 0 | 2.7 | 30.0 |
| obst:island | 0 | 0 | 0 | 0 | 3.15 | 8.55 |
| obst:door_jamb_L / _R | 0 | 0 | 0 | 0 | 0.75 / 0.75 | 23.4 / 3.6 |
| obst:hall_S (route end) | 0 | 0 | 0 | 0 | 0 | 30.0 |
| **total** | **1.12** | 0.75 | | 32.4 | 9.0 | 154 |

Sampled toe contacts by month (6 full months): 0, 1, 1, 1, 0, 2.

- **Snags** are rear glides catching the mat edge (ASSUMED thresholds: glide 1.0 cm, front wheel 1.5 cm); the
  0.8 cm threshold catches neither. **Collisions** = a walker leg inside an obstacle cell: the gap chair, the island
  corner and the door jambs, i.e. exactly the pinch points. `hall_S` brushes are the walker parked at the hallway's
  end wall at the end of each return trip, not a hazard.
- **Sanity:** heels inside obstacles after rejection 0% (raw draws 0.11%, resampled); consecutive-heel distance
  p5/p50/p95 = 0.33/0.39/0.45 m, none outside 0.1–0.8 m.
- **Real map, no code change:** the same command on `out/kitchen4_dv` (REAL, read-only, stage-7 `path.json` as the
  route) runs (30 nights, 0.7 s). Its sparse splat bump specks register as snags there, which is a map-noise question
  for the maps session, not a model result. Not committed (scratch only).
- Self-checks: `python -m pytest worldmodel/test_worldmodel.py` (5 pass: hazard ids, route clearance, mixture
  sampling/density, baseline steering, remove-the-mat).

**Assumed, not measured:** step time 0.9 s, heel→toe 0.17 m, brush distance 3 cm, snag rises; contact table placeholder.

> Step-1 numbers above are from tag `wm-baseline`. Two engine changes since (start heels centred on the route start;
> routes smoothed at 0.3 m, see "Closed-loop stability") shift them slightly; the current baseline run is
> `baseline/summary.json` and the table in step 2.

## Step 2 — learned world model (REAL data: PhysioNet Multi-Gait-Posture)

### Data
PhysioNet **Multi-Gait-Posture 1.0.0**, CC BY 4.0 (cite the PhysioNet record and Goldberger et al. 2000 when published).
Adults walking with a wheeled walker, straight corridors and single left/right 90° corners, 3 speeds.
`python -I worldmodel/gait.py <dataset> data/samples.npz` → 361 trials, 7,413 steps, **4,794 samples**.

- **Departure from the brief ("processed skeletons only"):** footsteps and the route come from the **raw Xsens
  world-frame sheets** (60 Hz, 23 segments), exactly as `motion/gait_data.py` already did, because the processed camera
  skeleton is in the walker camera's frame and has no world frame to place feet in. The processed
  `aligned_skeleton_3d.csv` is used for the walker: a rigid fit (Kabsch) of the camera skeleton onto the Xsens one gives
  the camera's, i.e. the walker's, pose in the world. Fit residual median **20.9 mm**, 0 / 181,494 frames rejected (> 5 cm).
- Skipped: `participant01_straight_0.3_corridor1` (45 camera rows vs 1,020 index rows) and
  `participant03_right_0.3_corner1` (empty index file); one P02 folder holds a stray csv of another trial.
- Dropped steps: 769 same-side (stance detection), 6 implausible lengths, 400 without a camera frame within 2 Xsens frames.
- **Walker shift assumption:** the data's walker point is the research walker's camera, 1.09 m from the user on average.
  The sim keeps its own walker geometry and takes only the variation around that mean (shift −0.593 m).
- Split **by participant**: train P00–P09 (3,294), val P10–P11 (749), **test P12–P13 (751)**. No walker videos of our
  own exist in `data/walker_videos/`, so no fine-tuning.

### Model (`worldmodel/learned.py`, `train.py`)
MLP 10 → 128 → 128 (SiLU) with two heads: next heel = mixture of 5 Gaussians; walker pose when it lands = one Gaussian
(x, y, yaw). Local frame on the stance heel, mirrored for the right foot. Inputs = last 3 heels + the 3 route points the
engine uses as the action. Weights committed in `worldmodel/weights/` (`learned.npz` for numpy, `learned.onnx` for the
viewer). ONNX checked in **onnxruntime-web 1.30 (wasm)**: max |web − torch| = 1.4e-6 (`learned/onnx_web_check.txt`).

### Held-out test (REAL, P12–P13) — `learned/results.json`
One step (heel error mean, NLL, coverage of the 50% / 90% regions):

| model | heel err (cm) | corner heel err | NLL | cover 50 / 90 | walker pos (cm) | walker yaw (°) |
|---|---|---|---|---|---|---|
| hand rule as configured | 10.73 | 10.23 | 0.261 | 0.08 / 0.32 | 8.17 | 3.37 |
| hand rule fit to train | 7.49 | 8.30 | −2.903 | 0.64 / 0.95 | 8.17 | 3.37 |
| **learned** | **3.63** | **4.20** | **−4.548** | 0.57 / 0.93 | **7.91** | **2.70** |

**Closed loop** (each held-out trial rolled out from its first state along its real route, the model's own steps fed
back; phase-free errors vs the real walk):

| model | group | heel side-offset (cm) | walker pos (cm) | walker yaw (°) | step length (cm) |
|---|---|---|---|---|---|
| hand rule as configured | straight (18) | 5.54 | 2.77 | 3.99 | 6.73 |
| | corner (36) | 10.15 | 4.07 | 9.39 | 4.56 |
| hand rule fit to train | straight | 4.47 | 2.85 | 4.35 | 5.89 |
| | corner | 8.77 | 4.61 | 10.54 | 4.86 |
| **learned** | straight | **2.09** | **2.68** | **3.35** | **3.82** |
| | corner | **3.02** | **3.70** | **4.12** | **3.47** |

**Verdict: the learned model beats the hand rule on every closed-loop measure, most at the corners** (heel
side-offset 3.0 vs 8.8–10.2 cm, walker yaw 4.1° vs 9.4–10.5°). Smallest margin: walker position on straights, 2.68 vs
2.77 cm (about a tie). The 90% region covers 93% of held-out steps (calibrated); the 50% region 57%.

### Walker feedback
A first version also took the previous walker pose as input. One-step it was better (walker 4.9 cm), but in closed loop
on the synthetic kitchen it fed its own errors back: walker up to 4.4 m from the feet, yaw flipping 180°, 374
collisions a month vs 9. The walker input was dropped: the walker now follows the feet and the route and cannot drift.

### Closed-loop stability
On the synthetic kitchen the learned model still made 11.35% impossible steps (15.9% of steps reversing along the
route), while on real held-out routes it makes 0%. Causes, in order of effect:
1. **The A\* route is out of distribution.** Grid kinks up to 72° per cm, median 5.5° per 10 cm; real routes stay under
   3.8° per 10 cm even at p99. Fix: `plan_route` smooths the route at 0.3 m (`SMOOTH_M`; walker users walk curves, not
   grid steps). Clearance still checked by `test_route_avoids_obstacles`; route 6.27 → 5.49 m.
2. **Start state:** the start heels sat behind `route[0]`, giving action features 5–20 sd out. Now centred on it.
3. **Glitch components:** mixture components under 2% weight (sd 0.3–0.4 m) absorb stance-detection errors in the
   data; drawn in a 400-step loop one places a heel 0.7 m backward. The simulation drops them (`MIN_W`); one-step
   scores keep the full mixture.

Bare closed loop on the kitchen route, impossible steps: 11.35% → 7.2% (σ 15 cm) → 3.4% (20 cm) → 1.6% (30 cm).

### Synthetic kitchen, 200 nights, both models (SYNTHETIC map) — `learned/synth_kitchen/*/summary.json`
Per month (contact table PLACEHOLDER):

| model | fix | toe contacts (exp.) | snags | collisions | brushes | impossible steps |
|---|---|---|---|---|---|---|
| baseline | none | 1.043 | 27.75 | 11.4 | 156 | 0% |
| baseline | remove sink mat | 0.474 | 0 | 13.2 | 159 | 0% |
| baseline | move chair_W 0.3 m | 1.042 | 27.75 | 6.45 | 109 | 0% |
| learned | none | 1.014 | 30.6 | 30.3 | 166 | 0.54% |
| learned | remove sink mat | 0.501 | 0 | 34.2 | 166 | 0.53% |
| learned | move chair_W 0.3 m | 1.054 | 32.25 | 20.4 | 128 | 0.49% |

- Both models rank the fixes the same way: removing the mat removes all snags and ~50–55% of toe contacts; moving the
  chair cuts collisions (11.4 → 6.5 baseline, 30.3 → 20.4 learned). Removing the mat does not change collisions; the
  11.4 vs 13.2 and 30.3 vs 34.2 gaps are Monte Carlo noise between runs.
- The learned model reports ~3× the collisions. Its steps carry real people's variability (step length p5–p95
  0.25–0.58 m vs the hand rule's 0.33–0.45 m), so the walker drifts wider through the 6 cm-a-side gap and past the
  island and counter. There is no ground truth on this synthetic map to say which count is right; the REAL held-out
  tests above are what say the learned model walks more like people.
- ~0.5% of learned steps are still outside 0.1–0.8 m: the kitchen S-curve is sharper than any training corner. Not
  hidden: reported in every `summary.json` under `sanity`.

**Training run:** B200, Slurm job 47354332 (`slurm/worldmodel.sbatch`, 49 s wall, best epoch 18; `learned/train_log.json`).
A laptop CPU run of the same code and seed gave the same verdict (closed-loop corner heel 3.16 cm, yaw 4.16°); the
"Closed-loop stability" diagnosis above was done on that CPU model.

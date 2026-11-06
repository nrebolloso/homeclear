# Homeclear: a discharge dress rehearsal

> Working name. Alternatives considered: Ghostwalk, D/C Ready, Discharge Orders, Threshold.

Build spec for the full product, for the team.

---

## 1. What it is

Before an older adult comes home from the hospital, someone films the home with a phone. We turn the video into a **measured 3D Gaussian splat**, then **simulate this patient, with their walker, walking their real routes hundreds of times** to find where they would trip, snag the walker, or get stuck. We test fixes (move a chair, remove a mat, add a nightlight), rank them by how much risk they remove, and hand the occupational therapist (OT) a report before the patient comes home.

**Demo scenario:** a real kitchen (`kitchen1_dvapp`; `kitchen2` and `kitchen3` as alternates). It's the patient's first morning home: walk from the kitchen entrance to the sink, then to a chair at the table, and sit down.

**One-liner:** *The splat measures the home, a learned world model predicts how the patient moves, physics checks the walker, Cosmos Reason catches what measurement can't, and Cosmos Transfer shows the family what that morning looks like.*

### Why it matters
- Falls spike right after discharge: 8.0 per 1,000 person-days in the first 2 weeks vs. 1.7 three months later (Mahoney et al.). Across 600,000+ discharged older adults, falls peaked in the first 3 weeks, at about $9,600 per fall (HKU).
- The current fix, an OT home visit, takes just under 4 hours of OT time, and averaged £208 in one UK trial (HOVIS). Visits that can't happen in time delay discharge.
- Prior work (3D home scans for remote OT assessment, LiDAR hazard checklists such as RASSAR) measures homes. **Nobody simulates the specific patient, equipment, and routes.** That's our gap.

---

## 2. Hard rules

1. **Measured vs. imagined are never mixed.** Every hazard number comes from measured geometry, the world model, physics, or published data. Anything generated (Cosmos video, fills under moved objects) is tinted and labeled "imagined, not measured" and never used for measurement.
2. **Nothing faked.** Every number, PASS, screenshot, and video comes from something that actually ran. Label results SYNTHETIC or REAL.
3. **Know the accuracy, design around it.** Report measured error against tape measurements. Anything within that margin of a limit is flagged "borderline, OT to verify," not pass/fail.
4. **Support, not diagnosis.** Pitch as "flags for OT review."

---

## 3. Architecture

```
Phone video ──► Reconstruction (gsplat, B200) ──► Metric splat (scaled from table dimensions)
                                                     │
                       ┌─────────────────────────────┼──────────────────────────────┐
                       ▼                             ▼                              ▼
              Scene understanding            Occupancy + bump maps          Cosmos Reason 2
              (SAM 3 masks → 3D)            (floater-filtered, local         (hazard proposals,
                                              floor-relative heights)          lifted to 3D,
                       │                             │                         confirmed by geometry)
                       └──────────────┬──────────────┘                              │
                                      ▼                                             │
                         Route planner (A* on inflated grid)                        │
                                      ▼                                             │
          Rollout engine: learned world model + walker physics + toe-clearance model│
                         (hundreds of simulated trips)                              │
                                      ▼                                             ▼
                 Risk per hazard, ranked fixes ─────────────────────────────► OT report
                                      │
                                      ▼
        Viewer: Spark + three.js (first/third person, ghost walkers, drag objects)
                                      │
                                      ▼
        Export controls ──► Cosmos Transfer 2.5 (B200, precomputed) ──► photoreal clip
```

**Live in the browser:** splat rendering, walker, hazard checks, dragging objects, re-planning, rollouts, night shader.
**Precomputed on HiPerGator:** splats, maps, fills under movable objects, Cosmos Transfer clips, Cosmos Reason outputs, model training.

---

## 4. Components

### 4.1 Capture
- Phone video, 4K30, main 1x lens, focus and exposure locked, slow walking.
- Three passes: chest height, waist height angled down, knee/floor height (camera 10–20 cm up, tilted 30–45° down). Close orbits (30–50 cm) around each floor hazard.
- Every light on; blinds closed at night; mirrors covered; no flashlight.
- Ground truth: tape-measure known dimensions. For `kitchen1_dvapp`: table height, width, length (inches). Ideally also one floor-level gap the walker passes through and the doorway width.
- Optional: printed ArUco markers (DICT_4X4_50, 150 mm) on the floor for scale; measure the printed size.

### 4.2 Reconstruction
- gsplat on HiPerGator **B200** via Slurm, best-quality settings per current docs (e.g. MCMC strategy, full iterations, full resolution).
- If the capture app exported camera poses or depth, use them (after a consistency check); otherwise COLMAP.
- Optional second model with 2D Gaussian splatting for measurement (flatter surfaces, fewer floaters); keep the 3DGS model for visuals.
- Floater cleanup: drop very transparent or oversized Gaussians; crop to the room.

### 4.3 Scale and accuracy
- Fit the tabletop plane and extent; convert inches to meters.
- **Leave-one-out:** set scale from two table dimensions, predict the third, for all three combinations; report each error in cm and the mean; final scale from all three. Table height also validates the floor plane.
- Validate against any extra gap/doorway measurements. Report mean and max error in `proof/accuracy/`.
- Use the measured error as the borderline margin everywhere downstream.

### 4.4 Scene understanding and maps
- Floor: RANSAC plane on Gaussian centers; align floor to z = 0.
- Occupancy grid (~2 cm cells): obstacles from ~5 cm to 1.8 m height. Only trust cells observed from many views.
- Floor-bump grid: ~0.5–5 cm features, with heights measured **relative to a locally fitted floor plane** (cancels global error).
- Semantic masks: SAM 3 (text-prompted: "rug", "mat", "cable", "chair", "table") on frames, lifted to 3D using camera poses.
- Thin hazards (cables): classify, don't measure; use a typical height labeled "estimated."
- Coverage mask: where the capture had good coverage (used to fence walking).

### 4.5 Route planner (intention, not a world model)
- A* on the occupancy grid with obstacles inflated by half the walker width plus margin.
- Extra cost for hugging walls and sharp turns; smooth to waypoints.
- Re-plans live in a Web Worker when objects move.

### 4.6 World model: learned walker-user motion
- **Question it answers:** "Given how this person has been walking and where they're heading, where does the next foot (and the walker) go?"
- **State:** recent heel/toe positions, center of mass, speed, heading, walker pose, distances to nearby obstacles. **Action:** the route point ~1 m ahead. **Output:** a distribution (mixture of Gaussians) over the next foot placement and walker pose.
- **Data:**
  - PhysioNet **Multi-Gait-Posture** (CC BY 4.0): 14 adults walking with a wheeled walker, straight and through left/right corner turns at 0.3/0.5/0.7 m/s; heel and toe positions; ~92 min. Download processed skeletons only. Limits: young participants (mean ~25), remote-guided walker.
  - **Our walker videos:** a two-front-wheel, two-rear-glide folding walker. Courses: straight, 90° turns, doorway, tight U-turn, backing up to sit, crossing a mat edge and threshold. 2–3 people; acted slow passes labeled. Heel/toe from an open-source pose model; ArUco markers on floor (scale) and walker crossbar (tracking).
  - Optional rescaling toward older adults: Caicedo et al. older-adults gait dataset (if downloadable) or cited published averages.
- **Training:** small network on B200 via Slurm; pretrain on PhysioNet, fine-tune on our videos. Split by participant; hold out at least one person entirely.
- **Baseline:** hand-rule step model (fixed step length/width, centerline following).
- **Evaluation (held-out people):**
  - one-step error, learned vs. baseline, straight vs. turns
  - closed-loop rollouts at 10/20/40 steps (average and final displacement error)
  - uncertainty coverage (fraction of real steps inside the predicted 90% region)
  - counterfactual: same start, route turning left/straight/right; predictions must follow
  - sanity: % of steps inside walls, impossible step lengths
- **Rule:** use the learned model only if it beats the baseline; otherwise ship the baseline and say so.
- **Deployment:** export to ONNX; run in the browser with onnxruntime-web in a Web Worker; measure ms per step.

### 4.7 Walker physics
- Rapier (browser, WebAssembly) in a Web Worker.
- Floor: heightfield from the bump grid; walls/furniture: boxes from the occupancy map.
- Walker: rigid frame, two front wheels, two rear glides, built from the real walker's measured wheel diameter, glide size, width, weight.
- The person is a pushing force following the world model's steps. A sharp deceleration = **snag event**.
- **Validation:** push the real walker over a real threshold, a folded mat corner, and a taped cable; the sim must agree on what catches.

### 4.8 Rollout engine (the "ghost walkers")
```
for each of N simulated trips (default 200–500):
    start beside the entrance; plan route
    repeat until seated at the table:
        goal  = route point ~1 m ahead
        dist  = world_model(state, goal, obstacles)
        step  = sample(dist)
        physics: move walker → snag?
        toe check: crossing a hazard edge → contact probability
        update state
    record path, contacts, snags, gap brushes
aggregate → per-hazard rates, expected toe contacts per month
```
- **Toe-contact probability** comes from published gait data through a calibration table (hazard height → contact probability per stride), not from video. Reference: older adults' minimum toe clearance averaged 14.1 ± 8.3 mm, with contact on a 1 cm obstacle about 1 in 578 strides (Frontiers 2014). The distribution is skewed: calibrate to published rates, don't assume a bell curve.
- **Model-based planning:** for each intervention (remove mat, move chair, tape cable, add nightlight), modify the map, re-plan, re-run, and rank by risk reduction.

### 4.9 Viewer ("the walker game")
- **Stack:** Vite + TypeScript + three.js + Spark (splat renderer) + three.js TransformControls; plain HTML/CSS panels (or Tweakpane); Web Workers for planning, rollouts, physics, ONNX.
- **Modes:** first person (eye height) and third person (mannequin pushing the walker).
- **Mannequin:** freely licensed rigged humanoid, scaled to persona, slightly stooped; walk cycle timed to predicted steps; two-bone foot IK plants each foot exactly on the predicted footstep; hands IK'd to the handles. Quality checks: foot skating < ~1 cm, penetration/floating < ~1 cm.
- **Autoplay** along the route (demo default) and **free walk** (WASD), fenced to covered floor; gray fog where coverage is thin.
- **Live hazard checks:** a foot over a bump flashes red with its measured height; the walker frame turns red below the clearance margin with the gap in cm; snags flash.
- **World-model visuals:** next-step cloud (floor decal, opacity = probability), future trail (~3 s of predicted steps), footprint decals, ghost walkers + footfall heatmap (red where it overlaps hazards), learned vs. baseline split view, live "what if" when dragging the goal.
- **Editable scene:** chairs, mats, table (if separable), nightlight. Move/rotate (90° snaps), blocked by walls; tinted precomputed fill appears at the original spot; route and numbers update live.
- **Night mode:** lighting shader; a placed nightlight adds warm falloff.
- **Panels:** hazard list (measured / "OT should check"), toe contacts per month, before/after when layout changes, measured vs. imagined legend, model info (training data, held-out error).
- **Cosmos clip player:** video element with a canvas overlay drawing hazard markers from the clip's saved camera path.
- Target 30+ fps on a laptop. Runs fully offline.

### 4.10 Cosmos Reason 2 (hazard spotter)
- Sizes 2B/8B/32B; start with 8B on a B200.
- Input: real route frames + patient context; output: structured JSON (type, reason, image location).
- Lift each proposal to 3D via the frame's camera pose; cluster across frames.
- Geometry confirms (→ simulation), dismisses, or routes to "OT should check" when unmeasurable (missing grab bar, slippery mat, clutter).
- **Evaluation:** hand-label 30–50 frames as an answer key; compare geometry alone vs. geometry + Reason vs. geometry + a general vision model (catches and false alarms). Keep Reason only if it adds real catches.
- Its reasoning sentences become notes in the OT report.

### 4.11 Cosmos Transfer 2.5 (photoreal clip for the family)
- Transfer 2.5-2B: up to four controls (edge, blur, segmentation, depth); 1280×720 at 16 fps; ~93-frame chunks; ~65 GB GPU memory → **B200 only**.
- Export from the viewer: camera path along the worst-case simulated trip, per-frame depth (splat + mannequin/walker, depth-composited), segmentation (floor, wall, counter, table, chair, mat, person, walker), edges; 93-frame chunks with ~16 frames overlap. Use pose/keypoint control if the current version supports it.
- **Never draw hazard highlights into controls**; overlay them after generation.
- Prompt example: *"An older adult in comfortable home clothes slowly pushing a two-wheeled folding walker across a home kitchen in early morning light; realistic, steady camera."* Fixed seed; same prompt across chunks; blend at overlaps.
- Variants: as-is vs. after fixes; optional night version.
- Precomputed; labeled "imagined, not measured."

### 4.12 OT report
- One HTML page (printable to PDF): scene overview, route map, measured hazards with measurements and borderline flags, toe contacts/snags per month, ranked fixes with risk reduction, equipment to order, "OT should check" list with Cosmos Reason notes, accuracy statement, generated imagery clearly labeled.

---

## 5. Data formats (shared contract)

```
viewer/public/scene/
  scene.json            manifest: units (m), axis convention (z-up → three.js y-up handled in ONE place), file list
  splat_main.ply        main splat, metric, floor at height 0
  objects/<id>.ply      movable objects, removed from main splat
  objects/<id>.json     footprint polygon, allowed rotations
  fills/<id>.ply        precomputed fill for the object's original spot (tinted)
  maps/occupancy.png+json   cell size, origin, values
  maps/bumps.png+json       floor-relative heights (m)
  maps/coverage.png+json
  hazards.json          [{id, type, pos, height_m, clearance_m, source: geometry|cosmos_reason,
                          measured|estimated, borderline, ot_check, note}]
  route.json            start, goal, waypoints
  walker.json           width, depth, wheel_diameter, glide size, leg positions, handle height
  persona.json          height, eye height, gait profile, trips per day
viewer/public/clips/    <clip>.mp4 + <clip>.json (prompt, layout, camera path, date)
worldmodel/INTERFACE.md world model + rollout engine API (state, action, output, events)
```

---

## 6. Repo layout

```
capture/        capture instructions, marker PDF, measurement log
pipeline/       frames, poses, splat training, scale/accuracy, maps, segmentation, export
worldmodel/     data prep, model, training, evaluation, rollout engine, ONNX export
physics/        Rapier walker model, validation notes
cosmos/         control rendering, Transfer jobs, Reason jobs, chunk stitching
viewer/         Vite + TS app
slurm/          sbatch scripts (B200)
proof/          accuracy/, hipergator/, world_model/, realistic_sim/, person_walk/, cosmos/, demo/
STATUS.md  BLOCKERS.md  RESULTS.md
```

---

## 7. HiPerGator

- **All GPU jobs on B200:** `--partition=hpg-b200 --gpus=1`. Request only the CPU/memory/time needed.
- Run a B200 sanity job first: nvidia-smi, torch/CUDA versions, device capability, BF16 matmul, gsplat CUDA kernels compiling and running. Rebuild CUDA extensions for the B200 if needed.
- Never run heavy work on login nodes. Large data and checkpoints on `/blue`.
- Containers: Apptainer (not Docker).
- Gated models (Cosmos, SAM 3): Hugging Face login + license acceptance by a human first; never store tokens in the repo.
- Proof of every job: job ID, sbatch script, log, `sacct` state/elapsed/exit code, runtime, peak GPU memory, outputs.

---

## 8. Build order and acceptance tests

| Tier | Milestone | Done when |
| --- | --- | --- |
| Must | Kitchen splat + scale + accuracy | Leave-one-out table error reported; floor at 0 |
| Must | Maps + hazards | Occupancy/bump/coverage maps exported; hazards.json valid |
| Must | Baseline world model + rollout engine | 200 trips on the kitchen map; toe contacts/month; ghost-walker image |
| Must | Viewer core | Splat + walker, autoplay + free walk, live hazard checks, 30+ fps |
| Should | Learned world model | Beats baseline on held-out people at turns over 20+ steps, or honest report |
| Should | Mannequin + world-model visuals | Third-person walk with IK; next-step cloud; ghosts live via ONNX |
| Should | Editable scene + ranked fixes | Dragging a chair/mat re-plans in ~1 s; fixes ranked |
| Should | Walker physics | Matches real walker on threshold, mat, cable tests |
| Should | Cosmos Transfer clip | One worst-case clip of the real kitchen, overlays aligned |
| Should | Cosmos Reason evaluation | Answer-key comparison table |
| Should | OT report | Printable page with all sections |
| Stretch | Cosmos Predict trust horizon | Prediction error vs. distance against the real splat |
| Stretch | WebXR | Walk the kitchen in a headset |

**Workflow rules:** baseline before smart; tag `demo-safe` whenever the full demo runs and re-record a backup video; new work on branches; update STATUS.md after each milestone; cut features that miss their checkpoint; feature freeze, then record the final demo video, before judging.

---

## 9. Demo (≈3 minutes)

1. **Hook:** falls spike after discharge; OT visits take hours and get skipped.
2. **The kitchen:** fly through the splat; show the table measurements vs. the splat's (accuracy).
3. **The walk:** third person; the next-step cloud leads the feet; a foot crosses the mat edge (red); the walker squeezes past a chair (clearance in cm). "Every step comes from a world model trained on real walker users and tested on people it never saw."
4. **Hundreds of mornings:** ghost walkers fan out; footfall heatmap; toe contacts per month.
5. **Judge takes the controls:** drags a chair or the mat; ghosts re-flow; the number drops; the tinted fill shows the imagined floor.
6. **What the family sees:** Cosmos Transfer clip of that morning, before and after fixes, labeled imagined.
7. **The OT report:** measured hazards, ranked fixes, "OT should check" items from Cosmos Reason.
8. **Prop:** push the real walker over a folded mat corner and show the sim predicted the snag.

**Fallbacks:** backup demo video; autoplay if free walk misbehaves; Cosmos clips are just MP4 files.

---

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scale wrong → every clearance wrong | Leave-one-out table check; extra gap measurement; borderline margin |
| Floaters create fake obstacles | Opacity/size filtering; multi-view trust; optional 2DGS for measuring |
| Thin hazards below resolution | Floor-level capture pass; classify cables, label heights "estimated" |
| Learned model doesn't beat baseline | Baseline-first pipeline; honest report; ship baseline |
| Toe-contact model overstates risk | Calibrate to published contact rates, not a normal distribution |
| B200 software or queue issues | Sanity job first; precompute early; work on CPU tasks while queued |
| Cosmos identity drift across chunks | Fixed seed and prompt; overlap blending; one great short clip beats a long one |
| Demo breaks live | `demo-safe` tag, backup video, offline viewer, precomputed clips |
| Overclaiming | "Measurable hazards for OT review," never "finds every hazard" |

---

## 11. Out of scope

Isaac Sim (roadmap: full-body gait in physics; needs RTX GPUs, not B200), the robot car (roadmap: scanning homes for people without family nearby), wheelchairs, stairs, multiple floors, real patient data, live Cosmos generation, training a world model from scratch at foundation scale.

---

## 12. References

- Mahoney et al., falls in the 90 days after discharge: https://www.pubmed.ncbi.nlm.nih.gov/11025789/
- HKU, post-hospital falls temporal pattern and cost: https://nursing.hku.hk/research/high-impact-publications/high-impact-publications-2023-14
- HOVIS trial, OT pre-discharge home visits: https://eprints.nottingham.ac.uk/1766/
- HOVIS cost-effectiveness (OT time per visit): https://nottingham-repository.worktribe.com/OutputFile/729791
- UF / Gainesville VA, 3D remote home assessments: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12759903/
- RASSAR (University of Washington): https://homes.cs.washington.edu/~kaimingc/rassar.pdf
- Minimum toe clearance and trip probability (Frontiers 2014): https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2014.00243/text
- PhysioNet Multi-Gait-Posture: https://physionet.org/content/multi-gait-posture/
- Older-adults gait dataset (Caicedo et al.): https://pmc.ncbi.nlm.nih.gov/articles/PMC7701341
- gsplat: https://github.com/nerfstudio-project/gsplat
- Spark: https://sparkjs.dev/docs/overview/
- SAM 3: https://github.com/facebookresearch/sam3
- Cosmos Transfer 2.5-2B model card: https://build.nvidia.com/nvidia/cosmos-transfer2_5-2b/modelcard
- Cosmos Transfer 2.5: https://github.com/nvidia-cosmos/cosmos-transfer2.5
- Cosmos Reason 2: https://huggingface.co/nvidia/Cosmos-Reason2-32B
- Cosmos 3 announcement: https://datanorth.ai/news/nvidia-launches-cosmos-3
- Gaussian splatting accuracy vs. laser scanning (ISPRS 2026): https://isprs-annals.copernicus.org/articles/XI-M-1-2026/31/2026/isprs-annals-XI-M-1-2026-31-2026.pdf
- AGS-Mesh, indoor splats with geometric priors: https://arxiv.org/html/2411.19271v2
- HiPerGator GPU access: https://docs.rc.ufl.edu/scheduler/gpu_access

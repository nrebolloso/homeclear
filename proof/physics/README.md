# Object physics: proof

Everything here is **SIMULATED** unless it says otherwise. The shapes come from the splat (measured). Every mass,
friction and stiffness is **sampled from an assumed range**; none is measured. The real-walker check below hasn't been
done yet (BLOCKERS.md).

## Live (viewer + VR): Rapier in a Web Worker, on the user's machine

| What | Where |
|---|---|
| Colliders per object: voxel columns from `objects/<id>.ply` (legs stay separate from the seat); chairs and tables are dynamic bodies, and each splat follows its body | `viewer/src/objphys.ts` (`columns`, `createWorld`) |
| Mat: a thin slab with sampled floor friction; the walker's glides drag it and the wheels roll over it | same |
| Curled corner: found in the mat's own splat points (90th-percentile height within 6 cm of a corner, at least `curl_min_m` above the mat's median); cut off the slab and hung on a motorised hinge sprung to the measured curl | `curledCorner`, `createWorld` |
| Worker, and feedback for every walker contact: haptic pulse (headset), sound, red flash, a line in the events log (bumped / pushed / TIPPED / slid / corner caught / corner FOLDED) | `viewer/src/physworker.ts`, `viewer/src/livephys.ts` |
| Tests: chair bumped and pushed; a 60 kg object blocks; a slippery mat slides while a grippy one stays; a curled corner is found, held, caught and folded | `viewer/tests/objphys.test.ts` |

The corner curl on the real mat (kitchen4_lighter) **isn't detected**. Its corners sit at most about 6 mm above the
mat's median (90th percentile), under the 8 mm threshold. So the live viewer shows no flap there, and the batch uses
an assumed curl, labelled as such.

## Randomisation ranges

`physics_ranges.json` (repo root) is read by both the viewer and the batch. Each run or trial draws one value
uniformly from each range:

| | range |
|---|---|
| chair mass | 3-8 kg |
| chair floor friction | 0.25-0.7 |
| table mass, friction | 15-40 kg, 0.3-0.7 |
| mat mass | 0.8-2.5 kg/m² |
| mat floor friction | 0.15-0.6 |
| flap stiffness, damping | 0.01-0.15 N m/rad, 0.001-0.01 |
| walker push (person's max force) | 25-60 N |
| glide friction | 0.15-0.45 |
| walker frame mass | 3.4 kg: the spec sheet's 7.5 lb (manufacturer figure, not weighed) |
| hand load on the walker | 15-45 N |
| batch only: assumed curl (when the splat shows none) | lift 1-4 cm, flap 6-15 cm |

Walker geometry is the user's own walker, a Drive Medical 10210-1, taken from the manufacturer's spec sheet and not
taped: 0.61 m (24 in) overall width, 1 in tube, 5 in front wheels, rear glide caps. The depth of 0.445 m (17.5 in) comes
from a retailer listing. The glide caps' size isn't published, so the glides stay modelled as 3.3 cm spheres.

## Offline batch (HiPerGator, CPU): MuJoCo

- GPUs on the RTX 6000 partition, and why they weren't needed: [gpus.md](gpus.md).
- Geometry: `physics/export_batch_scene.ts` writes `physics/batch_scene_kitchen4_lighter.json` from the same code the
  viewer uses: the same chair columns from the splats, the mat footprint, and the curl detector.
- Simulation (`physics/batch_mujoco.py run`), one trial at a time:
  - The walker is modelled as wheels, glides, legs and braces, at the same sizes as the live walker.
  - The person is a P-D follower walking at the sampled speed, with force capped at the sampled max push and the hand
    load pressing down.
  - Scenarios:
    - `chair`: a random chair and face, a random offset that sometimes misses the chair.
    - `mat_edge`: crossing the middle 80% of a random edge.
    - `mat_corner`: driving at the curled corner.
  - Speeds 0.1-0.6 m/s; approach angles 0-90° from head-on.
  - Same event thresholds as live:
    - moved/slid: more than 2 cm
    - tipped: more than 30°
    - folded: flap past 90°
    - caught: flap lifted by the walker
  - The object settles for 0.5 s first. A trial where it drifts more than 1 cm untouched is dropped and counted.
  - On a glancing approach, the walker's start is backed off along its path until it isn't touching the object.
    Without that, 18% of chair trials began inside the chair. That was a geometry bug, fixed before the final run.
- Run: `slurm/physics_batch.sbatch`, 32 array tasks × 300 trials × 3 scenarios, on the burst CPU QOS.
- Summary: `physics/batch_mujoco.py summarize out/physics/shard_*.csv --out physics/batch_results.json --md
  proof/physics/results.md`, with Wilson 95% intervals. [batch_results.json](batch_results.json) is a copy of that file.
- Results tables: [results.md](results.md), generated. Don't edit it by hand.

## Into the rollouts and the OT report

`viewer/src/objrisk.ts` reads `physics/batch_results.json` and works out each route's risk:

- **Mat:** every crossing onto the mat looks up P(slides) and P(corner folds) at the persona's speed and the route's
  angle to the edge.
- **Chairs:** the closest pass of the route gives the chance of touching the chair, from the rollouts' sideways sway
  model. That is multiplied by P(moved / tipped | touch) at that approach.

Each result is multiplied by trips per month. `evaluate.ts` adds these as `objects`, and the OT report shows them under
"Furniture the walker could push (simulated)", with the CI and the SIMULATED label.

Shortcut: one batch, run on kitchen4_lighter's chairs and mat, serves every scene. Rerun it per scene when that matters.

## Videos

Recorded with `viewer/e2e/record.ts` (fixed clock, third person, W held). Each `.frames.json` beside a video is the
walker pose per frame. Properties are sampled fresh each run, so one clip is one draw, not the typical case.

| File | Shows |
|---|---|
| `chair_push.mp4` | free walk into a kitchen chair, which is pushed ahead of the walker frame (real scene). The tucked chairs all sit against the table, and a straight walk at one hits the table, not the chair (it holds: 15-40 kg). So chair5 was first dragged 1.4 m onto open floor. A headless replay of the same start logged `chair5 bumped, pushed 2 cm+, bumped, TIPPED 30°` (another draw) |
| `mat_cross.mp4` | walking onto the kitchen mat from the south: the wheels roll on, and the glides drag it about 2 cm (replay: `rug slid 2 cm+`). Other sides don't work: free walk needs about 0.8 m of seen floor ahead of the person, and west of the mat there isn't any |
| `corner_catch.mp4` | a front wheel runs into the curled corner of `rug_curl` and catches it, with a red flash (`sample_objects`: a SYNTHETIC scene, because the real mat has no curl; the chair was moved aside to clear the approach) |

No live clip shows a fold. Over 14 resampled draws on that approach, the corner was caught 13 times and folded 0
times; this 15 × 19 cm mat slides away instead, even at the lowest stiffness. That agrees with the batch, where
P(fold) at the corner is about 1%. The fold itself is covered by `tests/objphys.test.ts` (a 60 cm SYNTHETIC mat). A
staged fold video was not made: it would present a rare draw as the typical case.

## Validation against the real walker (not done yet; needs the user)

The protocol, so sim and reality can be compared like for like:

1. **Folded towel:** fold a bath towel corner up 2-3 cm, as a stand-in for the curl. Push the walker over it 10 times
   head-on and 10 times at about 45°, at a normal walking pace. Count how often it catches and how often it folds.
   Note the floor type.
2. **Mat:** cross the real kitchen mat 10 times. Count the slides (more than 2 cm, marked with tape).
3. **Chair:** push into a real kitchen chair 10 times head-on and 10 times grazing it. Count moved (more than 2 cm) and
   tipped. Weigh the chair on a bathroom scale.
4. Film each one from the side with a tape measure in frame. Then compare the counts with the matching
   speed/angle cells in results.md. Any measured mass or friction replaces its assumed range in physics_ranges.json,
   labelled as measured.

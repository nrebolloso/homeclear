# World model interface (walker user)

Contract between the world model / rollout engine (`worldmodel/`) and the rest of the project
(splat + maps session, viewer). Units: metres, radians, seconds. Frame: the stage-6 floor frame, floor z = 0, +z up,
x/y on the floor. Nothing here changes the splat or map stages; it only reads their output.

## 1. Inputs

### Map directory (exactly what `stages/06_occupancy.py` writes to `out/<scene>/`)
| file | dtype / shape | meaning |
|---|---|---|
| `grid.json` | `{"origin_xy": [x0, y0], "cell_m": c, "shape": [H, W]}` | `array[i, j]` covers world `(x0 + i*c, y0 + j*c)` to `+c` |
| `floor.npy` | bool (H, W) | observed floor (walkable if not an obstacle) |
| `obstacles.npy` | bool (H, W) | furniture, walls, anything between `grid.obstacle_z` |
| `bumps.npy` | bool (H, W) | floor bumps (rugs, mats, thresholds, cables) |
| `bump_height_m.npy` | float (H, W) | bump height above the LOCAL floor, 0 where no bump |
| `bump_estimated.npy` | bool (H, W), optional | height is a typical value (thin cable), not measured |
| `labels.json`, optional | `{"objects": [{"name", "kind": "obstacle"|"bump", "box_xy": [[x0,y0],[x1,y1]]}]}` | human names for hazards; cells inside a box take its name |
| `route.json`, optional | `{"waypoints": [[x, y], ...]}` | the walk; else `path.json` from stage 7 (its `xy`) |

Cells that are neither floor nor obstacle are unknown and treated as blocked. A real kitchen map dropped in
`out/<scene>/` loads with no code change: `python -m worldmodel.rollout --map out/<scene>`.

**Hazard ids.** Bump patches are 8-connected components after a 3x3 link (as `grid.bump_link_cells`), id `bump:<k>`;
obstacle components are `obst:<k>`. If `labels.json` names a box, every cell in it gets that name instead
(e.g. `bump:sink_mat`, `obst:chair_W`). Ids are stable for a given map file.

### Route
Waypoints in world xy. The engine plans A* through them on the occupancy grid inflated by half the walker width
(`stages/07_plan.astar`, same cost as stage 7), and resamples the path every 1 cm.

### Walker and persona (`config.yaml` → `game.walker`, `game.persona`, `game.risk`; overrides in `worldmodel/config.yaml`)
Walker: `width_m, depth_m, user_gap_m, leg_radius_m`. Persona: `stride_m` (step length), `stride_cv`, `foot_sep_m`,
`toe_clearance_cv`, `gait_profile` (selects `risk.contact_table`). Risk: `trips_per_night`, `days_per_month`,
`path_offset_sd_m`. World-model-only extras (ASSUMED, labelled as such in outputs): `step_time_s`,
`toe_offset_m`, `brush_m`, `snag_rise_m`.

## 2. World model call

```
dist = model.predict(state, action)          # worldmodel/models.py
heel = dist.sample(rng)  /  dist.mean()  /  dist.logpdf(xy)
walker = model.walker_pose(state, heel, action)
```

**state** (`State`, world frame)
- `heels (3, 2)`, `toes (3, 2)`, `sides (3,)`: last three foot placements, newest first, side +1 left / -1 right
- `com (2,)`, `com_v (2,)`: centre of mass and its velocity (speed and heading derive from it)
- `walker (3,)`: walker pose `x, y, yaw` (centre of the frame)
- `obstacle_dist (8,)`: free distance from the CoM along 8 rays at 0, 45, ... 315° from the heading, capped at 2 m

**action**: the route ahead as points at 0.25, 0.5 and **1.0 m** of arc length past the current position, `(3, 2)`
world xy. The 1 m point is the steering target.

**output** (`StepDist`): a mixture of K Gaussians over the next heel position of the swing foot (world xy, with each
component's covariance given in the frame of the route direction), plus the next walker pose. The next toe is the
heel + `toe_offset_m` along the step direction. Models: `baseline` (hand rule, K = 1) and `learned` (MDN, K = 5).
The learned model has a second head for the walker pose (fitted from the dataset's walker camera, see
`proof/world_model/WORLD_MODEL.md` step 2); the baseline uses the geometric rule. The learned model's inputs are the
heels and the action only, not the previous walker pose (fed back, it diverged).

## 3. Rollout engine output (per night)

`python -m worldmodel.rollout --map <dir> --nights 200 --model baseline|learned [--remove <hazard>] [--move <hazard> dx dy]`

Per night (`trips_per_night` trips, alternating direction): written to `<out>/rollout.npz` + `<out>/events.csv`
- footsteps: night, trip, step, side, heel xy, toe xy
- walker path: night, trip, step, x, y, yaw
- `toe_contact` events: night, trip, step, hazard id, rise (m), p (per-swing contact probability), sampled 0/1
- `snag` events: a walker leg crossing a floor rise ≥ `snag_rise_m` (front wheels / rear glides); hazard id, rise
- `collision` events: a walker leg inside an obstacle cell (chair, counter); hazard id
- `brush` events: the walker frame within `brush_m` of an obstacle (doorways, tight gaps); hazard id, gap (m)

Aggregates (`<out>/summary.json`): per hazard, per month (expected toe contacts = sum of p; sampled counts; snags;
collisions; brushes), month-by-month series (30 nights = 1 month), and sanity counters (feet inside obstacles, step lengths
outside 0.1–0.8 m, resampled draws). Plots: ghost walkers, footfall heatmap, hazard hits, contacts per month.

Contact probabilities come from `risk.contact_table`, which is a **placeholder, not calibrated**; all per-month
numbers inherit that label.

# Light the path, bathroom grab bar, stroke persona, reach lens (2026-10-24)

All visual pieces are designed, not built (teal tags). No number comes from the pictures.

## Light the path (`viewer/src/lights.ts`)

Reimagine → **☾ Light the path at night** (or `game.lights.lightPath()`): walking the selected route in 25 cm steps,
each stretch more than 75 cm outside every light gets a plug-in motion nightlight on the nearest fixed wall within
1.3 m (furniture and door leaves don't count), else a battery one 50 cm beside the path, never on the walking line.
Each is an `add` fix with `light_r` 1.5 m (typical, assumed): the simulation counts floor within it as lit, so the
darkness multiplier (1.5×, `risk.dark_contact_multiplier`, an ASSUMED number) stops applying there. The note says so.
At night: a warm bulb, a halo, a point light on the walker and mannequin, and the scan lit around it (`night.ts`, now
16 extra lights shared with the step lights).

- `game_synth`: 1 path light on the wall by the doorway, simulated toe contacts down 15% on "bed to bathroom".
- `kitchen4_lighter_objects`: 3 path lights on the main route (that route has no floor bumps, so contacts were 0 before
  and after: the lights show at night, the number can't move).
- Images: `kitchen4_path_lights_night.jpg` (left none, right lit), `game_synth_path_lights_night.jpg`.

## Bathroom grab bar (`viewer/src/bathroom.ts`)

For each `toilet` in `game.fixtures`: the back is the end nearer a wall (floor map), the bar goes on the nearer side
wall, 107 cm long, top at 87.5 cm (ADA 604.5: 84-91 cm). If that wall is on the patient's weak side the fix says so
(a fold-down bar on the strong side is the OT's call). Applied, the toilet's grab-bar check goes from "OT to verify"
to ok ("designed"). `game_synth_toilet_grab_bar.jpg`. No real scene marks a toilet yet (MEASURING.md §5).

## Stroke persona (`viewer/src/stroke.ts`, `vision.ts`)

"Stroke, left side weak": the patient's walker, shorter (0.28 m) and less regular steps, wider toe-clearance spread,
the stronger side set to the right (stair rails, the toilet bar's side note follow), and the left half of the view
dimmed ("After a stroke: left half of the view missing"). Assumed numbers, labelled as a comparison.

## Reach lens (`night.ts`)

With the wheelchair persona, the scan is tinted by height: green 38-122 cm (ADA 308 reach range from a seat), red above
or below, the floor untinted. `kitchen4_reach_lens.jpg` (left patient, right wheelchair).

## Stairs seen only in part (`stairs.ts`)

When the scan resolves only part of a flight (the landing more than 30 cm above the last tread found, or more scan
above it), riser, riser-difference and tread-depth results become "OT to verify" with a pointer to MEASURING.md,
instead of fail. Tape-measured stairs and fully seen ones still fail.

## Checks

- `npm test`: 144/144 (new `tests/lights.test.ts`: placement, wall search, risk drop through evaluate(), toilet bar
  side and check, stroke persona, partial-flight guard).
- `npm run build`: ok.
- e2e: 38/38 PASS.

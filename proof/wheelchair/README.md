# Wheelchair persona, stairlift, and Explore without the walker (2026-10-24)

## Wheelchair (`viewer/src/wheelchair.ts`)

A fourth comparison persona in every scene ("Wheelchair (typical manual chair, assumed)"), added in the viewer when
the scene's `personas.json` doesn't have one. The chair is built from primitives at its configured size: 66 cm wide,
1.0 m from the push handles to the footplates, 60 cm drive wheels, seat at 48 cm (typical values, ASSUMED until
the patient's chair is measured). The mannequin sits in it, hands on the rims.

**No fall model.** There is no calibrated trip model for a wheelchair, so its contact table is all zeros and the trip
numbers read 0 by construction (the persona note says so). The result is in the checks, from the 2010 ADA Standards:

| Check | Limit | Source of the number |
|---|---|---|
| Turning space at each route start and end | 1525 mm circle of clear floor within 1 m (304.3.1) | the planner's distance field (measured map) |
| Changes in level on the route | ≤ 6.4 mm square; ≤ 13 mm bevelled (borderline); taller fails (303.2-3) | measured bump heights |
| Door clear width | ≥ 815 mm (404.2.3): the door need is never below this for a wheelchair | marked doors |
| Stairs | fail without a stairlift; with one, borderline: OT to check the transfer | marked stairs + the lift's typical folded depth |

On `kitchen4_lighter_objects`: the route start fails (140 cm clear, short of 153 cm), the route end passes (209 cm).
`kitchen4_wheelchair.jpg` shows the chair on the real scan (frame red: the gap past the bin is under the margin).

## Stairlift (`stairs.ts`, `stairs3d.ts`)

A new stair fix, `stair_lift:<stair>`: a straight-rail stairlift on the wall side (away from the one seen rail), with
a second wheelchair kept upstairs. Typical spec values: folds to 33 cm, fits flights from 70 cm, $2,000–5,000
installed (the fix carries $3,500 as a placeholder). The check reports how much of the measured flight width is left
beside it folded. In 3D: the rail on the treads, a seat that rides up and back every 16 s, and the second chair at the
top facing the lift, all teal ("designed, not built"). `stairlift_meshes.jpg`: a test flight marked on `game_synth`,
the scan hidden so the meshes show (left: seat at the bottom, off frame; right: 3 s later, partway up).

## Explore (`main.ts`)

The toolbar's **Explore** button now parks the walker where it stood and turns collisions off: walls, furniture and
live physics no longer push or stop the camera (it stays inside the scanned grid). **Follow route** picks the walker
back up. Keyboard free walk and `game.setFree` are unchanged (walker on you, fenced), since the physics pass and the
e2e checks rely on them. `game.explore()` reports the state. Checked on `kitchen4_lighter_objects`: 8 s of W in
Explore moved the camera 4.0 m with the walker left at its spot; the same line in free walk stopped 28 cm earlier at
the scan's edge.

## Checks

- `npm test`: 135/135 (new `tests/wheelchair.test.ts`: turning space, level changes, zero contacts, stairs with and
  without the lift, evaluate() end to end).
- e2e: 38/38 PASS against the dev server.

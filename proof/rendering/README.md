# Grounding the meshes in the scan (`viewer/src/ground.ts`)

2026-10-24. Visual only: nothing here feeds a measurement or a risk number.

The walker, cane and mannequin are three.js meshes standing in a Gaussian splat. The splat has its light baked in, so
the meshes had one flat hemisphere light, no shadow where they meet the floor, and nothing for the walker's metal to
reflect. Two changes:

- **Contact shadows**: a soft dark blob (radial `(1 - t²)²` falloff) under each walker leg or cane tip, a faint one
  under the whole frame, and blobs that follow the mannequin's feet (smaller and fainter while a foot swings). Every
  device made through `buildDevice` in `main.ts` gets them, including the replay walker and the one parked at the top
  of the stairs (`stairs3d.ts` no longer paints a shadow teal).
- **Room light on the meshes**: Spark's `SparkRenderer.renderEnvMap` renders the splat into a PMREM environment map
  once at load, from the middle of the floor grid at 1 m, with every mesh hidden. It becomes `scene.environment`, and
  the hemisphere light drops from 2.2 to 0.6. At night the env map is scaled by 0.07, the same factor `night.ts`
  applies to the scan, and a warm point light at the nightlight (same radius as its glow on the scan) lights the
  walker and mannequin too.

`?noground` turns both off (the old look), which is how the "before" images were made.

## Images (left: `?noground`, right: this change)

Same scene (`kitchen4_lighter_objects`), same route position (route 0, 4 s of autoplay) and same camera in each pair.

| File | What to look at |
|---|---|
| `ground_front.jpg` | shadows under the walker's tips; lighter, room-coloured metal |
| `ground_close.jpg` | low view: the tips and feet sit on the floor instead of floating |
| `ground_side.jpg` | known limit, see below |
| `ground_lamp.jpg` | `game_synth` at night, walker next to the nightlight: left lamp off, right on (the leg facing it turns warm) |

## Known limits

- **Shadows show through splat furniture.** Splats don't write depth, so anything drawn as a mesh (the walker itself
  already did this) draws over a table or chair that is in front of it. In `ground_side.jpg` the leg shadows show as
  dark dots on the tabletop. Fix: depth-only occluders from the object boxes and wall cells (plan item 8 in
  `PLAN_ACCESSIBILITY_DEMO.md`).
- One env map for the whole room, taken from its middle: a mesh in a dark corner is lit like the middle of the room.
- The gain is modest in daylight: the scan is bright and diffuse, so the shadows are soft by design.
- The env-map capture waits for all splats to load, at most 10 s; on a slower load the meshes keep the old flat light.

## Checks
- e2e: 38/38 PASS (`node e2e/run.ts` against the dev server with this change), including night mode with no page errors.
- `npm test`: 129/130; the one failure is the optimizer speed check (`optimize.test.ts`, 33 s run), which fails the same way without this change.

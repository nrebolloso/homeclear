# Gait personalization handoff (VR team)

Branch `wm-planner`. Desktop replays a held-out PhysioNet participant as "the user"; VR feeds what Quest 2 tracks
into the same API. Per AGENTS.md, VR input stays in `xr.ts`: call `window.game.gait` from there and don't reach into
`gaitfit.ts`.

## API (`window.game.gait`, `viewer/src/gaitfit.ts`)

| Call | What it does |
|---|---|
| `await ready` | persona model loaded (`public/gait/persona.json`, from `worldmodel/persona.py`) |
| `observe(sample)` | one heel strike: scores mean vs fitted next-step prediction, then takes Adam steps on the 8-d embedding (network frozen) |
| `reset()` | back to the population-mean embedding |
| `state()` | `{ steps, seconds, e, map, err_last10: { heel, head, walker: { pop, fit } } }` |
| `replan()` | reruns the kitchen planner with this person's world model (`planfix.ts replanFor`); the Planner panel shows how the fixes changed |
| `ghost` | `THREE.Group`, the predicted-self ghost (walker frame + head). It is already in the scene and is a scene object, so it renders in XR |
| `panel` | `THREE.Sprite` with the style map and error meter. Hang it off a controller or the walker |
| `worldModel()` / `popWorldModel()` | plain `WorldModel` with the fitted / mean embedding folded in |
| `play(speed, pid?)`, `stop()`, `people()` | desktop replay of held-out participants |

### `GaitSample`, one per heel strike, floor frame (metres, radians)

```ts
{ heels: [XY, XY, XY],        // last three heel strikes, newest first
  sides: number[],            // sides[0] = side of the newest heel (+1 left)
  action: XY[],               // route points ahead (same as the sim's frame())
  walker1: [x, y, yaw],       // walker frame centre after this step
  head1: [x, y, z],           // headset position after this step
  dt: number,                 // seconds since the last sample
  heel1?: XY }                // the next heel, if known (never in VR: heel error is then not scored)
```

Quest 2 does not track feet. In VR, feed the model's own predicted heels (`ghost` positions / the last forward pass)
as `heels`, plus a heel-strike trigger. The simplest trigger is a head-height minimum: the head dips about 1–2 cm at
each heel strike. The walker pose comes from a controller taped to the walker (VR_WALKER_MOUNT.md).

## What the numbers say (be honest in the pitch)

From `out/gait/persona_eval.json`: leave-two-people-out CV over 14 PhysioNet people. Each person's first 30 s is
fitted from walker + head only, and every later step is scored.

| next-step error | mean embedding | fitted | people improved |
|---|---|---|---|
| head (cm) | 9.84 | **5.22** | 12 / 14 |
| walker (cm) | 12.42 | **11.67** | 10 / 14 |
| heel (cm) | 4.03 | 4.13 | 3 / 14 |
| NLL | 786 | **466** | 14 / 14 |

Personalization learns what the headset sees (head and walker) and does not improve heel placement. Even an oracle fit
that is shown the heels doesn't help (3.81 vs 3.82 cm median), so heel style is not identifiable from this data.
Closed-loop rollouts are about neutral (heel lateral error 2.80 vs 2.94 cm). Re-plans with a fitted embedding change
the fix ranking through the walker and head, not the feet.

## Our own walker videos

PhysioNet is the stand-in. `worldmodel/walker_videos.py` is the loader hook for our recordings: the file format is in its
docstring (`steps.csv`, one row per heel strike), and you train with `python -m worldmodel.persona --extra <dir>`. Acted passes
(`acted = 1`) are kept and labelled, so the model can be trained with or without them. Recorded people get pids 100+.

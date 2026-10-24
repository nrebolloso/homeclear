# Walker mount: Quest 2 controllers on a real walker

The patient pushes their own walker through the scanned home in VR. One controller rides on the walker, so the virtual
walker (and its leg checks over rugs and cords) goes exactly where the real one does; the other controller is a wand they
pick up to edit the room and put back to walk. No thumbsticks: hands stay on the walker.

Walker: **Drive Medical 10210-1** (two-button folding walker, 5 in wheels). From the manufacturer's spec sheet (now in
every config and `physics_ranges.json`): 24 in (0.61 m) wide, **1 in (25.4 mm) aluminium tubes**, 5 in front wheels,
rear glide caps, 7.5 lb, handles 32-39 in. Depth 17.5 in (0.445 m) is a retailer figure, not on the spec sheet.

## The layout

| Controller | Where | Job |
|---|---|---|
| **Left: the walker controller** | Fixed at the **centre of the top front bar** (the cross-brace between the two sides), ring facing **up**, handle along the bar | Tracks the real walker. Nobody presses anything on it. |
| **Right: the wand** | In a **bottle cage / cup holder** on the frame, within reach of the right hand | Lifted out: point, pinch/trigger to drag, delete, teleport, press the card buttons. Docked: walk. |

Left-handed patient: swap them (`?wand=left`, mount the right controller).

Why the centre of the front bar: a person on a walker looks slightly down and ahead, which is where the headset's
cameras see the front bar, so tracking holds; the hands stay clear of it (a hand on a handle would cover the ring); and on
the centre line the walker's middle is straight behind the controller, so calibration is a push forward and a fixed
offset (off-centre also needs a sideways offset, and a small angle error grows with the distance).

## Parts

Check every clamp's listed tube range includes **25.4 mm (1 in)** before buying.

| Part | For | Notes |
|---|---|---|
| 2 reusable hook-and-loop (Velcro) cable straps, about 20-30 cm | Walker controller, today | Two straps around the controller handle and the bar |
| Rubber pad / shelf liner, a few cm square | Under the controller | Grip, so it can't rotate on the round tube |
| Bike bottle cage + a handlebar clamp adapter (or two more Velcro straps) | The wand's dock | Wand goes in handle-down; foam or tape inside so it doesn't rattle |
| Optional: handlebar phone/accessory clamp + a Quest controller adapter (golf-club style), or a **3D-printed clamp** | Walker controller, later | No wobble and the same spot every time, so calibration lasts. Search Printables / Thingiverse for "Quest 2 controller holder" first |
| 2 AA batteries | One per controller | The battery door is in the handle: the straps must come off without cutting (no zip ties) |

## Fitting it

1. Fold and unfold the walker once with nothing mounted, and note where the **two fold buttons** and the hinge move.
   Nothing may block them or ride on a moving part.
2. Put the rubber pad on the centre of the top front bar. Lay the left controller on it, **ring facing up**, handle along
   the bar, and strap it at two points. Push it with a finger: it must not rock or turn. Any play shows up as the
   virtual walker shaking and the leg checks flickering (2 deg of rock moves the far legs about 1 cm, the scale this
   project measures at).
3. Fit the bottle cage where the right hand reaches it from the handle without letting go of the walker with the left,
   and where it can't touch a leg when the walker folds.
4. Fold and unfold again with everything on, and walk 10 m: nothing slips, rattles or catches a wheel.

## Headset settings (once)

- **Turn off auto-switching from controllers to hands** (Settings, then the hands / controllers section under movement
  tracking; names vary by system version). When both controllers sit still, a pause with the wand docked for example,
  the Quest otherwise switches to hand tracking after a few seconds and the walker controller drops out.
- Battery: on a long session the controllers drain in hours, not minutes; start with fresh AAs.

## Software: what exists and what doesn't

| Piece | Status |
|---|---|
| Wand: point, drag, twist, hold-to-delete, teleport; card buttons (dangers tour, night walk, safer room) | Built, `viewer/src/xr.ts` (tested in `npm run e2e:xr`) |
| Hand pinch as a stand-in for the trigger | Built |
| **Virtual walker follows the walker controller** | **Not built.** Today the virtual walker follows the head. |
| **Calibration**: push the walker straight forward ~1 m; heading from the push, the controller's height and its offset to the walker's centre from the frame size | **Not built** |
| **Dock detection**: wand still at a fixed spot relative to the walker controller = walk mode, lifted = edit mode | **Not built** |

All three can be written and tested now with IWER's emulated controllers (`?emulate=quest2`): script the left controller
as a pushed walker and the right one into and out of a dock pose. They wait on Juan's port of the VR marking onto
`xr.ts`, so the two don't collide. The feel test needs the real walker and charged controllers.

## Still to measure (tape)

- Front-to-rear leg depth (the 17.5 in is retailer-only)
- Rear glide cap diameter
- Handle height, set for this patient
- After fitting: the controller's position on the bar (height above the floor, distance behind the front legs) as a
  check on the calibration

# Walker mount: Quest 2 controllers on a real walker

The patient stands at their own walker, hands on the grips, in the scanned home in VR. There is usually no room to walk
the home for real, so the **left controller is strapped next to the left grip** and its thumbstick moves them: up/down
walks along the walker's heading, left/right snap-turns 30 deg. Because it is fixed to the walker, the virtual walker (and
its leg checks over rugs and cords) points wherever the real one does. The right controller is a wand they lift out of a
cup holder to edit the room and press the card buttons.

Walker: **Drive Medical 10210-1** (two-button folding walker, 5 in wheels). From the manufacturer's spec sheet (in every
config and `physics_ranges.json`): 24 in (0.61 m) wide, **1 in (25.4 mm) aluminium tubes**, 5 in front wheels, rear glide
caps, 7.5 lb, handles 32-39 in, 17 in between the grips, base depth 17.5 in (0.445 m).

## The layout

| Controller | Where | Job |
|---|---|---|
| **Left: the walker controller** | On the **left upper side bar** (the short silver bar from the left grip toward the front leg), just in front of the grip; handle along the bar pointing forward, **thumbstick and buttons up** within reach of the left thumb | Its stick moves the patient; its tracking turns the virtual walker. Its trigger is ignored. |
| **Right: the wand** | In a **cup holder** clamped on the right upper side bar, just in front of the right grip | Lifted out: point, pinch/trigger to drag, delete, teleport, press the card buttons. |

**Keep the grey front bar clear**: it carries the two red fold buttons and the hinge.

Left-handed patient: swap them (`?mount=right&wand=left`, strap the right controller by the right grip).

## Parts (ordered 2026-10-24)

| Part | For | Notes |
|---|---|---|
| Zip ties, the **12 in / 48 lb** ones (LOCKLOCK assorted pack) | Walker controller | Two per fitting. Not releasable: snip them to change the battery, and fit fresh ones |
| **Adhesive rubber grip tape**, 1 in x 20 ft | Under the walker controller, on the bar only | Wipe the bar with rubbing alcohol first; 2-3 turns. Never on the controller |
| **Walker cup holder** with clamp for 0.55-1.7 in tubes | The wand's dock | Silicone grips inside hold the handle; angle the phone holder out of the way |
| AA batteries | One per controller | Spares: with stay-awake on the controllers drain faster |
| Flush cutters (optional) | Trimming zip-tie tails smooth | So no sharp edge against the hand |

## Fitting it

1. Fold and unfold the walker once with nothing mounted, and note where the fold buttons and the hinge move.
2. Clean the left upper side bar and wrap 2-3 turns of grip tape where the controller will sit.
3. Lay the left controller on it, handle forward along the bar, **thumbstick up**, close enough that the left thumb
   reaches the stick without letting go of the grip.
4. Two zip ties around handle and bar: one near the bottom of the handle, one just below the ring. Firm, not crushing.
   **Not over the trigger or the grip button, not over the battery door, and the ring uncovered.** Snip the tails flush.
5. Push it with a finger: it must not rock or turn. Play shows up as the virtual walker shaking and the leg checks
   flickering (2 deg of rock moves the far legs about 1 cm, the scale this project measures at).
6. Clamp the cup holder on the right upper side bar in front of the right grip, where it can't touch a leg when folding.
7. Fold and unfold again with everything on.

## Headset settings (once)

- **Turn off auto-switching from controllers to hands** (Settings, the hands / controllers section under movement
  tracking; names vary by system version). When both controllers sit still, the Quest otherwise switches to hand tracking
  after a few seconds and the walker controller drops out.
- Fresh AAs at the start of a session.

## Using it

Open the viewer with **`?mount=left`** (e.g. `http://localhost:5179/?scene=k4_150k&hz=90&mount=left`).

1. **Stand behind the walker, facing the way it points, and press ENTER VR.** The app takes that moment to line the
   controller up with the walker: the strap never holds it exactly straight.
2. Left stick **up/down** walks forward/back along the walker's heading (you can look around while you push); **left/right**
   snap-turns 30 deg once per flick. You can also turn the real walker: the virtual one turns with it.
3. If the virtual walker ever points off from the real one (the controller shifted on the bar), stand behind it facing
   its way and press the card's **Line up the walker** button with the wand.

## Software: what exists and what doesn't

| Piece | Status |
|---|---|
| `?mount=left`: stick walks along the walker, snap-turns; virtual walker follows the real one; line-up at entry and on the card; mounted trigger ignored | Built, `viewer/src/xr.ts` (`npm run e2e:xr`, emulated) |
| Wand: point, drag, twist, hold-to-delete, teleport; card buttons (dangers tour, night walk, safer room, compare) | Built |
| Hand pinch as a stand-in for the trigger | Built |
| Juan's planning menu opens on a **left-stick click** | Easy to press by accident on a mounted stick: worth moving to a button |
| Dock detection (wand in its holder = walk mode, lifted = edit mode) | Not built |
| The feel on the real walker | Needs the parts and charged controllers |

## Still to measure (tape)

- Rear glide cap diameter
- Handle height, set for this patient
- After fitting: where the controller sits (height, distance behind the grip), as a check on the virtual walker's placement

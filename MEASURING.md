# Measuring a home so the viewer flags it on load

Tape the home once, write the numbers into the run's config, re-export, and every stair, doorway, seat and switch shows
up already measured and checked: on the desktop, in the headset, for everyone who opens the scene. Nobody has to
mark points during a demo, and the numbers are tape-measured (`measured: tape`), which the hard rules prefer to
anything read off the splat.

What you need: a tape measure (metric, or convert: 1 in = 0.0254 m), the printed 150 mm ArUco marker
(`python marker/make_marker.py --print`), and the run's `config.<run>.yaml`.

## 0. Why each stair and door still needs a location once

The splat's floor frame has z = 0 on the floor and +z up (stage 5), but its x/y origin and direction come from the
reconstruction, not from the room, so a tape measure can't tell you "the stairs are at x = 3.4". Each stair and door
needs its **position** in that frame **once**; its **sizes** come from the tape. Two ways to get positions, neither
needs marking during the demo:

- **Copy once (most accurate):** in the viewer, Advanced → Mark stairs / Mark doorway, then **Copy as config YAML** in
  the Stairs / Doorways panel. Paste into the config and replace the measured sizes with your tape values (below).
  After the re-export the marks come from the config; clear the browser's own marks (**Clear marked** in each panel).
- **Stand there and read it:** in Explore or Fly (F), put the camera over the spot and type `game.debug.camera.position`
  in the browser console (or `game.body` in free walk). x and y are the floor-frame coordinates, good to a few cm.

Positions only say *where*; a few cm off doesn't change any verdict. Widths, heights and depths come from the tape.

## 1. Scale first (everything else depends on it)

If the scale is off, every number is off by the same factor: door widths, gaps, the wheelchair turning circle, seat
heights. Check it before anything else.

1. Lay the printed marker flat on the floor (or tape it to a wall) where the video sees it from several angles.
   Measure the printed black square's side with the tape and set `scale.marker_size_m` to that, not to 0.150.
2. Add tape checks under `accuracy.ground_truth` (stage 6b turns them into the map's error margin). The best ones are
   things the map measures directly:

```yaml
accuracy:
  ground_truth:
  - {name: marker_height, kind: marker_height, meters: 0.75}      # only for a marker on a wall/chair: floor to its centre (on the floor: leave out)
  - {name: hall doorway, kind: free_span, box_xy: [[x0, y0], [x1, y1]], axis: 1, meters: 0.762}   # narrowest clear gap in the box
  - {name: bathroom threshold, kind: bump_height, box_xy: [[x0, y0], [x1, y1]], meters: 0.012}    # floor edge height
```

3. After stages 4 and 6b, compare a few things you can see in the viewer with the tape: a chair seat, the table height,
   a doorway. If they are all off by about the same percentage, the scale is wrong; fix that, don't edit the
   measurements.

## 2. Stairs (`game.stairs`)

Left and right are **as seen standing at the bottom, facing up**. Measure every step; uneven risers are exactly what the
checks look for.

| Measure | How | Config field |
|---|---|---|
| Each riser height | floor to the top of step 1, then the top of each step to the top of the next, up to the landing | `treads_z`: running totals (step 1, step 1+2, …, the landing last) |
| Where each step's front edge is | along the flight from the bottom step's front edge: 0 for step 1, then + each tread depth | `tread_fronts_m` (same count as `treads_z`) |
| Tread depth | front edge (nose) to the riser behind it, on a typical step | `tread_depth_m` |
| Width | clear width between walls / rail and the open edge, at a middle step | `width_m` |
| Landing height | floor to the landing (= the last `treads_z`) | `top_z` |
| Rails | per side: is there one (`seen`), nothing (`none`), a bare wall (`wall`)? Rail height: straight down from the rail top to the step's front edge | `rails: {left, right, height_m: {left, right}}` |

Location: `bottom` = the two ends of the bottom step's front edge `[x, y]`; `top` = a point on the landing just past
the last step. From "Copy as config YAML" or by standing there (section 0).

```yaml
game:
  stairs:
  - name: stairs
    bottom: [[3.42, -0.71], [4.21, -0.69]]     # bottom step's front edge, left end then right end (from the viewer)
    top: [3.85, -2.95]                         # on the landing, just past the last step (from the viewer)
    top_z: 2.31                                # floor to landing (tape)
    treads_z: [0.19, 0.38, 0.575, 0.765, 0.96, 1.15, 1.345, 1.535, 1.73, 1.92, 2.115, 2.31]   # running totals (tape)
    tread_fronts_m: [0, 0.26, 0.52, 0.78, 1.04, 1.30, 1.56, 1.82, 2.08, 2.34, 2.60, 2.86]     # + tread depth each (tape)
    tread_depth_m: 0.26
    width_m: 0.89
    rails: {left: seen, right: wall, height_m: {left: 0.87}}
    measured: tape
```

The viewer uses a tape stair exactly as written (no splat measuring). The checks it gets: each riser and how much they
differ, tread depth, width, a rail for the stronger hand both ways (set `strong_side` in section 6), rail height
86–97 cm, room at the bottom, light at both ends, the walker at the top, and for the wheelchair persona whether a
stairlift fits. The fixes (rails, step lights, edge strips, a second walker, a stairlift) are offered automatically.

## 3. Doorways (`game.doors`)

| Measure | How |
|---|---|
| Clear width | door open 90°: from the face of the open door to the stop on the other jamb (that's ADA's clear width, narrower than the frame) |
| Which side it hinges | the jamb with the hinges (`a` or `b`) |
| Height, wall thickness (optional) | floor to the head jamb; jamb depth |

Location: `a` and `b` are the two jambs' inside faces at the floor `[x, y]`. The checks read the width as the
distance from `a` to `b`, so after copying them from the viewer set that distance to the taped width, keeping the
middle and the direction:

```python
import math
a, b, tape = [1.10, 2.40], [1.88, 2.43], 0.762     # copied a, b; taped clear width
mx, my, dx, dy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0] - a[0], b[1] - a[1]
k = tape / 2 / math.hypot(dx, dy)
print([round(mx - dx * k, 3), round(my - dy * k, 3)], [round(mx + dx * k, 3), round(my + dy * k, 3)])
```

```yaml
game:
  doors:
  - name: bathroom door
    a: [1.109, 2.400]
    b: [1.871, 2.430]          # |a - b| ≈ 0.762, the taped clear width
    hinge: a
    height_m: 2.03
    measured: tape
```

The checks: width against code (81 cm) and this walker (or 81.5 cm for the wheelchair), and whether a route goes
through it. Offered fixes: offset hinges, door off, widen.

## 4. Floor edges, thresholds, rugs, cords

The bump map measures these from the splat (stage 7). Tape the tallest few as `bump_height` ground truth (section 1)
so the map's height error is known: a bump within that error of a limit shows "borderline, OT to verify" instead of
pass/fail. Measure from the floor to the top edge, at the highest point the foot or wheel would meet. Cords are thin
for the splat: add them as objects with `kind: other` and note the taped height.

## 5. Seats, beds, toilet, switches, phone (`game.fixtures`)

Seat heights for the transfer check come from the splat inside the fixture's box. Tape each one anyway: if the viewer
disagrees by more than a centimetre or two, look at the scale (section 1) before anything else.

```yaml
game:
  fixtures:
  - {name: bed, kind: bed, box_xy: [[x0, y0], [x1, y1]]}               # seat height measured from the splat in the box
  - {name: toilet, kind: toilet, box_xy: [[x0, y0], [x1, y1]]}
  - {name: hall switch, kind: switch, xyz: [x, y, 1.12]}              # z: floor to the switch centre (tape)
  - {name: phone, kind: phone, attach: nightstand, xyz: [x, y, 0.72]}  # rides on the nightstand if it moves
  - {name: toilet wall, kind: grab_bar_wall, xyz: [x, y, 0.85]}       # where a grab bar could go
```

Point kinds: `switch`, `phone`, `outlet`, `grab_bar_wall`. Switches matter twice: the stair check wants one within
1.5 m of the bottom and of the top, and no marked switches at all makes it "borderline".

## 6. The person and their equipment (`game.persona`, `game.walker`)

| Measure | How | Field |
|---|---|---|
| Knee height | seated, feet flat, shoes on: floor to the crease behind the knee | `persona.knee_height_m` |
| Reach | standing with the walker: shoulder to fingertips forward | `persona.reach_m` |
| Eye height | standing with the walker | `persona.eye_height_m` |
| Stronger hand | which side they lean on (rails, grab bars, getting out of bed) | `persona.strong_side: left / right` |
| Hip precautions | from the discharge orders | `persona.hip_precautions: true` |
| Walker | outer width at the widest point, front-to-back depth of the frame, handle height, body to rear legs | `walker.width_m`, `depth_m`, `handle_height_m`, `user_gap_m` |

The wheelchair persona uses typical sizes until its own are taped; its sizes live in `viewer/src/wheelchair.ts`
(`WHEELCHAIR`).

## 7. Export and check

```bash
python stages/12_export_scene.py config.<run>.yaml
```

Then open `http://localhost:5179/?scene=<run>`:
- The Stairs and Doorways panels list your entries as tape-measured; the findings list has their checks.
- Clear any marks saved in this browser for the scene (**Clear marked** in the Stairs and Doorways panels): a browser
  mark with the same name replaces the config one.
- Spot-check three things with the tape against the viewer. If they all disagree by the same percentage, it's the
  scale.

What still comes from the splat, whatever you tape: the floor map (walls, furniture, free floor), bump heights,
object footprints and seat heights. That's why section 1 matters most.

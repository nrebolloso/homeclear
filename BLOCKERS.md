# Blockers: things only you can do

1. **Re-measure the kitchen table's width** (short side of the top, edge to edge). In the kitchen1 splat the width is
   14.5% short of the 41 in in `data/measurements.yaml` while the height agrees (+1.7%); kitchen2_nofar is within 2.6% on
   both. If the table really is 41 in, kitchen1 (and so `kitchen1_dvapp`) is distorted and should not be the measured demo scene.
2. **Film the floor along the demo route** (entrance → sink → chair), phone about 30° down, and don't move anything
   between clips. Tape one aisle or doorway width and one mat or threshold height for real accuracy margins.
3. **Bedroom tape measurements** (`configs/bedroom.yaml`): the printed marker's black square, toilet seat height, bed
   height, and the bathroom doorway's clear width.
4. **Walker specs**: mostly answered by the spec sheet of your walker (Drive Medical 10210-1: 24 in wide, 1 in tube,
   5 in wheels, rear glide caps, 7.5 lb), now in every config and `physics_ranges.json`. Still to tape: depth front to
   rear legs (17.5 in is a retailer figure, not on the spec sheet), the rear glide cap's diameter, and the handle height
   you set it to (it adjusts 32-39 in; configs use 0.85 m).
5. **Your own home (`configs/myhome.yaml`): film it, measure later.** Print the marker (`python marker/make_marker.py --print`,
   100%, check with a bank card), keep it in view, copy the video to `data/myhome.mp4`, `./run_all.sh configs/myhome.yaml`.
   Until anything is taped, the dimensions are placeholders with `estimated: true` (stage 4 SKIP, no margins). Then tape:
   a doorway's clear width, a rug or threshold height, the toilet seat and bed heights.
6. **Bedroom objects and route.** Stage 6c proposes objects (`out/bedroom/objects_proposed.yaml`, from Grounding DINO + SAM 2);
   the bed and rug come out in several pieces. Which pieces are the real bed, rug and door, and where are the bed's exit side
   and the toilet (floor-frame x, y, read off `out/bedroom/occupancy.png` or by hovering in the viewer)? Those go into
   `configs/bedroom.yaml` (`game.objects`, `game.routes`, `plan.start/goal`); they are not guessed. Optional, before seeing any
   Cosmos Reason output: list the real hazards in an answer key (kind + floor-frame x, y); empty, the run is not scored.
7. **Real-walker physics check** (object physics is SIMULATED until this is done): push the walker over a bath towel
   with one corner folded up 2-3 cm (10 head-on, 10 at about 45°), across the kitchen mat (10), and into a kitchen
   chair (10 head-on, 10 grazing). Film from the side with a tape measure in view, count catches, folds, slides and
   moves (more than 2 cm), and weigh the chair. Full protocol: `proof/physics/README.md`.

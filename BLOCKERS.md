# Blockers: things only you can do

**Schedule:** judging at [TIME] (actual time still needed). Feature freeze at [TIME - 3h]; record
`proof/demo/final.mp4` at [TIME - 2h]. After the freeze: fixes and polish only.

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
8. **Real-GPU fps check on the demo laptop (Nicolas).** Open `http://localhost:5173/` (not `?demo=1`) and read the
   fps in the HUD at the bottom. The laptop is on battery with the power-saver profile right now. That alone drops
   headless fps to about 16-22 (it was 60 plugged in), and the e2e fps check fails. Plug in and switch to the
   balanced or performance profile first.
9. **Quest 2 test with taped controllers: fps + tracking (VR team).**
10. **Lounge object removal: three leftovers need a call (branch merge-juan, 2026-10-24).** Removing each of the 17
   lounge objects now takes the whole object (fix 71649ea). Exceptions:
   - **sofa2:** a few long thin streak Gaussians (0.4-0.9 m) about 0.5 m off its back stay in the air. They are white,
     and only look blue from some angles (view-dependent colour). Neither 6c's point vote nor the render lift
     (`--lift render`) labels them. Two options: accept them, or retrain the lounge with a cap on Gaussian size.
   - **stool2:** a small dark patch stays. It is most likely the unlabelled bench beside the stool, or floor the
     stool hid from the camera.
   - Furniture 6c never detected (the bench, the table by chair3, the sofa near the rug) can't be removed at all.
   **Render lift, not adopted:** it finds 25 objects instead of 17. That includes a door, but also overlapping sofa
   pieces (sofa4/5/6), and it doesn't fix the leftovers above. It is in `out/gator_lounge_lift` on HPG if you want it.
   The new stage 12 rules apply to every `objects: auto` scene. Only the lounge has been re-exported: kitchen4_lighter
   and the others keep their old export until rebuilt. Pushing commits d012fb8..71649ea to main waits for your OK.

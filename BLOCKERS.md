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
10. **Kitchen planner zones and outlets (kitchen4_lighter).** `configs/planner/kitchen4_lighter.json` uses the zones you
   described (start in front of the fridge, sink next to it, goal near the stairs), read off the viewer. The outlets are
   assumed: the nightlight at (-1.13, -0.58) and the add_nightlight spot at (1.35, 0.80). Mark the real outlets and tape
   the fridge-door swing; the planner then only places nightlights on real outlets.
11. **Our own walker videos for gait personalization.** Film yourself and teammates with the walker and write `steps.csv` as
   described in `worldmodel/walker_videos.py`. Then run `python -m worldmodel.persona --extra <dir>`. Until then the embedding is
   trained on PhysioNet only.
12. **VR: the 3D ghosts are untested in a headset (VR team).** `game.gait.ghost` and the life-size world-model ghosts
   (`game.wmghosts`: two gait styles, futures fan, predicted self, month replay) and the live futures fan (`game.fan`: 30 trails, 30 frames, 10 people, updated every 0.5 s in `xrFrame`, 4-5 s ahead, plus a card per route fork) are scene objects, so they should render in
   WebXR, but nobody has looked at them on a Quest 2. Labels are sprites sized for a desktop camera, and the month replay
   draws 3 instanced meshes of 60. Check legibility and fps in the headset, and bind `twoStyles()` / `month()` from `xr.ts`.
13. **Re-run the planner's B200 search for the unified "taped" mat (Nicolas, HiPerGator).** A taped mat is now a 1.5 mm edge
   (`grid.ts TAPED_EDGE_M`, mirrored in `planner/engine.py`); the published search (job 47465023) used the old rule. A CPU
   re-score of the taped replays gives ~60.0-60.4/month, but `out/planner/kitchen4_lighter/search.json` was not regenerated.
   Run `planner/publish.sh` after the job.
14. **Shuffle recordings for the fan's "shuffler".** The low-clearance foot lift is an ASSUMPTION (16th percentile of the
   Frontiers 2014 MTC curve, ~7 mm). Film a few deliberate shuffling passes over the mat edge (side view, tape in view) so
   the lift distribution comes from our own data.
15. **Should the planner minimise toe catches alone?** Its objective is toe catches + simulated snags + brushes/month, and the
   snags/brushes dominate (60.91 = 0.07 toe catches + the rest), so the option "least effort for 20% less risk" cuts the
   objective without saving any toe catches. The demo now leads with toe catches/month everywhere; changing the objective
   means a new B200 search.
16. **Merge `rug-calibration` into `wm-planner` (yours; its BLOCKERS 17).** Without it the round trip cannot fold the mat (the
   Rapier flap: 0/8 inbound legs). A trial merge in a scratch worktree (discarded) worked with the recipe there plus the
   fan hook `fold: () => live?.fold() ?? layout.folds?.[0] ?? null`: tsc clean, and with `?rugfold=1` the mat folded at the
   end of the inbound leg in 4/4 runs and the outbound fan showed "folded corner". After the merge, re-record
   `futures_fan.mp4` with `&rugfold=1` so the fold is in the video.

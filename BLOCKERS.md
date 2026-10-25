# Blockers: things only you can do

**Schedule:** judging at ~4:30 PM. Feature freeze at 12:30 PM; record `proof/demo/final.mp4` at ~2:30 PM.
After the freeze: fixes and polish only.

7. **Real-walker physics check** (object physics is SIMULATED until this is done): push the walker over a bath towel
   with one corner folded up 2-3 cm (10 head-on, 10 at about 45°), across the kitchen mat (10), and into a kitchen
   chair (10 head-on, 10 grazing). Film from the side with a tape measure in view, count catches, folds, slides and
   moves (more than 2 cm), and weigh the chair. Full protocol: `proof/physics/README.md`.
8. **Real-GPU fps check on the demo laptop (Nicolas).** Open `http://localhost:5173/` (not `?demo=1`) and read the
   fps in the HUD at the bottom. The laptop is on battery with the power-saver profile right now. That alone drops
   headless fps to about 16-22 (it was 60 plugged in), and the e2e fps check fails. Plug in and switch to the
   balanced or performance profile first.
9. **Quest 2 test with taped controllers: fps + tracking (VR team).**
12. **VR: the 3D ghosts are untested in a headset (VR team).** `game.gait.ghost` and the life-size world-model ghosts
   (`game.wmghosts`: two gait styles, futures fan, predicted self, month replay) and the live futures fan (`game.fan`: 30 trails, 30 frames, 10 people, updated every 0.5 s in `xrFrame`, 4-5 s ahead, plus a card per route fork) are scene objects, so they should render in
   WebXR, but nobody has looked at them on a Quest 2. Labels are sprites sized for a desktop camera, and the month replay
   draws 3 instanced meshes of 60. Check legibility and fps in the headset, and bind `twoStyles()` / `month()` from `xr.ts`.
13. **Re-run the planner's B200 search for the unified "taped" mat (Nicolas, HiPerGator).** A taped mat is now a 1.5 mm edge
   (`grid.ts TAPED_EDGE_M`, mirrored in `planner/engine.py`); the published search (job 47465023) used the old rule. A CPU
   re-score of the taped replays gives ~60.0-60.4/month, but `out/planner/kitchen4_lighter/search.json` was not regenerated.
   Run `planner/publish.sh` after the job.
   **Done:** B200 job 47577852 (toe-catch objective, 1.5 mm taped edge, glide caps in the action set), critic 47577853;
   published to `viewer/public/planner/kitchen4_lighter/` after `planner/check_options.py` passed.
15. **Should the planner minimise toe catches alone?** Its objective is toe catches + simulated snags + brushes/month, and the
   snags/brushes dominate (60.91 = 0.07 toe catches + the rest), so the option "least effort for 20% less risk" cuts the
   objective without saving any toe catches. The demo now leads with toe catches/month everywhere; changing the objective
   means a new B200 search.
   **Decided (Nicolas):** objective = expected toe catches/month; snags + brushes only break ties (TIE_BREAK 1e-5) and are
   shown as notes on each option. Done in job 47577852.
17. **The rug count is 8, not 9 (rug-calibration).** `data/recording_notes.csv` has 8 passes over a flat loose rug (7 off,
   1 onto), and all 8 disturbed it (6 folded, 2 dragged). 1000101386 started pre-folded (the wheel rolled over, the fold
   stayed) and 1000101389 is bare floor (clean). If there is a ninth pass, add its row; `physics/rug_calib.py rewrite`
   recomputes the real rates.
19. **"Maui's effort model" was not found.** No `effort.ts` (TM2's `moveEffort`) on any branch, so the glide-caps fix uses the
   planner's existing scale: $8, 5 min, effort 1 (`configs/planner/kitchen4_lighter.json`, `options.walker.caps`). Swap in
   the real numbers once `effort.ts` lands.
21. **Put the scene bundle in the Drive folder and share it (Nicolas).** The Drive connector can't upload a 375 MB file, so
    the folder "Homeclear scene bundles" (https://drive.google.com/drive/folders/1sMKaR_2YbwhMRrhvPaULsURbEhZY0rlH) is
    empty. Drag in `kitchen4_lighter_v1.zip` (`~/Downloads/kitchen4_lighter_v1.zip` on the laptop, or /blue/dream_team/nrebolloso/scene_bundles/) and share
    the folder with the team. Teammates without HiPerGator access can then run `tools/get_scene.sh kitchen4_lighter <zip>`.
22. **kitchen4 demo vs a rebuild (2026-10-25): nothing changed, two things need a call.** Rebuilding kitchen4_lighter
   from demo-safe code reproduces the demo exactly (objects, splat, floor/obstacle/bump maps, route, hazards). With the
   merge-juan code (after fix b7c2484) the movable boxes and basket are identical; standing chairs, the trash can and
   bedside_table2 cut 1-4% more (bedside_table2 2x: its legs), floor +469 cells (0.19 m²), obstacles -67 cells; route,
   hazards and 200-trip numbers (1.1 contacts/month) unchanged. The calls:
   - The demo folder's `walker.json` is the old 0.66 m walker; the config (since a2fbd0f, before demo-safe) is the
     0.61 m Drive Medical spec. Any re-export shows 13 findings / 4 cm per side instead of 17 / 1 cm.
   - Removal fills in the demo are lama (HPG only). A local rebuild has ns fills, which show a magenta "imagined"
     column above the counter. Re-run 12b with lama on HPG before replacing the demo folder.
   Compare scenes: `kitchen4_oldexport_lighter`, `kitchen4_newexport_lighter` (viewer `?scene=`).
   **Re-checked 2026-10-25 with the code after the main merge and the stool2 fix (ae6d976):** identical to the b7c2484
   rebuild (objects, splat, all five grids, route, hazards, walker) apart from the new empty `reach_points` key; 200-trip
   toe catches/month 1.1 (1.1-1.2) in both. Route renders differ only in the walker labels (0.66 vs 0.61 m) and the
   standing chairs' cut. `kitchen4_lighter` was not touched. Compare scene: `kitchen4_headexport_lighter`.

**Closed, won't do** (out of scope for the demo):
- 1. Re-measure the kitchen table's width
- 2. Film the floor along the demo route
- 3. Bedroom tape measurements
- 4. Walker specs
- 5. Your own home (`configs/myhome.yaml`): film it, measure later
- 6. Bedroom objects and route
- 10. Kitchen planner zones and outlets (kitchen4_lighter)
- 11. Our own walker videos for gait personalization
- 14. Shuffle recordings for the fan's "shuffler"
- 16. A real glide-cap / tennis-ball pass (rug-calibration)
- 18. No wide view for 1000101380
- 20. Lounge object removal: three leftovers need a call (branch merge-juan, 2026-10-24)

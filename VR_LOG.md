# VR log: everything done on the VR lane (Diego + Claude Code on the Mac), 2026-10-23 to 2026-10-25

Written for the next person or agent picking up VR (e.g. Claude Code on the Windows/Link PC) so nothing is redone.
Branch `diego/vr` (merged into `main` through `feat/renovations` -> `nicolas/demo`; `diego/vr` has main merged back in).
Newer than `HANDOFF_VR.md`, which describes the old `vr-mode` branch: on main today **`xr.ts` is the VR code** (not
unused), and VR in `main.ts` is only a hook block.

## 1. Before you start: don't redo these

- Every item in section 3 is built, tested and on main. Read `viewer/src/xr.ts`'s header comment for the controls.
- Quest 2 performance limits are already measured (section 4). Don't re-sweep 150K/200K/250K on the v1.0.2 export.
- kitchen4's scale was checked on site against the real table (section 4.4): **it is right; don't rescale it.**
- The walker parts are chosen and ordered (section 6). Don't shop again.
- The emulated VR suite needs no headset: `npm run e2e:xr` (IWER, emulated Quest 2).

## 2. Where things are

| File | What |
|---|---|
| `viewer/src/xr.ts` | Everything in the headset: `setupXR(host: XrHost)`, the rig, hands, controllers, wand, thumbsticks, card buttons, `?mount=`, `?scale=`, `?emulate=quest2` (IWER 2.5.0) |
| `viewer/src/xrtour.ts` | VR tour: `plainSpot`, `tourStand` (stops 0.9 m from each hazard) |
| `viewer/src/wand.ts` | Wand maths: floor hit, twist, quarter snap, hold-to-delete timing |
| `viewer/src/perf.ts` | Quest tiers: render scale, foveation, refresh rate, splat trim (`PERF`) |
| `viewer/src/xrcompare.ts`, `frontend-xr.ts` | Juan's: compare before/after, restore my room, planning shell (menu) |
| `tools/thin_scene.py` | Thinned display copy of a scene for headsets: `python tools/thin_scene.py viewer/public/scene/kitchen4_lighter --budget 150000 --out k4_150k` |
| `viewer/e2e/xr.ts` | Emulated VR suite, `npm run e2e:xr` (or `node e2e/xr.ts http://127.0.0.1:<port>`) |
| `viewer/e2e/quest-sweep.ts` | Real-Quest fps sweep over route viewpoints, `npm run quest:sweep -- --hz 90 --dirs 8 --query "&..."` |
| `VR_WINDOWS.md` | Windows PC + Quest Link setup (full-quality scene on a PC graphics card) |
| `VR_WALKER_MOUNT.md` | Controllers on the real walker: layout, parts, fitting, use |

### URL parameters (viewer)

| Param | Effect |
|---|---|
| `scene=k4_150k` | Which folder in `viewer/public/scene/` |
| `hz=90` | Refresh rate to request (Quest default 72) |
| `mount=left` / `mount=right` | That controller is zip-tied to the walker (section 3) |
| `wand=left` | Wand in the left hand (default right) |
| `scale=1.1` | Shows the home 10% bigger (rig scaled by 1/1.1). Look only: measurements stay in scan metres. A comfort/try-out knob, not a fix (section 4.4) |
| `floor=3` | Lifts the scan's floor 3 cm against the real one (negative lowers it): you stand that much lower in the scan. For a scan whose floor sits off the real floor (section 4.5) |
| `measure=1` | A card on the wand shows its height above the real floor (in and cm): rest it on a real surface and see if the scan's surface is at the same height |
| `emulate=quest2` | IWER emulated headset in a desktop browser |
| `xrscale=`, `foveation=`, `stddev=`, `maxpx=`, `link=1` | Override render scale (Quest 0.5), foveation (Quest 1), splat trim (2.0 / 128 px), force Link tier |

### npm scripts (viewer/)

`dev:quest` (adb reverse + vite on 127.0.0.1:5179), `mirror:quest` (scrcpy, left eye cropped), `mirror:quest:both`
(whole panel), `e2e:xr`, `quest:sweep`. Port **5179 strictPort** (vite.config.ts). Juan's suites default to 5180:
pass `http://127.0.0.1:5179`.

## 3. What was built (commits, oldest first)

| Commit | What |
|---|---|
| `e660757` | pyproject.toml for laptop deps; viewer checks run on macOS (Mac Chrome path, PR #2) |
| `4e5788c` | WebXR mode: Enter VR, 1:1 floor (`local-floor`), stick and pinch walking |
| `17f7d48` | Wand editing: point, hold trigger/pinch to drag furniture, twist wrist to turn, hold still to delete, point at floor to teleport |
| `549e3ab` | `thin_scene.py` headset copies; VR render options |
| `a989d93` | Tracked hands (models served locally), splat trim for the Quest, start on scanned floor; `VR_WINDOWS.md` |
| `1557435`, `bec5cb9`, `86ccc6c` | `mirror:quest` / `mirror:quest:both` (scrcpy) |
| `856b9f1` | Emulated Quest 2 suite (`e2e/xr.ts`) and the real-Quest fps sweep (`quest-sweep.ts`) |
| `12d37fc` | VR moved out of `main.ts` into `xr.ts` (`XrHost` interface); Juan's labels and performance mode follow the headset |
| `e143490` | XSS fix: Cosmos Reason notes and tour text escaped (local `esc()` in main.ts; don't import report.ts, it renders a page on load) |
| `a104514` | "See a safer room" card button (reimagined room via `game.reimagine`) |
| `44cb728` | Performance-mode splat trim 2.2 -> 2.0 (measured, section 4); sweep `--query` |
| `b5dc2dd` | "Night walk" and "Show me the dangers" card buttons |
| `d669ecd` | The VR card follows every teleport; real-Quest checks of tour and night walk |
| `36f10f8` | Tour stops 0.9 m from each hazard (was 1.2); sweep `--dirs 8` |
| `40dceb1` | Walker mount plan doc |
| `5e953fa`, `c48a4e0` | Juan's `feat/renovations` merged in: XrEditor, planning shell, xrcompare, resets, wheelchair persona, contact shadows |
| `1f8df17` | VR starts on well-filmed floor (route-median coverage), not at the scan's edge: first view ~90 fps |
| `7539a46` | Thumbsticks back (user asked): left walks relative to view (standable checks), right snap-turns 30 deg about the head |
| `933bbfc` | `?mount=left`: stick up/down walks along the walker's heading, left/right snap-turns 30 deg, virtual walker follows the mounted controller, line-up at VR entry + "Line up the walker" card button, mounted trigger ignored |
| `0231cb2` | `?scale=` (rig scale) to compare the scan's size with the real room |

Since merged from main (Juan, `d44b2c6`, `e3bedac`): planning menu is a **held** left-stick click; wand stick click =
undo last object edit, with the other grip held = redo; a controls hint strip on the off-hand controller; haptic pulses.
With `?mount=left` the off-hand controller is the one on the walker, so the strip sits on the walker bar and redo needs
its grip. Not yet looked at in the headset.

### Controls today (headset)

- Walk for real (1:1); left stick walks; right stick snap-turns 30 deg; pinch/trigger on the off hand glides forward.
- Wand: point + hold = drag, twist = turn, hold still = delete, A = remove, grip = reset object, both grips held = reset all,
  point at filmed floor + release = teleport, stick click = undo.
- Card buttons (pressed with the wand): Show me the dangers (tour), Night walk, See a safer room, Compare, Restore my room,
  Line up the walker (mount mode).
- Mount mode: one stick; stand behind the walker facing its way when pressing ENTER VR (the offset is taken then).

## 4. Measurements and numbers

### 4.1 Quest 2 frame rate (standalone, Quest Browser)

| Scene | Splats | 72 Hz | 90 Hz | Notes |
|---|---|---|---|---|
| kitchen4 full (old export) | 981K | ~7 fps | | Unusable standalone; needs Link |
| old export thinned 120K, **no trim** | 120K | misses 72 | | The splat trim is required |
| old export 150K | 150K | 20/24 viewpoints full rate, min 53 fps | holds 90 from room centre | `quest:sweep`, 24 viewpoints |
| old export 200K | 200K | 13/24, min 36 fps | | holds 72 only from room centre |
| old export 250K | 250K | fails | fails | |
| **v1.0.2 export `k4_150k`** | 150K | **48/48** (8 dirs), worst 70.9 | **43/48**, worst 77.1 | the one to use |
| v1.0.2 `k4_200k`, `k4_250k` | | | ~36 fps in some views | not usable |
| `k4v103_150k` (v1.0.3 export) | 150K | | **not swept yet** | open item |

- Splat trim (`PERF`): `max_std_dev` 2.0, `max_pixel_radius` 128. Juan's 2.2 gave a worst view of **47.8 fps vs 57.5 at
  2.0** (old export, 72 Hz). Render scale 0.5 on the Quest (0.85 draws 2.9x the pixels; the GPU is fill-bound),
  fixed foveation 1.
- At 90 Hz on `k4_150k`: tour, night walk, safer room and compare run at ~84-90 fps.
- Reimagine layout search: ~36 s on the Quest; the morph dips to 52-55 fps.
- Decision: **72 Hz stays the Quest default**; add `&hz=90` per scene (OK for `k4_150k`).
- Recommended URL: `http://localhost:5179/?scene=k4_150k&hz=90` (+ `&mount=left` on the walker).

### 4.2 Scenes (gitignored, `viewer/public/scene/`, on the Mac)

| Folder | What |
|---|---|
| `kitchen4_lighter` | v1.0.2 export, 553,897 splats (201K room + 352K furniture, chair6 dropped, 3 hazards) |
| `k4_150k`, `k4_200k`, `k4_250k` | thinned from v1.0.2 |
| `kitchen4_lighter_v103` | v1.0.3 export, 981,369 splats (626K room + 356K furniture). Looks more complete (walls, ceiling, clean floor; v1.0.2 has a black void and a dark streaky floor) but softer at 150K (edge energy 4.4 vs 5.2-5.4). Its zip's bundled viewer code is an OLD snapshot: don't use it |
| `k4v103_150k` | thinned from v1.0.3 |
| `kitchen4_lighter_prev`, `kitchen4_raw` | old export copies; can be deleted |
| `game_synth`, `game_synth_narrow` | synthetic scenes for the suites: `python tests/make_game_scene.py [--narrow]` |

### 4.3 Walker (Drive Medical 10210-1)

Manufacturer spec sheet: 24 in (0.61 m) wide, 1 in (25.4 mm) aluminium tubes, 5 in front wheels, rear glide caps,
7.5 lb, handles 32-39 in, 17 in between grips; base depth 17.5 in (0.445 m, retailer figure). Scene `walker.json`:
width 0.66, depth 0.5, handle height 0.85, user gap 0.25, leg radius 0.015. Still to tape: glide cap diameter, the
patient's handle height, where the controller ends up after fitting. 2 deg of controller rock moves the far legs ~1 cm.

**Taped on the real walker (2026-10-25):** front width **19.5 in (0.495 m)**, back width **21 in (0.533 m)** (it widens
toward the back), overall height **39.5 in (1.00 m)**. The configs' `walker_width_m: 0.61` (24 in, spec sheet) is 3 in
wider than this walker's widest point, so the sim calls some squeezes tighter than they are. Still to confirm: whether
those are outside-to-outside, and the front-to-back depth. The configs are Nick's (tell him before changing).

### 4.4 kitchen4 scale check (on site, 2026-10-24, no tape: laptop + phone lengths)

The scale comes from `configs/kitchen4.yaml` `scale.manual_factor: 1.13099` (table taken as 62 in long). In VR the
kitchen felt smaller than in person, so the table was measured with a 14" MacBook Pro (31.3 cm wide) and a Pixel 10
(15.3 cm long):

| Table side | Real | Scan (`objects/table.ply`) | Scan vs real |
|---|---|---|---|
| Long | 5 MacBooks + 1/4 Pixel = **~160 cm (63 in)** | 154 cm (61 in) | 4% short |
| Short | 1 MacBook + 3.9 Pixels = **~91 cm (35.8 in)** | 95 cm (37 in) | 4% long |
| Height | (not measured) | 0.78 m (30.6 in) | |

Errors in opposite directions = the table's outline is a bit off, not the scale. **Overall scale is right to within
a few percent; don't change `manual_factor`.** The "smaller" feeling is the headset: VR distances are commonly
underestimated 10-20%; also check the Quest 2 IPD slider (positions 1/2/3 = 58/63/68 mm) and that the virtual floor
meets the real one (touch the floor with a controller). Other scan heights for reference: tall cabinets ("box*"
objects) top at 2.14-2.28 m (84-90 in), bedside table 0.69 m, chairs 0.73 m, trash can 0.66 m.

**Taped (2026-10-25):** table **63 x 35.5 in (160.0 x 90.2 cm)**, so the scan is 3.8% short and 5.3% long; the
geometric mean is 120.1 cm real vs 121.0 cm scan (+0.7%). The scale is right (the config's 62 in should read 63 in;
the factor needn't change).

### 4.5 kitchen4 heights (on site, 2026-10-25, tape)

In VR, Diego felt about 2 in too tall next to the fridge with the Quest floor set correctly.

| | Tape | Scan (kitchen4_lighter, k4_150k, v1.0.3 all the same) | |
|---|---|---|---|
| Table top | 29.5 in (74.9 cm) | 77.5 cm | scan 3.5% tall |
| Fridge top | ~65.5 in (166 cm) | ~153-155 cm (front of the fridge) | scan ~12 cm short |
| Cabinet above the fridge | ~84 in (213 cm), hard to tape | ~197 cm | scan ~16 cm short |
| Floor near the fridge | - | -0.5 cm | right |
| Ceiling | almost 8 ft (2.4 m) | not in the scan (tops out at 2.29 m, the tall cabinets) | |

Table tall and fridge short = not a scale error and not the floor (the floor is at 0 in every copy): the scan lost the
top of the fridge (white, shiny, high up). Next to a fridge ~12 cm short you feel taller. The fix is in the scan
(a re-film was under way on 2026-10-25), not in VR. To check a new scan in the headset: `?measure=1`, rest a controller
on the real floor, the tabletop and the fridge top, and see if the virtual one rests on the scan's surface; a constant
gap everywhere means the floor (fix with `?floor=`), a gap only at one object means the scan there.

## 5. The headset (Quest 2) from the Mac

- Connect: `adb reverse tcp:5179 tcp:5179` and `adb forward tcp:9223 localabstract:chrome_devtools_remote`
  (Quest Browser DevTools over CDP on :9223; scripts eval in the page with a user gesture to enter VR remotely).
  On the Mac adb had to run outside Claude's sandbox.
- The headset needs Wi-Fi (ufguest) or the Quest Browser shows "no internet" even for localhost.
- **Stay-awake overrides are still ON** (set for unattended sweeps): `prox_close` (undo:
  `adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable`) and `stay_on_while_plugged_in=7` (undo:
  `adb shell settings put global stay_on_while_plugged_in 0`). Turn both off next time it's plugged in unless wanted.
- **Ask whether someone is wearing the headset before any remote action** (teleport, reload, blackout, entering VR),
  and warn before each one.
- Turn off the Quest's auto-switch from controllers to hands, or the mounted controller drops out when still.

## 6. Walker hardware (VR_WALKER_MOUNT.md has the full fitting steps)

- Left controller zip-tied on the **left upper side bar** in front of the left grip, thumbstick up (`?mount=left`).
  Keep ties off the trigger, grip button, battery door and ring. The grey front bar (red fold buttons) stays clear.
- Right controller = wand, in a cup holder clamped on the right side bar.
- Ordered 2026-10-24: LOCKLOCK zip ties (use 12 in / 48 lb), adhesive rubber grip tape 1 in x 20 ft (B0FBGYF432, on
  the bar only), walker cup holder (B094N4HRLX, clamp 0.55-1.7 in), AA batteries / flush cutters as add-on.
- Dock detection (wand in holder = walk, lifted = edit) is **not built**.
- BLOCKERS item 9 (VR team): Quest 2 test with taped controllers, fps + tracking. Not done yet.

## 7. Test status (merged diego/vr, 2026-10-24 evening, Mac)

- `npm test`: 176 pass, 17 skipped, 0 fail. `npm run build`: OK. `e2e:xr`: 28/28.
- 2026-10-25 (main with PR #9 merged in, plus `?floor=`, `?measure=1`, `bounded-floor`): `npm test` 222 pass, 17
  skipped, 0 fail; build OK; `e2e:xr` 29/29.
- Earlier on diego/vr: `node e2e/run.ts` 37/37.
- Juan's `e2e:frontend`, `e2e:frontend:xr`, `e2e:renovations` **time out on macOS** (stuck clicking ENTER VR /
  `#mode-explore`), same on his unmodified branch: they launch Chrome with `--use-angle=gl` (software GL on macOS) and
  default to port 5180. His "VR advances renovation animation" check fails on his branch too. "Fill appears only after
  the object moves" is flaky. Worth re-running on Windows, where `gl` is fine.

## 8. Open items

1. Quest 90 Hz `--dirs 8` sweep of `k4v103_150k` vs v1.0.2's 43/48: decides v1.0.2 vs v1.0.3 for the demo.
2. Stay-awake overrides off (section 5).
3. Real walker feel test with `?mount=left` once the parts are fitted; check Juan's hint strip on the mounted controller.
4. Tell Juan: his e2e suites time out on macOS; the renovation-animation check fails; the route-follow in his shell
   moves the camera for you (motion-sickness risk: add a vignette or fade); kitchen4 night mode is nearly black (no
   nightlight). (His planning menu now needs a held click, which fixes the accidental-open concern.)
5. Windows PC (RTX 4070 laptop): Quest Link didn't work, so the team uses **SteamVR (Steam Link)** (2026-10-25,
   `VR_WINDOWS.md` section 2B). Full-quality scene result pending; check the floor with `&measure=1` and the buttons once.
6. Delete `kitchen4_lighter_prev`, `kitchen4_raw` if unused. Dock detection not built.
7. Room-scale boundary: the session now asks for `bounded-floor` (optional) besides `local-floor`; before that the Quest
   used the stationary boundary only. Check in the headset that the room boundary is used.
8. Tell Juan: **B on the wand silently turns on stairs/doors marking** (`main.ts` `markerXR.buttons`): it draws the
   stair/door handles with their heights, and while it is on the trigger goes to those handles, so furniture can't be
   edited (A or grip leaves it). Nothing in the headset says it is on. Suggest a card ("Stairs & doors editing · A to
   exit") or moving it into the menu.
9. Tell Nick: kitchen4 fridge top missing ~12 cm (section 4.5); table is 63 in, not 62 (section 4.4); this walker is
   21 in at its widest, not 24 (section 4.3).
11. **World model in the headset (BLOCKERS 12), built 2026-10-25:** a "World model" card button steps through two
   walking styles, a month of trips, the imagined-futures fan and off. Fixed on the way: the ghosts never moved in VR
   (`wmg.update` only ran in the desktop loop), starting them in VR switched the desktop to fly mode and turned the walker
   55 deg (`setFly`), and a thinned headset copy (`k4_150k`) found no planner search (now uses `scene.thinned.source`).
   `e2e:xr` checks 12a/12b, emulated only. **The ghosts need Nick's staged demo kitchen** (`tools/stage_demo_hazards.py`
   adds the mat, cord, nightlight and pulled-out chair; the planner fails with "no object mat" without it). The Mac's
   `kitchen4_lighter` is not staged (on purpose for now: the staged hazards aren't in the real kitchen); the test used a
   staged copy in a scratch worktree. In the headset: the month label is big and sits overhead in the middle of the route,
   and it lists raw object names (`trash_can`, `chair8 moved`). Still to check on the Quest: fps with 60 ghosts.
10. Tell Juan (security review of `viewer/session-plugin.ts`, the companion relay): a device is known only by the
   `client` name in its URL, and those names are sent to every device, so anyone who can reach the dev server can post
   as another device (even the headset host). Fine on `127.0.0.1` and over adb; not with `--host` on a shared network.
   Fix: a random secret per device when it joins, required on every POST, never broadcast.

## 9. Team decisions to keep

- Patient/caretaker is the primary audience.
- In-headset UI is scene objects only (never DOM/CSS2D). Reimagined room only through `game.reimagine`.
- `xr.ts` is the VR lane's; `main.ts` only gets hook blocks. Don't hand-edit `out/`, `viewer/public/scene/`, `proof/`.
- Commits keep the `Co-Authored-By` trailer; no AI attribution in code.

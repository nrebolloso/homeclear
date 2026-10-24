# Plan: devices, lights, better-looking added objects, accessibility fixes (demo push)

Draft, 2026-10-24. Owner: Juan. Status: proposal, nothing built yet.

Hard rules still apply (SPEC §2): every added thing is **designed, not built** (teal, labelled), and product sizes
come from spec sheets marked `typical`. No risk number may come from rendered pixels. Where we have no calibrated
model (wheelchair falls, lighting), the viewer shows **code checks (pass / fail / borderline)** or numbers tagged
**ASSUMED**, never a made-up falls-per-month figure.

---

## 1. What's already there (so we build on it, not around it)

| Piece | Where | What it does now |
|---|---|---|
| Persona switch | `main.ts` `setPersona`, `scene/*/personas.json` | swaps device mesh, gait, planner width; has `patient` (walker), `cane`, `parkinsons` |
| Device mesh | `walker.ts` `buildDevice` | walker or cane from primitives at `walker.json` sizes; same `{group, legs, probes, setLegRed}` shape |
| Mannequin | `mannequin.ts` | cylinders + spheres, two-bone leg IK onto the simulated footsteps, hands on the grips |
| Night | `night.ts` | Spark dyno modifier: darkens every splat, warm falloff around 1 nightlight + up to 8 extra lights (step lights) |
| Stairs fixes | `stairs.ts`, `stairs3d.ts` | measured risers, handrail (copied from the scan), step lights, second walker / rollator parked at the top |
| Doors | `doors.ts`, `doors3d.ts` | offset hinges, remove, widen (`carve`) |
| Lighting of meshes | `main.ts:97` | one `HemisphereLight` (2.2, dropped to 0.25 at night). Nothing else. |

"Crane" in the request = the **cane** persona, which already exists. The new device is the **wheelchair**.

---

## 2. Ranked by demo yield (impact on judges ÷ hours)

| # | Feature | Why it lands | Effort | Risk |
|---|---|---|---|---|
| **1** | **Wheelchair persona + stairlift / ramp suggestions** | Same room, new person, different answer: the stairs become impassable and the fix list changes to stairlift + a second chair at the top. Shows the system is about *this* person. | 6–8 h | low: reuses persona switch + stairs fixes |
| **2** | **"Light the path" at night** (placeable light fixtures that actually light the scan) | Most visual moment of the demo: lights go down, click once, glowing nightlights pop on along the route, the room lights up around them, risk drops. | 4–6 h | low: night shader already takes 8 lights |
| **3** | **Ground the added objects** (contact shadows + room-lit materials from the splat) | Mannequin, walker and fixtures stop looking pasted on. Every other feature looks better because of it. | 2–3 h | low |
| **4** | **Bathroom package**: grab bars, raised toilet seat, shower chair / transfer bench | The best-evidenced home modifications for falls; we have a bathroom capture (`myhome_bedbath`). | 5–7 h | medium: needs toilet / tub marked |
| **5** | **Stroke persona** (one-sided weakness + neglect) | Reuses `strong_side`: rails, grab bars and bed approach flip to the strong side; things move to the seen side. | 3–4 h | low |
| 6 | Splat "lenses" (clearance x-ray, reach band, light temperature) | Shows off that the scan itself is being changed, not overlaid. | 2–4 h each | low |
| 7 | Rigged mannequin (GLB skinned mesh driven by the existing IK) | Looks nicer up close; STATUS already lists it. | 5–8 h | medium: rig/licensing/IK retarget |
| 8 | Depth occluders (walker hidden behind the table) | Correctness of the look when walking behind furniture. | 3–5 h | medium |

**If there's only one day: do 3 → 1 → 2, then 4 if the bathroom marking works.** Item 3 first because it is cheap
and makes the screenshots for 1 and 2 look right.

### Demo script these produce (≈90 s)

1. Walker persona on the stairs: existing rail + step lights + walker parked at the top.
2. Switch to **wheelchair**: route turns red at the bottom step and at the 74 cm door; the fix list becomes
   *stairlift (straight rail, typical $2–5k) + parked wheelchair at the top* or *bedroom moved downstairs*; the door
   gets *widen to 82 cm*; a 1.5 m turning circle shows red where the room is too tight.
3. **Night walk**: lights down. Click **Light the path**: three motion nightlights appear on the route (bed side, hall,
   bathroom door), each glows and lights the scan around it; the dark-leg risk drops (tagged ASSUMED multiplier).
4. Bathroom: grab bars on the strong side, raised seat, shower bench, all teal, each with cost + funding line.
5. Switch to **stroke (left side weak)**: the rail and the grab bar flip sides.

---

## 3. Feature details

### 3.1 Wheelchair persona (`wheelchair.ts`, new; `personas.json` entry)

**Device** (`device: 'wheelchair'` in `WalkerCfg`, built by `buildDevice`):
- Size: typical manual chair 0.66 m wide × 1.07 m long, seat 0.48 m (ADA's design footprint is 30 × 48 in,
  760 × 1220 mm). Mesh from primitives like the walker (two 0.6 m rear wheels with hand rims, two casters, seat,
  back, footplates), so it stays exactly at the configured size. Probes = the four corners + footplate front.
- Mannequin: seated pose (`buildMannequin` gets a `pose: 'walk' | 'seated'`): hips at seat height, hands on the rims.
- `setLegRed(k)` -> wheel / caster turns red.

**Checks** (code checks, not a fall model; each one pass / fail / borderline within the stage-6b margin):

| Check | Limit (2010 ADA Standards) | Data we have |
|---|---|---|
| Door clear width | ≥ 815 mm (32 in) | `doors.ts` measured jambs |
| Route width | ≥ 915 mm (36 in) | occupancy grid, inflated planner |
| Turning space at each end of the route and at turns | 1525 mm (60 in) circle, or a T-turn | occupancy grid (coordinate with TM3's 1.5 m circle rule) |
| Level changes | ≤ 6 mm vertical, ≤ 13 mm bevelled; more needs a ramp | bump map (stage 7) |
| Stairs | impassable | `stairs` |
| Reach | forward reach 380–1220 mm (15–48 in) | object heights (optional) |

**Planner:** walker-width inflation already comes from `plan.walker_width_m`; add `turn_diameter_m` for the circle
test at route ends. Physics (`main.ts:651` already skips the cane): skip the Rapier walker pass for the wheelchair;
optionally flag casters over bumps > 13 mm.

**Suggestions it unlocks** (new `add` interventions, costs via `movecost.ts` placeholder until TM2's `effort.ts`):
- **Stairlift** (`stair_lift:<stair>`): see 3.2.
- **Threshold ramp** at each bump > 13 mm on the route (rubber ramp, typical $30–80).
- **Widen door / offset hinges** (exists in `doors.ts`; offset hinges add ≈ 5 cm).
- **Modular ramp** for an entry step: length = rise × 12 (1:12), shown along the floor; flag if it doesn't fit.
- **Move the bedroom downstairs** as a no-cost text option when no stairlift fits.

### 3.2 Stairlift (`stairs.ts` fix + `stairs3d.ts` mesh)

- Rail along the flight at `pitchAt(s)` on the wall side, ~0.1 m above the nosings, extending past top and bottom.
- Carriage: seat, back, armrests, footplate; animates up the rail with the seated mannequin (`play()`), folds at the top.
- **Measured fit check**: folded depth ≈ 0.33 m (typical; spec sheets say 30–35 cm). Show
  "flight 91 cm wide (measured) → 58 cm left beside the folded lift". Fail if the flight is under ~0.7 m.
- At the top: reuse `parkedPose` / `top_device` with `'wheelchair'` added (a second chair waits at the top, as the
  walker does now). That's the same pattern judges already saw.
- Cost / funding text: straight stairlift typically $2,000–5,000 installed, curved $10,000+. **Original Medicare
  does not cover stairlifts**; candidates are Medicaid HCBS waivers, VA HISA, MA supplemental benefits. That
  classification is TM2's (`effort.ts`); we only pass `kind: 'stair_lift'`.

### 3.3 Light fixtures that light the room (`lights.ts`, new)

**Fixtures** (new `add` interventions with a model and a `light: {r, color, z}`):

| Fixture | Typical | Where the optimizer puts it |
|---|---|---|
| Plug-in motion nightlight | 0.3 m up a wall, r ≈ 1.5 m, warm 2700 K | along the route where it leaves every light's radius |
| Under-bed motion strip | floor level, r ≈ 1.0 m | bed side the patient gets out on |
| Illuminated light switch | 1.1 m | at each door on the route |
| Stair step lights | exists | `stair_lights:` |
| Lamp on the nightstand | 0.7 m, r ≈ 2 m | nightstand, if one is there |

**Rendering (three layers, cheap):**
1. The scan: `night.ts` light list already does this. Raise `MAX_EXTRA_LIGHTS` 8 → 16 if needed, and give each light
   its own colour (`dynoVec3` per light) so warm vs cool reads.
2. The meshes (walker, mannequin, fixtures): a real `THREE.PointLight` per fixture with the same position / radius
   (`distance = r`, `decay = 2`), on only at night, so the walker is lit by the nightlight it passes.
3. The glow: an emissive bulb + an additive sprite halo (radial-gradient texture, `depthWrite: false`). No bloom
   pass: it costs frame time and doesn't run in WebXR.

**"Light the path" button:** walk the route at 0.25 m steps; any run longer than ~1 m outside every light radius
gets a nightlight at the nearest wall cell (occupancy edge) next to it. Each placement is an intervention, so the
existing ranking shows its risk drop. The drop comes from `risk.dark_contact_multiplier` (1.5, **ASSUMED**), so the
card says so.

Stretch: lights don't shine through walls. Precompute per-light 2D visibility on the occupancy grid (raycast),
store as a small texture, multiply the falloff in the dyno by it (needs a texture read in dyno; check Spark supports it).

### 3.4 Rendering the mannequin, walker and added objects

Why they look off now: flat hemisphere light that doesn't match the room, no shadow where they touch the floor,
plain primitives.

In order of yield:
1. **Contact shadows** (`ground.ts`, new, ~1 h): a soft dark ellipse decal (radial-gradient texture on a plane,
   `depthWrite: false`, multiply blending, z = 2 mm) under each foot, each walker leg / wheel, and each added
   fixture. Moves with them. Biggest single realism gain.
2. **Light them with the room** (~1 h): Spark 2.4 has `SparkRenderer.renderEnvMap({ scene, worldCenter, hideObjects,
   update })` which renders the splat into a PMREM env map. Render once at the room centre at load (hide meshes),
   set `scene.environment` (or `spark.recurseSetEnvMap(group, env)`), drop the hemisphere light to ~0.6. Materials
   then pick up the room's colours and brightness. Re-render with night on, or just scale `envMapIntensity` at night.
3. **Better materials / shapes** (~2 h): walker: `TubeGeometry` bends at the top corners, grey rubber tips (or tennis
   balls on the rear legs, which many patients use), brushed-aluminium `metalness 0.9 roughness 0.3` that now
   reflects the env map. Mannequin: `CapsuleGeometry` limbs, a neck, matte neutral grey (a mannequin should look like
   one, not a skin tone that clashes with the scan). Keep everything built at config sizes: walker dims are measured.
4. **Fade on approach** in first person: drop mesh opacity when the camera is inside it (stops the mannequin's head
   filling the screen).
5. **Rigged mannequin** (later): a Mixamo-style GLB (`GLTFLoader` + `SkinnedMesh`), driving the hip/knee/ankle bones
   from the existing IK so feet still land exactly on the simulated steps. Decorative objects (stairlift chair,
   shower bench, lamp) can be GLBs scaled to their spec sizes; check each model's licence (CC0 / CC-BY, credit in
   README).
6. **Occlusion** (later): splats test depth but don't write it, so a mesh behind the table draws over it. Add
   depth-only occluders (`colorWrite: false`) from object proxies and wall cells of the occupancy grid, inset ~3 cm so
   they don't cut the splat's own surface.

### 3.5 Bathroom package

Needs the toilet and tub/shower located: add `game.marker.begin('toilet' | 'tub')` (two clicks: front edge + the
wall behind; `marker.ts` is Juan's) or take them from detection (`kind: toilet | tub`, ask the detection owner).

| Fix | Placement rule (2010 ADA, residential practice) | Typical cost |
|---|---|---|
| Grab bar beside toilet | 840–915 mm (33–36 in) high, 1065 mm (42 in) long, ≤ 305 mm from back wall, on the **strong side** | $30–60 + install |
| Grab bar behind toilet | same height, 915 mm (36 in) long | same |
| Raised toilet seat / toilet frame | seat 430–485 mm (17–19 in); compare to persona knee height | $30–60 |
| Tub transfer bench / shower chair | across the tub wall | $40–100 |
| Handheld shower + non-slip strips | | $30–60 |
| Vertical grab bar at tub entry | | $30–60 |

Rendered like the stair rail: teal, designed-not-built, product + cost card. Each one is an `add` intervention so
the fix list and OT report pick them up.

### 3.6 Stroke persona

`personas.json`: `stroke_left`: walker or quad cane, `strong_side: right`, shorter stride, higher stride CV,
`vision: 'left_neglect'` if `vision.ts` can do a left-field fade (add the filter if not). Effects:
- Stair rail on the strong side going **up and down** → usually "rails on both sides" (measured rails already known).
- Toilet grab bar on the strong side; bed approached and exited from the strong side (optimizer bed side).
- "Move often-used items to the right" as an OT checklist item (advice, no number).

Parkinson's (already a persona): add **floor stripes at doorways** (visual cueing for freezing) as a cheap `add` fix.

### 3.7 Splat lenses (dyno modifiers next to the night one)

- **Clearance x-ray**: tint splats red within 0.3 m of the route corridor edge where clearance < need (one uniform
  per corridor segment, or a small texture).
- **Reach band** (wheelchair): tint splats between 380 and 1220 mm high, within 0.6 m of the route, green; above
  red. "Everything red is out of reach from the chair."
- **Time of day**: a slider from day to 3 a.m. instead of the on/off night box.
- **Light temperature**: warm 2700 K vs cool 5000 K per fixture (warm is the usual night recommendation: less glare).

All visual only, labelled as such.

---

## 4. Other accessibility fixes worth listing (OT checklist in the report)

Evidence base: home-hazard assessment and modification cut the rate of falls by about a fifth overall and by about a
third in people at high risk, most clearly when an OT leads it (Cochrane review of fall prevention in the community,
Gillespie et al. 2012; Pighills et al. 2011). CDC STEADI "Check for Safety" and the 2010 ADA Standards give the
specifics. Sorted by how well our simulation can show it:

**Simulated (changes the route or a risk number)**: remove / tape rugs and cords (exists); move furniture for a
clear 0.9 m path (exists); nightlights on the bed → bathroom path (3.3); rails both sides of stairs (exists);
threshold ramps (3.1); widen / offset-hinge doors (exists).

**Checked against code (pass / fail from measured geometry)**: door clear width, turning circle, route width, step
riser/tread (exists), handrail height 865–965 mm (34–38 in), toilet and bed height vs knee height, grab bar
placement.

**Advice only (OT checklist, no number)**:
- Lever door handles and rocker light switches (one-handed use: stroke, arthritis).
- High-contrast tape on stair nosings and step edges (low vision, also helps dementia).
- Chair with armrests and firm seat for sit-to-stand; furniture risers.
- Bed rail / transfer pole; bed height so feet rest flat when seated.
- Often-used kitchen items between hip and shoulder height; a reacher.
- Phone or medical-alert button reachable from the floor; fall-detection.
- Smoke / CO alarms with strobe (hearing loss).
- Non-slip mats in tub and on the bathroom floor.

---

## 5. Ownership and where code goes

Juan's lane (no one else's files): new modules `wheelchair.ts`, `lights.ts`, `ground.ts`; `marker.ts` toilet/tub
marking; `stairs.ts` / `stairs3d.ts` stairlift (renovations work); `reimagine.ts` cards; `movecost.ts` placeholder
costs for the new kinds.

Shared, short hook blocks only: `main.ts` (`// ---------- lights (lights.ts) ----------` etc.), `index.html` panels
appended at the end, `e2e/run.ts` checks appended.

Ask first:
- **TM3** (`rules.ts`, `optimize.ts`): turning-circle and lighting rules are on their list. Offer the geometry
  (`lights.ts` path coverage, circle test) as functions they call.
- **TM2** (`effort.ts`): funding classes for `stair_lift`, `grab_bar`, `ramp`, `nightlight`, `toilet_seat`, `bench`.
- **Detection owner**: `kind: toilet | tub | shower` from 6c, so marking is optional.
- **VR team**: new buttons go through `game.*` (`game.lights.lightPath()`, `game.setPersona('wheelchair')`); all new
  UI is scene objects (cards, sprites), never DOM.

## 6. Order of work and done-when

| Step | Done when | Test |
|---|---|---|
| 1. `ground.ts` contact shadows + env map | before/after screenshots in `proof/rendering/`; fps within 5 % on the Quest perf tier | e2e screenshot check |
| 2. Wheelchair device + persona + code checks | switching to wheelchair shows door / circle / stairs verdicts on the myhome and kitchen scenes | unit tests for the circle + door checks (`tests/wheelchair.test.ts`) |
| 3. Stairlift fix | appears in fixes for the wheelchair persona only; fit check uses measured width; animates | `tests/stairs.test.ts` additions |
| 4. `lights.ts` fixtures + "Light the path" | night: lights glow, scan lit, risk drop shown with ASSUMED tag | test: placements cover the route; risk drop > 0 |
| 5. Bathroom package | grab bars on the strong side at code height on `myhome_bedbath` | placement unit test |
| 6. Stroke persona | rails / grab bar flip with `strong_side` | persona test |
| 7. Lenses, rigged mannequin, occluders | as time allows | screenshots |

Every step: `cd viewer && npm test && npm run build`, then `npm run dev` + `node e2e/run.ts`.

### Status (2026-10-24)

| Step | State | Where / what's left |
|---|---|---|
| 1. Grounded meshes | done | `ground.ts`, `proof/rendering/` |
| 2. Wheelchair | done | `wheelchair.ts`, `proof/wheelchair/` |
| 3. Stairlift | done | offered for every persona, not only the wheelchair (a stairlift also helps walker users); the fit check only fails it for the chair |
| 4. Light the path | done | `lights.ts`; Reimagine → "Light the path at night", `game.lights`; `proof/demo_features/` |
| 5. Bathroom package | partly | a grab bar beside each toilet in `game.fixtures` (`bathroom.ts`), side from the floor map's walls, weak side flagged. No config marks a toilet yet (only `game_synth`), so it shows nowhere real until one is added (MEASURING.md §5). Not done: tub transfer bench, handheld shower, toilet frame (needs a `tub` fixture kind) |
| 6. Stroke persona | done | `stroke.ts`, left-side view loss in `vision.ts` |
| 7. Lenses | partly | reach lens (wheelchair persona, `night.ts`). Not done: clearance x-ray, time-of-day slider, light colour temperature |
| 7. Rigged mannequin | not done | needs a licensed rigged GLB (CC0 / CC-BY) chosen and added to the repo first |
| 7. Depth occluders | not done | inner boxes from object proxies + wall cells; risk of hiding the object's own splat |
| Also done | | partial-scan stair guard ("OT to verify" + MEASURING.md, not fail); Explore parks the walker, no collisions |
| Also not done | | wheelchair threshold-ramp and modular-ramp fixes (the level check's note says it); Parkinson's doorway floor stripes |

Sources to cite in the report: 2010 ADA Standards for Accessible Design (§304 turning space, §404 doors, §303
level changes, §405 ramps, §505 handrails, §604 toilets, §609 grab bars, §308 reach); CDC STEADI "Check for Safety";
Gillespie et al., Cochrane 2012 (CD007146); Pighills et al. 2011 (J Am Geriatr Soc). Product sizes and prices are
typical ranges: mark `typical` and replace with the patient's own equipment where known.

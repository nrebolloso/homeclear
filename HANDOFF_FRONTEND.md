# Frontend workspace

Branch: `feat/frontend`, created from `feat/renovations` at `cc2263a` so guided marking and VR editing remain available.
Separate checkout: `../homeclear-frontend`. The original checkout stays on its existing branch.

From `viewer/`, run `npm ci` and `npm run dev -- --port 5180 --host 127.0.0.1`.
Use `http://127.0.0.1:5180/?scene=kitchen4_lighter_objects` (local scene export required), or `?scene=game_synth`.
Scene exports, Python environment, node_modules, screenshots, and build output remain ignored.

## Structure

- `viewer/src/frontend.ts`: floating desktop shell, existing-control reparenting, navigation, inspection, proposals, costs, lighting concepts.
- `frontend.css`: responsive layout, focus states, high-contrast surfaces, compact controls; no full-width top bar.
- `frontend-model.ts`: conservative estimate aggregation, distinct proposal outcomes, installation metadata types, lighting concepts.
- `frontend-xr.ts`: ray-selectable scene-mesh menu, inspection card, fade transitions. Left thumbstick click opens/closes it.
- `main.ts`: small adapter at the bottom plus playback, particle-path, and XR input hooks. Existing IDs, handlers, backend calls, and `game.reimagine` contract stay available.

The existing DOM is reparented once after initialization. This avoids rewriting teammate handlers or rearranging `index.html`. Legacy sidebars are hidden; the controls they contain are placed into the new surfaces or remain addressable for existing integration APIs.

## Current behavior

- Explore, Follow route (pause/restart/speed), and manual Inspect (hazards, changes, all).
- Inspection frames real items from the existing findings/change data; it does not generate clinical results. Desktop uses a direct viewpoint change. VR fades between user-requested valid viewpoints without rotating the user's head. Returning from inspection restores the previous location.
- Filters share the original vision/night/display controls and stay selected across modes. The route remains particles, with simulated footsteps controlled separately.
- Assessment, Reimagine, and Changes share one collapsible panel. Layout search produces one recommendation plus distinct alternatives; previews use the existing optimizer output. A preview loads the working simulated layout. Use this layout opens its unified change list; neither action claims that physical changes happened.
- Proposals are rejected as stale after patient/route/manual-layout changes; search again for the new context.
- Changes combines automatic and manual edits, costs, installation fields, selected-object actions, per-change undo, and restore inventory.
- Original/Proposed is the existing visual morph, not a rollback of simulation state. Comparison captions explicitly say results describe the proposed endpoint. This inherited morph is not a separate original-world simulation for every procedural renovation.
- Report and family fix card remain under the workspace menu. Scan setup and marking tools are under Advanced; keyboard help remains available.

## Backend handoff

`FrontendAdapter` and `FrontendSnapshot` in `frontend.ts` are the integration boundary. The current adapter reads existing worker results and `reim.changes()` and invokes existing actions. The optimizer, cost model, insurance classification, physics, and measured-geometry pipeline are unchanged.

`Installation` in `frontend-model.ts` defines the future optional metadata: setup-time range, helpers, professional requirement, tools, power, maintenance, disruption, and verification status. These fields are a schema seam; there is no new installation-estimation service. Missing fields display Pending/Verify instead of invented estimates. Connect validated backend installation metadata here when it lands.

Costs with `source: 'placeholder'` are excluded from known totals. Their example values can be inspected in the breakdown and retain the placeholder label. The known subtotal, unpriced-item count, and pending labor/helper fields avoid presenting missing data as zero. A future non-placeholder cost source feeds the existing cost interface. Funding is displayed as a classification requiring eligibility verification, not a coverage promise.

Lighting cards are general design concepts, separate from the optimizer and scene recommendations. They cannot be applied to a room or counted as evaluated improvements. No lux values or claims of improved real vision are inferred from rendering. Actual placement, costs, illumination, installation, and power need backend/site verification.

## Verification

Run from `viewer/`:

```text
npm test
npm run build
node e2e/frontend.ts http://127.0.0.1:5180
node e2e/frontend-xr.ts http://127.0.0.1:5180
node e2e/run.ts http://127.0.0.1:5180
node e2e/xr.ts http://127.0.0.1:5180
node e2e/renovations.ts http://127.0.0.1:5180
```

The frontend tests exercise actual synthetic geometry and existing layout actions. VR tests use IWER Quest 2 emulation; physical headset comfort, legibility, and performance still need a headset check. The broad viewer suite additionally requires the scene fixtures and Python clip-generation dependencies described in the repo README.

Verified on this branch: production build; 104 unit tests passed, 17 skipped for unavailable fixtures; all 38 broad viewer checks passed; desktop frontend, spatial-menu, existing XR, and renovation integration suites passed. Desktop/mobile screenshots are in ignored `viewer/e2e/artifacts/`. The existing large-bundle build warning remains.

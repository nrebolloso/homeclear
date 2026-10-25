# VR handoff (2026-10-24)

> Out of date: describes the old `vr-mode` branch. See `VR_LOG.md` for the current VR state (`xr.ts` is the VR code).

Branch: `vr-mode`. Latest commit: `e40be2b` (merge of `origin/main`). It is local only, **not pushed**.

## 1. State of the merge

`origin/main` was merged into `vr-mode`; 10 files conflicted and are resolved. `tsc --noEmit` is clean and the 61 unit tests pass. Both were run in a scratch copy, because `npm ci` in `viewer/` hit a locked file (probably the dev server on :5173/:5179).

### How the files were resolved
| Area | Resolution |
|---|---|
| `viewer/src/main.ts` | Kept vr-mode's WebXR path (SparkXr button, `xrStep`, hands, teleport, IWER `?emulate=quest2`). Dropped main's older `?xr=1` `setupXR` path, `xrFrame`, `game.xr()` and the `xr.place` branches. Kept main's `tourStep`, live physics (`live?.frame`), `routes[selRoute]`, and all the new imports. The loop is `renderer.setAnimationLoop(frame)` always. |
| `viewer/src/xr.ts` | Still in the repo, now **unused**. Delete it or keep it. |
| `viewer/e2e/*.ts`, `scripts/cmpshots.mjs` | Took main's `executablePath: CHROME` (`e2e/env.ts`), with vr-mode's `--use-angle=metal` on macOS. Added a macOS Chrome path to `env.ts`. |
| `viewer/e2e/run.ts` | Removed the obsolete `?xr=1 loads (#vrbutton)` check. `npm run e2e:xr` covers VR now. |
| `viewer/vite.config.ts` | No git conflict, but the merge produced two `server:` keys, so the second silently dropped `port: 5179, strictPort`. Combined into one. |
| `package-lock.json` | Regenerated from the merged `package.json` (both `iwer` and `qrcode`/rapier). |
| `.gitignore`, `README.md` | Kept both sides. The README's `?xr=1` sentence now says the Enter VR button is always there. |

### Not yet verified
- `npm run e2e` and `npm run e2e:xr` (browser suites) have not been run on the merged tree.
- Nothing has been tried in a real headset or with `quest:sweep`. In particular, check that live object physics and `tourStep` behave when presenting. In XR, `step()` skips `tourStep`; `live?.frame` still runs.
- `e2e/xr.ts` and `e2e/quest-sweep.ts` came only from vr-mode and may still launch Chrome with `channel: 'chrome'` instead of `env.ts`.
- `npm run build` calls `tsc`, but `typescript` is not in `package.json` (this was already true before the merge). Add it as a devDependency or change the script.
- The merged `main.ts` is about 1,440 lines. It now carries both the VR code and the new panels, so consider splitting VR out.

### Next steps
1. Free the lock on `viewer/node_modules` (stop the dev server) and run `npm ci`, `npm test`, `npm run e2e`, `npm run e2e:xr` in the real tree.
2. Push `vr-mode` (nobody has said yes to the push yet) and open or update the PR.
3. Test in the headset (`npm run dev:quest`; Windows Link: `VR_WINDOWS.md`).

## 2. UI redesign: discussion and proposal (no code written)

Goal: replace the two dense text sidebars with panels that work on desktop **and** in VR, with simpler text. Direction agreed so far is only "suggestions, no code changes".

### What is wrong now (from the screenshot)
- Two sidebars cover about 35% of the view.
- Authoring tools (Mark stairs, Mark doorway, Copy as config YAML, Cosmos prompt) sit next to the viewer controls.
- Jargon is heavy: "Toe contacts per month", "cost tags: picked only", "replanned in 113 ms (worker 80 ms)".
- Checkboxes, scrolling lists and tiny text don't work with a controller ray.

### Proposed model: one lens plus layers
**Lens (pick one)** sets the panel content and the scene tint:

| Lens | Shows | Panel |
|---|---|---|
| Walk | Clean original, nothing overlaid | Nearly empty: lens dock plus a "?" |
| Hazards | In-world hazard pins | One headline risk, the top 3 hazards, each with a "Fix" button |
| Cost | Cost tags and the receipt | Total, itemised fixes, before/after risk bar |
| Confidence | Captured areas normal; estimated areas desaturated, hatched or tinted | Legend and "% captured vs estimated" |
| Compare | Original vs reimagined, split or slider | The existing reimagine slider |

**Layers (toggle any)**: Route, Ghosts, Night, Imagined floor/ceiling. The Confidence lens could replace the current "Imagined floor/ceiling" checkboxes.

### Panel design
- **Desktop:** a bottom dock (lens icons with labels on the left, layer chips on the right, headline stat at the far end) plus one contextual drawer from a single side. Authoring tools move to a separate **Author / OT** mode that viewers never see.
- **VR:** a wrist or palm menu with 4–5 large lens buttons, plus a world-space card that follows lazily. No scrolling; paged cards with at most 3 items. Put critical information in the world (hazard pins, cost tag on the object, path colour), and keep the card out of the walking line and off the floor.
- **Look:** dark glass, one accent colour, one meaning per colour (green safe / amber check / red fix) in every lens, a big headline number with explanation behind an "i".

### Copy simplification
- "Toe contacts per month 0.0" becomes **Stub risk: Low**, number secondary.
- "tight passage: 9 cm each side over 0.13 m · OT should check" becomes **Tight gap, 9 cm each side** plus a pin.
- Move "500 simulated trips…" into a details popover.
- Hide timing stats ("replanned in 113 ms") unless a debug flag is on.
- "Who / Route / Eyes" becomes one **Profile** chip (patient, vision mode).

### Home screen
Recommended: a minimal home that slowly orbits the loaded scene, with the title, a one-line summary, a "Start walk" button, and an honest note ("Built from a phone video of this home"). The scene is already loaded, so this is cheap.

### Room swapping
Not as a game mechanic. If built, make it a "Rooms" chip in the dock plus an optional mini floor-plan. The real use case is the bedroom → bathroom route at night. Leave a slot for it now and build it later.

### Open question (needed before building)
Who is the primary person on screen: the **OT or clinician** (planning and costing fixes) or the **patient and family** (understanding their own home)? That choice sets the default mode, and it decides whether Cost or Hazards is the first lens. The other audience gets a switch.

## 3. Repo rules (from AGENTS.md) that affect this work
- **In-headset UI must be scene objects** (sprites, meshes), never DOM or `CSS2DObject`, which don't render in WebXR. The VR panels in section 2 must follow this, so the desktop dock (DOM) and the VR card (3D objects) will be two renderers of one shared lens/layer state.
- **VR ownership:** `viewer/src/xr.ts` belongs to the VR team (owner TBD). This merge stopped `main.ts` from using it, in favour of the vr-mode path. Tell the VR owner before deleting the file.
- **Reimagine in the headset** goes through `window.game.reimagine` (`setT`, `play`, `run`, `refresh`, `changes`); don't reach into `reimagine.ts`. The Compare lens should bind to this.
- **`main.ts` is a shared hot file:** new UI goes in its own module with a short hook block in `main.ts`. Append to `index.html` panels and `e2e/run.ts` checks, don't reorder.
- **Before merging a PR:** `cd viewer && npm test && npm run build`, then `npm run dev` and `node e2e/run.ts`. `npm run build` currently can't pass (no `typescript` dependency; see above), so fix that first.
- Teammates' PRs must not contain HiPerGator details, credentials or AI attribution in code. The merge commit `e40be2b` carries a `Co-Authored-By` trailer from the session's default; amend it if the team doesn't want that.

## 4. Process notes
- This is architectural work, so the brainstorming flow applies: approaches, then a design for approval, then a written spec, then a plan. Nothing in section 2 has been approved yet.
- Per the repo's notes, Juan's lane is `reimagine.ts` and the `movecost.ts` seam; check `AGENTS.md` before touching other owners' panels.

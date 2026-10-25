# Scan library and VR companion implementation

Branch: `feat/scan-library-vr-companion`. The original checkout remains on its branch.

1. Catalog real rooms, versions and samples from available exports. Put the picker beside the top-left room control.
2. Give each scene a disposable lifetime, keep one renderer/XR session, preserve per-scan layouts and viewpoints, recover from failed loading.
3. Unify the spatial menu: scans, experience, findings, changes, layers and comfort. Provide named vision profiles and per-eye effects with readable controls.
4. Add desktop companion, headset perspective and optional goggles presentation. Keep desktop camera movement independent from the wearer.
5. Route shared edits through object ownership and common history; prepare broad layout changes before applying them. Add bookmarks and review flags.
6. Validate scene transitions, headset filters, desktop camera independence, resource cleanup and existing regressions. Record hardware-only validation separately.

Commit after each implementation stage. Measurements remain separate from visual effects, generated fills and review notes. Unknown costs remain pending.

## Running this branch

The working checkout is `../homeclear-scan-companion-wt`, on `feat/scan-library-vr-companion`. The original checkout stays on `juan/vr`.

From `viewer/`:

```powershell
npm run scans:import
npm run dev -- --port 5183
```

The import command looks for `../../scenes_bundle` by default, or accepts an explicit bundle folder. It preserves original exported bytes, uses versioned directory names, and never overwrites an existing scan. Scene assets remain ignored by Git. This worktree reuses the original 19 exports through individual directory junctions and has its own copies of the eight additional bundles. Import those bundles again when using this branch in a different checkout.

The picker is immediately beside the top-left room control. Real rooms have a main card, floor-map preview, and expandable versions; samples are labeled separately. The catalog is generated from the files actually available, including in production builds. There are 27 exports installed here, grouped into Kitchen, Bedroom & Bathroom, Bedroom 2, Bedroom 3, Gator Lounge, Century Tower, Newell Stairs, Night Room, and samples.

Room switches preserve the page, renderer and XR session. Working layouts and positions are retained per scan during this visit; annotations and saved viewpoints also use scan-specific browser storage. Experience/display choices persist across switches. Restart demo resets the selected room's working layout. Missing essential assets leave the current room available. Loading is shown in the headset as well as on the desktop.

## Headset and desktop controls

Click the left stick to open the spatial workspace on the left hand (the right hand points at it): one panel, fixed to the left controller like the Google Earth VR menu, with World, Vision, Device, Tour and More tabs and a Fly switch on the right (the right stick then flies where the right hand points). More holds navigation, Findings, Changes, Changes & cost, Comfort and Saved viewpoints. Longer lists have Previous/Next controls. Vision profiles are named choices. The room is filtered separately for each eye; spatial controls and notifications render afterward for readability. Illustrative filters do not change measurements or simulation inputs.

During VR the desktop defaults to an independent orbit camera. Choose Headset perspective, Workspace + headset preview, or Goggles presentation in the companion panel. Desktop inspection does not relocate the wearer. Desktop vision and overlays can be local; the original room-experience controls remain shared. The companion output is rendered to a separate target/canvas, capped at 20 updates/s and 1280 pixels wide so the XR compositor cannot overwrite it. The headset render loop retains its own cadence.

Edit shared room offers numeric object movement, removal, undo/redo, and separate Prepare layouts / Apply selected layout actions. Shared object ownership rejects simultaneous edits of a held object. Undo/redo uses the same history for desktop and VR. Selected layouts record a history entry. Findings can be flagged for measurement from the VR Findings page; flags use the existing review store. Costs retain pending/placeholder labels.

## Separate-device sessions

For a standalone headset and laptop, open Scans → Connect another device. Use the same session name, choose Host on the headset and Companion on the laptop, and connect. The local Vite dev/preview server relays session messages. The host owns layout changes and calculations; the companion submits commands with the expected layout identity. Stale edits are rejected. The laptop renders its own room view and receives both head position and orientation.

For USB Quest development on this port, use `adb reverse tcp:5183 tcp:5183` and open `http://localhost:5183` in both browsers. LAN hosting needs the appropriate host binding and a secure context for headset WebXR. This is a local demo relay, not a deployed collaboration service. Static hosting supports the scan library and same-PC companion but needs a server adapter for separate-device sessions.

On a connected laptop, use the companion controls for shared edits. Annotation creation remains on the host/headset; completed host annotations synchronize with room state. Disconnect restores local editing methods.

## Verification

- 221 Node unit tests pass, including scan identity/grouping, stored viewpoints and edit ownership.
- Two Python importer tests pass: original bytes preserved, path traversal rejected before publishing a scene definition.
- TypeScript and the production build pass. The existing large-chunk warning remains.
- Desktop, frontend XR, layers/review, XR locomotion/editing, renovation marking, and core viewer regression scripts pass.
- Scan-library integration covers failed-load recovery, per-scan working state, one frontend after repeated switches, retained XR session, independent desktop inspection, split view, per-eye rendering, shared edits, undo and bookmarks.
- Separate-device integration covers authoritative edits, undo, scan changes, patient selection, full head pose and disconnect.

Hardware acceptance remains: physical Quest text readability, comfort, actual per-eye appearance, and frame budget with large scans, filters and spectator output. Browser/IWER checks do not establish headset performance or clinical fidelity.

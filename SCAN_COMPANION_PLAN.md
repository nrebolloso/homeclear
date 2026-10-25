# Scan library and VR companion implementation

Branch: `feat/scan-library-vr-companion`. The original checkout remains on its branch.

1. Catalog real rooms, versions and samples from available exports. Put the picker beside the top-left room control.
2. Give each scene a disposable lifetime, keep one renderer/XR session, preserve per-scan layouts and viewpoints, recover from failed loading.
3. Unify the spatial menu: scans, experience, findings, changes, layers and comfort. Provide named vision profiles and per-eye effects with readable controls.
4. Add desktop companion, headset perspective and optional goggles presentation. Keep desktop camera movement independent from the wearer.
5. Route shared edits through object ownership and common history; prepare broad layout changes before applying them. Add bookmarks and review flags.
6. Validate scene transitions, headset filters, desktop camera independence, resource cleanup and existing regressions. Record hardware-only validation separately.

Commit after each implementation stage. Measurements remain separate from visual effects, generated fills and review notes. Unknown costs remain pending.

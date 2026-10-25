# VR from a Windows PC (SteamVR, or Quest Link / Air Link)

**The team is using SteamVR (Steam Link)** because Quest Link didn't work for us (2026-10-25): see section 2B. The Link
steps are kept below in case it works on another PC.

The Quest 2 can't render the full kitchen on its own: it runs at 7 fps in VR with all 981K splats, and only a thinned
120–150K copy reaches 72 fps (`tools/thin_scene.py`). With Link, a Windows PC renders the full scene on its own
graphics card and streams it to the headset. The viewer needs no code changes: Chrome on Windows sends WebXR to whichever **OpenXR runtime** is active
(SteamVR or Link), and that runtime streams to the headset.

macOS can't do this: Quest Link, Air Link, SteamVR, Virtual Desktop and ALVR have no macOS version for the PC side.

## What you need

- Windows 10/11 PC with an **NVIDIA or AMD graphics card** that Meta lists for Link (search "Meta Quest Link
  compatibility requirements"). Intel integrated graphics won't work.
- Quest 2 on the same Meta account as the Link app.
- **Cable Link:** a USB-C cable into a USB 3 port on the PC (more reliable at a hackathon).
  **Air Link (wireless):** PC and Quest on the same network, ideally 5 GHz. **eduroam and UF Guest usually block devices
  from seeing each other, so use a phone hotspot or a travel router.**
- Git, Node 22 or later (`node -v`), Google Chrome.

### Gaming laptops (e.g. RTX 4070 Laptop)

Laptops switch between the CPU's built-in graphics and the NVIDIA chip (Optimus). Chrome has to run on the NVIDIA one,
or VR is slow or Chrome can't find the headset:

1. **Plug the laptop into power.** On battery the GPU is throttled.
2. **Windows Settings → System → Display → Graphics:** add **Google Chrome** and the Link service
   (`C:\Program Files\Oculus\Support\oculus-runtime\OVRServer_x64.exe`) and set both to **High performance** (the NVIDIA
   GPU). Or in the **NVIDIA Control Panel → Manage 3D settings → Program settings**, pick the NVIDIA processor for both.
3. If the laptop has a **MUX switch / "dGPU only" mode** (in the NVIDIA app, Armoury Crate, Vantage, etc.), turning it
   on is the most reliable fix. It needs a restart.
4. Check in Chrome: open `chrome://gpu` and look for the NVIDIA card under **GL_RENDERER**.

## 1. Code and scene

```powershell
git clone https://github.com/nrebolloso/homeclear
cd homeclear
git switch main
cd viewer
npm ci
```

Scene data isn't in git (`viewer/public/scene/` is ignored). Unzip `kitchen4_lighter.zip` (ask the team for it) so you
get `viewer/public/scene/kitchen4_lighter/scene.json`, **not** `kitchen4_lighter/kitchen4_lighter/scene.json`.
Optional synthetic test scene: `python tests/make_game_scene.py` (needs the Python setup in the README).

## 2. Meta Quest Link app (one time)

1. Install **Meta Quest Link** from meta.com and sign in.
2. **Settings → General → OpenXR Runtime → set Meta Quest Link as active.** Without this, Chrome says "VR not supported".
3. **Settings → General → Unknown sources → on** (lets non-Store apps like Chrome use the headset).
4. For hand tracking over Link: **Settings → Beta → Developer runtime features → on**. Controllers work without it.
5. **Devices → your Quest 2 → Graphics preferences:** start with **72 Hz** and the default render resolution. Raise
   either once it runs smoothly.

## 2B. SteamVR with Steam Link (instead of section 2)

1. On the PC: install **Steam**, then **SteamVR** (in the Steam library, under Tools).
2. In the headset: install **Steam Link** from the Meta Horizon Store. It's wireless: PC and Quest on the **same network,
   5 GHz**. eduroam and guest Wi-Fi usually block it (phone hotspot or travel router, or the PC on Ethernet to the router).
3. Open Steam Link in the headset, pick the PC and accept the pairing code on the PC. SteamVR starts by itself.
4. **Make SteamVR the OpenXR runtime:** SteamVR window → **Settings → OpenXR** (older versions: **Developer**) →
   **Set SteamVR as OpenXR Runtime**. If the Meta Quest Link app is installed it may still hold the runtime; this takes
   it back. Without it, Chrome says "VR not supported" or tries Link. Restart Chrome after changing it.
5. **Gaming laptops:** besides Chrome, set SteamVR's `vrserver.exe` and `vrcompositor.exe`
   (`...\Steam\steamapps\common\SteamVR\bin\win64\`) to **High performance** (section "Gaming laptops", step 2).
6. Refresh rate and resolution come from **Steam Link's settings** (in the headset) and **SteamVR → Settings → Video**.
   Start at **72 Hz** and the default resolution; `?hz=` is ignored on a PC.
7. **Check the floor once:** SteamVR keeps its own floor height. Open the viewer with `&measure=1` and rest a controller
   on the real floor: the card should read about 0 in. If the virtual floor is off from the real one, use `&floor=`
   (cm, e.g. `&floor=-3`); see `VR_LOG.md` section 4.5. The room boundary is the Quest's own (the viewer asks for
   `bounded-floor`).
8. Use **controllers** (hand tracking through SteamVR into Chrome is not tested). The buttons follow WebXR's standard
   mapping, the same as on the Quest browser, but nobody has pressed them through SteamVR yet: check trigger, grip,
   A/B, X/Y and both sticks the first time.

Then skip section 3 (it is Link's) and go to section 4. Other wireless options that also act as the OpenXR runtime:
Virtual Desktop (paid, usually the smoothest) and ALVR (free).

## 3. Connect (Link only)

- **Cable:** plug in, put the headset on, accept **Enable Link**.
- **Air Link:** in the headset open **Quick Settings → Quest Link**, turn on **Use Air Link** and pick the PC.

You should now be in the grey Link space with a floating menu.

## 4. Run the viewer

```powershell
cd viewer
npm run dev
```

If Windows Firewall asks about Node, allow it on **private** networks. On the PC, open Chrome at:

```
http://localhost:5179/?scene=kitchen4_lighter&stddev=2.83&maxpx=512
```

`stddev=2.83&maxpx=512` turns off the splat trim the Quest needs on its own (Spark's defaults: full-quality splats).
Click **ENTER VR** on the PC with the mouse, then put the headset on. Over Link the refresh rate comes from step 2.5, so
`?hz=` is ignored.

## 5. In VR

- **Walk for real:** 1:1, the floor is your floor.
- **Right hand or controller = wand:** point at furniture, hold pinch/trigger and move to drag it (twist your wrist to
  turn it 90°); **hold still for 1.5 s to delete** it (the outline goes yellow then red; let go to cancel). Point at the
  floor and release to **teleport** (green ring, only on scanned floor). `&wand=left` swaps hands.
- **Left hand pinch / trigger:** walk forward where you look. **Left stick:** walk. **Right stick:** snap-turn.
- Labels (bump heights etc.) only show on the flat view for now.

## 6. Report back

The PC monitor's top bar shows fps. In Chrome DevTools (F12) on the PC tab:

```js
game.fps                       // frames per second
game.xrPose()                  // where you are; inputs: hands or controllers
```

Please send: **GPU model, cable or Air Link, refresh rate, fps in the middle of the kitchen with the full scene**, and
whether it felt smooth.

## Troubleshooting

| Symptom | Fix |
|---|---|
| ENTER VR says "VR not supported" | Step 2.2 (OpenXR runtime), or 2B.4 for SteamVR, then restart Chrome |
| SteamVR: Chrome opens VR in Link / nothing happens in the headset | Another runtime is active: 2B.4, restart Chrome |
| SteamVR: everything is a bit too high or low | SteamVR's floor height: 2B.7 (`&measure=1`, then `&floor=`) |
| Page won't load | `npm run dev` must be running; the URL is `localhost:5179` on the PC itself |
| Air Link can't find the PC | Network blocks devices (eduroam/guest Wi-Fi): use a hotspot, or a cable |
| Stutter over Air Link | 5 GHz, router near you; or lower Link's bitrate / use a cable |
| No hands, only controllers | Step 2.4, then reconnect Link |
| Starts outside the room | The route starts at the scan's edge; teleport inside (the viewer tries to start you on scanned floor) |

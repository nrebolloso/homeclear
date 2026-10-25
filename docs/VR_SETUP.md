# VR setup: Quest 2 on Juan's laptop

Quest 2 (serial `1WMHHB61WQ2305`) with Juan's laptop (RTX 4070 + AMD 780M). Last verified working Oct 25, 2026.

**Route that works: Quest Browser over USB.** The headset renders the page itself and loads it from the laptop through `adb reverse`. It needs the thinned 150K-splat scene (`kitchen4_vr150`), about 45-71 fps in VR. It does not use SteamVR, Steam Link or Meta Link.

For the full 981K-splat scene the laptop has to render and stream. That route (SteamVR over Steam Link) is documented at the bottom, but it did **not** connect on this laptop on Oct 25. See [Steam Link status](#steam-link-not-working-yet).

## Steps that work

1. **Thinned scene exists.** `homeclear/viewer/public/scene/kitchen4_vr150/` (git-ignored). If missing, from `homeclear`:
   ```
   .venv/Scripts/python.exe tools/thin_scene.py viewer/public/scene/kitchen4_lighter --budget 150000 --out kitchen4_vr150
   ```
2. **Start a second Vite server on port 5180.** This is separate from the normal `npm run dev` server on `:5179`. The `:5179` server listens on IPv6 only (`::1`), and `adb reverse` forwards the headset's `localhost` to the laptop's IPv4 loopback, so it cannot reach `:5179`. In `homeclear/viewer`:
   ```
   npx vite --host 127.0.0.1 --port 5180
   ```
   Leave it running. Both servers can run at the same time.
3. **Plug the headset into the laptop** with the USB-C cable, directly into a laptop USB port (no hub). Put the headset on and accept **Allow USB debugging** (tick Always allow).
4. **Check adb sees it.** `adb` is not on the PATH, so use the full path, or set an alias for the terminal window:
   ```
   Set-Alias adb "C:\Users\juanc\Local_Dev\android-platform-tools\platform-tools\adb.exe"
   adb devices
   ```
   It must say `device`. `unauthorized` means the prompt in the headset has not been accepted yet (see Troubleshooting).
5. **Forward the port:**
   ```
   adb reverse tcp:5180 tcp:5180
   adb reverse --list
   ```
   The list should show `tcp:5180 tcp:5180`. This mapping is lost whenever USB reconnects or adb restarts, so re-run it after any drop.
6. **Open the page in the Quest Browser,** wearing the headset:
   ```
   localhost:5180/?scene=kitchen4_vr150&mount=left
   ```
   Use `localhost`, not the laptop's IP. WebXR only works on `localhost` or HTTPS, and the 5180 server listens on the laptop's loopback only. `mount=left` is the default VR view: see [URL flags](#url-flags). Pick a different scene with the table in [Scenes](#scenes).
7. **Wait for the splat to load, then press ENTER VR** at the bottom of the page (point with the controller, press the trigger).

## URL flags

Add flags to the address with `&`. The page address is `localhost:5180/?scene=<scene>&<flag>&<flag>`.

| Flag | Effect |
|---|---|
| `scene=<name>` | Which scan to load (see [Scenes](#scenes)). Defaults to `kitchen4_lighter`, which is too heavy for the headset on its own. |
| `mount=left` | **Default VR view.** The left controller is fixed on the walker (strap or cup holder, see `VR_WALKER_MOUNT.md`) and drives it: stick up/down walks along the walker's heading, left/right snap-turns 30 degrees, and the virtual walker points where the real one does. The trigger is ignored. On entering VR, stand centred behind the walker facing its way; the "Line up the walker" button retakes the line-up. A tracked hand does not count as mounted. |
| `mount=right` | Same, with the right controller on the walker. |
| `wand=left` | The wand (point, drag furniture, teleport) moves to the left hand. The wand defaults to the right. |
| `floor=<cm>` | Lifts or lowers the virtual floor, for example `floor=-3`. Check with `measure=1`. |
| `measure=1` | Shows the floor-height card: rest a controller on the real floor and it should read about 0 in. |
| `scale=<n>` | World scale (default 1). |

Example: `localhost:5180/?scene=turlington_vr150&mount=left&wand=right`.

Source: `viewer/src/xr.ts` (`params.get(...)` for `mount`, `wand`, `floor`, `scale`) and `main.ts` for `scene`. The `measure` flag is documented in `VR_WINDOWS.md`/`VR_LOG.md`; `hz=` only matters in the Quest Browser (it sets the target refresh rate).

## Scenes

Folders in `homeclear/viewer/public/scene/` (git-ignored). The headset renders the page itself, so use a **thinned `_vr150` copy** (150,000 splats) for any big scene. The full scenes are for the PC.

| Scene (`scene=`) | What | Splats | In the headset |
|---|---|---|---|
| `kitchen4_vr150` | Kitchen, thinned | 150K of 1,002,459 | Yes, 45-71 fps |
| `turlington_vr150` | Turlington, thinned | 150K of 1,632,152 | Yes (same budget; not yet timed) |
| `kitchen4_lighter` | Kitchen, full | about 1.0M | PC only |
| `turlington_lighter` | Turlington, full | 1,632,152 | PC only |
| `aleroom_lighter`, `aleroom2_lighter` | Ale's room | not checked | thin first |
| `century_tower_lighter` | Century Tower | not checked | thin first |
| `newell_lounge1_lighter`, `newell_stair_lighter` | Newell lounge and stair | not checked | thin first |
| `nicoroom1_lighter` | Nico's room | not checked | thin first |
| `game_synth`, `game_synth_narrow` | Synthetic test scenes | not checked | check size first |

**To make a thinned copy of any scene** (from `homeclear`, takes a minute; the output folder name is what goes in `scene=`):
```
.venv/Scripts/python.exe tools/thin_scene.py viewer/public/scene/<scene>_lighter --budget 150000 --out <scene>_vr150
```
For example `... turlington_lighter ... --out turlington_vr150`. 150K is the limit from the Quest 2 measurements: 200K and 250K were too heavy.

Remember: the thinned folders are git-ignored and can disappear. `kitchen4_vr150` was missing on Oct 25 and had to be regenerated with the command above.

### Skipping the typing

- **Bookmark it.** Load the page once and use the browser's star/Add bookmark.
- **Open it from the laptop** (ask first whether someone is wearing the headset):
  ```
  adb shell am start -a android.intent.action.VIEW -d "http://localhost:5180/?scene=kitchen4_vr150&mount=left" com.oculus.browser
  ```
  In PowerShell the `&` is inside the quotes, so it is passed through. Swap in another scene name from [Scenes](#scenes).
  This was not verified on the headset; the bookmark is the tested way.

### Optional: fps readout from the laptop

```
adb forward tcp:9223 localabstract:chrome_devtools_remote
```
Then connect playwright-core with `connectOverCDP('http://127.0.0.1:9223')` and read `game.fps` and `game.xrPose()`.

## Every session: the exact commands, in order

Use two PowerShell windows. Window A runs the server and stays open. Window B runs adb.

**Window A: the server** (the order against Window B does not matter, but it must be running before the page loads):
```
cd "C:\Users\juanc\Local_Dev\GatorHacks 2026\homeclear\viewer"
npx vite --host 127.0.0.1 --port 5180
```

**Window B: the headset link:**
```
Set-Alias adb "C:\Users\juanc\Local_Dev\android-platform-tools\platform-tools\adb.exe"
adb devices
adb reverse tcp:5180 tcp:5180
adb reverse --list
```
- Copy the `Set-Alias` line exactly, with the whole path (never shorten it with `...`). Or skip the alias and run every command as `& "C:\Users\juanc\Local_Dev\android-platform-tools\platform-tools\adb.exe" devices`.
- `adb devices` must show `device` (not `unauthorized`, not empty). `no devices/emulators found` means the USB link is down: check the cable and try again. Put the headset on and accept the prompt if needed.
- `adb reverse --list` must show `UsbFfs tcp:5180 tcp:5180`. If it prints nothing, run `adb reverse tcp:5180 tcp:5180` again.

**In the headset (Quest Browser):** open `localhost:5180/?scene=kitchen4_vr150&mount=left`, wait for the splat to load, press **ENTER VR**. Or have adb open it (someone must be wearing the headset):
```
adb shell am start -a android.intent.action.VIEW -d "http://localhost:5180/?scene=kitchen4_vr150&mount=left" com.oculus.browser
```

**On the laptop (optional, to look at the same viewer):** open `http://127.0.0.1:5180/?scene=kitchen4_vr150` in Chrome. It loads, but there is no ENTER VR button on the PC; VR is entered in the headset.

The server (Window A) and the port forward (Window B) are separate. Running `npx vite` does not set up the forward, and `adb reverse` does not start the server. You need both for the headset.

## When you have to redo something

| Thing | Lasts until | Redo it when |
|---|---|---|
| `npx vite ... --port 5180` (Window A) | You close the window or press Ctrl+C, or reboot the laptop | The window was closed, or the page stops loading and nothing listens on 5180 (`Get-NetTCPConnection -State Listen -LocalPort 5180`) |
| `adb reverse tcp:5180 tcp:5180` | Not long: it is lost when USB reconnects (cable replugged or glitch), when adb restarts (`adb kill-server`), and likely when the headset reboots. It also vanished after the headset slept (not proven to be the cause). | **Any time the page stops loading in the headset.** Check `adb reverse --list`; if empty, run it again. It is safe to run it every time before opening the page. |
| USB debugging approval (the "Allow" prompt) | Kept when you tick "Always allow" | `adb devices` shows `unauthorized` again (new adb key, revoked authorizations, or a first connection after the daemon starts) |
| `Set-Alias adb ...` | That PowerShell window only | You open a new window (or use the full path instead) |
| `kitchen4_vr150` scene folder | Stays on disk (git-ignored) | The folder is missing (fresh clone, or `viewer/public/scene/` was regenerated) |
| Quest Browser bookmark | Stays in the headset | Never, unless the headset is reset |
| Proximity override (`prox_close`) | Until the headset reboots or you run `automation_disable` | The headset keeps sleeping on you (see Notes) |

**Rule of thumb:** if the page won't load, run `adb devices` then `adb reverse --list` first. That fixes it most of the time. Only restart the server if nothing is listening on 5180.

## Troubleshooting (all hit on Oct 25)

| Symptom | Cause and fix |
|---|---|
| `adb : The term 'adb' is not recognized` | adb is not on the PATH. Use the full path or the `Set-Alias` line in step 4. |
| `adb devices` says `unauthorized`; `adb reverse` says "device unauthorized" | Put the headset on and accept "Allow USB debugging". If no prompt: replug the cable, or `adb kill-server` then `adb devices`. A freshly started adb daemon always needs this once. |
| Quest Browser loads the wrong page, or an error | `adb reverse --list` is empty, so the headset's `localhost:5180` goes nowhere. Re-run step 5. |
| Page worked, then stopped loading | USB glitch. The log showed `USB_STATE=DISCONNECTED -> CONNECTED` within half a second, which wipes `adb reverse`. Re-run step 5. Use a direct USB 3 port, a firmly seated cable, and plug the laptop into power. |
| Everything went black / the session ended | The headset's proximity sensor stopped seeing a face (`PROX_OFF -> HEADSET_UNMOUNTED`), so the headset slept and the browser went to the background, ending the WebXR session. See the proximity override under Notes. |
| Viewer page is blank grey with a "Scans" dropdown showing a URL | The whole URL was pasted into `scene=`. The address must be one `?scene=kitchen4_lighter...` (or `kitchen4_vr150`), not `?scene=http://...?scene=...`. |
| No ENTER VR button on Chrome on the PC | By design: the button is hidden until `navigator.xr.isSessionSupported('immersive-vr')` is true. Chrome on the PC only has that with SteamVR or Link connected to the headset. The Quest Browser does not need either. |
| `localhost:5179` fails | Nothing was listening on 5179 (the `npm run dev` server was not running). The 5180 server serves the same viewer. |

## Performance reference

| Setup | Result |
|---|---|
| Quest 2 standalone, 150K splats | About 45-71 fps; v1.0.3 `kitchen4_vr150`, 56-stop sweep: 72 Hz 37/56 at full rate (min 46.8, median 71.5), 90 Hz 19/56 (min 44.8, median 82.7) |
| Quest 2 standalone, 200K / 250K | Too heavy |
| Quest 2 standalone, full 981K | About 7 fps, needs the PC route |
| Laptop GPU (RTX 4070), 150K to full 981K | 76 fps down to 60 fps; the 72 Hz median holds to about 400K; 90 Hz never |

## Notes

- **Ask first.** From Diego's `VR_LOG.md` (branch `origin/diego/vr`, the VR lane's source of truth): ask whether someone is wearing the headset before any remote action (teleport, reload, entering VR, `adb shell am start`).
- **Proximity override** (a device setting, so the user runs it): `adb shell am broadcast -a com.oculus.vrpowermanager.prox_close` keeps the headset "worn"; undo with `adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable`. On Oct 25 `stay_on_while_plugged_in=7` was set but the proximity override was not forcing the sensor (`mProximityPositive=false`).
- The headset was still showing the Guardian boundary setup (`GuardianSetupFlow`) when it slept. Finish the boundary setup so it stops interrupting.
- Meta installs to `C:\Program Files\Meta Horizon\`, not `Oculus`.
- The button hides itself, and Spark prints nothing, when WebXR is unavailable. Check with `navigator.xr.isSessionSupported('immersive-vr').then(console.log)` in the DevTools Console (F12).

## Steam Link: not working yet

SteamVR over Steam Link would let the laptop render the full scene (`VR_WINDOWS.md` section 2B has the steps). On Oct 25 it did not connect here. What was found:

- SteamVR logged `Hmd Not Found (108)` on every start (22:20 Oct 24 through 03:11 Oct 25): it never had a headset attached.
- The headset found the PC, but Steam Link said it could only connect on the local network. Pinging the headset (`172.21.1.57`) from the PC got no replies and no ARP entry on the CourtYards Wi-Fi, which points to client isolation. The Wi-Fi was also set to Public (set it to Private).
- The laptop and headset were then moved to an iPhone hotspot, which came up on **2.4 GHz** (channel 6). For Steam Link switch the hotspot to 5 GHz: iPhone, Settings, Personal Hotspot, turn **off** "Maximize Compatibility", then reconnect both devices.
- With the headset plugged in over USB, SteamVR's `vrlink` driver failed to bind sockets on the headset's USB network adapter (`169.254.x.x`, "UsbNcm Host Device"), probably in conflict with the running Meta runtime (`OVRServer_x64`, started by `OVRService`). Unplug the USB cable for Steam Link. Stopping `OVRService` needs an admin prompt (`services.msc`).
- OpenXR runtime was correctly set to SteamVR (`...\SteamVR\steamxr_win64.json`). Firewall rules for Steam and SteamVR were fine.
- Steps not yet tried together: hotspot on 5 GHz, Wi-Fi Private, USB unplugged, Meta service stopped, SteamVR started from Steam Link in the headset.

If Steam Link is retried, use the full-quality page at `http://localhost:5179/?scene=kitchen4_lighter&stddev=2.83&maxpx=512` in Chrome on the PC (run `npm run dev` first), click ENTER VR on the PC, and put the headset on. Check the floor with `&measure=1` (and `&floor=` in cm if it is off). Quest Link (Meta) is documented in `VR_WINDOWS.md` and did not work on this laptop; the likely cause is the proximity sensor.

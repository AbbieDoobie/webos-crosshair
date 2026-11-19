# Crosshair (LG webOS TVs)

A crosshair on top of whatever your TV is currently showing. Pick a shape, color, and size, and the crosshair will overlay itself over the picture.

Made for console and PC games that don't have a crosshair of their own (or only show one while aiming). Game Optimizer, VRR, ALLM, and HDR all stay on with it up, and by default it gets out of the way by itself when you go to Home or open an app.

**Needs a rooted LG TV with the Homebrew Channel.** Tested on an OLED C2 running webOS 10.3.1, so other models and versions may work, but I cannot promise anything there!

- [Features](#features)
- [Initial Setup](#initial-setup)
- [Remote Button Setup (LG Input Hook)](#remote-button-setup-lg-input-hook)
- [Options](#options)
- [Technical Stuff and Limitations](#technical-stuff-and-limitations)
- [Building](#building)
- [License](#license)

## Features

| What you do | What happens |
|---|---|
| Open **Crosshair** from the app list | The settings panel opens over the game |
| Change a look setting while the crosshair is on | The real crosshair updates live |
| Select a look setting while the crosshair is off | A preview shows exactly where the real one would go |
| Press your remote button once **(if set up)** | Crosshair turns on or off |
| Press it three times quickly **(if set up)** | Settings panel opens, crosshair stays how it was |
| Go to Home or open an app | Crosshair hides, and comes back when you return to an input **(if enabled)** |
| Turn the TV on | Crosshair comes on by itself **(if auto-start is enabled)** |

- 21 shapes: dots, circles, crosses, T, X, scope, squares, diamonds, corner brackets, a chevron, a triangle, and dot patterns.
- 11 color presets, or any hue you want.
- Separate brightness for HDR, picked automatically (the TV draws app graphics a LOT brighter over HDR).
- Move it anywhere on screen, for games whose aim point isn't dead center.
- Settings are kept through reboots.

## Initial Setup

1. Install `com.abbiedoobie.crosshair_<version>_all.ipk`.
2. Open **Crosshair** from the app list. The first time, it gets root access through the Homebrew Channel by itself (a note shows under the title for a couple of seconds), and sets itself up to start with the TV.
3. Turn it on.

After an update, open Crosshair once (or reboot the TV) so it gets root again; until then it uses the default look. If a warning stays under the title, it couldn't get root: check that the TV is rooted and the Homebrew Channel is installed.

## Remote Button Setup (LG Input Hook)

LG Input Hook (`org.webosbrew.inputhook`, available in the Homebrew Channel) can run a command when a remote button is pressed. Bind any button you like to the crosshair's `button` method for one-press on/off and, if enabled, triple-press to open settings.

1. Open **LG Input Hook** and press the button you want to use. Input Hook shows its key code.
2. Choose **Add keybind** and enter that key code in **ID**.
3. Set **Action** to **Execute**, and paste this into **Command**:

   ```
   luna-send -n 1 luna://com.abbiedoobie.crosshair.service/button '{}'
   ```

4. Choose **Save changes**, then press the button once to check that the crosshair turns on or off.

Notes:

- The command above handles everything: one press turns the crosshair on or off, and three quick presses open the settings **(if enabled)**. If you'd rather have separate buttons, replace `button` in the command with `show`, `hide`, or `toggle`.
- **Pick a button that isn't bound to anything else** in Input Hook.
- Presses count as one gesture while each comes within 600 ms of the one before. The first press toggles right away; a second is held back and undone when the gesture ends (so two presses leave things as they were); a third undoes the first and opens the settings panel. With **Verbose logging** on, each press is logged as `BUTTON button press <n>` (see [Logs](#logs)).

## Options

Up/Down picks a row, Left/Right changes it (hold to speed up on long ranges), OK toggles or runs it, and Back closes the panel. The Magic Remote pointer works too: click a row's arrows, a switch, or the row itself. Rows that don't apply to the current shape (or to an outline that's off) are hidden.

### On / off

**Crosshair** turns it on or off. **Off by default.**

**Auto-start with TV** decides what happens when the TV powers on (a boot, or waking from standby): on if enabled, off if not. **Off by default.**

**Triple press opens settings** makes three quick presses of your remote button open this panel. One press still turns the crosshair on or off. Turn it off to make every press a plain toggle. **On by default.**

**Hide on Home and apps** hides the crosshair while Home or an app is in front, and brings it back when you return to an input (HDMI, live TV, or AV). The picture menus and quick settings over an input keep it up. This doesn't change the on/off setting, it only hides it. **On by default.**

### Shape

**Shape** picks one of the 21 shapes. **Dot by default.**

**Size** is 2 to 96. **8 by default.**

**Thickness** is 1 to 8, for shapes with lines or rings. **2 by default.**

**Gap** is 0 to 32, the empty space in the middle of crosses, Xs, and the like. **3 by default.**

### Color

**Color** picks one of the presets: Green, Lime, Yellow, Orange, Red, Pink, Magenta, Purple, Blue, Cyan, or White. **Green by default.**

**Custom color** sets any hue, in 5-degree steps.

**Brightness** is 10% to 100%, used while the TV shows a normal (SDR) picture. It gives a darker shade of the color that's still fully solid. **100% by default.**

**HDR brightness** is the same thing, used while the TV shows HDR. The TV draws app graphics far brighter over HDR, so this one starts lower. The panel tags whichever brightness is in use right now. **70% by default.**

**Opacity** is 10% to 100%, and lets the game show through the crosshair. **100% by default.**

### Outline

**Outline** draws a border around every part of the crosshair, which helps on busy backgrounds. **Off by default.**

**Outline color** is Black or White. **Black by default.**

**Outline width** is 1 to 3. **1 by default.**

### Position

**Move left / right** is -900 to 900, and **Move up / down** is -500 to 500. Both are **0 (center) by default.**

**Center it** puts it back in the middle.

### Logging

**Verbose logging** makes the service log everything it does: button presses, turning on and off, launching and closing the app, the panel, power states, and HDR changes. Without it, only startup, shutdown, warnings, and errors are logged. Turn it on when you're tracking down a problem. See [Logs](#logs) for where to find them. **Off by default.**

**Reset to defaults** resets the look and position, but keeps the on/off, auto-start, triple press, hide, and logging settings how you had them.

## Technical Stuff and Limitations

### How it works

The crosshair is two parts in one package, `com.abbiedoobie.crosshair`:

| Part | Role |
|---|---|
| Service (`com.abbiedoobie.crosshair.service`) | Native (C) root service. Stores settings, applies the power-on rule, and starts or closes the app. |
| App (`com.abbiedoobie.crosshair`) | Transparent `floating` web app that draws the crosshair as SVG and holds the on-TV settings panel. |

- The app is a `floating` window: a compositor layer above full-screen windows (inputs, apps, and, on webOS 10, the Home screen) and below the TV's overlay menus, popups, and notifications. Unlike overlay windows, it isn't closed by the compositor's 2-minute idle timer.
- The window takes remote focus only while the settings panel is open: the page sets the `needFocus` window property when the panel opens and clears it when it closes, and the compositor follows the property live. With the panel closed, the remote goes to whatever is underneath.
- The service launches the app with `{"dot": true}` to show the crosshair. Any other launch (the app list or the triple press) opens the panel. While open, the panel holds a `getConfig` subscription with `panel: true`, which keeps the app loaded even with the crosshair off.
- When neither the crosshair nor the panel is up, the app is closed entirely, since a loaded floating window interferes with Home and Back. Turning the crosshair on relaunches it in about half a second (the first launch after an install takes several seconds).
- The service is event driven, with no polling loops. It subscribes to the power state, the running-app list, the foreground app, and the picture settings, and does nothing between events.
- **Storage writes.** Turning the crosshair on or off never writes to the TV's storage: on/off lives in RAM (`/tmp`), and the power-on rule sets it after every boot. Other settings are saved to `config.json` once changes stop for 10 seconds, when the settings panel closes, or when the TV powers down, and only if something actually changed.
- **Power-on rule.** After a boot or a wake from standby, `visible` is set to `autoStart`. A restart of the service alone (reinstall, crash) keeps the current state; `/tmp/com.abbiedoobie.crosshair.booted` marks that the boot already happened and holds the on/off state.
- **HDR detection.** The `dynamicRange` dimension of the picture settings (for example `hdrALLM`) selects `hdrBrightness` over `brightness`.
- **Hide on Home and apps.** The first non-crosshair entry in `getForegroundAppInfo` is the main app. Only `com.webos.app.hdmi*`, `livetv`, and `externalinput.*` count as inputs.
- The app is relaunched automatically if it dies on its own, up to 5 times a minute.
- **Logs.** The service logs through syslog, tagged `com.abbiedoobie.crosshair`; see [Logs](#logs). PmLog, the webOS logger, would be the usual choice, but the TV drops PmLog lines from homebrew unless its developer log recording is switched on.
- **Root.** Homebrew Channel installs the IPK and nothing more. When the panel sees the service isn't root, it calls Homebrew Channel's `elevateService` for it, then the service's `restart`, and the service comes back as root. Once root, the service writes its boot hook, which re-runs `elevate-service` at every boot (an update reinstalls the service without root) before starting it.
- **Crash recovery.** The process the hub starts is a small supervisor that runs the service in a child process. If the service crashes or is killed, the supervisor starts it again a second later, up to 5 times a minute; a normal stop isn't restarted. The supervisor takes about 0.15 MB.

### Measurements (C2, webOS 10.3.1)

- Game Optimizer, ALLM, VRR, HDR, and the refresh rate are unchanged with the crosshair up (checked at 4K 120 Hz HDR10 with `scripts/tv/gamecheck.sh`).
- About 30 MB for the app while on, and under 3 MB for the service (about 0.4 MB of it its own, the rest shared system libraries). No CPU use while idle.
- Input lag has not been measured, though none was noticeable in testing.

### Limitations

- Requires root (Homebrew Channel). Without it, settings may not be kept and the power-on rule may not apply.
- Only tested on an OLED C2 (OLED42C2PUA) with webOS 10.3.1, firmware 33.31.68.
- Sizes are in 1080p units. The TV's graphics plane is 1080p, so on a 4K panel each unit is a 2x2 block of physical pixels, and half units can't be drawn.
- With **Hide on Home and apps** off, the crosshair draws over Home and apps, and the Magic Remote pointer can't select anything under it (the arrow keys still work).
- With auto-start on, the first remote button press right after a boot has occasionally been lost.

### Service API

All methods are at `luna://com.abbiedoobie.crosshair.service/<method>`.

| Method | Parameters | Description |
|---|---|---|
| `getConfig` | `subscribe`, `panel` (both optional) | Current settings, whether the crosshair should be on screen now (`show`), whether the picture is HDR, and whether the service is root. With `subscribe`, a reply after every change. The settings panel adds `panel: true`, which keeps the app loaded until it cancels. |
| `setConfig` | `config` | Applies a partial settings object. Invalid fields are skipped and keep their current value. |
| `resetConfig` | | Restores the default look and position, keeping on/off, auto-start, triple press, hide, and logging. |
| `show`, `hide`, `toggle` | | Turns the crosshair on or off. |
| `button` | | Remote button handler for Input Hook (one press toggles, three open the settings if enabled). |
| `status` | | Settings, whether the app is loaded, whether the panel is open, whether the crosshair is on screen, power state, dynamic range, foreground app, and whether an input is in front. |
| `start` | | No-op; the boot hook calls it to start the service. |
| `restart` | | Saves and exits; the next call starts it again. The panel uses it after getting the service elevated, so it comes back as root. |

### Files on the TV

| Path | Contents |
|---|---|
| `/home/root/.config/com.abbiedoobie.crosshair/config.json` | Saved settings (everything but on/off) |
| `/tmp/com.abbiedoobie.crosshair.booted` | Boot marker and the current on/off (cleared every boot) |
| `/var/log/legacy-log` | The TV's syslog file, which holds the service's log lines (in RAM, cleared every boot, size managed by the TV) |
| `/var/lib/webosbrew/init.d/95-abbiedoobie-crosshair` | Boot hook, written by the service once it's root. Keeps the service elevated and starts it at boot, and deletes itself if Crosshair is uninstalled. |

### Logs

The service writes to the TV's system log, which keeps it in `/var/log/legacy-log`. That file is in RAM, so logging never writes to the TV's storage, and the TV caps its size and clears it at every boot. Each line is tagged `com.abbiedoobie.crosshair[<pid>]` and starts with an ID such as `STARTED`, `LAUNCH_FAILED`, or `BUTTON`. To read them over SSH:

```sh
grep -F 'com.abbiedoobie.crosshair[' /var/log/legacy-log
```

Startup, shutdown, warnings, and errors are always there. Everything else needs **Verbose logging** on.

## Building

Requirements: Python 3, Node.js 20 or newer, LG's CLI (`npm install -g @webos-tools/cli`) with `ares-package` on `PATH`, and the webOS toolchain for the service (see below).

```sh
python scripts/build.py
python scripts/deploy.py <ssh-host>
```

`build.py` stages the app with its shared files, generates the icons, builds the service, and writes the IPK to `build/`. `deploy.py` copies it to the TV, installs the IPK (checking the installed version and retrying once), elevates the service, and restarts it (the service then writes its boot hook). `build.py` also writes `com.abbiedoobie.crosshair.manifest.json` next to the IPK, for the Homebrew Channel repository; attach both to the GitHub release `v<version>`. The store icon is kept in `assets/icon130.png`, and `build.py` updates it if the generated icon changes. `<ssh-host>` is anything `ssh` accepts, such as `root@<tv-ip>` or a Host alias from your SSH config.

### The service

The service is C, in `crosshair/native/`. It needs CMake and the [buildroot-nc4](https://github.com/openlgtv/buildroot-nc4) webOS toolchain (built and tested with release `webos-a38c582`), extracted with `relocate-sdk.sh` run. The toolchain runs on Linux; on Windows, `build.py` runs `scripts/build-native.sh` in WSL (distro `Ubuntu-24.04`, or set `CROSSHAIR_WSL_DISTRO`). Set `TOOLCHAIN` if the SDK isn't in `~/arm-webos-linux-gnueabi_sdk-buildroot`.

- `scripts/gen_schema.py` writes the C settings table from `config.js`, so defaults, limits, and shapes stay in one place.
- `scripts/native_parity.py <ssh-host>` runs a few thousand random settings patches through `config.js` and through the C code on the TV, and checks that they match.
- `ares-package` takes file modes from the disk, and Windows has none, so `build.py` marks the service binary executable inside the IPK.

### Development previews

Serve the repository with `python -m http.server` and open:

- `dev/gallery.html`: every shape, drawn by the shipping `render.js` at 4x zoom, plain and outlined.
- `dev/settings.html`: the real app in a desktop browser, with the service emulated by `dev/mock-bridge.js`. Arrow keys, Enter, and Escape act as the remote; reload to reopen the panel after closing it. Add `?hdr=1` to pretend the TV is showing HDR, and `?root=0` to pretend the service isn't elevated (and that getting root fails).

### TV scripts

Run on the TV over SSH (`ssh -tt`, so `luna-send` prints its replies):

- `scripts/tv/status.sh`: one-screen health check for the crosshair and Input Hook. Read-only.
- `scripts/tv/gamecheck.sh`: prints game mode, ALLM, VRR, HDR, and resolution with the crosshair off, on, and off again. Leaves the crosshair off.

### Project layout

| Path | Contents |
|---|---|
| `crosshair/app/` | The floating app: the crosshair and the settings panel |
| `crosshair/native/` | The root service (C) |
| `crosshair/shared/` | `config.js` (settings schema and validation), `render.js` (drawing), and `luna.js` (bus client), copied into the app |
| `assets/` | The store icon and screenshots, linked from the Homebrew Channel listing |
| `scripts/` | `build.py`, `deploy.py`, `icons.py` (launcher icons), and the service build scripts |
| `scripts/tv/` | Scripts to run on the TV |
| `dev/` | Desktop previews |

## License

MIT

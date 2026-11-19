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

1. Install both packages: `org.abbie.crosshair_<version>_all.ipk` (settings and service) and `org.abbie.crosshair.dot_<version>_all.ipk` (the crosshair itself).
2. Elevate the service to root. This is needed once after every install:

   ```sh
   /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service org.abbie.crosshair.service
   ```

3. Copy `crosshair/boot/95-abbie-crosshair` to `/var/lib/webosbrew/init.d/` and make it executable, so the service starts at boot.
4. Open **Crosshair** from the app list and turn it on.

`scripts/deploy.py` does steps 1 to 3 over SSH (see [Building](#building)). If the settings panel shows an amber warning under the title, the service isn't running as root; redo step 2 and reboot.

## Remote Button Setup (LG Input Hook)

LG Input Hook (`org.webosbrew.inputhook`, available in the Homebrew Channel) can run a command when a remote button is pressed. Bind any button you like to the crosshair's `button` method for one-press on/off and, if enabled, triple-press to open settings.

1. Open **LG Input Hook** and press the button you want to use. Input Hook shows its key code.
2. Choose **Add keybind** and enter that key code in **ID**.
3. Set **Action** to **Execute**, and paste this into **Command**:

   ```
   luna-send -n 1 luna://org.abbie.crosshair.service/button '{}'
   ```

4. Choose **Save changes**, then press the button once to check that the crosshair turns on or off.

Notes:

- The command above handles everything: one press turns the crosshair on or off, and three quick presses open the settings **(if enabled)**. If you'd rather have separate buttons, replace `button` in the command with `show`, `hide`, or `toggle`.
- **Pick a button that isn't bound to anything else** in Input Hook.
- Presses count as one gesture while each comes within 600 ms of the one before. The first press toggles right away; a second is held back and undone when the gesture ends (so two presses leave things as they were); a third undoes the first and opens the settings panel. Each press is logged in `/tmp/org.abbie.crosshair.log` as `button press <n>`.

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

**Reset to defaults** resets the look and position, but keeps the on/off, auto-start, triple press, and hide settings how you had them.

## Technical Stuff and Limitations

### How it works

The crosshair is three parts in two packages:

| Part | Package | Role |
|---|---|---|
| Service (`org.abbie.crosshair.service`) | `org.abbie.crosshair` | Root service, in JS or native C (same methods and files). Stores settings, applies the power-on rule, and starts or closes the dot app. |
| Settings (`org.abbie.crosshair`) | `org.abbie.crosshair` | Overlay web app with the on-TV panel. Takes remote focus while open. |
| Dot (`org.abbie.crosshair.dot`) | `org.abbie.crosshair.dot` | Transparent `floating` web app that draws the crosshair as SVG. Hidden from the app list. |

- The dot is a `floating` window: a compositor layer above the full-screen input and below the TV's own menus. Unlike overlay windows, it isn't closed by the compositor's 2-minute idle timer and doesn't take remote focus.
- Off closes the dot app entirely, since a loaded floating window interferes with Home and Back. Turning it on relaunches it in about half a second (the first launch after an install takes several seconds).
- The service is event driven, with no polling loops. It subscribes to the power state, the running-app list, the foreground app, and the picture settings, and does nothing between events.
- **Storage writes.** Turning the crosshair on or off never writes to the TV's storage: on/off lives in RAM (`/tmp`), and the power-on rule sets it after every boot. Other settings are saved to `config.json` once changes stop for 10 seconds, when the settings panel closes, or when the TV powers down, and only if something actually changed.
- **Power-on rule.** After a boot or a wake from standby, `visible` is set to `autoStart`. A restart of the service alone (reinstall, crash) keeps the current state; `/tmp/org.abbie.crosshair.booted` marks that the boot already happened and holds the on/off state.
- **HDR detection.** The `dynamicRange` dimension of the picture settings (for example `hdrALLM`) selects `hdrBrightness` over `brightness`.
- **Hide on Home and apps.** The first non-crosshair entry in `getForegroundAppInfo` is the main app. Only `com.webos.app.hdmi*`, `livetv`, and `externalinput.*` count as inputs.
- The dot app is relaunched automatically if it dies on its own, up to 5 times a minute.
- **Crash recovery (native service).** The process the hub starts is a small supervisor that runs the service in a child process. If the service crashes or is killed, the supervisor starts it again a second later, up to 5 times a minute; a normal stop isn't restarted. The supervisor takes about 0.15 MB.

### Measurements (C2, webOS 10.3.1)

- Game Optimizer, ALLM, VRR, HDR, and the refresh rate are unchanged with the crosshair up (checked at 4K 120 Hz HDR10 with `scripts/tv/gamecheck.sh`).
- About 30 MB for the dot app while on. The JS service takes about 21 MB (6.9 MB of it its own, the rest shared Node code); the native service takes 2 MB (0.5 MB its own). No CPU use while idle.
- Input lag has not been measured, though none was noticeable in testing.

### Limitations

- Requires root (Homebrew Channel). Without `elevate-service`, settings may not be kept and the power-on rule may not apply.
- Only tested on an OLED C2 (OLED42C2PUA) with webOS 10.3.1, firmware 33.31.68.
- Sizes are in 1080p units. The TV's graphics plane is 1080p, so on a 4K panel each unit is a 2x2 block of physical pixels, and half units can't be drawn.
- With **Hide on Home and apps** off, Home and Back may not work properly while the crosshair is up.
- With auto-start on, the first remote button press right after a boot has occasionally been lost.

### Service API

All methods are at `luna://org.abbie.crosshair.service/<method>`.

| Method | Parameters | Description |
|---|---|---|
| `getConfig` | `subscribe` (optional) | Current settings, whether the picture is HDR, and whether the service is root. With `subscribe`, a reply after every change. |
| `setConfig` | `config` | Applies a partial settings object. Invalid fields are skipped and keep their current value. |
| `resetConfig` | | Restores the default look and position, keeping on/off, auto-start, triple press, and hide. |
| `show`, `hide`, `toggle` | | Turns the crosshair on or off. |
| `button` | | Remote button handler for Input Hook (one press toggles, three open the settings if enabled). |
| `status` | | Settings, whether the dot app is loaded, power state, dynamic range, foreground app, and whether an input is in front. |
| `start` | | No-op; the boot hook calls it to start the service. |

### Files on the TV

| Path | Contents |
|---|---|
| `/home/root/.config/org.abbie.crosshair/config.json` | Saved settings (everything but on/off) |
| `/tmp/org.abbie.crosshair.booted` | Boot marker and the current on/off (cleared every boot) |
| `/tmp/org.abbie.crosshair.log` | Service log, up to 64 KB plus one older file (cleared every boot) |
| `/var/lib/webosbrew/init.d/95-abbie-crosshair` | Boot hook |

## Building

Requirements: Python 3, Node.js 20 or newer, and LG's CLI (`npm install -g @webos-tools/cli`) with `ares-package` on `PATH`.

```sh
python scripts/build.py
python scripts/deploy.py <ssh-host>
```

`build.py` stages each part with its shared files, generates the icons, and writes both IPKs to `build/`. `deploy.py` copies them to the TV, installs them (checking the installed version and retrying once), elevates the service, installs the boot hook, and restarts the service. `<ssh-host>` is anything `ssh` accepts, such as `root@<tv-ip>` or a Host alias from your SSH config.

### Native service

`python scripts/build.py --native` ships the C service in `crosshair/native/` instead of the JS one. It needs CMake and the [buildroot-nc4](https://github.com/openlgtv/buildroot-nc4) webOS toolchain (built and tested with release `webos-a38c582`), extracted with `relocate-sdk.sh` run. The toolchain runs on Linux; on Windows, `build.py` runs `scripts/build-native.sh` in WSL (distro `Ubuntu-24.04`, or set `CROSSHAIR_WSL_DISTRO`). Set `TOOLCHAIN` if the SDK isn't in `~/arm-webos-linux-gnueabi_sdk-buildroot`.

- `scripts/gen_schema.py` writes the C settings table from `config.js`, so defaults, limits, and shapes stay in one place.
- `scripts/native_parity.py <ssh-host>` runs a few thousand random settings patches through `config.js` and through the C code on the TV, and checks that they match.
- `ares-package` takes file modes from the disk, and Windows has none, so `build.py` marks the service binary executable inside the IPK.

### Development previews

Serve the repository with `python -m http.server` and open:

- `dev/gallery.html`: every shape, drawn by the shipping `render.js` at 4x zoom, plain and outlined.
- `dev/settings.html`: the real settings panel in a desktop browser, with the service emulated by `dev/mock-bridge.js`. Arrow keys, Enter, and Escape act as the remote. Add `?hdr=1` to pretend the TV is showing HDR, and `?root=0` to pretend the service isn't elevated.

### TV scripts

Run on the TV over SSH (`ssh -tt`, so `luna-send` prints its replies):

- `scripts/tv/status.sh`: one-screen health check for the crosshair and Input Hook. Read-only.
- `scripts/tv/gamecheck.sh`: prints game mode, ALLM, VRR, HDR, and resolution with the crosshair off, on, and off again. Leaves the crosshair off.

### Project layout

| Path | Contents |
|---|---|
| `crosshair/dot/` | The floating dot app |
| `crosshair/settings/` | The settings panel app |
| `crosshair/service/` | The root JS service |
| `crosshair/native/` | The same service in C (`--native`) |
| `crosshair/shared/` | `config.js` (settings schema and validation), `render.js` (drawing), and `luna.js` (bus client), copied into each package |
| `crosshair/boot/` | Homebrew Channel boot hook |
| `scripts/` | `build.py`, `deploy.py`, `icons.py` (launcher icons), and the native build scripts |
| `scripts/tv/` | Scripts to run on the TV |
| `dev/` | Desktop previews |

## License

MIT

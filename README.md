# Crosshair for LG webOS TVs

A crosshair over whatever the TV is showing, for games on an HDMI input. It sits above the
picture without taking the remote, stays up through long play sessions, and comes back by
itself after the screen sleeps.

## Features

- Six shapes: dot, cross, cross with a centre dot, T, circle, and circle with a centre dot.
- Color, size, thickness, gap, opacity, and an optional outline.
- Move it left, right, up, or down for games whose aim point isn't the exact centre.
- On-TV settings: open **Crosshair** from the app list. An on/off switch sits at the top.
  While the crosshair is off, selecting a look setting previews it in place. While it's on,
  changes show live on the real one.
- Toggle it with a remote button through LG Input Hook.
- Off by default. **Auto-start with TV** (also off by default) turns it on whenever the TV
  powers on. Settings survive reboots.

## Setup

1. Install both packages: `org.abbie.crosshair_<version>_all.ipk` (settings and service) and
   `org.abbie.crosshair.dot_<version>_all.ipk` (the crosshair itself).
2. The service needs root. Elevate it once after every install:

   ```
   /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service org.abbie.crosshair.service
   ```

3. Copy `crosshair/boot/95-abbie-crosshair` to `/var/lib/webosbrew/init.d/` so the crosshair
   comes back after a reboot.

`scripts/deploy.py` does all three over SSH.

### Toggle button (LG Input Hook)

Add an entry to `/home/root/.config/lginputhook/keybinds.json`, using the key code of the
button you want (the MR22 Magic Remote's Alexa button is `1086`). Input Hook reloads the file
by itself.

```json
"<keycode>": {"action": "exec", "command": "luna-send -n 1 luna://org.abbie.crosshair.service/toggle '{}'"}
```

## Options

| Setting | Range | Default |
|---|---|---|
| Crosshair | On / Off | Off |
| Auto-start with TV | On / Off: on after every boot or wake from standby | Off |
| Shape | Dot, Cross, Cross + dot, T, Circle, Circle + dot | Dot |
| Color | Green, Red, Cyan, Yellow, Magenta, Orange, Pink, White | Green |
| Size | 2 to 64 | 8 |
| Thickness | 1 to 8 (not for Dot) | 2 |
| Gap | 0 to 32 (cross shapes) | 3 |
| Opacity | 10% to 100% | 100% |
| Outline | On / Off, Black or White, width 1 to 3 | Off |
| Move left / right, up / down | -300 to 300 | 0 |

Sizes are in 1080p pixels. On a 4K panel each one is two physical pixels.

## Technical Stuff and Limitations

- **Needs a rooted TV** with the Homebrew Channel. Tested on an LG OLED C2 running webOS 10.3.1.
- **The Home menu doesn't open while the crosshair is on.** Turn it off to use Home. The input
  picker, Game Optimizer, and picture settings work either way.
- The crosshair is a `floating` window: a compositor layer above the full-screen input,
  below the TV's own menus. The 2-minute idle timer that closes overlay windows doesn't touch
  it, and it doesn't take remote focus.
- Off closes the crosshair app entirely. On starts it again in about half a second. While
  on, it costs about 30 MB for the web page, and the service about 21 MB, with no CPU use
  while idle.

## Building

Needs Python 3, Node.js 20 or newer, and LG's CLI (`npm install -g @webos-tools/cli`) with
`ares-package` on PATH.

```
python scripts/build.py
python scripts/deploy.py <ssh-host>
```

`<ssh-host>` is anything ssh accepts: `root@<tv-ip>`, or a Host alias carrying the key.

| Path | What it is |
|---|---|
| `crosshair/dot/` | `org.abbie.crosshair.dot`: the floating, transparent web app that draws the crosshair (SVG) |
| `crosshair/settings/` | `org.abbie.crosshair`: the on-TV settings panel (overlay window), and the app-list entry |
| `crosshair/service/` | `org.abbie.crosshair.service`: root JS service; stores settings, toggles, keeps the dot loaded |
| `crosshair/shared/` | `config.js` (settings schema and validation), `render.js` (draws the crosshair), and `luna.js` (bus client), copied into each package |
| `crosshair/boot/` | Homebrew Channel boot hook |
| `scripts/` | `build.py`, `deploy.py`, and `icons.py` (generates the launcher icons) |

Service API, at `luna://org.abbie.crosshair.service/`: `getConfig` (subscribable),
`setConfig {config}`, `resetConfig`, `show`, `hide`, `toggle`, `status`, and `start`.

Settings live in `/home/root/.config/org.abbie.crosshair/config.json`. The service log is
`/tmp/org.abbie.crosshair.log`.

## License

MIT.

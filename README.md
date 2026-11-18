# Crosshair for LG webOS TVs

A crosshair over whatever the TV is showing, for games on an HDMI input. It sits above the
picture without taking the remote, stays up through long play sessions, and comes back by
itself after the screen sleeps.

## Features

- 21 shapes: dots, circles, crosses, T, X, scope, squares, diamonds, corner brackets, a
  chevron, a triangle, and dot patterns.
- Color presets or any hue, size, thickness, gap, opacity, and an optional outline.
- Separate brightness for SDR and HDR, switched automatically: the TV draws app graphics much
  brighter over HDR games.
- Move it anywhere on screen for games whose aim point isn't the exact centre. Hold Left or
  Right in the settings to move faster.
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

### Remote button (LG Input Hook)

One press turns the crosshair on or off. Three quick presses open the settings panel; turn
off **Triple press opens settings** to make every press a plain toggle. Add an entry to `/home/root/.config/lginputhook/keybinds.json`, using the key code of the
button you want (the MR22 Magic Remote's Alexa button is `1086`). Input Hook reloads the file
by itself.

```json
"<keycode>": {"action": "exec", "command": "luna-send -n 1 luna://org.abbie.crosshair.service/button '{}'"}
```

Don't end the command with `&`: Input Hook then never runs it.

## Options

| Setting | Range | Default |
|---|---|---|
| Crosshair | On / Off | Off |
| Auto-start with TV | On / Off: on after every boot or wake from standby | Off |
| Triple press opens settings | On / Off: three quick presses of the remote button open this panel | On |
| Shape | Dot, Circle, Circle + dot, Broken circle, Cross, Cross + dot, T, T + dot, X, X + dot, Scope, Horizontal line, Square, Square + dot, Diamond, Diamond + dot, Corner brackets, Chevron, Triangle, Four dots, Five dots | Dot |
| Size | 2 to 96 | 8 |
| Thickness | 1 to 8 (shapes with lines) | 2 |
| Gap | 0 to 32 (shapes with a gap) | 3 |
| Color | Green, Lime, Yellow, Orange, Red, Pink, Magenta, Purple, Blue, Cyan, White | Green |
| Custom color | Any hue, in 5-degree steps | |
| Brightness | 10% to 100%, used for SDR pictures | 100% |
| HDR brightness | 10% to 100%, used while the TV shows HDR | 70% |
| Opacity | 10% to 100% | 100% |
| Outline | On / Off, Black or White, width 1 to 3 | Off |
| Move left / right | -900 to 900 | 0 |
| Move up / down | -500 to 500 | 0 |
| Center it | Puts it back in the middle | |

Sizes are in 1080p pixels: the TV draws app graphics at 1080p, so on a 4K panel each one is
a 2x2 block of physical pixels.

Brightness gives an opaque, darker shade of the color. Opacity lets the game show through it.

## Technical Stuff and Limitations

- **Needs a rooted TV** with the Homebrew Channel. Tested on an LG OLED C2 running webOS 10.3.1.
- **The Home menu doesn't open while the crosshair is on.** Turn it off to use Home. The input
  picker, Game Optimizer, and picture settings work either way.
- The crosshair is a `floating` window: a compositor layer above the full-screen input,
  below the TV's own menus. The 2-minute idle timer that closes overlay windows doesn't touch
  it, and it doesn't take remote focus.
- The crosshair doesn't change Game Optimizer, ALLM, VRR, HDR, or the refresh rate (checked at
  4K 120 Hz HDR10; `scripts/tv/gamecheck.sh`).
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
| `scripts/tv/` | Run on the TV: `status.sh` (health check) and `gamecheck.sh` (game-mode A/B test) |
| `dev/` | Desktop previews: `gallery.html` (every shape) and `settings.html` (the panel, with a mock service). Serve the repo with `python -m http.server` |
| `extras/inputhook-autostart/` | A more reliable boot start for LG Input Hook (see its comments) |

Service API, at `luna://org.abbie.crosshair.service/`: `getConfig` (subscribable; also
reports whether the picture is HDR),
`setConfig {config}`, `resetConfig`, `show`, `hide`, `toggle`,
`button` (one press toggles; three quick presses open the settings), `status`, and `start`.

Settings live in `/home/root/.config/org.abbie.crosshair/config.json`. The service log is
`/tmp/org.abbie.crosshair.log`.

## License

MIT.

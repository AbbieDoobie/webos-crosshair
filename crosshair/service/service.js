/*
 * org.abbie.crosshair.service: owns the crosshair settings and keeps the dot on screen.
 *
 * Runs as root (Homebrew Channel's elevate-service). Event driven: it holds a keep-alive
 * activity and four subscriptions (power state, the running-app list, the foreground app,
 * and the picture settings for HDR), and does nothing between events.
 *
 * Methods (luna://org.abbie.crosshair.service/<method>):
 *   getConfig {subscribe}   current settings, whether the picture is HDR, and whether
 *                           the service runs as root; with subscribe, a reply after
 *                           every change
 *   setConfig {config}      apply a partial settings object; invalid fields are skipped
 *                           and keep their current value
 *   resetConfig             defaults for the look, keeping on/off, auto-start, and the
 *                           triple-press and hide-outside-inputs settings as they are
 *   show / hide / toggle    turn the crosshair on or off
 *   button                  the remote button (Input Hook calls this): one press toggles;
 *                           with tripleOpensSettings, three quick presses open the panel
 *   status                  settings plus whether the dot app is loaded, and the power state
 *   start                   no-op; the boot hook calls it to start the service
 *
 * Power-on rule: after the TV boots or wakes from standby, the crosshair is on if
 * auto-start is on, and off otherwise. The dim "Screen Off" state isn't a power-on.
 *
 * With hideOutsideInputs, the dot app is also closed while Home or an app is in front, and
 * comes back on an input (HDMI, live TV, AV). The on/off setting itself doesn't change.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Service = require('webos-service');
var Config = require('./config.js');

var SERVICE_ID = 'org.abbie.crosshair.service';
var DOT_APP_ID = 'org.abbie.crosshair.dot';
var SETTINGS_APP_ID = 'org.abbie.crosshair';
var CONFIG_DIR = '/home/root/.config/org.abbie.crosshair';
var CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
var LOG_FILE = '/tmp/org.abbie.crosshair.log';
//The /tmp folder is RAM (tmpfs) and emptied every boot, so a missing marker means this is
//the first start since boot, rather than a restart (reinstall, crash) that should keep the
//current on/off. The marker holds that on/off, so turning the crosshair on or off never
//writes to the TV's storage.
var BOOT_MARKER = '/tmp/org.abbie.crosshair.booted';
var LOG_MAX_BYTES = 64 * 1024;  //Two files at most (log and .1), both in RAM

//Match foreground apps that are a TV input. Anything else in front (Home, an app) hides the dot.
var INPUT_APP = /^com\.webos\.app\.(hdmi\d+|livetv|externalinput\.)/;

//Settings changes arrive in bursts while the panel is open. Save once things go quiet, or
//right away when the panel closes (its subscription ends) or the TV powers down.
var SAVE_DELAY_MS = 10000;
var WAKE_DELAY_MS = 1500;       //Let the compositor settle after the screen comes on
//Failsafe: budget for relaunching a dot app that died by itself, so a crashing app can't
//loop forever.
//Launches you cause (on/off, coming back to an input, waking) don't count.
var LAUNCH_WINDOW_MS = 60000;
var LAUNCH_BUDGET = 5;
//Presses count as one gesture while each comes within PRESS_GAP_MS of the one before.
//A press normally reaches the service about 30 ms after lginput2 sees it, so this is generous.
var PRESS_GAP_MS = 600;

var service = new Service(SERVICE_ID);
var logSize = -1;               //Bytes in LOG_FILE, so logging doesn't stat the file every line
var savedText = '';             //What config.json holds now, to skip writes that change nothing
var configDirReady = false;
var config = loadConfig();
var configSubscribers = [];
var saveTimer = null;
//The tvpower states in which apps keep running. "Screen Off" is the dim semi-sleep: the
//compositor hides the dot itself and shows it again on wake, so it counts as up.
var UP_STATES = ['Active', 'Screen Off'];
var powerState = 'Active';
var dotRunning = null;          //Starts null (no reply yet). true = loaded. false = not running.
var foregroundApp = '';         //The app in front, from the foreground subscription
var onInput = true;             //An input is in front (assumed until the first reply)
var hdr = false;                //The TV is showing an HDR picture (picks hdrBrightness)
var dynamicRange = '';
var launchTimes = [];
var launchPending = false;
//Root comes from Homebrew Channel's elevate-service. Without it the service can't keep
//settings in /home/root, so the settings panel warns.
var elevated = typeof process.getuid === 'function' && process.getuid() === 0;
var pressCount = 0;
var pressTimer = null;

//---------------------------------------------------------------------------------------
//Logging. Keep a short file in /tmp (cleared every boot), trimmed when it grows.

function log(level, text) {
    var line = new Date().toISOString() + ' ' + level + ' ' + text + '\n';
    try {
        //Grab the size once, then count what we append
        if (logSize < 0) {
            try { logSize = fs.statSync(LOG_FILE).size; } catch (e) { logSize = 0; }
        }
        if (logSize > LOG_MAX_BYTES) {
            fs.renameSync(LOG_FILE, LOG_FILE + '.1');
            logSize = 0;
        }
        fs.appendFileSync(LOG_FILE, line);
        logSize += Buffer.byteLength(line);
    } catch (e) { /* Logging must NEVER take the service down */ }
}

//---------------------------------------------------------------------------------------
//Settings storage.

//Build the text config.json should hold. On/off isn't in it: the power-on rule sets it
//after every boot, and a restart in between reads it from the boot marker in RAM.
function storedText(c) {
    var out = {};
    for (var key in c) if (key !== 'visible') out[key] = c[key];
    return JSON.stringify(out, null, 2);
}

function loadConfig() {
    var c;
    try {
        c = Config.merge(Config.DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
        configDirReady = true;
    } catch (e) {
        c = Config.merge(Config.DEFAULTS, {});
    }
    savedText = storedText(c);
    //On a restart since boot, on/off comes from the marker. Versions before 0.4.2 left the
    //marker empty and kept on/off in config.json, so that value stays as the fallback.
    try {
        var state = JSON.parse(fs.readFileSync(BOOT_MARKER, 'utf8'));
        c = Config.merge(c, { visible: state.visible });
    } catch (e) { /* No marker (first start since boot), or an old empty one */ }
    return c;
}

function saveNow() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    var text = storedText(config);
    if (text === savedText) return;     //Changed and changed back, so nothing to write
    try {
        if (!configDirReady) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            configDirReady = true;
        }
        var tmp = CONFIG_FILE + '.tmp';
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, CONFIG_FILE);    //Atomic, so never a half-written file
        savedText = text;
    } catch (e) {
        log('ERROR', 'save failed: ' + e.message);
    }
}

//Keep on/off in the boot marker (RAM), so a service restart picks it back up
function writeVisibleState() {
    try {
        fs.writeFileSync(BOOT_MARKER, JSON.stringify({ visible: config.visible }));
    } catch (e) { /* Worst case, a restart falls back to config.json */ }
}

function sameConfig(a, b) {
    for (var key in a) if (a[key] !== b[key]) return false;
    return true;
}

function applyConfig(next) {
    var changed = !sameConfig(next, config);
    var visibilityChanged = next.visible !== config.visible;
    var hideChanged = next.hideOutsideInputs !== config.hideOutsideInputs;
    config = next;
    if (!changed) return;
    if (visibilityChanged) writeVisibleState();
    //Only a stored setting needs a save; a change that was undone cancels the pending one
    if (storedText(config) !== savedText) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
    } else if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    broadcast();
    if (visibilityChanged) log('INFO', 'crosshair ' + (config.visible ? 'on' : 'off'));
    if (visibilityChanged || hideChanged) {
        updateDot(visibilityChanged ? 'turned on' : 'hide setting changed');
    }
}

//Check if the dot should be on screen right now
function wanted() {
    return config.visible && (onInput || !config.hideOutsideInputs);
}

function updateDot(reason) {
    if (wanted()) ensureDot(reason, false);
    else closeDot();
}

function broadcast() {
    configSubscribers.forEach(function (msg) {
        msg.respond({ config: config, hdr: hdr, elevated: elevated, subscribed: true });
    });
}

//---------------------------------------------------------------------------------------
//HDR detection. The picture settings carry the current dynamic range as a "dimension"
//(seen: "hdrALLM" for HDR10 game content with ALLM), and push a reply when it changes.

function watchDynamicRange() {
    var sub = service.subscribe('luna://com.webos.settingsservice/getSystemSettings',
        { category: 'picture', keys: ['pictureMode'], subscribe: true });
    sub.on('response', function (reply) {
        var dim = reply.payload.dimension;
        if (!dim || typeof dim.dynamicRange !== 'string') return;
        var range = dim.dynamicRange;
        var isHdr = /hdr|hlg|dolby|dv/i.test(range) && !/^sdr/i.test(range);
        if (range !== dynamicRange) log('INFO', 'dynamic range ' + range);
        dynamicRange = range;
        if (isHdr !== hdr) {
            hdr = isHdr;
            broadcast();
        }
    });
    sub.on('cancel', function () {
        log('WARN', 'picture settings subscription dropped, retrying');
        setTimeout(watchDynamicRange, 5000);
    });
}

//---------------------------------------------------------------------------------------
//The dot app runs only while the crosshair is on.
//
//Off closes it completely: a loaded floating window, even an empty one, stops the Home
//menu from opening. Relaunching a previously loaded web app takes about 0.4 s.

function ensureDot(reason, force, budgeted) {
    if (!wanted()) return;
    if (UP_STATES.indexOf(powerState) < 0 || launchPending) return;
    if (dotRunning === true && !force) return;

    if (budgeted) {
        var now = Date.now();
        launchTimes = launchTimes.filter(function (t) { return now - t < LAUNCH_WINDOW_MS; });
        if (launchTimes.length >= LAUNCH_BUDGET) {
            log('WARN', 'relaunch budget spent, not launching (' + reason + ')');
            return;
        }
        launchTimes.push(now);
    }
    launchPending = true;
    log('INFO', 'launching dot app (' + reason + ')');

    service.call('luna://com.webos.applicationManager/launch',
        { id: DOT_APP_ID, noSplash: true, spinner: false },
        function (reply) {
            launchPending = false;
            if (!reply.payload.returnValue) {
                log('ERROR', 'launch failed: ' + (reply.payload.errorText || 'unknown'));
            } else if (!wanted()) {
                closeDot(true);     //Turned off or hidden again while it was launching
            }
        });
}

function closeDot(force) {
    if (dotRunning === false && !launchPending && !force) return;
    log('INFO', 'closing dot app');
    service.call('luna://com.webos.applicationManager/closeByAppId', { id: DOT_APP_ID },
        function () {});
}

function watchRunningApps() {
    var sub = service.subscribe('luna://com.webos.applicationManager/running', { subscribe: true });
    sub.on('response', function (reply) {
        var list = reply.payload.running;
        if (!list) return;
        var running = list.some(function (app) { return app.id === DOT_APP_ID; });
        if (running !== dotRunning) {
            dotRunning = running;
            if (!running) ensureDot('dot app not running', false, true);
            else if (!wanted()) closeDot(true);
        }
    });
    sub.on('cancel', function () {
        log('WARN', 'running-app subscription dropped, retrying');
        setTimeout(watchRunningApps, 5000);
    });
}

//Watch the foreground app to hide the dot outside inputs. The list has the main app first,
//then anything layered over it (quick settings, our own panel and dot). Only the main app
//decides, so the picture menus over HDMI keep the crosshair.
function watchForeground() {
    var sub = service.subscribe('luna://com.webos.applicationManager/getForegroundAppInfo',
        { subscribe: true, extraInfo: true });
    sub.on('response', function (reply) {
        var list = reply.payload.foregroundAppInfo;
        if (!Array.isArray(list)) return;
        var main = list.filter(function (a) {
            return a.appId && a.appId.indexOf('org.abbie.crosshair') !== 0;
        })[0];
        if (!main || main.appId === foregroundApp) return;
        foregroundApp = main.appId;
        var input = INPUT_APP.test(foregroundApp);
        if (input === onInput) return;
        onInput = input;
        if (config.visible && config.hideOutsideInputs) {
            log('INFO', (onInput ? 'showing on ' : 'hiding for ') + foregroundApp);
        }
        updateDot('back on ' + foregroundApp);
    });
    sub.on('cancel', function () {
        log('WARN', 'foreground subscription dropped, retrying');
        setTimeout(watchForeground, 5000);
    });
}

function watchPower() {
    var sub = service.subscribe('luna://com.webos.service.tvpower/power/getPowerState', { subscribe: true });
    sub.on('response', function (reply) {
        var state = reply.payload.state;
        if (!state || state === powerState) return;
        var previous = powerState;
        powerState = state;
        log('INFO', 'power state ' + previous + ' -> ' + state);
        //Write any pending settings before a power-down can cut them off
        if (UP_STATES.indexOf(state) < 0) saveNow();
        if (state !== 'Active') return;
        //Semi-sleep restores the window by itself and needs nothing.
        if (UP_STATES.indexOf(previous) >= 0) return;
        //A real power-on: apply the auto-start rule. Standby also clears floating windows
        //even if the app stayed loaded, so relaunch unconditionally: on a loaded app that
        //just remaps its window.
        applyPowerOnRule('wake from ' + previous);
        setTimeout(function () { ensureDot('wake from ' + previous, true); }, WAKE_DELAY_MS);
    });
    sub.on('cancel', function () {
        log('WARN', 'power subscription dropped, retrying');
        setTimeout(watchPower, 5000);
    });
}

//---------------------------------------------------------------------------------------
//Luna methods.

function setVisible(msg, visible) {
    applyConfig(Config.merge(config, { visible: visible }));
    msg.respond({ visible: config.visible });
}

service.register('getConfig', function (msg) {
    if (msg.isSubscription) configSubscribers.push(msg);
    msg.respond({ config: config, hdr: hdr, elevated: elevated, subscribed: !!msg.isSubscription });
}, function (msg) {
    var i = configSubscribers.indexOf(msg);
    if (i >= 0) configSubscribers.splice(i, 1);
    //The settings panel (or the dot app) closed, so the burst of changes is over
    if (saveTimer) saveNow();
});

service.register('setConfig', function (msg) {
    var patch = msg.payload && msg.payload.config;
    if (!patch || typeof patch !== 'object') {
        msg.respond({ returnValue: false, errorText: 'config object required' });
        return;
    }
    applyConfig(Config.merge(config, patch));
    msg.respond({ config: config });
});

service.register('resetConfig', function (msg) {
    applyConfig(Config.merge(Config.DEFAULTS, {
        visible: config.visible, autoStart: config.autoStart,
        tripleOpensSettings: config.tripleOpensSettings,
        hideOutsideInputs: config.hideOutsideInputs
    }));
    msg.respond({ config: config });
});

service.register('show', function (msg) { setVisible(msg, true); });
service.register('hide', function (msg) { setVisible(msg, false); });
service.register('toggle', function (msg) { setVisible(msg, !config.visible); });

//Handle the remote button. The first press toggles right away, so a single press feels
//instant. A second quick press is held back: on its own it toggles back once the gesture
//ends, so two presses leave things as they were. A third quick press undoes the first
//toggle and opens the settings panel instead.
service.register('button', function (msg) {
    msg.respond({ returnValue: true });
    if (!config.tripleOpensSettings) {
        applyConfig(Config.merge(config, { visible: !config.visible }));
        return;
    }
    pressCount++;
    log('INFO', 'button press ' + pressCount);
    if (pressTimer) clearTimeout(pressTimer);
    if (pressCount === 1) {
        applyConfig(Config.merge(config, { visible: !config.visible }));
    } else if (pressCount === 3) {
        pressCount = 0;
        pressTimer = null;
        log('INFO', 'triple press: opening settings');
        applyConfig(Config.merge(config, { visible: !config.visible }));
        service.call('luna://com.webos.applicationManager/launch', { id: SETTINGS_APP_ID },
            function (reply) {
                if (!reply.payload.returnValue) {
                    log('ERROR', 'settings launch failed: ' + (reply.payload.errorText || 'unknown'));
                }
            });
        return;
    }
    pressTimer = setTimeout(function () {
        if (pressCount === 2) applyConfig(Config.merge(config, { visible: !config.visible }));
        pressCount = 0;
        pressTimer = null;
    }, PRESS_GAP_MS);
});

service.register('status', function (msg) {
    msg.respond({
        config: config, dotLoaded: dotRunning === true, powerState: powerState,
        hdr: hdr, dynamicRange: dynamicRange, elevated: elevated,
        foregroundApp: foregroundApp, onInput: onInput
    });
});

service.register('start', function (msg) {
    ensureDot('start', false);
    msg.respond({ started: true });
});

//---------------------------------------------------------------------------------------

//NOTE: Hacky, but required. The keep-alive activity stops webos-service's idle shutdown,
//but on webOS 10 the bus connection doesn't hold Node's event loop open by itself, so
//without a pending timer the process exits with code 0 straight after start. One inert
//timer keeps it alive.
service.activityManager.create('keepAlive', function () {});
setInterval(function () {}, 0x7fffffff);

//Log and keep running instead of exiting, so one bad reply can't take the crosshair down
process.on('uncaughtException', function (e) {
    log('ERROR', 'uncaught: ' + (e && e.stack || e));
});

function applyPowerOnRule(reason) {
    log('INFO', reason + ': auto-start ' + (config.autoStart ? 'on' : 'off'));
    applyConfig(Config.merge(config, { visible: config.autoStart }));
}

log('INFO', 'service started' + (elevated ? '' : ' WITHOUT ROOT (not elevated)'));
if (!fs.existsSync(BOOT_MARKER)) {
    //Write the marker first, so it exists even when the rule leaves on/off as it was.
    //Worst case (can't write it), the rule runs again on the next start.
    writeVisibleState();
    applyPowerOnRule('boot');
}
watchPower();
watchRunningApps();
watchForeground();
watchDynamicRange();

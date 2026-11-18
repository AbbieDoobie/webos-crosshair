/*
 * org.abbie.crosshair.service: owns the crosshair settings and keeps the dot on screen.
 *
 * Runs as root (Homebrew Channel's elevate-service). Event driven: it holds a keep-alive
 * activity and three subscriptions (power state, the running-app list, and the picture
 * settings for HDR), and does nothing between events.
 *
 * Methods (luna://org.abbie.crosshair.service/<method>):
 *   getConfig {subscribe}   current settings and whether the picture is HDR; with
 *                           subscribe, a reply after every change to either
 *   setConfig {config}      apply a partial settings object; invalid fields are ignored
 *   resetConfig             defaults, keeping on/off and auto-start as they are
 *   show / hide / toggle    turn the crosshair on or off
 *   status                  settings plus whether the dot app is loaded, and the power state
 *   start                   no-op; the boot hook calls it to start the service
 *
 * Power-on rule: after the TV boots or wakes from standby, the crosshair is on if
 * auto-start is on, and off otherwise. The dim "Screen Off" state isn't a power-on.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var Service = require('webos-service');
var Config = require('./config.js');

var SERVICE_ID = 'org.abbie.crosshair.service';
var DOT_APP_ID = 'org.abbie.crosshair.dot';
var CONFIG_DIR = '/home/root/.config/org.abbie.crosshair';
var CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
var LOG_FILE = '/tmp/org.abbie.crosshair.log';
// /tmp is emptied every boot, so a missing marker means this is the first start since
// boot rather than a restart (reinstall, crash) that should keep the current on/off.
var BOOT_MARKER = '/tmp/org.abbie.crosshair.booted';
var LOG_MAX_BYTES = 256 * 1024;

var SAVE_DELAY_MS = 750;        // settings changes arrive in bursts while a value is held
var WAKE_DELAY_MS = 1500;       // let the compositor settle after the screen comes on
var LAUNCH_WINDOW_MS = 60000;   // relaunch budget: at most LAUNCH_BUDGET per window
var LAUNCH_BUDGET = 5;

var service = new Service(SERVICE_ID);
var config = loadConfig();
var configSubscribers = [];
var saveTimer = null;
// tvpower states in which apps keep running. "Screen Off" is the dim semi-sleep: the
// compositor hides the dot itself and shows it again on wake, so it counts as up.
var UP_STATES = ['Active', 'Screen Off'];
var powerState = 'Active';
var dotRunning = null;          // null until the first running-app reply
var hdr = false;                // the TV is showing an HDR picture (picks hdrBrightness)
var dynamicRange = '';
var launchTimes = [];
var launchPending = false;

// ---------------------------------------------------------------------------------------
// Logging: a short file in /tmp (cleared every boot), trimmed when it grows.

function log(level, text) {
    var line = new Date().toISOString() + ' ' + level + ' ' + text + '\n';
    try {
        var st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
        if (st && st.size > LOG_MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) { /* logging must never take the service down */ }
}

// ---------------------------------------------------------------------------------------
// Settings storage.

function loadConfig() {
    try {
        var parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return Config.merge(Config.DEFAULTS, parsed);
    } catch (e) {
        return Config.merge(Config.DEFAULTS, {});
    }
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
        saveTimer = null;
        try {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            var tmp = CONFIG_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
            fs.renameSync(tmp, CONFIG_FILE);    // atomic: never a half-written file
        } catch (e) {
            log('ERROR', 'save failed: ' + e.message);
        }
    }, SAVE_DELAY_MS);
}

function applyConfig(next) {
    var changed = JSON.stringify(next) !== JSON.stringify(config);
    var visibilityChanged = next.visible !== config.visible;
    config = next;
    if (!changed) return;
    scheduleSave();
    broadcast();
    if (visibilityChanged) {
        log('INFO', 'crosshair ' + (config.visible ? 'on' : 'off'));
        if (config.visible) ensureDot('turned on', false);
        else closeDot();
    }
}

function broadcast() {
    configSubscribers.forEach(function (msg) {
        msg.respond({ config: config, hdr: hdr, subscribed: true });
    });
}

// ---------------------------------------------------------------------------------------
// HDR detection. The picture settings carry the current dynamic range as a "dimension"
// (seen: "hdrALLM" for HDR10 game content with ALLM), and push a reply when it changes.

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

// ---------------------------------------------------------------------------------------
// The dot app runs only while the crosshair is on.
//
// Off closes it completely: a loaded floating window, even an empty one, stops the Home
// menu from opening. Relaunching a previously loaded web app takes about 0.4 s.

function ensureDot(reason, force) {
    if (!config.visible) return;
    if (UP_STATES.indexOf(powerState) < 0 || launchPending) return;
    if (dotRunning === true && !force) return;

    var now = Date.now();
    launchTimes = launchTimes.filter(function (t) { return now - t < LAUNCH_WINDOW_MS; });
    if (launchTimes.length >= LAUNCH_BUDGET) {
        log('WARN', 'relaunch budget spent, not launching (' + reason + ')');
        return;
    }
    launchTimes.push(now);
    launchPending = true;
    log('INFO', 'launching dot app (' + reason + ')');

    service.call('luna://com.webos.applicationManager/launch',
        { id: DOT_APP_ID, noSplash: true, spinner: false },
        function (reply) {
            launchPending = false;
            if (!reply.payload.returnValue) {
                log('ERROR', 'launch failed: ' + (reply.payload.errorText || 'unknown'));
            }
        });
}

function closeDot() {
    if (dotRunning === false) return;
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
            if (!running) ensureDot('dot app not running', false);
        }
    });
    sub.on('cancel', function () {
        log('WARN', 'running-app subscription dropped, retrying');
        setTimeout(watchRunningApps, 5000);
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
        if (state !== 'Active') return;
        // Semi-sleep restores the window by itself and needs nothing.
        if (UP_STATES.indexOf(previous) >= 0) return;
        // A real power-on: apply the auto-start rule. Standby also clears floating windows
        // even if the app stayed loaded, so relaunch unconditionally: on a loaded app that
        // just remaps its window.
        applyPowerOnRule('wake from ' + previous);
        setTimeout(function () { ensureDot('wake from ' + previous, true); }, WAKE_DELAY_MS);
    });
    sub.on('cancel', function () {
        log('WARN', 'power subscription dropped, retrying');
        setTimeout(watchPower, 5000);
    });
}

// ---------------------------------------------------------------------------------------
// Luna methods.

function setVisible(msg, visible) {
    applyConfig(Config.merge(config, { visible: visible }));
    msg.respond({ visible: config.visible });
}

service.register('getConfig', function (msg) {
    if (msg.isSubscription) configSubscribers.push(msg);
    msg.respond({ config: config, hdr: hdr, subscribed: !!msg.isSubscription });
}, function (msg) {
    var i = configSubscribers.indexOf(msg);
    if (i >= 0) configSubscribers.splice(i, 1);
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
    applyConfig(Config.merge(Config.DEFAULTS,
        { visible: config.visible, autoStart: config.autoStart }));
    msg.respond({ config: config });
});

service.register('show', function (msg) { setVisible(msg, true); });
service.register('hide', function (msg) { setVisible(msg, false); });
service.register('toggle', function (msg) { setVisible(msg, !config.visible); });

service.register('status', function (msg) {
    msg.respond({
        config: config, dotLoaded: dotRunning === true, powerState: powerState,
        hdr: hdr, dynamicRange: dynamicRange
    });
});

service.register('start', function (msg) {
    ensureDot('start', false);
    msg.respond({ started: true });
});

// ---------------------------------------------------------------------------------------

// The keep-alive activity stops webos-service's idle shutdown, but on webOS 10 the bus
// connection doesn't hold Node's event loop open by itself: without a pending timer the
// process exits with code 0 straight after start. One inert timer fixes that.
service.activityManager.create('keepAlive', function () {});
setInterval(function () {}, 0x7fffffff);

process.on('uncaughtException', function (e) {
    log('ERROR', 'uncaught: ' + (e && e.stack || e));
});

function applyPowerOnRule(reason) {
    log('INFO', reason + ': auto-start ' + (config.autoStart ? 'on' : 'off'));
    applyConfig(Config.merge(config, { visible: config.autoStart }));
}

log('INFO', 'service started');
if (!fs.existsSync(BOOT_MARKER)) {
    try { fs.writeFileSync(BOOT_MARKER, ''); } catch (e) { /* worst case: rule runs again */ }
    applyPowerOnRule('boot');
}
watchPower();
watchRunningApps();
watchDynamicRange();

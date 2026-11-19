/*
 * On-TV settings panel, in the same floating window as the crosshair.
 *
 * The window takes the remote only while the panel is open (the needFocus window
 * property); with the panel closed, the remote goes to whatever is underneath. While open,
 * the panel holds a getConfig subscription with panel: true, which tells the service to
 * keep the app loaded even with the crosshair off.
 *
 * Every change goes straight to the service. While the crosshair shows, it shows each
 * change. While it doesn't, this panel draws a preview of it whenever a look setting is
 * selected, with the same drawing code.
 *
 * Remote: Up/Down choose a row, Left/Right change it (hold to speed up), OK toggles or
 * runs it, Back closes. The Magic Remote pointer works too: click a row's arrows, a
 * switch, or the row itself.
 */
(function () {
    'use strict';

    var SERVICE = 'luna://org.abbie.crosshair.service/';
    var C = CrosshairConfig;

    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };
    var HUE_STEP = 5;
    var REPEAT_MS = 300;        //Presses closer than this count as holding the key
    var RETRY_MS = 2000;        //Wait before subscribing again after the service drops

    var isOpen = false;
    var subscription = null;    //The panel's getConfig subscription while open
    var current = null;         //Token of the live subscription; replies to others are dropped
    var retryTimer = 0;
    var config = null;
    var hdr = false;            //The TV is showing HDR, so HDR brightness is in use
    var dotShown = false;       //The crosshair is on screen (the service's show flag)
    var selectedKey = 'visible';
    var requestSeq = 0;         //Sequence number of the newest setConfig sent
    var inFlight = 0;           //Number of setConfig calls not yet answered
    var lastKey = 0;
    var lastKeyTime = 0;
    var repeats = 0;

    var rowsEl = document.getElementById('rows');
    var messageEl = document.getElementById('message');
    var warningEl = document.getElementById('warning');
    var previewEl = document.getElementById('preview');

    function uses(control) {
        return function (c) { return C.SHAPE_INFO[c.shape].uses.indexOf(control) >= 0; };
    }

    function colorName(list, value) {
        for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].name;
        return 'Custom';
    }

    function percent(v) { return Math.round(v * 100) + '%'; }

    var ROWS = [
        { key: 'visible', label: 'Crosshair', type: 'bool' },
        { key: 'autoStart', label: 'Auto-start with TV', type: 'bool' },
        { key: 'tripleOpensSettings', label: 'Triple press opens settings', type: 'bool' },
        { key: 'hideOutsideInputs', label: 'Hide on Home and apps', type: 'bool' },
        { divider: true },
        { key: 'shape', label: 'Shape', type: 'choice', choices: C.SHAPES,
            format: function (v) { return C.SHAPE_NAMES[v]; } },
        { key: 'size', label: 'Size', type: 'number' },
        { key: 'thickness', label: 'Thickness', type: 'number', when: uses('thickness') },
        { key: 'gap', label: 'Gap', type: 'number', when: uses('gap') },
        { divider: true },
        { key: 'color', label: 'Color', type: 'color', choices: C.COLORS },
        { key: 'hue', label: 'Custom color', type: 'hue' },
        { key: 'brightness', label: 'Brightness', type: 'number', format: percent,
            tag: function () { return hdr ? '' : 'in use'; } },
        { key: 'hdrBrightness', label: 'HDR brightness', type: 'number', format: percent,
            tag: function () { return hdr ? 'in use' : ''; } },
        { key: 'opacity', label: 'Opacity', type: 'number', format: percent },
        { divider: true },
        { key: 'outline', label: 'Outline', type: 'bool' },
        { key: 'outlineColor', label: 'Outline color', type: 'color', choices: C.OUTLINE_COLORS,
            when: function (c) { return c.outline; } },
        { key: 'outlineWidth', label: 'Outline width', type: 'number',
            when: function (c) { return c.outline; } },
        { divider: true },
        { key: 'offsetX', label: 'Move left / right', type: 'number' },
        { key: 'offsetY', label: 'Move up / down', type: 'number' },
        { key: 'center', label: 'Center it', type: 'action' },
        { divider: true },
        { key: 'verboseLogging', label: 'Verbose logging', type: 'bool' },
        { divider: true },
        { key: 'reset', label: 'Reset to defaults', type: 'action' },
        { key: 'close', label: 'Close', type: 'action' }
    ];

    function visibleRows() {
        return ROWS.filter(function (r) { return !r.when || r.when(config); });
    }

    function selectableRows() {
        return visibleRows().filter(function (r) { return !r.divider; });
    }

    //-----------------------------------------------------------------------------------
    //Changing values.

    function send(patch) {
        config = C.merge(config, patch);   //Show it at once; the service has the final say
        render();
        var seq = ++requestSeq;
        inFlight++;
        Luna.call(SERVICE + 'setConfig', { config: patch }, function (reply) {
            inFlight--;
            if (reply.returnValue === false) {
                showMessage('Could not save: ' + (reply.errorText || 'service not responding'));
                resync();
                return;
            }
            if (seq === requestSeq) takeConfig(reply.config);
        });
    }

    //Use the service's settings, redrawing only if they differ from what's shown (most
    //replies just confirm the change already drawn)
    function takeConfig(next) {
        if (!next) return;
        var same = !!config;
        for (var key in next) if (!config || next[key] !== config[key]) { same = false; break; }
        config = next;
        if (!same) render();
    }

    //Work out how many steps one press moves, growing while Left/Right is held. Only for
    //settings with long ranges; short ones stay one step per press.
    function stepsFor(row) {
        var range;
        if (row.type === 'hue') range = 360 / HUE_STEP;
        else if (row.type === 'number') {
            var spec = C.NUMBERS[row.key];
            range = (spec.max - spec.min) / spec.step;
        } else return 1;
        if (range < 40) return 1;
        return repeats >= 20 ? 10 : repeats >= 8 ? 5 : repeats >= 3 ? 2 : 1;
    }

    function step(row, dir) {
        var patch = {};
        var v = config[row.key];
        if (row.type === 'bool') {
            //Like a switch: Right turns it on, Left turns it off.
            if (v === (dir > 0)) return;
            patch[row.key] = dir > 0;
        } else if (row.type === 'choice' || row.type === 'color') {
            var list = row.choices.map(function (c) { return typeof c === 'string' ? c : c.value; });
            var i = list.indexOf(v);
            i = (i < 0) ? 0 : (i + dir + list.length) % list.length;
            patch[row.key] = list[i];
        } else if (row.type === 'hue') {
            var hue = C.hexToHue(config.color, HUE_STEP) + dir * HUE_STEP * stepsFor(row);
            patch.color = C.hueToHex(hue);
        } else if (row.type === 'number') {
            patch[row.key] = v + dir * C.NUMBERS[row.key].step * stepsFor(row);
        } else {
            return;
        }
        send(patch);
    }

    function activate(row) {
        if (row.type === 'bool') step(row, config[row.key] ? -1 : 1);
        else if (row.key === 'center') send({ offsetX: 0, offsetY: 0 });
        else if (row.key === 'reset') resetConfig();
        else if (row.key === 'close') close();
    }

    //Grab the service's real values after a failed save, so the panel doesn't keep showing
    //a change that never happened
    function resync() {
        Luna.call(SERVICE + 'getConfig', {}, function (reply) {
            if (inFlight === 0) takeConfig(reply.config);
        });
    }

    function resetConfig() {
        ++requestSeq;
        Luna.call(SERVICE + 'resetConfig', {}, function (reply) {
            takeConfig(reply.config);
        });
    }

    //Take the remote, or hand it back to whatever is underneath
    function setFocus(on) {
        var value = on ? 'true' : 'false';
        try {
            webOSSystem.window.setProperty('needFocus', value);
        } catch (e) {
            try { PalmSystem.setWindowProperty('needFocus', value); } catch (e2) { /* Not on a TV */ }
        }
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        selectedKey = 'visible';
        document.getElementById('panel').hidden = false;
        setFocus(true);
        if (config) render();
        subscribe();
    }

    //Hide the panel and hand back the remote. With the crosshair off there's nothing left
    //to show, so the app closes (the service would close it too once the subscription ends).
    function close() {
        if (!isOpen) return;
        isOpen = false;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
        current = null;
        if (subscription) { subscription.cancel(); subscription = null; }
        document.getElementById('panel').hidden = true;
        CrosshairRender.clear(previewEl);
        setFocus(false);
        if (!dotShown) window.close();
    }

    //-----------------------------------------------------------------------------------
    //Drawing.

    function showMessage(text) {
        messageEl.textContent = text || '';
    }

    //Warn when the service answers but isn't root: settings won't be kept, and the crosshair
    //won't follow the TV's power state reliably.
    function showElevationWarning(show) {
        if (!warningEl || warningEl.hidden === !show) return;
        warningEl.hidden = !show;
        warningEl.textContent = show
            ? 'The service isn’t running as root, so settings may not be kept. ' +
              'On the TV, run elevate-service org.abbie.crosshair.service, then reboot.'
            : '';
        updateScrollFade();
    }

    function valueText(row) {
        var v = config[row.key];
        if (row.type === 'color') return colorName(row.choices, v);
        if (row.type === 'hue') return C.hexToHue(config.color, HUE_STEP) + '°';
        if (row.format) return row.format(v);
        return String(v);
    }

    function swatchColor(row) {
        if (row.type === 'color') return config[row.key];
        if (row.type === 'hue') return C.hueToHex(C.hexToHue(config.color, HUE_STEP));
        return null;
    }

    function switchEl(row) {
        var sw = document.createElement('span');
        sw.className = 'switch' + (config[row.key] ? ' on' : '');
        var knob = document.createElement('span');
        knob.className = 'knob';
        sw.appendChild(knob);
        return sw;
    }

    function arrow(row, dir) {
        var a = document.createElement('span');
        a.className = 'arrow';
        a.textContent = dir < 0 ? '◀' : '▶';
        a.addEventListener('click', function (e) {
            e.stopPropagation();
            selectedKey = row.key;
            repeats = 0;
            step(row, dir);
        });
        return a;
    }

    //Draw a preview whenever a look setting is selected while the crosshair isn't showing
    function renderPreview() {
        var show = !dotShown && C.LOOK_KEYS.indexOf(selectedKey) >= 0;
        if (show) CrosshairRender.draw(previewEl, config, { hdr: hdr });
        else CrosshairRender.clear(previewEl);
    }

    function render() {
        if (!config || !isOpen) return;
        renderRows();
        renderPreview();
    }

    function renderRows() {
        var rows = visibleRows();
        if (!selectableRows().some(function (r) { return r.key === selectedKey; })) {
            selectedKey = 'visible';
        }

        var selectedEl = null;
        rowsEl.textContent = '';
        rows.forEach(function (row) {
            if (row.divider) {
                var d = document.createElement('div');
                d.className = 'divider';
                rowsEl.appendChild(d);
                return;
            }
            var el = document.createElement('div');
            el.className = 'row' + (row.type === 'action' ? ' action' : '') +
                (row.key === selectedKey ? ' selected' : '');
            if (row.key === selectedKey) selectedEl = el;

            var label = document.createElement('span');
            label.className = 'label';
            label.textContent = row.label;
            var tagText = row.tag && row.tag();
            if (tagText) {
                var tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = tagText;
                label.appendChild(tag);
            }
            el.appendChild(label);

            if (row.type === 'bool') {
                var holder = document.createElement('span');
                holder.className = 'value';
                holder.appendChild(switchEl(row));
                el.appendChild(holder);
            } else if (row.type !== 'action') {
                var value = document.createElement('span');
                value.className = 'value';
                value.appendChild(arrow(row, -1));
                var swatch = swatchColor(row);
                if (swatch) {
                    var sw = document.createElement('span');
                    sw.className = 'swatch';
                    sw.style.background = swatch;
                    value.appendChild(sw);
                }
                var text = document.createElement('span');
                text.textContent = valueText(row);
                value.appendChild(text);
                value.appendChild(arrow(row, 1));
                el.appendChild(value);
            }

            el.addEventListener('click', function () {
                selectedKey = row.key;
                activate(row);
                render();
            });
            el.addEventListener('mouseover', function () {
                if (selectedKey !== row.key) { selectedKey = row.key; render(); }
            });
            rowsEl.appendChild(el);
        });

        //Keep the selected row in view, clear of the faded edges, when the list is taller
        //than the panel.
        if (selectedEl) {
            var margin = 80;                    //More than the 56px edge fade
            var top = selectedEl.offsetTop;     //Relative to #rows (the offset parent)
            var bottom = top + selectedEl.offsetHeight;
            if (top < rowsEl.scrollTop + margin) rowsEl.scrollTop = Math.max(0, top - margin);
            else if (bottom > rowsEl.scrollTop + rowsEl.clientHeight - margin) {
                rowsEl.scrollTop = bottom - rowsEl.clientHeight + margin;
            }
        }
        updateScrollFade();
    }

    //Fade the list's top or bottom edge while rows are hidden past it
    function updateScrollFade() {
        var above = rowsEl.scrollTop > 0;
        var below = rowsEl.scrollTop + rowsEl.clientHeight < rowsEl.scrollHeight - 1;
        rowsEl.className = (above ? 'more-above' : '') + (below ? ' more-below' : '');
    }

    //-----------------------------------------------------------------------------------
    //Remote keys.

    function moveSelection(dir) {
        var rows = selectableRows();
        var i = rows.map(function (r) { return r.key; }).indexOf(selectedKey);
        i = Math.min(rows.length - 1, Math.max(0, i + dir));
        selectedKey = rows[i].key;
        render();
    }

    function currentRow() {
        var rows = selectableRows();
        for (var i = 0; i < rows.length; i++) if (rows[i].key === selectedKey) return rows[i];
        return rows[0];
    }

    document.addEventListener('keydown', function (e) {
        if (!isOpen) return;
        var now = Date.now();
        repeats = (e.keyCode === lastKey && now - lastKeyTime < REPEAT_MS) ? repeats + 1 : 0;
        lastKey = e.keyCode;
        lastKeyTime = now;

        if (!config) {
            if (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC) close();
            return;
        }
        switch (e.keyCode) {
        case KEY.UP: moveSelection(-1); break;
        case KEY.DOWN: moveSelection(1); break;
        case KEY.LEFT: step(currentRow(), -1); break;
        case KEY.RIGHT: step(currentRow(), 1); break;
        case KEY.OK: activate(currentRow()); break;
        case KEY.BACK:
        case KEY.ESC: close(); break;
        default: return;
        }
        e.preventDefault();
    }, true);

    rowsEl.addEventListener('wheel', function (e) {
        rowsEl.scrollTop += e.deltaY;
        updateScrollFade();
        e.preventDefault();
    });

    //-----------------------------------------------------------------------------------

    //Follow the service's settings while open. If it drops (reinstall, crash), drop the
    //dead subscription and keep trying, so the panel picks the service back up by itself.
    function subscribe() {
        retryTimer = 0;
        var token = {};
        current = token;
        var handle = Luna.subscribe(SERVICE + 'getConfig', { panel: true }, function (reply) {
            if (token !== current) return;      //Closed, or replaced by a retry
            if (reply.returnValue === false || reply.subscribed === false) {
                showMessage('Crosshair service not responding. Is it installed and elevated?');
                if (handle) handle.cancel();
                subscription = current = null;
                retryTimer = setTimeout(subscribe, RETRY_MS);
                return;
            }
            showMessage('');
            showElevationWarning(reply.elevated === false);
            if (typeof reply.show === 'boolean' && reply.show !== dotShown) {
                dotShown = reply.show;
                if (config) renderPreview();
            }
            if (typeof reply.hdr === 'boolean' && reply.hdr !== hdr) {
                hdr = reply.hdr;
                if (config) render();
            }
            //While our own changes are in flight, the pushes are echoes of older values and
            //would make a held arrow key flicker backwards.
            if (inFlight === 0) takeConfig(reply.config);
        });
        if (token === current) subscription = handle;
    }

    window.CrosshairPanel = { open: open, close: close };
}());

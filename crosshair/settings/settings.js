/*
 * On-TV settings panel.
 *
 * Every change goes straight to the service. While the crosshair is on, the real one
 * (the dot app) shows each change. While it's off, this panel draws a preview of it
 * whenever a look setting is selected, with the same drawing code, in its own full-screen
 * transparent window. Nothing else launches, so the panel keeps the remote.
 *
 * Remote: Up/Down choose a row, Left/Right change it, OK toggles or runs it, Back closes.
 * The Magic Remote pointer works too: click a row's arrows, a switch, or the row itself.
 */
(function () {
    'use strict';

    var SERVICE = 'luna://org.abbie.crosshair.service/';
    var C = CrosshairConfig;

    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };

    var config = null;
    var selectedKey = 'visible';
    var requestSeq = 0;        // newest setConfig sent
    var inFlight = 0;          // setConfig calls not yet answered
    var rowsEl = document.getElementById('rows');
    var messageEl = document.getElementById('message');
    var previewEl = document.getElementById('preview');

    function isCross(c) { return c.shape === 'cross' || c.shape === 'crossdot' || c.shape === 'tcross'; }
    function hasLines(c) { return c.shape !== 'dot'; }

    function colorName(list, value) {
        for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].name;
        return value;
    }

    var ROWS = [
        { key: 'visible', label: 'Crosshair', type: 'bool' },
        { key: 'autoStart', label: 'Auto-start with TV', type: 'bool' },
        { divider: true },
        { key: 'shape', label: 'Shape', type: 'choice', choices: C.SHAPES,
            format: function (v) { return C.SHAPE_NAMES[v]; } },
        { key: 'color', label: 'Color', type: 'color', choices: C.COLORS },
        { key: 'size', label: 'Size', type: 'number' },
        { key: 'thickness', label: 'Thickness', type: 'number', when: hasLines },
        { key: 'gap', label: 'Gap', type: 'number', when: isCross },
        { key: 'opacity', label: 'Opacity', type: 'number',
            format: function (v) { return Math.round(v * 100) + '%'; } },
        { divider: true },
        { key: 'outline', label: 'Outline', type: 'bool' },
        { key: 'outlineColor', label: 'Outline color', type: 'color', choices: C.OUTLINE_COLORS,
            when: function (c) { return c.outline; } },
        { key: 'outlineWidth', label: 'Outline width', type: 'number',
            when: function (c) { return c.outline; } },
        { divider: true },
        { key: 'offsetX', label: 'Move left / right', type: 'number' },
        { key: 'offsetY', label: 'Move up / down', type: 'number' },
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

    // -----------------------------------------------------------------------------------
    // Changing values.

    function send(patch) {
        config = C.merge(config, patch);   // show it at once; the service has the final say
        render();
        var seq = ++requestSeq;
        inFlight++;
        Luna.call(SERVICE + 'setConfig', { config: patch }, function (reply) {
            inFlight--;
            if (reply.returnValue === false) {
                showMessage('Could not save: ' + (reply.errorText || 'service not responding'));
                return;
            }
            if (seq === requestSeq && reply.config) {
                config = reply.config;
                render();
            }
        });
    }

    function step(row, dir) {
        var patch = {};
        var v = config[row.key];
        if (row.type === 'bool') {
            // Like a switch: Right turns it on, Left turns it off.
            if (v === (dir > 0)) return;
            patch[row.key] = dir > 0;
        } else if (row.type === 'choice' || row.type === 'color') {
            var list = row.choices.map(function (c) { return typeof c === 'string' ? c : c.value; });
            var i = list.indexOf(v);
            i = (i < 0) ? 0 : (i + dir + list.length) % list.length;
            patch[row.key] = list[i];
        } else if (row.type === 'number') {
            patch[row.key] = v + dir * C.NUMBERS[row.key].step;
        } else {
            return;
        }
        send(patch);
    }

    function activate(row) {
        if (row.type === 'bool') step(row, config[row.key] ? -1 : 1);
        else if (row.key === 'reset') resetConfig();
        else if (row.key === 'close') close();
    }

    function resetConfig() {
        ++requestSeq;
        Luna.call(SERVICE + 'resetConfig', {}, function (reply) {
            if (reply.config) {
                config = reply.config;
                render();
            }
        });
    }

    function close() {
        window.close();
    }

    // -----------------------------------------------------------------------------------
    // Drawing.

    function showMessage(text) {
        messageEl.textContent = text || '';
    }

    function valueText(row) {
        var v = config[row.key];
        if (row.type === 'color') return colorName(row.choices, v);
        if (row.format) return row.format(v);
        return String(v);
    }

    function switchEl(row) {
        var sw = document.createElement('span');
        sw.className = 'switch' + (config[row.key] ? ' on' : '');
        var knob = document.createElement('span');
        knob.className = 'knob';
        sw.appendChild(knob);
        return sw;
    }

    /* While the crosshair is off, draw it here whenever a look setting is selected. */
    function renderPreview() {
        var show = !config.visible && C.LOOK_KEYS.indexOf(selectedKey) >= 0;
        if (show) CrosshairRender.draw(previewEl, config);
        else CrosshairRender.clear(previewEl);
    }

    function render() {
        if (!config) return;
        renderRows();
        renderPreview();
    }

    function renderRows() {
        var rows = visibleRows();
        if (!selectableRows().some(function (r) { return r.key === selectedKey; })) {
            selectedKey = 'visible';
        }

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

            var label = document.createElement('span');
            label.className = 'label';
            label.textContent = row.label;
            el.appendChild(label);

            if (row.type === 'bool') {
                var holder = document.createElement('span');
                holder.className = 'value';
                holder.appendChild(switchEl(row));
                el.appendChild(holder);
            } else if (row.type !== 'action') {
                var value = document.createElement('span');
                value.className = 'value';

                var left = document.createElement('span');
                left.className = 'arrow';
                left.textContent = '◀';
                left.addEventListener('click', function (e) {
                    e.stopPropagation(); selectedKey = row.key; step(row, -1);
                });

                var text = document.createElement('span');
                text.textContent = valueText(row);

                var right = document.createElement('span');
                right.className = 'arrow';
                right.textContent = '▶';
                right.addEventListener('click', function (e) {
                    e.stopPropagation(); selectedKey = row.key; step(row, 1);
                });

                value.appendChild(left);
                if (row.type === 'color') {
                    var sw = document.createElement('span');
                    sw.className = 'swatch';
                    sw.style.background = config[row.key];
                    value.appendChild(sw);
                }
                value.appendChild(text);
                value.appendChild(right);
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
    }

    // -----------------------------------------------------------------------------------
    // Remote keys.

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

    // -----------------------------------------------------------------------------------

    Luna.subscribe(SERVICE + 'getConfig', {}, function (reply) {
        if (reply.returnValue === false) {
            showMessage('Crosshair service not responding. Is it installed and elevated?');
            return;
        }
        showMessage('');
        // While our own changes are in flight, the pushes are echoes of older values and
        // would make a held arrow key flicker backwards.
        if (reply.config && inFlight === 0) {
            config = reply.config;
            render();
        }
    });
}());

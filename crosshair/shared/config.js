/*
 * Crosshair settings: defaults, limits, and validation.
 *
 * Shared by the service (which owns and stores the settings) and the settings app (which
 * needs the same limits and choices to draw its controls). Written as a UMD-style file so
 * it loads with require() in Node and with a <script> tag in a web app.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CrosshairConfig = factory();
}(this, function () {
    'use strict';

    var SHAPES = ['dot', 'cross', 'crossdot', 'tcross', 'circle', 'circledot'];

    var SHAPE_NAMES = {
        dot: 'Dot',
        cross: 'Cross',
        crossdot: 'Cross + dot',
        tcross: 'T',
        circle: 'Circle',
        circledot: 'Circle + dot'
    };

    var COLORS = [
        { name: 'Green', value: '#00ff00' },
        { name: 'Red', value: '#ff0000' },
        { name: 'Cyan', value: '#00ffff' },
        { name: 'Yellow', value: '#ffff00' },
        { name: 'Magenta', value: '#ff00ff' },
        { name: 'Orange', value: '#ff8000' },
        { name: 'Pink', value: '#ff66cc' },
        { name: 'White', value: '#ffffff' }
    ];

    var OUTLINE_COLORS = [
        { name: 'Black', value: '#000000' },
        { name: 'White', value: '#ffffff' }
    ];

    // Sizes are in the web app's 1920x1080 units. The TV scales them 2x on a 4K panel.
    var NUMBERS = {
        size: { min: 2, max: 64, step: 1 },
        thickness: { min: 1, max: 8, step: 1 },
        gap: { min: 0, max: 32, step: 1 },
        opacity: { min: 0.1, max: 1, step: 0.05 },
        outlineWidth: { min: 1, max: 3, step: 1 },
        offsetX: { min: -300, max: 300, step: 1 },
        offsetY: { min: -300, max: 300, step: 1 }
    };

    // `visible` is the on/off switch. `autoStart` decides what it is after the TV powers on
    // (boot, or wake from standby): on if true, off if false.
    var DEFAULTS = {
        visible: false,
        autoStart: false,
        shape: 'dot',
        color: '#00ff00',
        opacity: 1,
        size: 8,
        thickness: 2,
        gap: 3,
        outline: false,
        outlineColor: '#000000',
        outlineWidth: 1,
        offsetX: 0,
        offsetY: 0
    };

    function clampNumber(key, value) {
        var spec = NUMBERS[key];
        var n = Number(value);
        if (!isFinite(n)) return DEFAULTS[key];
        n = Math.min(spec.max, Math.max(spec.min, n));
        // Snap to the step so repeated adjustments never drift (0.1 + 0.05 + ...).
        n = spec.min + Math.round((n - spec.min) / spec.step) * spec.step;
        return Math.round(n * 1000) / 1000;
    }

    function isColor(value) {
        return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
    }

    /* Returns a complete, valid config: `base` with any valid fields of `patch` applied. */
    function merge(base, patch) {
        var out = {};
        var key;
        base = base || DEFAULTS;
        for (key in DEFAULTS) {
            out[key] = (base[key] === undefined) ? DEFAULTS[key] : base[key];
        }
        patch = patch || {};
        for (key in patch) {
            if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
            var v = patch[key];
            if (key === 'visible' || key === 'autoStart' || key === 'outline') {
                out[key] = v === true;
            } else if (key === 'shape') {
                if (SHAPES.indexOf(v) >= 0) out[key] = v;
            } else if (key === 'color' || key === 'outlineColor') {
                if (isColor(v)) out[key] = v.toLowerCase();
            } else if (NUMBERS[key]) {
                out[key] = clampNumber(key, v);
            }
        }
        return out;
    }

    // Settings that change how the crosshair looks (the settings panel previews these).
    var LOOK_KEYS = ['shape', 'color', 'size', 'thickness', 'gap', 'opacity', 'outline',
        'outlineColor', 'outlineWidth', 'offsetX', 'offsetY'];

    return {
        LOOK_KEYS: LOOK_KEYS,
        SHAPES: SHAPES,
        SHAPE_NAMES: SHAPE_NAMES,
        COLORS: COLORS,
        OUTLINE_COLORS: OUTLINE_COLORS,
        NUMBERS: NUMBERS,
        DEFAULTS: DEFAULTS,
        merge: merge
    };
}));

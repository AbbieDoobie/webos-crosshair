/*
 * Crosshair settings: defaults, limits, validation, and color helpers.
 *
 * Shared by the service (which owns and stores the settings), the settings app (which
 * needs the same limits and choices to draw its controls), and the renderer. Written as a
 * UMD-style file so it loads with require() in Node and with a <script> tag in a web app.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CrosshairConfig = factory();
}(this, function () {
    'use strict';

    // Every shape, in the order the settings panel cycles through them. `uses` lists which
    // size controls mean something for that shape; the panel hides the others.
    var SHAPE_LIST = [
        { id: 'dot', name: 'Dot', uses: [] },
        { id: 'circle', name: 'Circle', uses: ['thickness'] },
        { id: 'circledot', name: 'Circle + dot', uses: ['thickness'] },
        { id: 'arcs', name: 'Broken circle', uses: ['thickness', 'gap'] },
        { id: 'cross', name: 'Cross', uses: ['thickness', 'gap'] },
        { id: 'crossdot', name: 'Cross + dot', uses: ['thickness', 'gap'] },
        { id: 'tcross', name: 'T', uses: ['thickness', 'gap'] },
        { id: 'tdot', name: 'T + dot', uses: ['thickness', 'gap'] },
        { id: 'xcross', name: 'X', uses: ['thickness', 'gap'] },
        { id: 'xdot', name: 'X + dot', uses: ['thickness', 'gap'] },
        { id: 'scope', name: 'Scope', uses: ['thickness', 'gap'] },
        { id: 'hline', name: 'Horizontal line', uses: ['thickness', 'gap'] },
        { id: 'square', name: 'Square', uses: ['thickness'] },
        { id: 'squaredot', name: 'Square + dot', uses: ['thickness'] },
        { id: 'diamond', name: 'Diamond', uses: ['thickness'] },
        { id: 'diamonddot', name: 'Diamond + dot', uses: ['thickness'] },
        { id: 'brackets', name: 'Corner brackets', uses: ['thickness', 'gap'] },
        { id: 'chevron', name: 'Chevron', uses: ['thickness'] },
        { id: 'triangle', name: 'Triangle', uses: ['thickness'] },
        { id: 'fourdots', name: 'Four dots', uses: ['thickness'] },
        { id: 'fivedots', name: 'Five dots', uses: ['thickness'] }
    ];

    var SHAPES = SHAPE_LIST.map(function (s) { return s.id; });
    var SHAPE_NAMES = {};
    var SHAPE_INFO = {};
    SHAPE_LIST.forEach(function (s) { SHAPE_NAMES[s.id] = s.name; SHAPE_INFO[s.id] = s; });

    var COLORS = [
        { name: 'Green', value: '#00ff00' },
        { name: 'Lime', value: '#a0ff00' },
        { name: 'Yellow', value: '#ffff00' },
        { name: 'Orange', value: '#ff8000' },
        { name: 'Red', value: '#ff0000' },
        { name: 'Pink', value: '#ff66cc' },
        { name: 'Magenta', value: '#ff00ff' },
        { name: 'Purple', value: '#9955ff' },
        { name: 'Blue', value: '#3399ff' },
        { name: 'Cyan', value: '#00ffff' },
        { name: 'White', value: '#ffffff' }
    ];

    var OUTLINE_COLORS = [
        { name: 'Black', value: '#000000' },
        { name: 'White', value: '#ffffff' }
    ];

    // Sizes are in the web app's 1920x1080 units: the TV's graphics plane is 1080p, so on a
    // 4K panel each unit is a 2x2 block of physical pixels and half units can't be drawn.
    var NUMBERS = {
        size: { min: 2, max: 96, step: 1 },
        thickness: { min: 1, max: 8, step: 1 },
        gap: { min: 0, max: 32, step: 1 },
        opacity: { min: 0.1, max: 1, step: 0.05 },
        brightness: { min: 0.1, max: 1, step: 0.05 },
        hdrBrightness: { min: 0.1, max: 1, step: 0.05 },
        outlineWidth: { min: 1, max: 3, step: 1 },
        offsetX: { min: -900, max: 900, step: 1 },
        offsetY: { min: -500, max: 500, step: 1 }
    };

    // `visible` is the on/off switch. `autoStart` decides what it is after the TV powers on
    // (boot, or wake from standby): on if true, off if false. `brightness` applies to SDR
    // pictures and `hdrBrightness` to HDR ones, because the TV draws app graphics far
    // brighter while it shows HDR.
    var DEFAULTS = {
        visible: false,
        autoStart: false,
        shape: 'dot',
        color: '#00ff00',
        opacity: 1,
        brightness: 1,
        hdrBrightness: 0.7,
        size: 8,
        thickness: 2,
        gap: 3,
        outline: false,
        outlineColor: '#000000',
        outlineWidth: 1,
        offsetX: 0,
        offsetY: 0
    };

    var BOOLS = ['visible', 'autoStart', 'outline'];

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
            if (BOOLS.indexOf(key) >= 0) {
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

    // ---------------------------------------------------------------------------------------
    // Color helpers.

    function hexToRgb(hex) {
        var n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(rgb) {
        return '#' + rgb.map(function (c) {
            var h = Math.max(0, Math.min(255, Math.round(c))).toString(16);
            return h.length < 2 ? '0' + h : h;
        }).join('');
    }

    /* The color with its brightness scaled (0..1): a darker shade, still fully opaque. */
    function scaleColor(hex, factor) {
        return rgbToHex(hexToRgb(hex).map(function (c) { return c * factor; }));
    }

    /* Fully saturated color for a hue in degrees. */
    function hueToHex(hue) {
        var h = ((hue % 360) + 360) % 360 / 60;
        var x = 1 - Math.abs(h % 2 - 1);
        var rgb = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
            : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
        return rgbToHex(rgb.map(function (c) { return c * 255; }));
    }

    /* Hue in degrees of a color, rounded to `step`; 0 for greys. */
    function hexToHue(hex, step) {
        var rgb = hexToRgb(hex).map(function (c) { return c / 255; });
        var max = Math.max.apply(null, rgb);
        var min = Math.min.apply(null, rgb);
        var d = max - min;
        if (d === 0) return 0;
        var h;
        if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d) % 6;
        else if (max === rgb[1]) h = (rgb[2] - rgb[0]) / d + 2;
        else h = (rgb[0] - rgb[1]) / d + 4;
        h = (h * 60 + 360) % 360;
        step = step || 1;
        return (Math.round(h / step) * step) % 360;
    }

    // Settings that change how the crosshair looks (the settings panel previews these).
    var LOOK_KEYS = ['shape', 'color', 'hue', 'size', 'thickness', 'gap', 'opacity',
        'brightness', 'hdrBrightness', 'outline', 'outlineColor', 'outlineWidth',
        'offsetX', 'offsetY', 'center'];

    return {
        LOOK_KEYS: LOOK_KEYS,
        SHAPES: SHAPES,
        SHAPE_NAMES: SHAPE_NAMES,
        SHAPE_INFO: SHAPE_INFO,
        COLORS: COLORS,
        OUTLINE_COLORS: OUTLINE_COLORS,
        NUMBERS: NUMBERS,
        DEFAULTS: DEFAULTS,
        merge: merge,
        scaleColor: scaleColor,
        hueToHex: hueToHex,
        hexToHue: hexToHue
    };
}));

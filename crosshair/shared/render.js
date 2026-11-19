/*
 * Draws a crosshair into an <svg> sized 1920x1080 (the web-app coordinate space).
 *
 * Shared by the dot app (the real crosshair) and the settings panel (its preview while
 * the crosshair is off), so both put identical pixels in the identical place.
 *
 *   CrosshairRender.draw(svg, config, { hdr: bool })   redraws only if something changed
 *   CrosshairRender.clear(svg)
 *
 * Needs CrosshairConfig (config.js) loaded first.
 *
 * Every part is either a filled shape (rect, polygon, circle) or a stroked one (ring, open
 * or closed path). The outline is the same parts drawn underneath in the outline color:
 * filled parts get a stroke around them, stroked parts get a wider stroke.
 */
(function (root) {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var CX = 960;
    var CY = 540;

    function el(name, attrs) {
        var node = document.createElementNS(SVG_NS, name);
        for (var k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    //Build the parts for one shape, as [{ node, stroke: bool }, ...]
    function parts(c, cx, cy) {
        var s = c.size;
        var t = c.thickness;
        var g = c.gap;
        var half = t / 2;
        var out = [];
        var centerDot = Math.max(2, t * 1.5);

        function fill(node) { out.push({ node: node, stroke: false }); }
        function stroke(node) { out.push({ node: node, stroke: true }); }

        function rect(x, y, w, h) { fill(el('rect', { x: x, y: y, width: w, height: h })); }
        function dot(d, x, y) {
            fill(el('circle', { cx: x === undefined ? cx : x, cy: y === undefined ? cy : y, r: d / 2 }));
        }
        function ring(r, dash) {
            var attrs = { cx: cx, cy: cy, r: r, fill: 'none', 'stroke-width': t };
            if (dash) {
                attrs['stroke-dasharray'] = dash.join(' ');
                attrs['stroke-dashoffset'] = dash.offset;
            }
            stroke(el('circle', attrs));
        }
        //Draw a straight bar of thickness t from (x1,y1) to (x2,y2), as a filled polygon so
        //the outline wraps its ends too.
        function bar(x1, y1, x2, y2) {
            var dx = x2 - x1;
            var dy = y2 - y1;
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            var px = -dy / len * half;
            var py = dx / len * half;
            var pts = [[x1 + px, y1 + py], [x2 + px, y2 + py], [x2 - px, y2 - py], [x1 - px, y1 - py]];
            fill(el('polygon', { points: pts.map(function (p) { return p.join(','); }).join(' ') }));
        }
        function path(points, closed) {
            var d = 'M' + points.map(function (p) { return p.join(','); }).join(' L') + (closed ? ' Z' : '');
            stroke(el('path', {
                d: d, fill: 'none', 'stroke-width': t,
                'stroke-linejoin': 'miter', 'stroke-linecap': closed ? 'butt' : 'square'
            }));
        }

        //Cross arms: length s, starting g from the center.
        function armLeft() { rect(cx - g - s, cy - half, s, t); }
        function armRight() { rect(cx + g, cy - half, s, t); }
        function armDown() { rect(cx - half, cy + g, t, s); }
        function armUp() { rect(cx - half, cy - g - s, t, s); }
        function diagonals() {
            var k = Math.SQRT1_2;
            [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (d) {
                bar(cx + d[0] * g * k, cy + d[1] * g * k,
                    cx + d[0] * (g + s) * k, cy + d[1] * (g + s) * k);
            });
        }

        switch (c.shape) {
        case 'circle':
            ring(s / 2);
            break;
        case 'circledot':
            ring(s / 2);
            dot(centerDot);
            break;
        case 'arcs': {
            //Four arcs with gaps centered on right, bottom, left, and top.
            var r = s / 2;
            var quarter = Math.PI * r / 2;
            var gapLen = Math.min(quarter * 0.8, Math.max(2, g * 2));
            var dash = [quarter - gapLen, gapLen];
            dash.offset = -gapLen / 2;
            ring(r, dash);
            break;
        }
        case 'cross':
        case 'crossdot':
            armLeft(); armRight(); armDown(); armUp();
            if (c.shape === 'crossdot') dot(centerDot);
            break;
        case 'tcross':
        case 'tdot':
            armLeft(); armRight(); armDown();
            if (c.shape === 'tdot') dot(centerDot);
            break;
        case 'xcross':
        case 'xdot':
            diagonals();
            if (c.shape === 'xdot') dot(centerDot);
            break;
        case 'scope': {
            //A ring at radius g + s with cross arms running from the gap out to it.
            var rr = g + s;
            ring(rr);
            armLeft(); armRight(); armDown(); armUp();
            break;
        }
        case 'hline':
            armLeft(); armRight();
            break;
        case 'square':
        case 'squaredot': {
            var h = s / 2;
            rect(cx - h, cy - h, s, t);           //Top
            rect(cx - h, cy + h - t, s, t);       //Bottom
            rect(cx - h, cy - h, t, s);           //Left
            rect(cx + h - t, cy - h, t, s);       //Right
            if (c.shape === 'squaredot') dot(centerDot);
            break;
        }
        case 'diamond':
        case 'diamonddot': {
            var dh = s / 2;
            path([[cx, cy - dh], [cx + dh, cy], [cx, cy + dh], [cx - dh, cy]], true);
            if (c.shape === 'diamonddot') dot(centerDot);
            break;
        }
        case 'brackets': {
            //Four corner brackets around an empty square of half-width g + s/2.
            var b = g + s / 2;
            var arm = Math.max(t * 2, s / 2);
            [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) {
                var x = q[0] < 0 ? cx - b : cx + b - arm;
                var y = q[1] < 0 ? cy - b : cy + b - t;
                rect(x, y, arm, t);
                var vx = q[0] < 0 ? cx - b : cx + b - t;
                var vy = q[1] < 0 ? cy - b : cy + b - arm;
                rect(vx, vy, t, arm);
            });
            break;
        }
        case 'chevron': {
            //A caret (^) whose point sits on the aim point: two bars, plus a small diamond
            //that fills the notch where they meet.
            bar(cx, cy, cx - s / 2, cy + s / 2);
            bar(cx, cy, cx + s / 2, cy + s / 2);
            var k = half * Math.SQRT2;
            fill(el('polygon', { points: [[cx, cy - k], [cx + k, cy], [cx, cy + k], [cx - k, cy]]
                .map(function (p) { return p.join(','); }).join(' ') }));
            break;
        }
        case 'triangle': {
            var tr = s / 2;
            var pts = [-90, 30, 150].map(function (a) {
                var rad = a * Math.PI / 180;
                return [cx + tr * Math.cos(rad), cy + tr * Math.sin(rad)];
            });
            path(pts, true);
            break;
        }
        case 'fourdots':
        case 'fivedots': {
            var dd = Math.max(2, t * 1.5);
            var dr = s / 2;
            dot(dd, cx, cy - dr); dot(dd, cx, cy + dr); dot(dd, cx - dr, cy); dot(dd, cx + dr, cy);
            if (c.shape === 'fivedots') dot(dd);
            break;
        }
        default:
            dot(s);
        }
        return out;
    }

    function clear(svg) {
        svg.__crosshairKey = '';
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    function paint(list, color, extra) {
        list.forEach(function (p) {
            if (p.stroke) {
                p.node.setAttribute('stroke', color);
                if (extra) p.node.setAttribute('stroke-width', Number(p.node.getAttribute('stroke-width')) + extra);
            } else {
                p.node.setAttribute('fill', color);
                if (extra) {
                    p.node.setAttribute('stroke', color);
                    p.node.setAttribute('stroke-width', extra);
                    p.node.setAttribute('stroke-linejoin', 'round');
                }
            }
        });
    }

    function draw(svg, c, opts) {
        var hdr = !!(opts && opts.hdr);
        var key = JSON.stringify(c) + (hdr ? '/hdr' : '');
        if (key === svg.__crosshairKey) return;
        clear(svg);
        svg.__crosshairKey = key;

        var C = root.CrosshairConfig;
        var factor = hdr ? c.hdrBrightness : c.brightness;
        var color = C.scaleColor(c.color, factor);
        var outlineColor = C.scaleColor(c.outlineColor, factor);

        var cx = CX + c.offsetX;
        var cy = CY + c.offsetY;
        //One group carries the opacity so overlapping parts don't double up.
        var group = el('g', { opacity: c.opacity });

        if (c.outline) {
            var under = parts(c, cx, cy);
            paint(under, outlineColor, c.outlineWidth * 2);
            under.forEach(function (p) { group.appendChild(p.node); });
        }
        var over = parts(c, cx, cy);
        paint(over, color, 0);
        over.forEach(function (p) { group.appendChild(p.node); });
        svg.appendChild(group);
    }

    root.CrosshairRender = { draw: draw, clear: clear };
}(this));

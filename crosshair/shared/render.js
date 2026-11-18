/*
 * Draws a crosshair into an <svg> sized 1920x1080 (the web-app coordinate space).
 *
 * Shared by the dot app (the real crosshair) and the settings panel (its preview while
 * the crosshair is off), so both put identical pixels in the identical place.
 *
 *   CrosshairRender.draw(svg, config)   redraws only if the config changed
 *   CrosshairRender.clear(svg)
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

    /* The filled shapes for one shape style. A ring is marked so the outline pass can
       widen its stroke instead of filling it. */
    function parts(c, cx, cy) {
        var t = c.thickness;
        var g = c.gap;
        var len = c.size;
        var half = t / 2;
        var out = [];

        function arm(x, y, w, h) { out.push(el('rect', { x: x, y: y, width: w, height: h })); }
        function dot(d) { out.push(el('circle', { cx: cx, cy: cy, r: d / 2 })); }
        function ring() {
            out.push(el('circle', {
                cx: cx, cy: cy, r: len / 2, fill: 'none',
                stroke: c.color, 'stroke-width': t, 'data-ring': '1'
            }));
        }

        var centreDot = Math.max(2, t * 1.5);

        switch (c.shape) {
        case 'cross':
        case 'crossdot':
        case 'tcross':
            arm(cx - g - len, cy - half, len, t);                            // left
            arm(cx + g, cy - half, len, t);                                  // right
            arm(cx - half, cy + g, t, len);                                  // bottom
            if (c.shape !== 'tcross') arm(cx - half, cy - g - len, t, len);  // top
            if (c.shape === 'crossdot') dot(centreDot);
            break;
        case 'circle':
            ring();
            break;
        case 'circledot':
            ring();
            dot(centreDot);
            break;
        default:
            dot(len);
        }
        return out;
    }

    function clear(svg) {
        svg.__crosshairKey = '';
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }

    function draw(svg, c) {
        var key = JSON.stringify(c);
        if (key === svg.__crosshairKey) return;
        clear(svg);
        svg.__crosshairKey = key;

        var cx = CX + c.offsetX;
        var cy = CY + c.offsetY;
        // One group carries the opacity so overlapping parts don't double up.
        var group = el('g', { opacity: c.opacity, fill: c.color });

        if (c.outline) {
            // The outline is the same shapes drawn underneath, thicker, in the outline color.
            var w = c.outlineWidth * 2;
            parts(c, cx, cy).forEach(function (node) {
                if (node.getAttribute('data-ring')) {
                    node.setAttribute('stroke', c.outlineColor);
                    node.setAttribute('stroke-width', c.thickness + w);
                } else {
                    node.setAttribute('fill', c.outlineColor);
                    node.setAttribute('stroke', c.outlineColor);
                    node.setAttribute('stroke-width', w);
                    node.setAttribute('stroke-linejoin', 'round');
                }
                group.appendChild(node);
            });
        }
        parts(c, cx, cy).forEach(function (node) { group.appendChild(node); });
        svg.appendChild(group);
    }

    root.CrosshairRender = { draw: draw, clear: clear };
}(this));

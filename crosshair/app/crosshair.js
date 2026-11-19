/*
 * The crosshair: draws the service's settings and redraws only when they change. Also
 * decides, from how the app was launched, whether to open the settings panel.
 *
 * Nothing runs between changes: no timers, no animation frames. The drawing is a static
 * SVG that the compositor only has to blend. The service launches this app with
 * { dot: true } to show the crosshair, and closes it when neither the crosshair nor the
 * panel is up. Any other launch (the app list, the triple press) opens the panel.
 */
(function () {
    'use strict';

    var SERVICE = 'luna://org.abbie.crosshair.service/';
    var RETRY_MS = 2000;

    //Nothing is drawn until the service answers, so a crosshair that is meant to be off
    //never flashes up.
    var svg = document.getElementById('crosshair');

    function subscribe() {
        var handle = Luna.subscribe(SERVICE + 'getConfig', {}, function (reply) {
            if (reply.returnValue === false || reply.subscribed === false) {
                //Service restarting (reinstall, crash). Drop the dead subscription so
                //retries don't pile up bridges, then try again shortly.
                if (handle) handle.cancel();
                setTimeout(subscribe, RETRY_MS);
                return;
            }
            if (!reply.config) return;
            if (reply.show) CrosshairRender.draw(svg, reply.config, { hdr: reply.hdr });
            else CrosshairRender.clear(svg);
        });
    }

    function launchParams() {
        var system = window.webOSSystem || window.PalmSystem;
        var text = system && system.launchParams;
        if (!text) return {};
        if (typeof text !== 'string') return text;
        try {
            return JSON.parse(text) || {};
        } catch (e) {
            return {};
        }
    }

    function onLaunch(params) {
        if (!params || !params.dot) CrosshairPanel.open();
    }

    //A launch while the app is already loaded arrives here, with its parameters
    document.addEventListener('webOSRelaunch', function (e) {
        onLaunch(e && e.detail ? e.detail : launchParams());
    });

    subscribe();
    onLaunch(launchParams());
}());

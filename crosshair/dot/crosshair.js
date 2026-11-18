/*
 * The crosshair: draws the service's settings and redraws only when they change.
 *
 * Nothing runs between changes: no timers, no animation frames. The drawing is a static
 * SVG that the compositor only has to blend. The service closes this app when the
 * crosshair is turned off, so `visible` is normally true while it runs.
 */
(function () {
    'use strict';

    var SERVICE = 'luna://org.abbie.crosshair.service/';
    var RETRY_MS = 2000;

    // Nothing is drawn until the service answers, so a crosshair that is meant to be off
    // never flashes up.
    var svg = document.getElementById('crosshair');

    function subscribe() {
        Luna.subscribe(SERVICE + 'getConfig', {}, function (reply) {
            if (reply.returnValue === false || reply.subscribed === false) {
                // Service restarting (reinstall, crash): try again shortly.
                setTimeout(subscribe, RETRY_MS);
                return;
            }
            if (!reply.config) return;
            if (reply.config.visible) CrosshairRender.draw(svg, reply.config);
            else CrosshairRender.clear(svg);
        });
    }

    subscribe();

    // A relaunch (the service re-asserting the window after a wake) needs nothing extra.
    document.addEventListener('webOSRelaunch', function () {}, true);
}());

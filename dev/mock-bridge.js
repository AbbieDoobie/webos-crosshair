/*
 * Development stand-in for webOS's PalmServiceBridge, emulating the crosshair service in
 * memory so the app runs in a desktop browser. Add ?hdr=1 to the page URL to
 * pretend the TV is showing HDR, and ?root=0 to pretend the service isn't elevated.
 */
(function () {
    'use strict';

    var config = CrosshairConfig.merge(CrosshairConfig.DEFAULTS, {});
    var hdr = /[?&]hdr=1/.test(location.search);
    var elevated = !/[?&]root=0/.test(location.search);
    var subscribers = [];

    function reply(bridge, payload) {
        setTimeout(function () { bridge.onservicecallback(JSON.stringify(payload)); }, 10);
    }

    //The real service also hides the crosshair outside inputs; here an input is always in front
    function state(extra) {
        var r = { config: config, show: config.visible, hdr: hdr, elevated: elevated };
        for (var k in extra) r[k] = extra[k];
        return r;
    }

    function broadcast() {
        subscribers.forEach(function (b) { reply(b, state({ subscribed: true })); });
    }

    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function (uri, json) {
        var args = JSON.parse(json);
        var method = uri.split('/').pop();
        if (method === 'getConfig') {
            if (args.subscribe) subscribers.push(this);
            reply(this, state({ subscribed: !!args.subscribe, returnValue: true }));
        } else if (method === 'setConfig') {
            config = CrosshairConfig.merge(config, args.config);
            reply(this, { config: config, returnValue: true });
            broadcast();
        } else if (method === 'resetConfig') {
            config = CrosshairConfig.merge(CrosshairConfig.DEFAULTS,
                { visible: config.visible, autoStart: config.autoStart,
                  tripleOpensSettings: config.tripleOpensSettings,
                  hideOutsideInputs: config.hideOutsideInputs,
                  verboseLogging: config.verboseLogging });
            reply(this, { config: config, returnValue: true });
            broadcast();
        } else {
            reply(this, { returnValue: false, errorText: 'mock: unknown method ' + method });
        }
    };
    window.PalmServiceBridge.prototype.cancel = function () {
        var i = subscribers.indexOf(this);
        if (i >= 0) subscribers.splice(i, 1);
    };
}());

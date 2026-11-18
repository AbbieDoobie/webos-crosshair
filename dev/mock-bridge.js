/*
 * Development stand-in for webOS's PalmServiceBridge, emulating the crosshair service in
 * memory so the settings panel runs in a desktop browser. Add ?hdr=1 to the page URL to
 * pretend the TV is showing HDR.
 */
(function () {
    'use strict';

    var config = CrosshairConfig.merge(CrosshairConfig.DEFAULTS, {});
    var hdr = /[?&]hdr=1/.test(location.search);
    var subscribers = [];

    function reply(bridge, payload) {
        setTimeout(function () { bridge.onservicecallback(JSON.stringify(payload)); }, 10);
    }

    function broadcast() {
        subscribers.forEach(function (b) { reply(b, { config: config, hdr: hdr, subscribed: true }); });
    }

    window.PalmServiceBridge = function () {};
    window.PalmServiceBridge.prototype.call = function (uri, json) {
        var args = JSON.parse(json);
        var method = uri.split('/').pop();
        if (method === 'getConfig') {
            if (args.subscribe) subscribers.push(this);
            reply(this, { config: config, hdr: hdr, subscribed: !!args.subscribe, returnValue: true });
        } else if (method === 'setConfig') {
            config = CrosshairConfig.merge(config, args.config);
            reply(this, { config: config, returnValue: true });
            broadcast();
        } else if (method === 'resetConfig') {
            config = CrosshairConfig.merge(CrosshairConfig.DEFAULTS,
                { visible: config.visible, autoStart: config.autoStart,
                  tripleOpensSettings: config.tripleOpensSettings });
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

/*
 * Minimal Luna bus client for webOS web apps, over PalmServiceBridge.
 *
 *   Luna.call(uri, params, callback)       one reply
 *   Luna.subscribe(uri, params, callback)  a reply per change; returns { cancel() }
 *
 * A bridge object must stay referenced until its replies arrive, so every request is held
 * in `live`: a one-shot call until its reply, a subscription until cancelled.
 */
(function (root) {
    'use strict';

    var live = [];

    function request(uri, params, callback, subscribe) {
        if (typeof PalmServiceBridge === 'undefined') {
            if (callback) callback({ returnValue: false, errorText: 'PalmServiceBridge unavailable' });
            return { cancel: function () {} };
        }
        var bridge = new PalmServiceBridge();
        var args = {};
        for (var k in (params || {})) args[k] = params[k];
        if (subscribe) args.subscribe = true;

        var handle = {
            cancel: function () {
                try { bridge.cancel(); } catch (e) { /* already gone */ }
                drop();
            }
        };

        function drop() {
            var i = live.indexOf(handle);
            if (i >= 0) live.splice(i, 1);
        }

        bridge.onservicecallback = function (text) {
            var payload;
            try {
                payload = JSON.parse(text);
            } catch (e) {
                payload = { returnValue: false, errorText: 'Bad reply: ' + text };
            }
            if (!subscribe) drop();
            if (callback) callback(payload);
        };

        live.push(handle);
        bridge.call(uri, JSON.stringify(args));
        return handle;
    }

    root.Luna = {
        call: function (uri, params, callback) { return request(uri, params, callback, false); },
        subscribe: function (uri, params, callback) { return request(uri, params, callback, true); }
    };
}(this));

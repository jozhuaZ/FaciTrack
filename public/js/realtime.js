/**
 * Subscribing to server-sent events, in one place.
 *
 * The notification panel grew its own copy of this; anything new should use
 * this instead so a change to how the connection is made happens once.
 *
 *     Realtime.on('presence:changed', function (payload) { ... });
 *
 * Prefers the SharedWorker so every open tab shares one connection. Browsers
 * without SharedWorker — several mobile ones — fall back to an EventSource per
 * tab, which costs a connection but behaves identically to the caller.
 */
(function (global) {
    'use strict';

    // Loaded globally from partials/script.ejs, and again by the pages that
    // included it before that was true. Running twice would replace the
    // registry and silently drop every handler registered against the first
    // copy, so the second load leaves the working one alone.
    if (global.Realtime) return;

    var handlers = {};
    var started = false;
    var connected = false;
    var pollTimer = null;
    var lastSeenId = 0;
    var lastPresenceVersion = null;

    // Often enough to feel live, rarely enough that a tab left open all day is
    // not thousands of requests. Only used where the stream cannot be held.
    var POLL_EVERY_MS = 15000;

    function emit(type, payload) {
        (handlers[type] || []).forEach(function (fn) {
            try { fn(payload); } catch (err) { console.error('[Realtime] handler for ' + type + ':', err); }
        });
    }

    /**
     * Ask for what arrived since last time.
     *
     * Each notification is emitted exactly as the stream would have sent it,
     * so nothing subscribing through Realtime.on() can tell the difference.
     *
     * presence:changed is different: on a stream it carries the change that
     * just happened, but a poll only ever sees "what is true now". Replaying a
     * stale event would be worse than none, so the poll carries a fingerprint
     * of the presence tables instead and emits presence:changed when it moves.
     * Subscribers re-read the roster themselves; nothing is inferred from the
     * event. That is what keeps the dean's boards current on a host that
     * answers the stream with 204.
     */
    function pollOnce() {
        return fetch('/notifications/poll?after=' + lastSeenId, { credentials: 'same-origin' })
            .then(function (res) {
                if (!res.ok) throw new Error('poll failed: ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (!connected) { connected = true; emit('connection:open'); }
                (data.notifications || []).forEach(function (n) {
                    if (n.id > lastSeenId) lastSeenId = n.id;
                    emit('notification:new', n);
                });

                if (data.presenceVersion && data.presenceVersion !== lastPresenceVersion) {
                    lastPresenceVersion = data.presenceVersion;
                    emit('presence:changed', null);
                }
            })
            .catch(function () {
                if (connected) { connected = false; emit('connection:error'); }
            });
    }

    function startPolling() {
        if (pollTimer) return;
        console.info('[Realtime] Using polling; this host does not hold streams open.');

        // Learn the current high-water mark before emitting anything, so the
        // first poll does not replay every notification the user already has
        // as though it just arrived. The presence fingerprint is seeded the
        // same way: the page has just been rendered, so nothing has changed
        // yet, and the first real change is what should trigger a re-read.
        fetch('/notifications/poll?after=0', { credentials: 'same-origin' })
            .then(function (res) { return res.ok ? res.json() : { notifications: [] }; })
            .then(function (data) {
                (data.notifications || []).forEach(function (n) {
                    if (n.id > lastSeenId) lastSeenId = n.id;
                });
                lastPresenceVersion = data.presenceVersion || null;
                connected = true;
                emit('connection:open');
            })
            .catch(function () { /* the interval below will retry */ })
            .then(function () {
                pollTimer = setInterval(pollOnce, POLL_EVERY_MS);
                // A tab brought back to the foreground should not wait out the
                // interval before catching up.
                global.document.addEventListener('visibilitychange', function () {
                    if (!global.document.hidden) pollOnce();
                });
            });
    }

    function start() {
        if (started) return;
        started = true;

        if (global.SharedWorker) {
            try {
                var worker = new SharedWorker('/js/notif-shared-worker.js');
                worker.port.start();
                worker.port.onmessage = function (e) {
                    if (!e.data || !e.data.type) return;
                    if (e.data.type === 'connection:open') connected = true;
                    if (e.data.type === 'connection:error') connected = false;

                    // The worker's stream closed for good rather than dropping
                    // — this host does not hold them open. Poll from here.
                    if (e.data.type === 'connection:closed') {
                        connected = false;
                        startPolling();
                        return;   // not an event anything subscribes to
                    }

                    if (e.data.type === 'notification:new' && e.data.payload &&
                        e.data.payload.id > lastSeenId) {
                        lastSeenId = e.data.payload.id;
                    }
                    emit(e.data.type, e.data.payload);
                };
                global.addEventListener('beforeunload', function () {
                    try { worker.port.postMessage('close'); } catch (err) { /* closing anyway */ }
                });
                return;
            } catch (err) {
                // Some browsers expose SharedWorker but refuse to construct it
                console.warn('[Realtime] SharedWorker unavailable, using a direct stream:', err.message);
            }
        }

        var stream = new EventSource('/notifications/stream');
        ['notification:new', 'presence:changed'].forEach(function (name) {
            stream.addEventListener(name, function (e) {
                var payload = null;
                try { payload = JSON.parse(e.data); } catch (err) { payload = e.data; }
                if (name === 'notification:new' && payload && payload.id > lastSeenId) {
                    lastSeenId = payload.id;
                }
                emit(name, payload);
            });
        });
        stream.onopen = function () { connected = true; emit('connection:open'); };
        stream.onerror = function () {
            connected = false;
            emit('connection:error');

            // readyState CLOSED means the browser has given up rather than
            // scheduled a retry — which is what a host that cannot hold a
            // stream open answers with. Polling takes over from here.
            if (stream.readyState === EventSource.CLOSED) startPolling();
        };
    }

    global.Realtime = {
        /** Register a handler. The connection opens on the first subscription. */
        on: function (type, handler) {
            (handlers[type] = handlers[type] || []).push(handler);
            start();
            return this;
        },
        isConnected: function () { return connected; },
    };
})(window);

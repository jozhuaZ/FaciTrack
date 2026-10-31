/**
 * Keeps In/Out badges current, on any page that shows them.
 *
 * The server already broadcasts `presence:changed` the moment a scanner
 * reports someone arriving or leaving. Two pages listened; the rest were
 * accurate only at the instant they were rendered. This subscribes once and
 * repaints, so a student is not left reading that somebody is In twenty
 * minutes after they left.
 *
 * Two ways to use it, because the pages differ:
 *
 *   Markup — put data-presence-for="<instructor public id>" on the element,
 *   and this rewrites its presence class and, if it carries
 *   data-presence-text, its label. Enough for a server-rendered badge.
 *
 *   PresenceLive.onUpdate(fn) — for pages that build their own DOM from an
 *   array and need to regroup or recount rather than swap a class.
 *
 * Presence and availability stay separate here exactly as they do on the
 * server: both are published, neither is derived from the other.
 */
(function (global) {
    'use strict';

    var ENDPOINT = '/presence/faculty.json';

    // A scanner going quiet sends nothing at all, so only elapsed time reveals
    // that somebody's tag stopped reporting. The stream — or, where the host
    // cannot hold one, Realtime's poll fingerprint — covers the rest.
    var BACKSTOP_MS = 60000;

    var PRESENCE_CLASSES = ['in-room', 'out-of-room', 'unknown'];
    var PRESENCE_TEXT = { 'in-room': 'In Room', 'out-of-room': 'Out', unknown: 'No data' };

    var handlers = [];
    var latest = new Map();
    var fetching = false;

    function paintElement(el, entry) {
        PRESENCE_CLASSES.forEach(function (c) { el.classList.remove(c); });
        el.classList.add(entry.presence);

        if (el.hasAttribute('data-presence-text')) {
            // An explicit label wins, so a page can say "In" where the shared
            // wording would say "In Room".
            var custom = el.getAttribute('data-presence-text-' + entry.presence);
            el.textContent = custom || PRESENCE_TEXT[entry.presence] || PRESENCE_TEXT.unknown;
        }
    }

    function paint(faculty) {
        latest = new Map(faculty.map(function (f) { return [f.id, f]; }));

        document.querySelectorAll('[data-presence-for]').forEach(function (el) {
            var entry = latest.get(el.getAttribute('data-presence-for'));
            if (entry) paintElement(el, entry);
        });

        handlers.forEach(function (fn) {
            try { fn(faculty); } catch (err) { console.error('[PresenceLive] handler:', err); }
        });
    }

    function refresh() {
        // document.hidden: a backgrounded tab does not need to keep polling,
        // and will refresh on the next event or when it comes back.
        if (fetching || document.hidden) return;
        fetching = true;

        fetch(ENDPOINT, { cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { if (data && data.success) paint(data.faculty); })
            .catch(function () { /* the next event or the backstop will retry */ })
            .then(function () { fetching = false; });
    }

    if (global.Realtime) global.Realtime.on('presence:changed', refresh);
    setInterval(refresh, BACKSTOP_MS);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refresh();
    });

    global.PresenceLive = {
        /** Called with the whole roster whenever presence changes. */
        onUpdate: function (fn) { handlers.push(fn); return this; },
        /** Ask now — for a page that has just re-rendered and wants current state. */
        refresh: refresh,
        /** The last known entry for one instructor, or null. */
        get: function (publicId) { return latest.get(publicId) || null; },
    };
}(window));

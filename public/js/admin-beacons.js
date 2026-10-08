/**
 * Admin → BLE Devices.
 *
 * Assigning tags, tuning a room's threshold, and keeping the health view true.
 *
 * The page used to reload itself on a timer, which threw away scroll position
 * and flashed the whole screen every twenty seconds. Now a `presence:changed`
 * event nudges it and only the affected cells are rewritten. A slow poll stays
 * as a backstop, because a scanner going *silent* produces no event — and the
 * absence of news is exactly what a health page has to notice.
 */
(function () {
    'use strict';

    // The server owns these rules and hands them over; the page only applies them
    var SCANNER_OFFLINE_AFTER = window.__SCANNER_OFFLINE_AFTER__ || 60;
    var TAG_OFFLINE_AFTER = window.__TAG_OFFLINE_AFTER__ || 120;

    // Staleness is now decided locally every few seconds, so this poll exists
    // only to pick up data that genuinely changed on the server.
    var BACKSTOP_MS = 30000;

    function showToast(type, title, message) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.innerHTML = '<div class="toast-content"><p class="toast-title"></p><p class="toast-message"></p></div>';
        toast.querySelector('.toast-title').textContent = title;
        toast.querySelector('.toast-message').textContent = message;
        container.appendChild(toast);
        setTimeout(function () {
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 4000);
    }

    function send(url, method, body) {
        return fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        })
            .then(function (res) { return res.json().catch(function () { return {}; }); })
            .catch(function () { return { success: false, error: 'Network error. Please try again.' }; });
    }

    /* ── Relative times ── */

    function timeAgo(iso) {
        var seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (isNaN(seconds)) return '—';
        if (seconds < 5) return 'just now';
        if (seconds < 60) return seconds + 's ago';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
        return Math.floor(seconds / 86400) + 'd ago';
    }

    /** "2h 14m" — a scanner's uptime falling is how you spot a reboot. */
    function uptime(seconds) {
        seconds = Number(seconds) || 0;
        if (!seconds) return '—';
        var d = Math.floor(seconds / 86400);
        var h = Math.floor((seconds % 86400) / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        if (d) return d + 'd ' + h + 'h';
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm';
        return seconds + 's';
    }

    function paint() {
        document.querySelectorAll('[data-since]').forEach(function (el) {
            el.textContent = timeAgo(el.dataset.since);
        });
        document.querySelectorAll('[data-uptime]').forEach(function (el) {
            el.textContent = uptime(el.dataset.uptime);
        });
        evaluateStaleness();
    }

    /**
     * Decide online/offline here rather than waiting for the server.
     *
     * Going *offline* is the absence of a report, so nothing ever arrives to
     * announce it — an event-driven page would sit on a stale "Online" until
     * the next poll. But staleness is only elapsed time against a last-seen
     * stamp the page already has, so it can be worked out locally, every few
     * seconds, without asking anyone.
     *
     * The server still owns the rule; it hands over the cutoffs and this
     * applies them. A refresh overwrites these stamps with fresher ones.
     */
    function evaluateStaleness() {
        var now = Date.now();

        function ageOf(row) {
            var since = row.querySelector('[data-since]');
            if (!since || !since.dataset.since) return null;
            var ms = new Date(since.dataset.since).getTime();
            return isNaN(ms) ? null : (now - ms) / 1000;
        }

        var scannersOnline = 0;
        var scanners = document.querySelectorAll('tr[data-room-id]');
        scanners.forEach(function (tr) {
            var age = ageOf(tr);
            var online = age !== null && age <= SCANNER_OFFLINE_AFTER;
            if (online) scannersOnline++;
            tr.classList.toggle('is-offline', !online);
            setPill(tr.cells[0], online, 'Online', 'Offline');
        });

        var tagsOnline = 0;
        document.querySelectorAll('tr[data-id]').forEach(function (tr) {
            var age = ageOf(tr);
            var online = age !== null && age <= TAG_OFFLINE_AFTER;
            if (online) tagsOnline++;
            tr.classList.toggle('is-offline', !online);
            setPill(tr.cells[0], online, 'Live', 'Quiet');
        });

        // The tiles count the same rows, so they cannot disagree with them
        var tiles = document.querySelectorAll('.bx-stat .bx-stat-value');
        if (tiles[0]) tiles[0].innerHTML = scannersOnline + '<span>/' + scanners.length + '</span>';
        if (tiles[2]) tiles[2].textContent = tagsOnline;

        var first = document.querySelector('.bx-stat');
        if (first) {
            first.classList.remove('good', 'warn', 'bad');
            first.classList.add(scanners.length && scannersOnline === scanners.length ? 'good'
                : (scannersOnline ? 'warn' : 'bad'));
        }
    }

    /* ── Live refresh ──
       Only changed values are rewritten. Rebuilding the tables would destroy a
       half-typed label or an open dropdown, which is the whole reason the
       reload was worth removing in the first place. */

    var refreshing = false;

    function isEditing() {
        // An open signal modal counts as busy too: a full reload while somebody
        // is reading a tag's history to set a threshold throws away what they
        // came for, and a newly discovered tag can wait for them to finish.
        var modal = document.getElementById('signalModal');
        if (modal && !modal.hidden) return true;

        var el = document.activeElement;
        return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT');
    }

    function setPill(cell, online, onText, offText) {
        var pill = cell.querySelector('.bx-pill');
        if (!pill) return;
        pill.classList.toggle('ok', online);
        pill.classList.toggle('off', !online);
        pill.textContent = online ? onText : offText;
    }

    function applyScanners(rows) {
        rows.forEach(function (s) {
            var tr = document.querySelector('tr[data-room-id="' + s.room_id + '"]');
            if (!tr) return;
            var since = tr.querySelector('[data-since]');
            if (since) { since.dataset.since = s.last_seen_at; since.textContent = timeAgo(s.last_seen_at); }

            var up = tr.querySelector('[data-uptime]');
            if (up) { up.dataset.uptime = s.last_uptime_sec || 0; up.textContent = uptime(s.last_uptime_sec); }

            var hearing = tr.cells[5];
            if (!hearing) return;
            if (s.tags_heard) {
                hearing.innerHTML = '<span class="bx-range"></span><span class="bx-muted bx-sub"></span>';
                hearing.querySelector('.bx-range').textContent = s.strongest + ' … ' + s.weakest + ' dBm';
                hearing.querySelector('.bx-sub').textContent =
                    s.tags_heard + ' assigned tag' + (s.tags_heard === 1 ? '' : 's') + ' in 5 min';
            } else {
                hearing.innerHTML = '<span class="bx-muted">nothing heard</span>';
            }
        });
    }

    function applyTags(rows) {
        rows.forEach(function (b) {
            var tr = document.querySelector('tr[data-id="' + b.id + '"]');
            if (!tr) return;
            var statusCell = tr.cells[0];

            // The in-room pill comes and goes as people move
            var inRoom = statusCell.querySelector('.bx-pill.in-room');
            if (b.instructor_id && b.is_present) {
                if (!inRoom) {
                    inRoom = document.createElement('span');
                    inRoom.className = 'bx-pill in-room';
                    statusCell.appendChild(inRoom);
                }
                inRoom.textContent = 'In ' + (b.present_room || 'room');
            } else if (inRoom) {
                inRoom.remove();
            }

            var since = tr.querySelector('[data-since]');
            if (since && b.last_seen_at) {
                since.dataset.since = b.last_seen_at;
                since.textContent = timeAgo(b.last_seen_at);
            }

            var signal = tr.querySelector('.bx-signal');
            if (signal && b.last_rssi !== null && b.last_rssi !== undefined) {
                signal.textContent = b.last_rssi + ' dBm';
                var strong = b.last_rssi >= (window.__RSSI_THRESHOLD__ || -75);
                signal.classList.toggle('strong', strong);
                signal.classList.toggle('weak', !strong);
            }
        });
    }

    /** Only the counts staleness does not own — the rest is worked out locally. */
    function applyStats(stats) {
        var tiles = document.querySelectorAll('.bx-stat .bx-stat-value');
        if (tiles[1]) tiles[1].innerHTML = stats.tagsAssigned + '<span>/' + stats.tagsTotal + '</span>';
    }

    function refresh() {
        if (refreshing || document.hidden) return;
        refreshing = true;

        fetch('/admin/beacons.json')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) return;

                // Patching only ever rewrites status, times and signal — never a
                // label or a dropdown — so it is safe to do while someone types.
                applyScanners(data.scanners);
                applyTags(data.beacons);
                applyStats(data.stats);
                // The window can lapse, or be closed from another browser, so
                // the card follows the server rather than a local timer.
                paintDiscovery(data.discovery);
                applyCounts(data.counts);
                evaluateStaleness();

                // A tag or scanner that did not exist when the page rendered has
                // no row to patch, and only server-rendered markup will do. That
                // full load waits until nobody is mid-edit, so an arriving tag
                // never throws away a half-typed label.
                var isNew = data.beacons.some(function (b) {
                    return !document.querySelector('tr[data-id="' + b.id + '"]');
                }) || data.scanners.some(function (s) {
                    return s.room_id && !document.querySelector('tr[data-room-id="' + s.room_id + '"]');
                });
                if (isNew && !isEditing()) location.reload();
            })
            .catch(function () { /* the backstop will try again */ })
            .finally(function () { refreshing = false; });
    }

    /* ── Actions ── */

    document.addEventListener('click', function (e) {
        var button = e.target.closest('[data-action]');
        if (!button) return;

        var row = button.closest('tr');
        var id = row.dataset.id;

        if (button.dataset.action === 'save') {
            button.disabled = true;
            send('/admin/beacons/' + id, 'PATCH', {
                instructorId: row.querySelector('[data-field="instructor"]').value || null,
                label: row.querySelector('[data-field="label"]').value.trim(),
            }).then(function (data) {
                button.disabled = false;
                if (!data.success) return showToast('error', 'Not saved', data.error || 'Could not save the tag.');
                row.classList.toggle('unassigned', !row.querySelector('[data-field="instructor"]').value);
                showToast('success', 'Saved', 'Tag updated.');
            });
        }

        if (button.dataset.action === 'save-threshold') {
            var roomId = row.dataset.roomId;
            var field = row.querySelector('[data-field="threshold"]');
            button.disabled = true;
            send('/admin/rooms/' + roomId + '/threshold', 'PATCH', { threshold: field.value.trim() })
                .then(function (data) {
                    button.disabled = false;
                    if (!data.success) return showToast('error', 'Not saved', data.error || 'Could not save the threshold.');
                    var note = row.querySelector('[data-threshold-note]');
                    if (note) note.textContent = data.threshold === null ? 'using the default' : 'tuned for this room';
                    showToast('success', 'Saved',
                        data.threshold === null
                            ? 'This room follows the default again.'
                            : 'This room now uses ' + data.threshold + ' dBm.');
                });
        }

        if (button.dataset.action === 'signal') {
            openSignal(id, row);
        }

        if (button.dataset.action === 'remove') {
            // Safe: the tag reappears unassigned the next time a scanner hears
            // it, so this is undone by leaving it switched on.
            if (!confirm('Forget this tag? It will reappear unassigned if a scanner hears it again.')) return;
            send('/admin/beacons/' + id, 'DELETE').then(function (data) {
                if (!data.success) return showToast('error', 'Not removed', data.error || 'Could not remove the tag.');
                row.remove();
                showToast('success', 'Removed', 'Tag forgotten.');
            });
        }
    });


    /* ── Signal history ───────────────────────────────────────────────────
       What a threshold gets set from. The tag's readings are not summarised
       into a single average anywhere here: an average flatters, and the number
       that matters is the weak end, because that is what a threshold has to
       clear when somebody turns their back on the scanner.
       ─────────────────────────────────────────────────────────────────────── */

    var signalModal = document.getElementById('signalModal');
    var signalBody = document.getElementById('signalBody');
    var signalTitle = document.getElementById('signalTitle');
    var signalSubtitle = document.getElementById('signalSubtitle');
    var signalWindow = document.getElementById('signalWindow');
    var openBeaconId = null;

    function esc(text) {
        var d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    /** A tiny line chart. No library: it is one series of integers. */
    function sparkline(series, threshold, exitThreshold) {
        if (series.length < 2) return '';

        var W = 600, H = 80, PAD = 4;
        var values = series.map(function (s) { return s.rssi; });
        var lo = Math.min.apply(null, values.concat([exitThreshold]));
        var hi = Math.max.apply(null, values.concat([threshold]));
        if (hi === lo) hi = lo + 1;

        var y = function (v) { return PAD + (hi - v) / (hi - lo) * (H - PAD * 2); };
        var x = function (i) { return i / (series.length - 1) * W; };

        var path = values.map(function (v, i) {
            return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
        }).join(' ');

        return '<svg class="bx-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
            '<line x1="0" x2="' + W + '" y1="' + y(threshold).toFixed(1) + '" y2="' + y(threshold).toFixed(1) +
                '" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 4"/>' +
            '<line x1="0" x2="' + W + '" y1="' + y(exitThreshold).toFixed(1) + '" y2="' + y(exitThreshold).toFixed(1) +
                '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 4"/>' +
            '<path d="' + path + '" fill="none" stroke="#2563eb" stroke-width="2" ' +
                'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
            '</svg>' +
            '<div class="bx-spark-key">' +
            '<span><i style="background:#2563eb"></i>signal</span>' +
            '<span><i style="background:#dc2626"></i>enter at ' + threshold + '</span>' +
            '<span><i style="background:#f59e0b"></i>leave below ' + exitThreshold + '</span>' +
            '</div>';
    }

    /** Say plainly whether this room's threshold fits these readings. */
    function verdict(room) {
        var weakShare = room.samples ? room.belowEnter / room.samples : 0;

        // No threshold can rescue a tag the scanner can barely hear. Offering a
        // number here would be worse than useless — it would look like a fix.
        if (room.belowScannerFloor) {
            return '<div class="bx-sig-verdict bad">' +
                '<strong>This is too weak to fix with a threshold.</strong> The readings here run down to ' +
                room.min + ' dBm, and the scanner discards anything below −85, so there is no cutoff that would ' +
                'hold this tag reliably. Raise the tag&rsquo;s transmit power in BeaconSET+, move the scanner closer ' +
                'or out into the open, or check the tag is not being worn behind somebody.</div>';
        }

        if (room.belowExit > 0) {
            return '<div class="bx-sig-verdict bad">' +
                '<strong>This threshold is too tight.</strong> ' + room.belowExit + ' of ' + room.samples +
                ' readings fell below even the exit line of ' + room.exitThreshold + ' dBm, so this tag drops out ' +
                'of the room while sitting still. Try <strong>' + room.suggested + ' dBm</strong>, which clears every ' +
                'reading in this window — provided nothing outside the room reads stronger than that.</div>';
        }
        if (weakShare > 0.2) {
            return '<div class="bx-sig-verdict warn">' +
                '<strong>The margin is doing the work.</strong> ' + room.belowEnter + ' of ' + room.samples +
                ' readings are under the ' + room.threshold + ' dBm enter line; only the exit margin is keeping ' +
                'this tag in the room. That holds, but somebody arriving would struggle to be picked up. ' +
                '<strong>' + room.suggested + ' dBm</strong> would fit these readings with room to spare.</div>';
        }
        return '<div class="bx-sig-verdict good">' +
            '<strong>This threshold fits.</strong> ' + (room.samples - room.belowEnter) + ' of ' + room.samples +
            ' readings clear ' + room.threshold + ' dBm with the weakest at ' + room.min + '.</div>';
    }

    function renderSignal(data) {
        if (!data.rooms.length) {
            signalBody.innerHTML = '<p class="bx-empty">No readings in this window. ' +
                'The tag has to be heard by a scanner before there is anything to tune against.</p>';
            return;
        }

        signalBody.innerHTML = data.rooms.map(function (room) {
            var series = data.series.filter(function (s) { return s.room === room.room; });
            return '<div class="bx-sig-room">' +
                '<h4>' + esc(room.room) + '</h4>' +
                '<span class="bx-muted bx-sub">' + room.samples + ' readings · threshold ' + room.threshold +
                    ' dBm (' + room.thresholdSource + ')</span>' +
                '<div class="bx-sig-grid">' +
                    '<div class="bx-sig-cell weak"><span>Weakest</span><strong>' + room.min + '</strong></div>' +
                    '<div class="bx-sig-cell weak"><span>10th pct</span><strong>' + room.p10 + '</strong></div>' +
                    '<div class="bx-sig-cell"><span>Median</span><strong>' + room.median + '</strong></div>' +
                    '<div class="bx-sig-cell"><span>Strongest</span><strong>' + room.max + '</strong></div>' +
                '</div>' +
                sparkline(series, room.threshold, room.exitThreshold) +
                verdict(room) +
                '</div>';
        }).join('');
    }

    function loadSignal() {
        if (!openBeaconId) return;
        signalBody.innerHTML = '<p class="bx-empty">Loading readings…</p>';
        send('/admin/beacons/' + openBeaconId + '/signal?minutes=' + signalWindow.value)
            .then(function (data) {
                if (!data.success) {
                    signalBody.innerHTML = '<p class="bx-empty">Could not load the readings.</p>';
                    return;
                }
                renderSignal(data);
            });
    }

    function openSignal(id, row) {
        openBeaconId = id;
        var label = row.querySelector('[data-field="label"]').value.trim();
        var mac = row.querySelector('.bx-mono').textContent.trim();
        var select = row.querySelector('[data-field="instructor"]');
        var who = select.value ? select.options[select.selectedIndex].text.trim() : 'Unassigned';

        signalTitle.textContent = label || mac;
        signalSubtitle.textContent = who + ' · ' + mac;
        signalModal.hidden = false;
        loadSignal();
    }

    function closeSignal() {
        signalModal.hidden = true;
        openBeaconId = null;
    }

    if (signalModal) {
        document.getElementById('signalClose').addEventListener('click', closeSignal);
        document.getElementById('signalRefresh').addEventListener('click', loadSignal);
        signalWindow.addEventListener('change', loadSignal);
        // Clicking the backdrop closes; clicking the card must not.
        signalModal.addEventListener('click', function (e) {
            if (e.target === signalModal) closeSignal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !signalModal.hidden) closeSignal();
        });
    }


    /* ── Adding a tag ────────────────────────────────────────────────────
       Unknown tags are only written down while listening, so this is the
       only route by which a new tag enters the system. The countdown is
       driven off the server's own deadline rather than a local timer: a
       window opened on one browser must not look open on another after it
       has already lapsed. */

    var discoveryCard = document.getElementById('discoveryCard');
    var discoveryUntil = 0;

    // While listening, the page checks every few seconds on its own. The
    // server's "new tag" message is enough on one server, but on Vercel the
    // report and this page can land on different instances and the message
    // never arrives — and the admin is standing at the scanner, waiting.
    var LISTEN_POLL_MS = 3000;
    var listenTimer = null;

    function paintDiscovery(state) {
        if (!discoveryCard) return;

        var open = Boolean(state && state.open);
        if (open && !listenTimer) listenTimer = setInterval(refresh, LISTEN_POLL_MS);
        if (!open && listenTimer) { clearInterval(listenTimer); listenTimer = null; }
        discoveryUntil = open ? Date.now() + (state.secondsLeft * 1000) : 0;

        discoveryCard.classList.toggle('listening', open);
        document.getElementById('discoveryStart').hidden = open;
        document.getElementById('discoveryStop').hidden = !open;
        document.getElementById('discoveryCountdown').hidden = !open;
        document.getElementById('discoveryRoom').disabled = open;
        document.getElementById('discoveryMinutes').disabled = open;
        document.getElementById('discoveryState').textContent = open ? 'Listening now' : 'Not listening';

        tickCountdown();
    }

    function tickCountdown() {
        var el = document.getElementById('discoveryCountdown');
        if (!el || el.hidden) return;

        var left = Math.max(0, Math.round((discoveryUntil - Date.now()) / 1000));
        var mins = Math.floor(left / 60);
        var secs = left % 60;
        el.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs + ' left';

        // The window closed while nobody was looking — reflect it rather than
        // leaving a card that claims to be listening.
        if (left === 0) { paintDiscovery({ open: false }); refresh(); }
    }

    var startBtn = document.getElementById('discoveryStart');
    if (startBtn) {
        startBtn.addEventListener('click', function () {
            startBtn.disabled = true;
            send('/admin/beacons/discovery/start', 'POST', {
                roomId: document.getElementById('discoveryRoom').value || null,
                minutes: Number(document.getElementById('discoveryMinutes').value),
            }).then(function (data) {
                startBtn.disabled = false;
                if (!data.success) { showToast('error', 'Not Listening', data.error || 'Could not start.'); return; }
                showToast('success', 'Listening', 'Hold the tag against the scanner now.');
                refresh();
            });
        });
    }

    var stopBtn = document.getElementById('discoveryStop');
    if (stopBtn) {
        stopBtn.addEventListener('click', function () {
            send('/admin/beacons/discovery/stop', 'POST').then(function () {
                paintDiscovery({ open: false });
                refresh();
            });
        });
    }

    var pruneBtn = document.getElementById('beaconPrune');
    if (pruneBtn) {
        pruneBtn.addEventListener('click', function () {
            var unclaimed = document.getElementById('beaconCountUnassigned').textContent;
            if (!window.confirm('Remove ' + unclaimed + ' unclaimed tag(s)? Assigned tags are left alone.')) return;

            pruneBtn.disabled = true;
            // olderThanDays 0 with includeRecent clears everything unassigned,
            // which is what the button on screen offers to do.
            send('/admin/beacons/prune', 'POST', { olderThanDays: 0, includeRecent: true })
                .then(function (data) {
                    pruneBtn.disabled = false;
                    if (!data.success) { showToast('error', 'Not Removed', data.error || 'Could not prune.'); return; }
                    showToast('success', 'Removed', data.removed + ' unclaimed tag(s) removed.');
                    refresh();
                });
        });
    }

    function applyCounts(counts) {
        if (!counts) return;
        var assigned = document.getElementById("beaconCountAssigned");
        var unassigned = document.getElementById("beaconCountUnassigned");
        if (assigned) assigned.textContent = counts.assigned;
        if (unassigned) unassigned.textContent = counts.unassigned;
    }

    setInterval(tickCountdown, 1000);

    /* ── Wiring ── */

    /** The Live badge should say what is actually true of the connection. */
    function markLive(connected) {
        var badge = document.getElementById('bxLive');
        if (!badge) return;
        badge.classList.toggle('is-down', !connected);
        badge.title = connected
            ? 'Connected — updates arrive as they happen'
            : 'Live connection lost — falling back to periodic checks';
    }

    if (window.Realtime) {
        window.Realtime.on('presence:changed', refresh);
        window.Realtime.on('connection:open', function () { markLive(true); });
        window.Realtime.on('connection:error', function () { markLive(false); });
    }

    // A scanner falling silent sends nothing, so only elapsed time reveals it
    setInterval(refresh, BACKSTOP_MS);

    /* Coming back to a tab that has been in the background.
       Nothing is fetched while hidden — polling a tab nobody is looking at is
       waste — but the staleness pass keeps running against timestamps that are
       no longer being renewed, so every scanner ages out and the tile reads
       0 online. That is correct about the data the page holds and wrong about
       the world, and it used to persist until the next backstop. Ask for fresh
       data the moment the tab is looked at again. */
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refresh();
    });
    // A tab restored from the back/forward cache fires this instead.
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) refresh();
    });

    paint();
    setInterval(paint, 5000);
    // Once on load, so a page opened (or reloaded) mid-listening picks up the
    // window — and its quick checks — straight away instead of at the backstop.
    refresh();
})();

/**
 * Dean Reports.
 *
 * Three plain tables — faculty roster, make-up requests, presence history —
 * each with search, filters and pagination. They share one small controller
 * rather than three near-identical copies, so a fix to paging or filtering
 * lands on all of them at once.
 *
 * Rows are rendered from data the server already put on the page; nothing here
 * fetches. Filtering is done over the array, not the DOM, so a search never
 * has to reason about which page is currently drawn.
 */
(function () {
    'use strict';

    var createTable = window.ReportTable.create;
    var esc = window.ReportTable.escapeHtml;

    // ── Faculty roster ───────────────────────────────────────────────────────
    var PRESENCE_BADGE = {
        'in-room': '<span class="table-badge confirmed">In Room</span>',
        'out-of-room': '<span class="table-badge declined">Out of Room</span>',
        'unknown': '<span class="table-badge">No data</span>',
    };

    function availPill(row) {
        return '<span class="avail-pill ' + esc(row.availability || 'none') + '">' +
            esc(row.availabilityLabel || 'Not set') + '</span>';
    }

    var facultyTable = createTable(document.querySelector('[data-table="faculty"]'), {
        rows: window.DEAN_REPORTS.faculty,
        noun: 'instructor',
        title: 'Faculty Roster',
        searchText: function (r) { return r.name + ' ' + r.position + ' ' + r.officeRoom; },
        render: function (r) {
            return '<td><strong>' + esc(r.name) + '</strong></td>' +
                '<td>' + esc(r.position) + '</td>' +
                '<td>' + esc(r.officeRoom) + '</td>' +
                '<td>' + availPill(r) + '</td>' +
                '<td>' + (PRESENCE_BADGE[r.bleStatus] || PRESENCE_BADGE.unknown) + '</td>' +
                '<td style="text-align:center">' + esc(r.hoursThisMonth) + 'h</td>' +
                '<td style="text-align:center">' + esc(r.consultationsThisMonth) + '</td>' +
                '<td style="text-align:center">' + esc(r.avgDuration || '—') + '</td>';
        },
    });

    // ── Make-up requests ─────────────────────────────────────────────────────
    var STATUS_BADGE = {
        pending: '<span class="table-badge pending">Pending</span>',
        approved: '<span class="table-badge confirmed">Approved</span>',
        declined: '<span class="table-badge declined">Declined</span>',
    };

    createTable(document.querySelector('[data-table="makeup"]'), {
        rows: window.DEAN_REPORTS.makeupRequests,
        noun: 'request',
        title: 'Make-Up Class Requests',
        searchText: function (r) {
            return r.instructorName + ' ' + r.subject + ' ' + r.subjectName + ' ' + r.section;
        },
        render: function (r) {
            return '<td><strong>' + esc(r.instructorName) + '</strong></td>' +
                '<td>' + esc(r.subject) + (r.subjectName
                    ? '<span style="display:block;font-size:.72rem;color:var(--gray-500)">' + esc(r.subjectName) + '</span>'
                    : '') + '</td>' +
                '<td>' + esc(r.section) + '</td>' +
                '<td style="text-align:center">' + esc(r.sessionCount) + '</td>' +
                '<td style="white-space:nowrap">' + esc(r.firstDate || '—') + '</td>' +
                '<td>' + esc(r.rooms) + '</td>' +
                '<td>' + (STATUS_BADGE[r.status] || esc(r.status)) + '</td>' +
                '<td>' + esc(r.decidedBy || '—') + '</td>' +
                '<td style="white-space:nowrap">' + esc(r.submittedAt || '—') + '</td>';
        },
    });

    // ── Presence history ─────────────────────────────────────────────────────
    createTable(document.querySelector('[data-table="presence"]'), {
        rows: window.DEAN_REPORTS.presenceLogs,
        noun: 'detection',
        title: 'Faculty Presence History',
        searchText: function (r) { return r.facultyName + ' ' + r.location; },
        render: function (r) {
            var entered = r.status === 'entered';
            return '<td><span class="table-badge ' + (entered ? 'confirmed' : '') + '">' +
                    (entered ? 'Entered' : 'Exited') + '</span></td>' +
                '<td><strong>' + esc(r.facultyName) + '</strong></td>' +
                '<td>' + esc(r.location) + '</td>' +
                '<td style="white-space:nowrap">' + esc(r.relative || '—') + '</td>';
        },
    });

    // ── Unanswered consultation requests ─────────────────────────────────────
    createTable(document.querySelector('[data-table="unanswered"]'), {
        rows: window.DEAN_REPORTS.unansweredRequests,
        noun: 'request',
        title: 'Unanswered Consultation Requests',
        searchText: function (r) {
            return r.instructorName + ' ' + r.studentName + ' ' + r.topic + ' ' + r.studentNumber;
        },
        render: function (r) {
            return '<td><span class="wait-pill' + (r.stale ? ' stale' : '') + '">' +
                    esc(r.waitingLabel) + '</span></td>' +
                '<td><strong>' + esc(r.instructorName) + '</strong></td>' +
                '<td>' + esc(r.studentName) +
                    '<span style="display:block;font-size:.72rem;color:var(--gray-500)">' +
                    esc(r.studentNumber) + '</span></td>' +
                '<td>' + esc(r.topic) + '</td>' +
                '<td style="white-space:nowrap">' + esc(r.dateLabel) +
                    '<span style="display:block;font-size:.72rem;color:var(--gray-500)">' +
                    esc(r.timeLabel) + ' · ' + esc(r.mode) + '</span></td>' +
                '<td style="white-space:nowrap">' + esc(r.requestedAt) + '</td>';
        },
    });

    /* ── Live presence ──
       The roster carries an In Room column, and this is a page a dean leaves
       open. Merging into the same array the table renders from means a search
       or a page position is kept — the rows redraw, the view does not jump. */
    if (window.PresenceLive) {
        window.PresenceLive.onUpdate(function (live) {
            var byId = {};
            live.forEach(function (f) { byId[f.id] = f; });

            var changed = false;
            window.DEAN_REPORTS.faculty.forEach(function (row) {
                var entry = byId[row.id];
                if (!entry) return;
                if (row.bleStatus !== entry.presence) { row.bleStatus = entry.presence; changed = true; }
                if (row.availability !== entry.availability) {
                    row.availability = entry.availability;
                    row.availabilityLabel = entry.availabilityLabel;
                    changed = true;
                }
            });

            // draw() re-reads the same array it was handed, so mutating in
            // place and redrawing keeps the current page and any search the
            // dean has typed. Rebuilding the table would throw both away.
            if (changed && facultyTable) facultyTable.draw();
        });
    }

    // ── Class attendance ─────────────────────────────────────────────────────
    // One row per class meeting (workload + approved make-ups) with the time
    // the instructor was detected in the assigned room. See ClassAttendanceModel.
    (function () {
        var card = document.querySelector('[data-table="attendance"]');
        if (!card) return;

        var STATUS = {
            'present':     { label: 'Present',          cls: 'att-present' },
            'partial':     { label: 'Partial',          cls: 'att-partial' },
            'absent':      { label: 'Not detected',     cls: 'att-absent' },
            'no-signal':   { label: 'No signal',        cls: 'att-no-signal' },
            'no-room':     { label: 'No room assigned', cls: 'att-no-room' },
            'in-progress': { label: 'In progress',      cls: 'att-in-progress' },
        };
        var period = document.getElementById('attendancePeriod');

        function key(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        function inPeriod(row) {
            var mode = period ? period.value : 'all';
            if (mode === 'all') return true;
            var now = new Date();
            if (mode === 'month') return row.date.slice(0, 7) === key(now).slice(0, 7);
            var monday = new Date(now);
            monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));   // Monday-start week
            return row.date >= key(monday);
        }
        function hm(min) {
            if (min === null || min === undefined) return '—';
            var h = Math.floor(min / 60), m = min % 60;
            return h ? (h + 'h' + (m ? ' ' + m + 'm' : '')) : (m + 'm');
        }

        var table = createTable(card, {
            rows: window.DEAN_REPORTS.classAttendance || [],
            noun: 'class meeting',
            title: 'Class Attendance',
            predicate: inPeriod,
            searchText: function (r) {
                return r.instructorName + ' ' + r.subjectCode + ' ' + r.subjectName + ' ' + r.section + ' ' + r.room;
            },
            render: function (r) {
                var st = STATUS[r.status] || { label: r.status, cls: '' };
                var time;
                if (r.presentMin === null) {
                    time = '<span class="att-sub">—</span>';
                } else {
                    var pct = Math.max(0, Math.min(100, r.percent || 0));
                    time = '<div class="att-time-figure">' + hm(r.presentMin) + ' <span>of ' + hm(r.scheduledMin) +
                           ' · ' + pct + '%</span></div>' +
                           '<div class="att-bar' + (r.status === 'partial' ? ' partial' : '') + '"><i style="width:' + pct + '%"></i></div>';
                }
                var seen = r.firstIn
                    ? esc(r.firstIn) + (r.lastOut ? ' – ' + esc(r.lastOut) : '') +
                      (r.lateMin > 5 ? '<span class="att-late">' + r.lateMin + ' min after start</span>' : '')
                    : '<span class="att-sub">—</span>';
                return '<td class="att-class"><strong>' + esc(r.subjectCode) +
                        (r.kind === 'makeup' ? '<span class="att-makeup">Make-up</span>' : '') + '</strong>' +
                        '<span class="att-sub">' + esc(r.section) + (r.classType ? ' · ' + esc(r.classType) : '') + '</span>' +
                        '<span class="att-sub">' + esc(r.dateLabel) + ' · ' + esc(r.timeLabel) + '</span></td>' +
                    '<td><strong>' + esc(r.instructorName) + '</strong></td>' +
                    '<td>' + esc(r.room) + '</td>' +
                    '<td class="att-time">' + time + '</td>' +
                    '<td style="white-space:nowrap">' + seen + '</td>' +
                    '<td><span class="table-badge ' + st.cls + '">' + esc(st.label) + '</span></td>';
            },
            // Every matching class, not just the page on screen
            onExport: function (rows) {
                if (!window.ExportSystem) return;
                window.ExportSystem.openPreview({
                    title: 'Class Attendance Report',
                    subtitle: card.dataset.subtitle || '',
                    columns: ['Date', 'Time', 'Instructor', 'Subject', 'Section', 'Room', 'Scheduled', 'In room', '%', 'First seen', 'Status'],
                    rows: rows.map(function (r) {
                        var st = STATUS[r.status] || { label: r.status };
                        return [r.dateLabel, r.timeLabel, r.instructorName, r.subjectCode + (r.kind === 'makeup' ? ' (make-up)' : ''),
                                r.section, r.room, hm(r.scheduledMin), hm(r.presentMin),
                                r.percent === null ? '—' : r.percent + '%', r.firstIn || '—', st.label];
                    }),
                });
            },
        });

        // Per-instructor totals for what the filters currently show. Only
        // classes that could be measured (a room, a working scanner, finished)
        // count toward the share, so "No signal" never drags anyone down.
        var summary = document.getElementById('attendanceSummary');
        function summarize() {
            if (!table || !summary) return;
            var by = {};
            table.visibleRows().forEach(function (r) {
                var s = by[r.instructorName] || (by[r.instructorName] = { sched: 0, present: 0, classes: 0 });
                if (r.status === 'present' || r.status === 'partial' || r.status === 'absent') {
                    s.sched += r.scheduledMin;
                    s.present += r.presentMin || 0;
                    s.classes++;
                }
            });
            summary.innerHTML = Object.keys(by).sort().map(function (name) {
                var s = by[name];
                if (!s.classes) return '';
                return '<span class="att-chip"><strong>' + esc(name) + '</strong>' +
                    hm(s.present) + ' of ' + hm(s.sched) + ' · ' + Math.round(s.present / s.sched * 100) + '% in room' +
                    ' · ' + s.classes + ' class' + (s.classes === 1 ? '' : 'es') + '</span>';
            }).join('');
        }

        if (period) period.addEventListener('change', function () { table.reset(); summarize(); });
        var toolbar = document.querySelector('[data-toolbar-for="attendance"]');
        if (toolbar) {
            toolbar.addEventListener('input', summarize);
            toolbar.addEventListener('change', summarize);
        }
        summarize();
    })();

    // ── Report picker ──
    // Every table is built above regardless of which is on screen, so switching
    // is instant and a search typed in one report survives a trip to another.
    (function () {
        var buttons = Array.prototype.slice.call(document.querySelectorAll('.report-pick'));
        var cards = Array.prototype.slice.call(document.querySelectorAll('.report-table'));
        if (!buttons.length || !cards.length) return;

        var STORE_KEY = 'facitrack_dean_report';

        function show(name) {
            cards.forEach(function (card) {
                card.hidden = card.getAttribute('data-table') !== name;
            });
            // Each toolbar sits above its card, so it is shown and hidden with it
            document.querySelectorAll('[data-toolbar-for]').forEach(function (bar) {
                bar.hidden = bar.getAttribute('data-toolbar-for') !== name;
            });
            buttons.forEach(function (btn) {
                var on = btn.getAttribute('data-show') === name;
                btn.classList.toggle('active', on);
                btn.setAttribute('aria-selected', String(on));
            });
            try { localStorage.setItem(STORE_KEY, name); } catch (err) { /* private mode */ }
        }

        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () { show(btn.getAttribute('data-show')); });
        });

        // The overdue banner carries the same data-show, so it opens the report
        // it is talking about rather than describing it and leaving the reader
        // to find it.
        var jump = document.querySelector('.report-alert-go');
        if (jump) {
            jump.addEventListener('click', function () {
                show(jump.getAttribute('data-show'));
                var card = document.querySelector('.report-table[data-table="unanswered"]');
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }

        // Anything overdue opens on that report, whatever was last viewed —
        // a dean landing here while requests are going unanswered should not
        // have to remember to go looking. Otherwise, reopen the last choice.
        var overdue = document.querySelector('.report-alert');
        if (overdue) {
            show('unanswered');
            return;
        }

        var initial = null;
        try { initial = localStorage.getItem(STORE_KEY); } catch (err) { /* ignore */ }
        var known = buttons.some(function (b) { return b.getAttribute('data-show') === initial; });
        show(known ? initial : buttons[0].getAttribute('data-show'));
    }());
}());

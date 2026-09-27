/**
 * Instructor Reports.
 *
 * One consultation-log table, driven by the shared controller in
 * /js/report-table.js — the same one the Dean reports use, so paging, empty
 * states and the result counter behave identically on both pages.
 *
 * Status is a plain field filter the controller handles itself. Period and
 * "specific day" are not field equality, so they go through the predicate hook
 * and keep their state here.
 */
(function () {
    'use strict';

    var esc = window.ReportTable.escapeHtml;
    var APPOINTMENTS = (window.INSTRUCTOR_REPORTS || {}).appointments || [];

    var period = { mode: 'all', date: '' };

    function parseDate(value) {
        var d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    function formatDate(value, longFormat) {
        var d = parseDate(value);
        if (!d) return '—';
        return d.toLocaleDateString('en-PH', longFormat
            ? { month: 'long', day: 'numeric', year: 'numeric' }
            : { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function weekRange() {
        var now = new Date();
        var start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(now.getDate() - now.getDay());       // Sunday
        var end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return { start: start, end: end };
    }

    function monthRange() {
        var now = new Date();
        return {
            start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
            end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
        };
    }

    /** The period filter, in the shape the shared controller expects. */
    function inPeriod(row) {
        if (period.mode === 'all') return true;

        var d = parseDate(row.date);
        if (!d) return false;

        if (period.mode === 'day') {
            var target = parseDate(period.date);
            return Boolean(target) && d.toDateString() === target.toDateString();
        }
        var range = period.mode === 'week' ? weekRange() : monthRange();
        return d >= range.start && d <= range.end;
    }

    /** The printed letterhead names the period the table is showing. */
    function periodLabel() {
        if (period.mode === 'week') return 'This Week';
        if (period.mode === 'month') return 'This Month';
        if (period.mode === 'day') return formatDate(period.date, true);
        return 'All Records';
    }

    function syncPeriodLabel() {
        var el = document.getElementById('logReportPeriodText');
        if (el) el.textContent = periodLabel();
    }

    var table = window.ReportTable.create(document.querySelector('[data-table="log"]'), {
        rows: APPOINTMENTS,
        noun: 'consultation',
        title: 'Consultation Logs',
        predicate: inPeriod,
        searchText: function (r) { return (r.studentName || '') + ' ' + (r.topic || ''); },
        render: function (r) {
            var status = String(r.status || 'pending');
            var label = status.charAt(0).toUpperCase() + status.slice(1);
            return '<td><strong>' + esc(r.studentName) + '</strong>' +
                    '<div style="font-size:.72rem;color:var(--gray-400)">' + esc(r.studentId || '—') + '</div></td>' +
                '<td style="white-space:nowrap">' + esc(formatDate(r.date)) + '</td>' +
                '<td style="white-space:nowrap">' + esc(r.time || '—') + '</td>' +
                '<td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' +
                    esc(r.topic || '') + '">' + esc(r.topic || '—') + '</td>' +
                '<td><span class="table-badge ' + esc(status) + '">' + esc(label) + '</span></td>' +
                '<td style="text-align:center"><button class="btn-page view-log-detail" data-log-id="' +
                    esc(r.id) + '">View</button></td>';
        },
    });

    // ── Period controls ──
    var periodSelect = document.getElementById('logPeriod');
    var dateInput = document.getElementById('logDate');

    periodSelect.addEventListener('change', function () {
        period.mode = this.value;
        // Picking a named period and a specific day at once is contradictory,
        // so choosing one clears the other.
        period.date = '';
        dateInput.value = '';
        syncPeriodLabel();
        table.reset();
    });

    dateInput.addEventListener('change', function () {
        if (this.value) {
            period.mode = 'day';
            period.date = this.value;
            periodSelect.value = 'all';
        } else {
            period.mode = 'all';
            period.date = '';
        }
        syncPeriodLabel();
        table.reset();
    });

    // ── Details modal ──
    var modal = document.getElementById('logDetailModal');
    var content = document.getElementById('logDetailContent');

    function openDetail(id) {
        var row = APPOINTMENTS.find(function (r) { return String(r.id) === String(id); });
        if (!row) return;

        var lines = [
            ['Student', esc(row.studentName) + ' (' + esc(row.studentId || '—') + ')'],
            ['Date', esc(formatDate(row.date, true))],
            ['Time', esc(row.time || '—')],
            ['Duration', esc(row.duration || '—')],
            ['Subject', esc(row.courseSubject || '—')],
            ['Section', esc(row.sectionGroupName || '—')],
            ['Topic', esc(row.topic || '—')],
            ['Status', esc(String(row.status || '').toUpperCase())],
        ];
        if (row.notes) lines.push(['Notes', esc(row.notes)]);

        content.innerHTML = lines.map(function (pair, i) {
            return '<p style="margin:0 0 ' + (i === lines.length - 1 ? '0' : '.75rem') + '">' +
                '<strong>' + pair[0] + ':</strong> ' + pair[1] + '</p>';
        }).join('');
        modal.style.display = 'flex';
    }

    function closeDetail() { modal.style.display = 'none'; }

    document.querySelector('[data-table="log"] [data-role="body"]').addEventListener('click', function (event) {
        var btn = event.target.closest('.view-log-detail');
        if (btn) openDetail(btn.dataset.logId);
    });

    document.getElementById('logDetailClose').addEventListener('click', closeDetail);
    modal.addEventListener('click', function (event) { if (event.target === modal) closeDetail(); });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && modal.style.display === 'flex') closeDetail();
    });

    // ── Export / Print ──
    var card = document.querySelector('[data-table="log"]');
    var preview = card.querySelector('.report-preview');

    // Opens the shared export preview (Print / Save as PDF, DOCX, XLSX) with
    // every row the filters match — not just the page on screen.
    document.getElementById('btnPrintLog').addEventListener('click', function () {
        var all = table.visibleRows();
        if (!window.ExportSystem) return;

        var header = preview.querySelector('.report-header-block');
        var textOf = function (selector) {
            var el = header && header.querySelector(selector);
            return el ? el.innerText.trim() : '';
        };

        window.ExportSystem.openPreview({
            title: textOf('.report-title-block') || 'Consultation Logs Report',
            subtitle: textOf('.report-period'),
            columns: ['Student', 'Student ID', 'Date', 'Time', 'Topic', 'Status'],
            rows: all.map(function (r) {
                var status = String(r.status || 'pending');
                return [
                    r.studentName || '—',
                    r.studentId || '—',
                    formatDate(r.date),
                    r.time || '—',
                    r.topic || '—',
                    status.charAt(0).toUpperCase() + status.slice(1),
                ];
            }),
        });
    });

    syncPeriodLabel();
}());

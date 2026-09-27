/**
 * A searchable, filterable, paginated table for the report pages.
 *
 * Dean and Instructor reports both use it, so paging, empty states and the
 * result counter cannot drift between them. Filtering runs over the source
 * array rather than the DOM, so a search never has to reason about which page
 * happens to be drawn.
 *
 * Expected markup inside the card:
 *   [data-role="search"]    optional text input
 *   [data-role="filter"]    zero or more <select data-field="rowProperty">
 *   [data-role="body"]      the <tbody> rows are written into
 *   [data-role="empty"]     shown when nothing matches
 *   [data-role="count"]     "12 requests"
 *   [data-role="pageinfo"]  "Showing 1–10 of 12"
 *   [data-role="prev"] / [data-role="next"]
 *   [data-role="export"]    optional, exports the visible rows
 */
(function (global) {
    'use strict';

    var PAGE_SIZE = 10;

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * @param {HTMLElement} root
     * @param {object}   config
     * @param {Array}    config.rows        every row, unfiltered
     * @param {function} config.render      row -> <tr> innerHTML
     * @param {function} config.searchText  row -> the string a search matches against
     * @param {function} [config.predicate] extra filter the declarative selects cannot express
     * @param {string}   [config.noun]      "instructor", "request", "log"
     * @param {number}   [config.pageSize]
     */
    function create(root, config) {
        if (!root) return null;

        var rows = config.rows || [];
        var pageSize = config.pageSize || PAGE_SIZE;
        var page = 1;

        // A toolbar may sit outside its card (above it) and name the card with
        // data-toolbar-for; its controls are looked up there as well.
        var name = root.getAttribute('data-table');
        var toolbar = name ? document.querySelector('[data-toolbar-for="' + name + '"]') : null;
        var scopes = toolbar ? [root, toolbar] : [root];
        var pick = function (role) {
            for (var i = 0; i < scopes.length; i++) {
                var el = scopes[i].querySelector('[data-role="' + role + '"]');
                if (el) return el;
            }
            return null;
        };
        var body = pick('body');
        var empty = pick('empty');
        var count = pick('count');
        var pageInfo = pick('pageinfo');
        var prev = pick('prev');
        var next = pick('next');
        var search = pick('search');
        var filters = scopes.reduce(function (all, scope) {
            return all.concat(Array.prototype.slice.call(scope.querySelectorAll('[data-role="filter"]')));
        }, []);
        var pagination = root.querySelector('.pagination-bar');

        function visibleRows() {
            var query = (search && search.value || '').toLowerCase().trim();

            return rows.filter(function (row) {
                // Every select must pass; "all" means that filter is off
                var passes = filters.every(function (select) {
                    if (!select.value || select.value === 'all') return true;
                    return String(row[select.dataset.field]) === select.value;
                });
                if (!passes) return false;
                if (config.predicate && !config.predicate(row)) return false;
                if (!query) return true;
                return config.searchText(row).toLowerCase().indexOf(query) !== -1;
            });
        }

        function draw() {
            var list = visibleRows();
            var pages = Math.max(1, Math.ceil(list.length / pageSize));
            if (page > pages) page = pages;

            var start = (page - 1) * pageSize;
            var slice = list.slice(start, start + pageSize);

            body.innerHTML = slice.map(function (row) {
                return '<tr>' + config.render(row) + '</tr>';
            }).join('');

            var noun = config.noun || 'result';
            if (count) count.textContent = list.length + ' ' + noun + (list.length === 1 ? '' : 's');
            if (empty) empty.style.display = list.length ? 'none' : 'block';
            // Paging controls on an empty table are just noise
            if (pagination) pagination.style.display = list.length ? '' : 'none';

            if (pageInfo) {
                pageInfo.textContent = list.length
                    ? 'Showing ' + (start + 1) + '–' + Math.min(start + pageSize, list.length) + ' of ' + list.length
                    : 'No results';
            }
            if (prev) prev.disabled = page <= 1;
            if (next) next.disabled = page >= pages;
        }

        // Any change to the query or the filters puts you back on page one, or
        // you can land on an empty page that used to have rows.
        function reset() { page = 1; draw(); }

        if (search) search.addEventListener('input', reset);
        filters.forEach(function (select) { select.addEventListener('change', reset); });
        if (prev) prev.addEventListener('click', function () { if (page > 1) { page--; draw(); } });
        if (next) next.addEventListener('click', function () { page++; draw(); });

        var exportBtn = pick('export');
        if (exportBtn && !config.onExport) {
            exportBtn.addEventListener('click', function () {
                if (!global.ExportSystem) return;
                global.ExportSystem.fromTable({
                    table: root.querySelector('table'),
                    onlyVisible: true,
                    title: config.title || 'Report',
                    subtitle: root.dataset.subtitle || '',
                    meta: ['Filtered view export (current table results)'],
                });
            });
        } else if (exportBtn) {
            exportBtn.addEventListener('click', function () { config.onExport(visibleRows()); });
        }

        draw();

        return {
            draw: draw,
            reset: reset,
            visibleRows: visibleRows,
            // Exposed so a caller can render rows outside the paged view —
            // printing, for instance, needs every matching row, not one page.
            renderRow: config.render,
        };
    }

    global.ReportTable = { create: create, escapeHtml: escapeHtml, PAGE_SIZE: PAGE_SIZE };
}(window));

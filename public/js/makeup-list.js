/**
 * Filter bar logic for both make-up request list pages
 * (instructor + dean).
 *
 * Filters:
 *   - Search  : text match against pre-built data-search haystack
 *   - Status  : data-status  (all | pending | approved | declined | withdrawn | expired)
 *   - Class Type : data-class-type  (all | lecture | laboratory | online)
 *
 * Every card is rendered once with data-status, data-class-type, and
 * data-search so all filtering is instant with no round trips.
 */
(function () {
    'use strict';

    var cards        = document.querySelectorAll('.mk-req');
    var searchInput  = document.getElementById('mkSearch');
    var clearBtn     = document.getElementById('mkSearchClear');
    var statusSelect = document.getElementById('mkStatusFilter');
    var typeSelect   = document.getElementById('mkTypeFilter');
    var emptyBox     = document.getElementById('mkFilterEmpty');

    // Nothing to do if the list is absent (empty-state path)
    if (!cards.length) return;

    var query      = '';
    var activeStatus = 'all';
    var activeType   = 'all';

    function apply() {
        var shown = 0;

        cards.forEach(function (card) {
            var matchesStatus = activeStatus === 'all' ||
                                card.dataset.status === activeStatus;

            // data-class-type is a space-separated list of types on the card
            var matchesType = activeType === 'all' ||
                              (card.dataset.classType || '').split(' ').indexOf(activeType) !== -1;

            var matchesQuery = !query ||
                               (card.dataset.search || '').indexOf(query) !== -1;

            var visible = matchesStatus && matchesType && matchesQuery;
            card.hidden = !visible;
            if (visible) shown++;
        });

        if (emptyBox) {
            emptyBox.hidden = shown > 0;
            if (!emptyBox.hidden) {
                emptyBox.textContent = query
                    ? 'Nothing matches \u201c' + searchInput.value.trim() + '\u201d.'
                    : 'No requests match the selected filters.';
            }
        }

        if (clearBtn) clearBtn.hidden = !query;
    }

    // ── Search ──
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            query = this.value.trim().toLowerCase();
            apply();
        });
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                this.value = '';
                query = '';
                apply();
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            searchInput.value = '';
            query = '';
            searchInput.focus();
            apply();
        });
    }

    // ── Status select ──
    if (statusSelect) {
        statusSelect.addEventListener('change', function () {
            activeStatus = this.value;
            apply();
        });
        activeStatus = statusSelect.value || 'all';
    }

    // ── Class type select ──
    if (typeSelect) {
        typeSelect.addEventListener('change', function () {
            activeType = this.value;
            apply();
        });
    }

    // Initial render
    apply();
}());

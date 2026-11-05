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
 *
 * On the instructor page the cards are also revealed in batches: the first
 * page is shown, and "Load more" appends the next page of whatever the
 * current filters match. The dean page has no load-more button, so there the
 * whole list is shown at once exactly as before.
 */
(function () {
    'use strict';

    var grid         = document.querySelector('.mk-req-grid');
    var cards        = grid ? Array.prototype.slice.call(grid.querySelectorAll('.mk-req')) : [];
    var searchInput  = document.getElementById('mkSearch');
    var clearBtn     = document.getElementById('mkSearchClear');
    var statusSelect = document.getElementById('mkStatusFilter');
    var typeSelect   = document.getElementById('mkTypeFilter');
    var emptyBox     = document.getElementById('mkFilterEmpty');
    var loadMoreBtn  = document.getElementById('mkLoadMore');
    var countLabel   = document.getElementById('mkListCount');

    // Nothing to do if the list is absent (empty-state path)
    if (!cards.length) return;

    var PAGE_SIZE = 6;
    var paginate  = !!loadMoreBtn;

    var query      = '';
    var shownLimit = paginate ? PAGE_SIZE : Infinity;

    function selectedValue(select) {
        return (select && select.value) || 'all';
    }

    function matches(card) {
        var activeStatus = selectedValue(statusSelect);
        var activeType   = selectedValue(typeSelect);

        var matchesStatus = activeStatus === 'all' ||
                            card.dataset.status === activeStatus;

        // data-class-type is a space-separated list of types on the card
        var matchesType = activeType === 'all' ||
                          (card.dataset.classType || '').split(' ').indexOf(activeType) !== -1;

        var matchesQuery = !query ||
                           (card.dataset.search || '').indexOf(query) !== -1;

        return matchesStatus && matchesType && matchesQuery;
    }

    function apply() {
        var matched = 0;

        cards.forEach(function (card) {
            if (!matches(card)) {
                card.hidden = true;
                return;
            }

            // Only the first `shownLimit` matches are on screen. Counting the
            // matches rather than the cards keeps the batch full even when a
            // filter hides cards between them.
            var withinLimit = matched < shownLimit;
            matched++;
            card.hidden = !withinLimit;
        });

        var shown = Math.min(matched, shownLimit);

        if (emptyBox) {
            emptyBox.hidden = matched > 0;
            if (matched === 0) {
                emptyBox.textContent = query
                    ? 'Nothing matches \u201c' + searchInput.value.trim() + '\u201d.'
                    : 'No requests match the selected filters.';
            }
        }

        if (clearBtn) clearBtn.hidden = !query;

        if (countLabel) {
            countLabel.textContent = matched
                ? 'Showing ' + shown + ' of ' + matched +
                  ' request' + (matched === 1 ? '' : 's')
                : '';
        }

        if (loadMoreBtn) loadMoreBtn.hidden = !paginate || matched <= shownLimit;
    }

    /** A filter changed, so start again from the first page. */
    function reset() {
        shownLimit = paginate ? PAGE_SIZE : Infinity;
        apply();
    }

    /**
     * If the page was opened at #req-<id> (the dean dashboard's "View"
     * shortcut), make sure that card is on screen even when it would fall
     * beyond the first batch.
     */
    function revealTarget() {
        if (!paginate || !window.location.hash) return;

        var id = window.location.hash.slice(1);
        if (!id) return;

        var seen = 0;
        for (var i = 0; i < cards.length; i++) {
            if (!matches(cards[i])) continue;
            seen++;
            if (cards[i].id === id) {
                shownLimit = Math.max(shownLimit, seen);
                return;
            }
        }
    }

    // ── Search ──
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            query = this.value.trim().toLowerCase();
            reset();
        });
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                this.value = '';
                query = '';
                reset();
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            searchInput.value = '';
            query = '';
            searchInput.focus();
            reset();
        });
    }

    // ── Status select ──
    if (statusSelect) {
        statusSelect.addEventListener('change', reset);
    }

    // ── Class type select ──
    if (typeSelect) {
        typeSelect.addEventListener('change', reset);
    }

    // ── Load more ──
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function () {
            shownLimit += PAGE_SIZE;
            apply();
        });
    }

    // Initial render
    revealTarget();
    apply();

    // ── Attachments menu ──
    // One paperclip per request. The menu is fixed-positioned because a card
    // clips its own overflow to keep its rounded corners, so an absolutely
    // positioned menu would be cut off at the card's edge. It closes whenever
    // the page moves underneath it, so it never floats beside the wrong card.
    var openMenu = null;
    var openBtn = null;

    function closeMenu() {
        if (!openMenu) return;
        openMenu.hidden = true;
        openBtn.setAttribute('aria-expanded', 'false');
        openMenu = null;
        openBtn = null;
    }

    function placeMenu(btn, menu) {
        var rect = btn.getBoundingClientRect();
        var gap = 6;
        var width = menu.offsetWidth;
        var height = menu.offsetHeight;
        var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        var top = rect.bottom + gap;

        // Open upwards when there is no room below, as the last cards sit at
        // the bottom of a long list.
        if (top + height > window.innerHeight - 8) {
            top = Math.max(8, rect.top - height - gap);
        }

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    document.querySelectorAll('.mk-attach-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var menu = btn.parentNode.querySelector('.mk-attach-menu');
            if (!menu) return;

            if (openMenu === menu) { closeMenu(); return; }

            closeMenu();
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            openMenu = menu;
            openBtn = btn;
            placeMenu(btn, menu);
        });
    });

    // Selecting a document opens it in a new tab; close the menu behind it.
    document.querySelectorAll('.mk-attach-item').forEach(function (item) {
        item.addEventListener('click', closeMenu);
    });

    document.addEventListener('click', function (e) {
        if (!openMenu) return;
        if (openMenu.contains(e.target) || (openBtn && openBtn.contains(e.target))) return;
        closeMenu();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape' || !openMenu) return;
        var btn = openBtn;
        closeMenu();
        if (btn) btn.focus();
    });

    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
}());

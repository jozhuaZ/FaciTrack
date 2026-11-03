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

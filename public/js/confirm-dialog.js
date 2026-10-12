/**
 * A confirmation modal in the app's own style, in place of the browser's
 * confirm() box.
 *
 *     ConfirmDialog.ask({
 *         title: 'Clear read notifications?',
 *         message: 'This cannot be undone.',
 *         confirmText: 'Clear read',
 *         danger: true,
 *     }).then(function (ok) { if (ok) ... });
 *
 * Resolves true only for the confirm button. Cancel and Escape resolve false;
 * a tap outside the card does nothing, so a stray tap cannot decide for you.
 *
 * Clicks and the Escape key are kept inside the dialog: an open notification
 * panel closes on any click outside it, and would otherwise vanish the moment
 * its own confirmation was answered.
 */
(function (global) {
    'use strict';

    if (global.ConfirmDialog) return;

    var STYLE =
        '.cfd-overlay{position:fixed;inset:0;z-index:4000;display:flex;align-items:center;justify-content:center;' +
        'padding:1rem;background:rgba(15,23,42,.5);opacity:0;transition:opacity .18s ease}' +
        '.cfd-overlay.is-open{opacity:1}' +
        '.cfd-card{width:100%;max-width:400px;background:#fff;border-radius:16px;' +
        'box-shadow:0 25px 70px rgba(0,0,0,.3);padding:1.5rem 1.5rem 1.25rem;text-align:center;' +
        'transform:scale(.94);transition:transform .2s cubic-bezier(.34,1.56,.64,1);font-family:var(--font-body,inherit)}' +
        '.cfd-overlay.is-open .cfd-card{transform:scale(1)}' +
        '.cfd-icon{width:52px;height:52px;margin:0 auto .9rem;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'background:#eff6ff;color:#1d4ed8}' +
        '.cfd-card.is-danger .cfd-icon{background:#fef2f2;color:#dc2626}' +
        '.cfd-title{margin:0 0 .4rem;font-family:var(--font-heading,inherit);font-size:1.05rem;font-weight:700;color:#111827}' +
        '.cfd-message{margin:0 0 1.25rem;font-size:.875rem;line-height:1.55;color:#4b5563}' +
        '.cfd-actions{display:flex;gap:.6rem}' +
        '.cfd-btn{flex:1;padding:.7rem 1rem;border-radius:10px;font-family:inherit;font-size:.875rem;font-weight:600;' +
        'cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}' +
        '.cfd-cancel{background:#fff;color:#374151;border:1.5px solid #d1d5db}' +
        '.cfd-cancel:hover{background:#f9fafb;border-color:#9ca3af}' +
        '.cfd-ok{background:linear-gradient(135deg,#0a3d62,#1e88e5);color:#fff;border:1.5px solid transparent}' +
        '.cfd-ok:hover{box-shadow:0 4px 12px rgba(10,61,98,.25)}' +
        '.cfd-card.is-danger .cfd-ok{background:#dc2626}' +
        '.cfd-card.is-danger .cfd-ok:hover{background:#b91c1c;box-shadow:0 4px 12px rgba(220,38,38,.25)}' +
        '.cfd-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
        '@media (max-width:420px){.cfd-actions{flex-direction:column-reverse}}';

    var ICON_DANGER = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/>' +
        '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
        '<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    var ICON_INFO = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>' +
        '<line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';

    var styled = false;
    var openCount = 0;

    function ask(opts) {
        opts = opts || {};
        if (!styled) {
            var css = document.createElement('style');
            css.textContent = STYLE;
            document.head.appendChild(css);
            styled = true;
        }

        return new Promise(function (resolve) {
            var previousFocus = document.activeElement;
            var overlay = document.createElement('div');
            overlay.className = 'cfd-overlay';
            overlay.innerHTML =
                '<div class="cfd-card' + (opts.danger ? ' is-danger' : '') + '" role="alertdialog" aria-modal="true" ' +
                'aria-labelledby="cfdTitle" aria-describedby="cfdMessage">' +
                '<div class="cfd-icon" aria-hidden="true">' + (opts.danger ? ICON_DANGER : ICON_INFO) + '</div>' +
                '<h3 class="cfd-title" id="cfdTitle"></h3>' +
                '<p class="cfd-message" id="cfdMessage"></p>' +
                '<div class="cfd-actions">' +
                '<button type="button" class="cfd-btn cfd-cancel"></button>' +
                '<button type="button" class="cfd-btn cfd-ok"></button>' +
                '</div></div>';
            // Text, never markup: a message may carry a name typed by a user
            overlay.querySelector('.cfd-title').textContent = opts.title || 'Are you sure?';
            overlay.querySelector('.cfd-message').textContent = opts.message || '';
            overlay.querySelector('.cfd-cancel').textContent = opts.cancelText || 'Cancel';
            overlay.querySelector('.cfd-ok').textContent = opts.confirmText || 'Confirm';
            if (!opts.message) overlay.querySelector('.cfd-message').remove();

            var done = false;
            function finish(result) {
                if (done) return;
                done = true;
                window.removeEventListener('keydown', onKey, true);
                overlay.classList.remove('is-open');
                setTimeout(function () { overlay.remove(); }, 180);
                openCount--;
                if (previousFocus && previousFocus.focus) {
                    try { previousFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
                }
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Escape') {
                    // Answer the dialog only — not whatever panel opened it
                    e.stopPropagation();
                    e.preventDefault();
                    finish(false);
                } else if (e.key === 'Tab') {
                    // Keep focus on the two buttons while the dialog is up
                    var buttons = overlay.querySelectorAll('.cfd-btn');
                    var first = buttons[0], last = buttons[buttons.length - 1];
                    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
                }
            }

            // Every click stops here, so the page behind never sees an
            // "outside" click; the backdrop itself does nothing.
            overlay.addEventListener('click', function (e) {
                e.stopPropagation();
                if (e.target.closest('.cfd-ok')) finish(true);
                else if (e.target.closest('.cfd-cancel')) finish(false);
            });
            window.addEventListener('keydown', onKey, true);

            document.body.appendChild(overlay);
            openCount++;
            requestAnimationFrame(function () { overlay.classList.add('is-open'); });
            // Destructive choices start on Cancel, so Enter does not delete
            overlay.querySelector(opts.danger ? '.cfd-cancel' : '.cfd-ok').focus();
        });
    }

    global.ConfirmDialog = { ask: ask, isOpen: function () { return openCount > 0; } };
}(window));

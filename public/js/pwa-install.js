/**
 * "Install FaciTrack" pill — signed-in pages only (loaded from partials/script).
 *
 * Once per visit (per browser session), when the app can be installed:
 *   fade in → widen to "Install FaciTrack" → hold 5 s → narrow back to the
 *   circle → hold 5 s → fade out.
 * Tapping the circle widens it again; tapping the widened pill installs.
 *
 * Never shown when FaciTrack is already running as the installed app. Chrome
 * and Edge only offer installing (beforeinstallprompt, caught in header.ejs)
 * while it is not installed, so that event doubles as the "not installed"
 * check. iOS Safari has no such event, so there the pill explains the
 * Add to Home Screen step instead.
 */
(function () {
    'use strict';

    var SESSION_KEY = 'facitrack_pwa_pill_shown';
    var LABEL = 'Install FaciTrack';
    var EXPANDED_HOLD = 5000;
    var COLLAPSED_HOLD = 5000;
    var FADE_MS = 400;
    var WIDEN_MS = 550;

    var standalone = (window.matchMedia && (
            window.matchMedia('(display-mode: standalone)').matches ||
            window.matchMedia('(display-mode: fullscreen)').matches ||
            window.matchMedia('(display-mode: minimal-ui)').matches ||
            window.matchMedia('(display-mode: window-controls-overlay)').matches)) ||
        window.navigator.standalone === true;
    if (standalone) return;

    function alreadyShown() {
        try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; }
    }
    function markShown() {
        try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) { /* private mode */ }
    }
    if (alreadyShown()) return;

    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

    var pill, label, timers = [], started = false, gone = false;

    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }

    function build() {
        pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'pwa-pill';
        pill.setAttribute('aria-label', LABEL);
        pill.innerHTML =
            '<span class="pwa-pill-icon" aria-hidden="true">' +
                '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/>' +
                '</svg>' +
            '</span>' +
            '<span class="pwa-pill-label">' + LABEL + '</span>';
        label = pill.querySelector('.pwa-pill-label');
        pill.addEventListener('click', onClick);
        document.body.appendChild(pill);
    }

    /** Widen, hold, narrow, hold, fade — restarted whenever the pill is widened by a tap. */
    function runFromExpanded() {
        clearTimers();
        pill.classList.add('is-expanded');
        later(function () { pill.classList.remove('is-expanded'); }, WIDEN_MS + EXPANDED_HOLD);
        later(dismiss, WIDEN_MS + EXPANDED_HOLD + WIDEN_MS + COLLAPSED_HOLD);
    }

    // The "Turn on notifications?" prompt covers the page; the pill waits for
    // it to close rather than playing out unseen underneath it.
    // Looked up in start(): its markup comes after this script in partials/script.
    var pushPrompt = null;
    function pushPromptOpen() { return !!pushPrompt && !pushPrompt.hidden; }

    /** Sit above the footer bar whenever it is on screen (always, in the desktop layout). */
    function clearFooter() {
        if (!pill) return;
        var footer = document.querySelector('.main-footer');
        pill.style.bottom = '';
        if (!footer) return;
        var top = footer.getBoundingClientRect().top;
        if (top < window.innerHeight) {
            pill.style.bottom = (window.innerHeight - top + 16) + 'px';
        }
    }

    function play() {
        clearTimers();
        pill.classList.remove('is-expanded', 'is-visible');
        clearFooter();
        // Two frames so the starting (hidden) state is painted before fading in
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                pill.classList.add('is-visible');
                later(runFromExpanded, FADE_MS + 200);
            });
        });
    }

    function start() {
        if (started || gone) return;
        started = true;
        markShown();
        build();
        pushPrompt = document.getElementById('pushPrompt');
        if (pushPrompt) {
            // Pause while the prompt is up; replay from the fade-in once it closes
            new MutationObserver(function () {
                if (gone) return;
                if (pushPromptOpen()) { clearTimers(); pill.classList.remove('is-expanded', 'is-visible'); }
                else play();
            }).observe(pushPrompt, { attributes: true, attributeFilter: ['hidden'] });
        }
        if (!pushPromptOpen()) play();
        window.addEventListener('resize', clearFooter);
        window.addEventListener('scroll', clearFooter, { passive: true });
    }

    function dismiss() {
        if (gone) return;
        gone = true;
        clearTimers();
        if (!pill) return;
        pill.classList.remove('is-expanded', 'is-visible');
        setTimeout(function () { if (pill && pill.parentNode) pill.parentNode.removeChild(pill); }, FADE_MS + 50);
    }

    function onClick() {
        if (!pill.classList.contains('is-expanded')) {
            runFromExpanded();
            return;
        }

        var prompt = window.__ftInstallPrompt;
        if (prompt) {
            clearTimers();
            prompt.prompt();
            prompt.userChoice.then(function () {
                // The event can only be used once, whatever the answer
                window.__ftInstallPrompt = null;
                dismiss();
            }, dismiss);
            return;
        }

        if (isIOSSafari) {
            // No install API on iOS: say where the option lives, then hold again
            // Longer text: set at a fixed width inside the label so it wraps
            // once, rather than reflowing while the pill widens
            label.innerHTML = '<span class="pwa-pill-hint">Tap Share, then “Add to Home Screen”</span>';
            pill.classList.add('is-hint');
            runFromExpanded();
        }
    }

    window.addEventListener('appinstalled', function () {
        window.__ftInstallPrompt = null;
        dismiss();
    });

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    ready(function () {
        if (window.__ftInstallPrompt) { start(); return; }
        if (isIOSSafari) { start(); return; }
        // Chrome/Edge may decide it is installable a moment after load
        document.addEventListener('ft:installable', start, { once: true });
    });
}());

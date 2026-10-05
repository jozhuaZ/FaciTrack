// FaciTrack — Main JS (PWA + Mobile)

document.addEventListener('DOMContentLoaded', function () {

    // ── PWA: Register service worker ──
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // ── Mobile: prevent 300ms tap delay ──
    // (handled by touch-action in CSS, but also set here for older browsers)
    document.documentElement.style.touchAction = 'manipulation';

    // ── Mobile: fix 100vh on iOS (address bar shrinks viewport) ──
    function setVh() {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
    }
    setVh();
    window.addEventListener('resize', setVh);
    window.addEventListener('orientationchange', function () {
        setTimeout(setVh, 200);
    });

    // ── Mobile: close modals on backdrop tap ──
    // A modal that must confirm before closing opts out with
    // data-backdrop-close="manual" and handles the tap itself.
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        if (overlay.dataset.backdropClose === 'manual') return;
        overlay.addEventListener('click', function (e) {
            if (e.target === this) {
                this.classList.remove('show');
            }
        });
    });

    // ── Mobile: the header hamburger drives the sidebar's own toggle ──
    // Forwarding rather than duplicating keeps the icon swap, the footer
    // reveal and aria-expanded in the one place that already handles them.
    (function () {
        const headerToggle = document.getElementById('headerMenuToggle');
        const sidebarToggle = document.getElementById('sidebarToggle');
        // Error pages render the header without a sidebar; leave it hidden there
        if (!headerToggle || !sidebarToggle) return;
        headerToggle.hidden = false;

        headerToggle.addEventListener('click', function (e) {
            // Without this the document handler below sees the same click and
            // closes the nav that was just opened
            e.stopPropagation();
            sidebarToggle.click();

            const isOpen = sidebarToggle.getAttribute('aria-expanded') === 'true';
            headerToggle.setAttribute('aria-expanded', String(isOpen));
            const menu = headerToggle.querySelector('.icon-menu');
            const close = headerToggle.querySelector('.icon-close');
            if (menu) menu.style.display = isOpen ? 'none' : '';
            if (close) close.style.display = isOpen ? '' : 'none';
        });
    }());

    // ── Mobile: close sidebar when tapping outside ──
    document.addEventListener('click', function (e) {
        const sidebar = document.querySelector('.instructor-sidebar, .student-sidebar');
        const toggle = document.getElementById('sidebarToggle');
        const headerToggle = document.getElementById('headerMenuToggle');
        const nav = document.querySelector('.sidebar-nav');
        if (
            sidebar && nav && nav.classList.contains('mobile-open') &&
            !sidebar.contains(e.target) && toggle && !toggle.contains(e.target) &&
            !(headerToggle && headerToggle.contains(e.target))
        ) {
            nav.classList.remove('mobile-open');
            if (toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                const iconMenu = toggle.querySelector('.icon-menu');
                const iconClose = toggle.querySelector('.icon-close');
                if (iconMenu) iconMenu.style.display = '';
                if (iconClose) iconClose.style.display = 'none';
            }
            // The header hamburger mirrors it, so put its icon back too
            if (headerToggle) {
                headerToggle.setAttribute('aria-expanded', 'false');
                const hMenu = headerToggle.querySelector('.icon-menu');
                const hClose = headerToggle.querySelector('.icon-close');
                if (hMenu) hMenu.style.display = '';
                if (hClose) hClose.style.display = 'none';
            }
            const footer = document.querySelector('.sidebar-footer');
            if (footer && window.innerWidth <= 1024) footer.style.display = 'none';
        }
    });

    // ── Auto-dismiss alerts ──
    // Opt-in only. Matching the bare .alert class removed anything that used
    // "alert" as a style: the Unanswered Requests tab on the dean's Reports
    // page (red while requests are overdue) vanished five seconds after load,
    // and so did the icon of every alert-type notification in the bell panel.
    document.querySelectorAll('[data-auto-dismiss]').forEach(alert => {
        setTimeout(() => {
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    });

});

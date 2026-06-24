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
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', function (e) {
            if (e.target === this) {
                this.classList.remove('show');
            }
        });
    });

    // ── Mobile: close sidebar when tapping outside ──
    document.addEventListener('click', function (e) {
        const sidebar = document.querySelector('.instructor-sidebar, .student-sidebar');
        const toggle = document.getElementById('sidebarToggle');
        const nav = document.querySelector('.sidebar-nav');
        if (
            sidebar && nav && nav.classList.contains('mobile-open') &&
            !sidebar.contains(e.target) && toggle && !toggle.contains(e.target)
        ) {
            nav.classList.remove('mobile-open');
            if (toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                const iconMenu = toggle.querySelector('.icon-menu');
                const iconClose = toggle.querySelector('.icon-close');
                if (iconMenu) iconMenu.style.display = '';
                if (iconClose) iconClose.style.display = 'none';
            }
            const footer = document.querySelector('.sidebar-footer');
            if (footer && window.innerWidth <= 1024) footer.style.display = 'none';
        }
    });

    // ── Auto-dismiss alerts ──
    document.querySelectorAll('.alert').forEach(alert => {
        setTimeout(() => {
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    });

});

/**
 * One instructor's consultation history, as the student sees it.
 *
 * Owns the cancel dialog and the ?openApt= highlight that notification links
 * arrive with.
 */
(function () {
    'use strict';

    var pendingCancelId = null;
    var modal = document.getElementById('declineModal');

    function formatFullDate(dateStr) {
        var d = new Date(dateStr + (String(dateStr).includes('T') ? '' : 'T00:00:00'));
        return d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
    }

    function showToast(type, title, message) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.innerHTML = '<div class="toast-content">' +
            '<p class="toast-title"></p><p class="toast-message"></p></div>';
        toast.querySelector('.toast-title').textContent = title;
        toast.querySelector('.toast-message').textContent = message;
        container.appendChild(toast);
        setTimeout(function () {
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 4000);
    }

    window.showDeclineModal = function (appointmentId, facultyName, date, slot) {
        pendingCancelId = appointmentId;
        document.getElementById('declineModalText').textContent =
            'You are about to cancel your appointment with ' + facultyName +
            ' scheduled for ' + formatFullDate(date) + ' at ' + slot + '. This action cannot be undone.';
        modal.classList.add('show');
    };

    window.hideDeclineModal = function () {
        modal.classList.remove('show');
        pendingCancelId = null;
    };

    window.confirmDecline = async function () {
        if (!pendingCancelId) return;

        var btn = document.querySelector('.decline-modal-confirm');
        btn.disabled = true;
        btn.textContent = 'Canceling…';

        try {
            var res = await fetch('/student/appointments/' + pendingCancelId + '/cancel', { method: 'POST' });
            var data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to cancel appointment.');

            window.hideDeclineModal();
            showToast('success', 'Appointment Canceled',
                'Your appointment has been canceled. The instructor will be notified.');
            setTimeout(function () { window.location.reload(); }, 1800);
        } catch (err) {
            showToast('error', 'Error', err.message || 'Failed to cancel appointment. Please try again.');
            btn.disabled = false;
            btn.textContent = 'Yes, Cancel';
        }
    };

    modal.addEventListener('click', function (event) {
        if (event.target === modal) window.hideDeclineModal();
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && modal.classList.contains('show')) window.hideDeclineModal();
    });

    // ── Search and filter ──
    window.CardFilter.create({
        cardSelector: '.apt-list-card',
        search: '#aptSearch',
        filters: [{ selector: '#aptStatus', attr: 'status' }],
        count: '#aptCount',
        empty: '#aptEmpty',
        noun: 'appointment',
        // An "Upcoming" heading above nothing reads as a bug, so a section
        // whose cards are all filtered out goes with them.
        onFilter: function () {
            document.querySelectorAll('.history-section').forEach(function (section) {
                var anyVisible = section.querySelector('.apt-list-card:not([hidden])');
                section.hidden = !anyVisible;
            });
        },
    });

    // A notification linked straight to one booking — bring it into view and
    // mark it, so the student is not left scanning the page for what changed.
    var openApt = window.STUDENT_OPEN_APT;
    if (openApt) {
        var card = document.querySelector('.apt-list-card[data-apt-id="' + openApt + '"]');
        if (card) {
            card.classList.add('is-target');
            setTimeout(function () {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 150);
            setTimeout(function () { card.classList.remove('is-target'); }, 4000);
        }
    }

    /* ── The consultation log form ──
       Only completed consultations carry the button. Opens the same preview
       as the instructor's, with its Download PDF button; the server checks the
       booking is this student's and is completed. */
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-consultation-form]');
        if (!btn || !window.ExportSystem) return;
        window.ExportSystem.openPreview({
            title: 'Consultation Log Form',
            subtitle: btn.getAttribute('data-form-subtitle') || '',
            pdf: { url: '/student/appointments/' + encodeURIComponent(btn.getAttribute('data-consultation-form')) + '/consultation-form' },
        });
    });

    /* ── Copying a meeting link ──
       Joining from the phone you booked on is one tap, but the common case is
       booking on a phone and joining from a laptop, and that needs the link
       out of the page. Delegated, so cards re-rendered by the filter keep
       working. */
    document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-copy-link]');
        if (!btn) return;

        var link = btn.getAttribute('data-copy-link');
        var restore = function () { btn.textContent = 'Copy'; };

        function fallback() {
            // clipboard.writeText needs a secure context, and this app is
            // reached over plain http on the campus network as well as https.
            var field = document.createElement('textarea');
            field.value = link;
            field.setAttribute('readonly', '');
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);
            field.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
            document.body.removeChild(field);
            return ok;
        }

        function done(ok) {
            btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
            if (ok) showToast('success', 'Copied', 'The meeting link is on your clipboard.');
            setTimeout(restore, 2000);
        }

        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(link).then(function () { done(true); },
                function () { done(fallback()); });
        } else {
            done(fallback());
        }
    });
}());

/**
 * Admin System Settings.
 *
 * Same unsaved-changes behaviour as the Instructor and Dean settings pages —
 * the shared tracker owns the bar, the leave guard and the per-card dirty
 * state; this file only says how each card saves itself.
 */
(function () {
    'use strict';

    function showToast(type, title, message) {
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.innerHTML = '<div class="toast-content"><p class="toast-title"></p><p class="toast-message"></p></div>';
        toast.querySelector('.toast-title').textContent = title;
        toast.querySelector('.toast-message').textContent = message;
        container.appendChild(toast);
        setTimeout(function () {
            toast.style.opacity = '0';
            setTimeout(function () { toast.remove(); }, 300);
        }, 4000);
    }

    function request(body) {
        return fetch('/admin/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(function (res) { return res.json().catch(function () { return {}; }); })
            .catch(function () { return { success: false, error: 'Network error. Please try again.' }; });
    }

    function value(id) { return document.getElementById(id).value.trim(); }
    function checked(id) { return document.getElementById(id).checked; }

    /** Save one card's fields, reporting whichever message the server gives back. */
    function saveCard(body, successMessage) {
        return request(body).then(function (data) {
            if (!data.success) {
                showToast('error', 'Not Saved', data.error || 'Could not save these settings.');
                return false;
            }
            showToast('success', 'Saved', successMessage);
            return true;
        });
    }

    var savers = {
        appointments: function () {
            // Times are compared as strings, which works because both are HH:MM
            if (value('makeupDayStart') >= value('makeupDayEnd')) {
                showToast('error', 'Check the hours', 'The earliest start must be before the latest end.');
                return Promise.resolve(false);
            }
            return saveCard({
                pending_nudge_every_hours: Number(value('pendingNudgeEveryHours')),
                makeup_max_weeks_ahead: Number(value('makeupMaxWeeksAhead')),
                makeup_day_start: value('makeupDayStart'),
                makeup_day_end: value('makeupDayEnd'),
            }, 'Appointment settings updated.');
        },

        presence: function () {
            return saveCard({
                presence_rssi_threshold: Number(value('presenceRssiThreshold')),
                presence_rssi_exit_margin: Number(value('presenceRssiExitMargin')),
                presence_room_switch_margin: Number(value('presenceRoomSwitchMargin')),
                presence_sighting_fresh_sec: Number(value('presenceSightingFresh')),
                presence_absent_after_sec: Number(value('presenceAbsentAfter')),
                presence_scanner_offline_after_sec: Number(value('presenceScannerOffline')),
                presence_logging_enabled: checked('presenceLoggingEnabled'),
            }, 'Presence detection updated.');
        },

        channels: function () {
            return saveCard({
                email_enabled: checked('emailEnabled'),
                push_enabled: checked('pushEnabled'),
            }, 'Notification channels updated.');
        },
    };

    if (window.SettingsTracker) {
        window.SettingsTracker.create({ savers: savers });
    }
})();

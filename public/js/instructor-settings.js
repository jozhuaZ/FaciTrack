/**
 * Instructor Settings page.
 *
 * Every card owns its own save endpoint. The change tracking, save bar and
 * leave guard come from /js/settings-tracker.js, shared with the Dean settings
 * page so the two behave identically. This file supplies the savers and the
 * instructor-specific controls.
 */
(function () {
    'use strict';

    // ── Toast ──
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

    function request(url, body) {
        return fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then(function (res) { return res.json().catch(function () { return {}; }); })
            .catch(function () { return { success: false, error: 'Network error. Please try again.' }; });
    }

    // ── Savers, one per card ─────────────────────────────────────────────────
    var savers = {
        profile: function () {
            var firstName = document.getElementById('inputFirstName').value.trim();
            var lastName = document.getElementById('inputLastName').value.trim();
            if (!firstName || !lastName) {
                showToast('error', 'Missing Fields', 'First name and last name are required.');
                return Promise.resolve(false);
            }
            return request('/instructor/profile', {
                firstName: firstName,
                middleName: document.getElementById('inputMiddleName').value.trim(),
                lastName: lastName,
            }).then(function (data) {
                if (!data.success) {
                    showToast('error', 'Not Saved', data.error || 'Could not update your profile.');
                    return false;
                }
                // Keep the header card and sidebar in step without a reload
                document.querySelector('.settings-name').textContent = data.name;
                var sidebarName = document.querySelector('.profile-name-mini');
                if (sidebarName) sidebarName.textContent = data.name;
                showToast('success', 'Saved', 'Personal information updated.');
                return true;
            });
        },

        status: function () {
            var checked = document.querySelector('input[name="campusStatus"]:checked');
            if (!checked) {
                showToast('error', 'No Status', 'Pick a status first.');
                return Promise.resolve(false);
            }
            return request('/instructor/availability-status', { status: checked.value })
                .then(function (data) {
                    if (!data.success) {
                        showToast('error', 'Not Saved', data.error || 'Could not update your status.');
                        return false;
                    }
                    var label = checked.parentElement.textContent.trim();
                    showToast('success', 'Status Updated', 'You are now set to "' + label + '".');
                    return true;
                });
        },

        notifications: function () {
            return request('/instructor/settings/notifications', {
                notifyNewRequests: document.getElementById('notifyNewRequests').checked,
                notifyCancellations: document.getElementById('notifyCancellations').checked,
                notifyReminders: document.getElementById('notifyReminders').checked,
                notifyBleAbsence: document.getElementById('notifyBleAbsence').checked,
                notifyAnnouncements: document.getElementById('notifyAnnouncements').checked,
            }).then(function (data) {
                if (!data.success) {
                    showToast('error', 'Not Saved', data.error || 'Could not save preferences.');
                    return false;
                }
                showToast('success', 'Saved', 'Notification preferences updated.');
                return true;
            });
        },

        link: function () {
            var link = document.getElementById('meetingLinkInput').value.trim();
            return request('/instructor/meeting-link', { meetingLink: link })
                .then(function (data) {
                    if (!data.success) {
                        showToast('error', 'Not Saved', data.error || 'Could not save the link.');
                        return false;
                    }
                    var message = data.meetingLink ? 'Meeting link saved.' : 'Meeting link cleared.';
                    if (data.backfilled) {
                        message += ' ' + data.backfilled + ' waiting consultation(s) updated.';
                    }
                    showToast('success', 'Saved', message);
                    return true;
                });
        },
    };

    // Change tracking, the save bar and the leave guard are shared with the
    // Dean settings page. This page only owns the savers above.
    var tracker = window.SettingsTracker.create({ savers: savers });

    function refreshDirtyState() { if (tracker) tracker.refresh(); }


    // ── Status card: highlight the selection and warn about longer absences ──
    var statusOptions = document.querySelectorAll('#statusGroup .status-option');
    var awayNote = document.getElementById('statusAwayNote');

    function paintStatus() {
        statusOptions.forEach(function (option) {
            var input = option.querySelector('input');
            option.classList.remove('active-available', 'active-alert');
            if (!input.checked) return;
            option.classList.add(input.value === 'available' ? 'active-available' : 'active-alert');
        });
        var selected = document.querySelector('input[name="campusStatus"]:checked');
        var away = selected && (selected.value === 'travel' || selected.value === 'leave');
        awayNote.classList.toggle('show', Boolean(away));
    }
    var statusSelect = document.getElementById('statusSelect');

    function syncStatusSelect() {
        var selected = document.querySelector('input[name="campusStatus"]:checked');
        if (statusSelect && selected) statusSelect.value = selected.value;
    }

    // Leave and Official Travel span days, but the status alone only hides
    // today. Ask for the dates as soon as one is picked — the same prompt the
    // dashboard shows — and put the choice back if the instructor backs out,
    // so a status can never be saved with nothing blocked behind it.
    var MULTI_DAY = { leave: 'On Leave', travel: 'Official Travel' };
    var lastStatus = (document.querySelector('input[name="campusStatus"]:checked') || {}).value || 'available';

    function selectStatus(value) {
        var radio = document.querySelector('input[name="campusStatus"][value="' + value + '"]');
        if (radio) radio.checked = true;
        paintStatus();
        syncStatusSelect();
        refreshDirtyState();
    }

    function handleStatusPicked(value) {
        if (value === lastStatus) return;

        if (!MULTI_DAY[value] || typeof UnavailModal === 'undefined') {
            lastStatus = value;
            refreshDirtyState();
            return;
        }

        var previous = lastStatus;
        UnavailModal.open(null, {
            prompt: 'Block the days you will be away, so students cannot book them. ' +
                    'Save your settings afterwards to apply the status.',
            reason: MULTI_DAY[value],
            skipLabel: 'Set status only',
            onBlocked: function () { lastStatus = value; },
            onSkipped: function () { lastStatus = value; },
            onDismissed: function () {
                selectStatus(previous);
                lastStatus = previous;
                showToast('error', 'Status Unchanged',
                    'Nothing was blocked, so your status was left as it was.');
            },
        });
    }

    statusOptions.forEach(function (option) {
        option.addEventListener('change', function () {
            paintStatus();
            syncStatusSelect();
            var input = option.querySelector('input');
            if (input && input.checked) handleStatusPicked(input.value);
        });
    });

    if (statusSelect) {
        statusSelect.addEventListener('change', function () {
            var radio = document.querySelector('input[name="campusStatus"][value="' + this.value + '"]');
            if (!radio) return;
            radio.checked = true;
            paintStatus();
            refreshDirtyState();
            handleStatusPicked(this.value);
        });
    }

    paintStatus();
    syncStatusSelect();

    // ── Security ──
    document.getElementById('btnChangePassword').addEventListener('click', function () {
        var button = this;
        var current = document.getElementById('inputCurrentPw');
        var next = document.getElementById('inputNewPw');
        var confirm = document.getElementById('inputConfirmPw');

        if (!current.value || !next.value || !confirm.value) {
            showToast('error', 'Missing Fields', 'Please fill in all password fields.');
            return;
        }
        if (next.value.length < 8) {
            showToast('error', 'Too Short', 'New password must be at least 8 characters.');
            return;
        }
        if (next.value !== confirm.value) {
            showToast('error', 'Mismatch', 'New passwords do not match.');
            return;
        }

        button.disabled = true;
        request('/instructor/password', {
            currentPassword: current.value,
            newPassword: next.value,
        }).then(function (data) {
            button.disabled = false;
            if (!data.success) {
                showToast('error', 'Not Changed', data.error || 'Could not change your password.');
                return;
            }
            current.value = next.value = confirm.value = '';
            showToast('success', 'Updated', 'Password changed successfully.');
        });
    });

    // ── Device notifications (Web Push) ──
    var pushToggle = document.getElementById('pushToggle');
    var pushMsg = document.getElementById('pushMsg');
    var pushTestBtn = document.getElementById('pushTestBtn');

    function sayPush(text, ok) {
        pushMsg.textContent = text;
        pushMsg.style.color = ok ? '#166534' : '#dc2626';
        pushMsg.style.display = text ? 'block' : 'none';
    }

    function refreshPush() {
        return window.FaciTrackPush.getState().then(function (state) {
            pushToggle.checked = state === 'on';
            pushToggle.disabled = state === 'unsupported' || state === 'denied';
            pushTestBtn.style.display = state === 'on' ? 'inline-block' : 'none';

            if (state === 'unsupported') {
                sayPush('This browser does not support device notifications.', false);
            } else if (state === 'denied') {
                sayPush('Notifications are blocked. Allow them in your browser settings to turn this on.', false);
            } else {
                sayPush('', true);
            }
        });
    }

    pushToggle.addEventListener('change', function () {
        var wanted = this.checked;
        pushToggle.disabled = true;
        sayPush('', true);

        var action = wanted ? window.FaciTrackPush.enable() : window.FaciTrackPush.disable();
        action.then(function (result) {
            if (!result.ok) {
                sayPush(result.error, false);
                pushToggle.checked = !wanted;
            } else {
                sayPush(wanted ? 'Device notifications enabled.' : 'Device notifications turned off.', true);
            }
            pushToggle.disabled = false;
            refreshPush();
        });
    });

    pushTestBtn.addEventListener('click', function () {
        fetch('/notifications/push/test', { method: 'POST' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                sayPush(data.success && data.sent
                    ? 'Test notification sent to ' + data.sent + ' device(s).'
                    : 'Could not send the test notification.', Boolean(data.sent));
            });
    });

    refreshPush();

    // ── Google Calendar ──
    // Connecting is a plain link out to Google's consent screen, so only the
    // disconnect and the sync controls need wiring. The page reloads after
    // both: the server decides what "connected" and "last synced" mean, and a
    // reload is the honest way to show what it now thinks.
    var googleDisconnect = document.getElementById('googleDisconnect');
    if (googleDisconnect) {
        googleDisconnect.addEventListener('click', function () {
            googleDisconnect.disabled = true;
            fetch('/instructor/google', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (!data.success) {
                        googleDisconnect.disabled = false;
                        showToast('error', 'Not Disconnected', data.error || 'Could not disconnect Google Calendar.');
                        return;
                    }
                    window.location.href = '/instructor/settings';
                })
                .catch(function () {
                    googleDisconnect.disabled = false;
                    showToast('error', 'Not Disconnected', 'Could not reach the server.');
                });
        });
    }

    var googleSync = document.getElementById('googleSyncNow');
    if (googleSync) {
        googleSync.addEventListener('click', function () {
            googleSync.disabled = true;
            googleSync.textContent = 'Syncing…';
            fetch('/instructor/calendar/sync', { method: 'POST' })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (!data.success) {
                        googleSync.disabled = false;
                        googleSync.textContent = 'Sync now';
                        showToast('error', 'Sync Failed', data.error || 'Could not read your calendar.');
                        return;
                    }
                    window.location.href = '/instructor/settings';
                })
                .catch(function () {
                    googleSync.disabled = false;
                    googleSync.textContent = 'Sync now';
                    showToast('error', 'Sync Failed', 'Could not reach the server.');
                });
        });
    }

    // The two calendar preferences save on change rather than through the save
    // bar — the card sits outside .settings-card, so nothing is tracking them.
    var googleSyncBox = document.querySelector('.gcal-sync');
    if (googleSyncBox && googleSyncBox.dataset.connection) {
        var connectionId = googleSyncBox.dataset.connection;

        function saveCalendarPref(body, label) {
            return fetch('/instructor/calendar/connections/' + encodeURIComponent(connectionId), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (!data.success) throw new Error(data.error || 'Not saved.');
                    showToast('success', 'Saved', label);
                })
                .catch(function () {
                    showToast('error', 'Not Saved', 'Could not save that preference.');
                });
        }

        var blockRule = document.getElementById('googleBlockRule');
        if (blockRule) {
            blockRule.addEventListener('change', function () {
                saveCalendarPref({ blockingRule: blockRule.value }, 'Blocking preference updated.');
            });
        }

        var importTitles = document.getElementById('googleImportTitles');
        if (importTitles) {
            importTitles.addEventListener('change', function () {
                saveCalendarPref(
                    { importTitles: importTitles.checked },
                    importTitles.checked ? 'Event titles will be imported.' : 'Busy times only.'
                );
            });
        }
    }

    // ── Profile photo ──
    // Saved to the account, not the browser. The sidebar avatar is repainted
    // alongside the settings one so the change is visible without a reload.
    AvatarUpload.init({
        input: 'settingsAvatarInput',
        remove: 'settingsAvatarRemove',
        targets: ['settingsAvatar', 'sidebarAvatar'],
        notify: showToast
    });

    refreshDirtyState();
}());

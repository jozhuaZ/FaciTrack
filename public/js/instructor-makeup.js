/**
 * Make-up class request form.
 *
 * One request carries several sessions. Ticking a class from the timetable adds
 * a session pre-filled from it, and "Find available slots" asks the server for
 * the soonest room and hour that suits each one — the instructor never has to
 * hunt through the timetable themselves. Every row still checks itself against
 * the server as it is edited, so a clash surfaces while it can still be fixed.
 */
(function () {
    'use strict';

    var ROOMS = window.MK_ROOMS || [];
    var ROOM_TYPES = window.MK_ROOM_TYPES || { Lecture: ['Lecture', 'Laboratory'], Laboratory: ['Laboratory'], Online: [] };
    var WINDOW_ = window.MK_WINDOW || {};
    var EDITING = window.MK_EDITING || null;

    var list = document.getElementById('mkSessions');
    var empty = document.getElementById('mkNoSessions');
    var counter = document.getElementById('mkCount');
    var form = document.getElementById('makeupForm');
    var generateBtn = document.getElementById('mkGenerate');
    var generateHint = document.getElementById('mkGenerateHint');

    var nextRowId = 1;

    // ── Small helpers ──────────────────────────────────────────────────────

    function slotToTime(slot) {
        var total = slot * 30;
        return String(Math.floor(total / 60)).padStart(2, '0') + ':' +
               String(total % 60).padStart(2, '0');
    }

    function timeToSlot(time) {
        var parts = String(time || '').split(':');
        return (parseInt(parts[0], 10) || 0) * 2 + (parseInt(parts[1], 10) >= 30 ? 1 : 0);
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g,
            function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
    }

    /** Only rooms that can actually host this kind of class. */
    function roomsFor(classType) {
        var allowed = ROOM_TYPES[classType] || [];
        return ROOMS.filter(function (r) { return allowed.indexOf(r.type) !== -1; });
    }

    function roomOptions(classType, selectedId) {
        return roomsFor(classType).map(function (r) {
            return '<option value="' + r.id + '"' +
                   (String(r.id) === String(selectedId) ? ' selected' : '') + '>' +
                   escapeHtml(r.name) + ' · ' + escapeHtml(r.type) + '</option>';
        }).join('');
    }

    function classTypeOptions(selected) {
        return ['Lecture', 'Laboratory', 'Online'].map(function (t) {
            return '<option value="' + t + '"' + (t === selected ? ' selected' : '') + '>' + t + '</option>';
        }).join('');
    }

    // ── Session rows ───────────────────────────────────────────────────────

    /** Build one session row. `seed` pre-fills it from a timetable block or a saved session. */
    function addRow(seed, blockCheckbox) {
        var data = seed || {};
        var classType = data.classType || 'Lecture';
        var id = nextRowId++;

        var row = document.createElement('div');
        row.className = 'mk-session';
        row.dataset.rowId = id;
        if (data.workloadBlockId) row.dataset.blockId = data.workloadBlockId;
        // The original class, so a suggestion can keep its length and usual room
        row.dataset.duration = data.durationSlots ||
            (data.startTime && data.endTime ? timeToSlot(data.endTime) - timeToSlot(data.startTime) : 2);
        row.dataset.preferredRoom = data.roomId || '';
        row.dataset.preferredStart = data.startTime ? timeToSlot(data.startTime) : '';

        row.innerHTML =
            '<div class="mk-session-head">' +
              '<span class="mk-session-title">' +
                escapeHtml(data.subjectCode || 'New session') +
                (data.sectionName ? ' · ' + escapeHtml(data.sectionName) : '') +
              '</span>' +
              '<div class="mk-session-tools">' +
                '<button type="button" class="mk-find" title="Find the soonest free slot">' +
                  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>' +
                  'Find a slot' +
                '</button>' +
                '<button type="button" class="mk-remove" title="Remove this session">&times;</button>' +
              '</div>' +
            '</div>' +
            '<div class="mk-session-grid">' +
              '<label class="mk-field"><span>Subject code</span>' +
                '<input class="modal-input" data-f="subjectCode" value="' + escapeHtml(data.subjectCode || '') + '" required></label>' +
              '<label class="mk-field"><span>Subject name</span>' +
                '<input class="modal-input" data-f="subjectName" value="' + escapeHtml(data.subjectName || '') + '"></label>' +
              '<label class="mk-field"><span>Section</span>' +
                '<input class="modal-input" data-f="sectionName" value="' + escapeHtml(data.sectionName || '') + '" required></label>' +
              '<label class="mk-field"><span>Class type</span>' +
                '<select class="modal-input" data-f="classType">' + classTypeOptions(classType) + '</select></label>' +
              '<label class="mk-field"><span>Date</span>' +
                '<input class="modal-input" type="date" data-f="classDate" min="' + WINDOW_.minDate + '" max="' + WINDOW_.maxDate + '" value="' + escapeHtml(data.classDate || '') + '" required></label>' +
              '<label class="mk-field" data-mode><span>Mode</span>' +
                '<select class="modal-input" data-f="deliveryMode">' +
                  '<option value="in-campus"' + (data.deliveryMode === 'online' ? '' : ' selected') + '>In-campus</option>' +
                  '<option value="online"' + (data.deliveryMode === 'online' ? ' selected' : '') + '>Online</option>' +
                '</select></label>' +
              '<label class="mk-field"><span>Start</span>' +
                '<input class="modal-input" type="time" step="1800" data-f="startTime" value="' + escapeHtml(data.startTime || '') + '" required></label>' +
              '<label class="mk-field"><span>End</span>' +
                '<input class="modal-input" type="time" step="1800" data-f="endTime" value="' + escapeHtml(data.endTime || '') + '" required></label>' +
              '<label class="mk-field mk-field-wide" data-room><span>Room</span>' +
                '<select class="modal-input" data-f="roomId"><option value="">Select a room…</option>' +
                  roomOptions(classType, data.roomId) + '</select></label>' +
            '</div>' +
            '<p class="mk-conflict" hidden></p>';

        row.querySelector('.mk-remove').addEventListener('click', function () {
            // Removing a row must also untick the class that created it
            if (blockCheckbox) blockCheckbox.checked = false;
            row.remove();
            refresh();
        });

        row.querySelector('.mk-find').addEventListener('click', function () {
            generate([row], this);
        });

        row.addEventListener('input', onRowEdit);
        row.addEventListener('change', onRowEdit);

        function onRowEdit(e) {
            var field = e.target.dataset.f;
            if (field === 'classType') paintClassType(row);
            if (field === 'deliveryMode') paintMode(row);
            if (field === 'startTime' || field === 'endTime') rememberDuration(row);
            if (field) row.classList.remove('is-suggested');
            scheduleCheck(row);
            refresh();
        }

        list.appendChild(row);
        paintClassType(row);
        refresh();
        return row;
    }

    /** An online class has no room to pick, so the mode is settled for it. */
    function paintClassType(row) {
        var classType = row.querySelector('[data-f="classType"]').value;
        var modeSelect = row.querySelector('[data-f="deliveryMode"]');
        var roomSelect = row.querySelector('[data-f="roomId"]');

        if (classType === 'Online') {
            modeSelect.value = 'online';
            modeSelect.disabled = true;
        } else {
            // Leaving Online: the mode was forced, so hand it back rather than
            // leaving the row online with no room field showing
            if (modeSelect.disabled) modeSelect.value = 'in-campus';
            modeSelect.disabled = false;
            // Keep the room only if it still suits the class
            var current = roomSelect.value;
            var stillValid = roomsFor(classType).some(function (r) { return String(r.id) === String(current); });
            roomSelect.innerHTML = '<option value="">Select a room…</option>' +
                roomOptions(classType, stillValid ? current : '');
        }
        paintMode(row);
    }

    /** Online sessions have no room, so the field goes away rather than lying. */
    function paintMode(row) {
        var mode = row.querySelector('[data-f="deliveryMode"]').value;
        var roomField = row.querySelector('[data-room]');
        roomField.style.display = mode === 'online' ? 'none' : '';
        roomField.querySelector('select').required = mode !== 'online';
    }

    /** A hand-typed time changes how long the generator should look for. */
    function rememberDuration(row) {
        var values = readRow(row);
        if (!values.startTime || !values.endTime) return;
        var span = timeToSlot(values.endTime) - timeToSlot(values.startTime);
        if (span > 0) row.dataset.duration = span;
    }

    function readRow(row) {
        var out = {};
        row.querySelectorAll('[data-f]').forEach(function (el) { out[el.dataset.f] = el.value; });
        if (row.dataset.blockId) out.workloadBlockId = row.dataset.blockId;
        if (!out.subjectName) out.subjectName = out.subjectCode;
        return out;
    }

    function rowIsComplete(v) {
        return v.subjectCode && v.sectionName && v.classDate && v.startTime && v.endTime &&
               (v.deliveryMode === 'online' || v.roomId);
    }

    function allRows() {
        return Array.prototype.slice.call(list.querySelectorAll('.mk-session'));
    }

    // ── Slot generation ────────────────────────────────────────────────────

    /** Rows the generator should fill: the ones with no date yet. */
    function rowsNeedingSlots() {
        return allRows().filter(function (row) {
            return !row.querySelector('[data-f="classDate"]').value;
        });
    }

    /** Slots the other rows are already holding, so a suggestion avoids them. */
    function occupiedBy(exclude) {
        return allRows()
            .filter(function (row) { return exclude.indexOf(row) === -1; })
            .map(readRow)
            .filter(function (v) { return v.classDate && v.startTime && v.endTime; })
            .map(function (v) {
                return {
                    classDate: v.classDate,
                    startSlot: timeToSlot(v.startTime),
                    endSlot: timeToSlot(v.endTime),
                    roomId: v.deliveryMode === 'online' ? null : v.roomId,
                };
            });
    }

    function generate(rows, button) {
        if (!rows.length) return;

        var payload = {
            items: rows.map(function (row) {
                var values = readRow(row);
                return {
                    key: row.dataset.rowId,
                    classType: values.classType,
                    deliveryMode: values.deliveryMode,
                    durationSlots: parseInt(row.dataset.duration, 10) || 2,
                    preferredRoomId: row.dataset.preferredRoom || values.roomId || null,
                    preferredStartSlot: row.dataset.preferredStart !== ''
                        ? parseInt(row.dataset.preferredStart, 10)
                        : (values.startTime ? timeToSlot(values.startTime) : null),
                };
            }),
            occupied: occupiedBy(rows),
        };
        if (EDITING) payload.editingRequestId = EDITING.id;

        var label = button ? button.textContent : '';
        if (button) { button.disabled = true; button.textContent = 'Searching…'; }

        fetch('/instructor/makeup/suggest-slots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (button) { button.disabled = false; button.textContent = label; }
                if (!data.success) {
                    showToast('error', 'Could not search', data.error || 'Please try again.');
                    return;
                }
                applySuggestions(rows, data.results);
            })
            .catch(function () {
                if (button) { button.disabled = false; button.textContent = label; }
                showToast('error', 'Network error', 'Could not reach the scheduler.');
            });
    }

    function applySuggestions(rows, results) {
        var byKey = {};
        rows.forEach(function (row) { byKey[row.dataset.rowId] = row; });

        var placed = 0;
        var missed = [];

        results.forEach(function (result) {
            var row = byKey[result.key];
            if (!row) return;

            if (!result.found) {
                missed.push(result.message);
                var box = row.querySelector('.mk-conflict');
                box.hidden = false;
                box.className = 'mk-conflict warn';
                box.textContent = result.message;
                return;
            }

            row.querySelector('[data-f="classDate"]').value = result.classDate;
            row.querySelector('[data-f="startTime"]').value = result.startTime;
            row.querySelector('[data-f="endTime"]').value = result.endTime;
            row.querySelector('[data-f="deliveryMode"]').value = result.deliveryMode;
            paintMode(row);
            if (result.roomId) row.querySelector('[data-f="roomId"]').value = String(result.roomId);

            // The server only suggests slots it has already cleared, so any
            // clash the row was showing is now stale
            bumpRow(row);
            row.classList.remove('has-conflict');
            row.classList.add('is-suggested');

            var note = row.querySelector('.mk-conflict');
            note.hidden = false;
            note.className = 'mk-conflict ok';
            note.textContent = 'Suggested: ' + result.dayOfWeek + ' ' + result.classDate + ', ' +
                result.timeLabel + (result.roomNumber ? ' in ' + result.roomNumber : ' online') + '.';
            placed++;
        });

        refresh();
        if (placed) {
            showToast('success', 'Slots found',
                placed + ' session' + (placed === 1 ? '' : 's') + ' scheduled. Adjust anything you like.');
        }
        if (missed.length && !placed) {
            showToast('error', 'Nothing free', missed[0]);
        }
    }

    // ── Live conflict check, debounced per row ─────────────────────────────

    var timers = {};

    /**
     * Every check carries the row's sequence number. Editing a row or dropping
     * a suggestion into it bumps that number, so a reply about values the row
     * no longer holds is thrown away instead of flagging a clash that is gone.
     */
    function bumpRow(row) {
        row.dataset.checkSeq = String((parseInt(row.dataset.checkSeq, 10) || 0) + 1);
        clearTimeout(timers[row.dataset.rowId]);
    }

    function scheduleCheck(row) {
        bumpRow(row);
        var id = row.dataset.rowId;
        timers[id] = setTimeout(function () { checkRow(row); }, 450);
    }

    function checkRow(row) {
        var box = row.querySelector('.mk-conflict');
        var values = readRow(row);
        if (!rowIsComplete(values)) {
            if (!row.classList.contains('is-suggested')) box.hidden = true;
            row.classList.remove('has-conflict');
            return;
        }

        if (EDITING) values.editingRequestId = EDITING.id;
        var seq = row.dataset.checkSeq;

        fetch('/instructor/makeup/check-conflicts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(values),
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.success || row.dataset.checkSeq !== seq) return;
                if (data.note) {
                    box.hidden = false;
                    box.className = 'mk-conflict warn';
                    box.textContent = data.note;
                    row.classList.remove('has-conflict');
                    return;
                }
                if (!data.conflicts.length) {
                    box.hidden = false;
                    box.className = 'mk-conflict ok';
                    box.textContent = 'That slot is free.';
                    row.classList.remove('has-conflict');
                    return;
                }
                box.hidden = false;
                box.className = 'mk-conflict bad';
                box.textContent = data.conflicts.map(function (c) { return c.message; }).join(' ');
                row.classList.add('has-conflict');
            })
            .catch(function () { /* the server re-checks on submit anyway */ });
    }

    // ── Page state ─────────────────────────────────────────────────────────

    function refresh() {
        var rows = allRows();
        counter.textContent = rows.length;
        empty.hidden = rows.length > 0;

        if (!generateBtn) return;
        var pendingRows = rowsNeedingSlots().length;
        generateBtn.disabled = pendingRows === 0;
        generateHint.textContent = !rows.length
            ? 'Tick a class to enable this.'
            : (pendingRows
                ? pendingRows + ' session' + (pendingRows === 1 ? '' : 's') + ' waiting for a slot.'
                : 'Every session has a slot. Use "Find a slot" on a row to move one.');
    }

    // ── Ticking a class adds a session pre-filled from it ──
    document.querySelectorAll('.mk-class-check').forEach(function (check) {
        check.addEventListener('change', function () {
            var block = JSON.parse(check.dataset.block);
            if (check.checked) {
                // No date: the generator fills it, or the instructor picks one
                var row = addRow({
                    workloadBlockId: block.id,
                    subjectCode: block.subjectCode,
                    subjectName: block.subjectName,
                    sectionName: block.sectionName,
                    classType: block.classType,
                    roomId: block.roomId,
                    durationSlots: block.endSlot - block.startSlot,
                    deliveryMode: block.classType === 'Online' ? 'online' : 'in-campus',
                }, check);
                row.dataset.preferredStart = block.startSlot;
                row.dataset.fromBlock = block.id;
            } else {
                var existing = list.querySelector('.mk-session[data-from-block="' + block.id + '"]');
                if (existing) { existing.remove(); refresh(); }
            }
        });
    });

    document.getElementById('mkAdd').addEventListener('click', function () { addRow(null, null); });

    if (generateBtn) {
        generateBtn.addEventListener('click', function () {
            generate(rowsNeedingSlots(), generateBtn);
        });
    }

    // ── File pickers ───────────────────────────────────────────────────────

    function wireFilePicker(inputId, boxId, textId, emptyLabel) {
        var input = document.getElementById(inputId);
        var box = document.getElementById(boxId);
        var text = document.getElementById(textId);
        if (!input) return null;

        input.addEventListener('change', function () {
            if (!this.files.length) {
                text.textContent = emptyLabel;
                box.classList.remove('has-file');
                return;
            }
            text.textContent = this.files.length === 1
                ? this.files[0].name
                : this.files.length + ' files selected';
            box.classList.add('has-file');
        });
        return input;
    }

    var docsInput = wireFilePicker('mkDocs', 'mkDocsBox', 'mkDocsText',
        'Click to attach one or more PDFs (max 5, 10 MB each)');
    wireFilePicker('mkPolling', 'mkPollingBox', 'mkPollingText',
        'Click to attach the student poll');

    // ── Submit: pack the rows into one field the server can parse ──────────

    form.addEventListener('submit', function (e) {
        var rows = allRows();
        if (!rows.length) {
            e.preventDefault();
            showToast('error', 'No sessions', 'Add at least one make-up session before submitting.');
            return;
        }
        if (!EDITING && docsInput && !docsInput.files.length) {
            e.preventDefault();
            showToast('error', 'Document required', 'Attach at least one supporting PDF.');
            return;
        }
        if (list.querySelector('.mk-session.has-conflict')) {
            e.preventDefault();
            showToast('error', 'Class conflict detected', 'Resolve the highlighted class conflicts first.');
            return;
        }

        // Drop any previous packing so a re-submit cannot double up
        form.querySelectorAll('input[name="sessions"]').forEach(function (el) { el.remove(); });

        rows.forEach(function (row) {
            var hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.name = 'sessions';
            hidden.value = JSON.stringify(readRow(row));
            form.appendChild(hidden);
        });
    });

    function showToast(type, title, message) {
        var container = document.getElementById('toastContainer');
        if (!container) return alert(title + ': ' + message);
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

    // ── Restore the sessions of a request being edited ──
    if (EDITING && EDITING.sessions) {
        EDITING.sessions.forEach(function (s) {
            addRow({
                workloadBlockId: s.workload_block_id,
                subjectCode: s.subject_code,
                subjectName: s.subject_name,
                sectionName: s.section_name,
                classType: s.class_type || 'Lecture',
                classDate: String(s.class_date).slice(0, 10),
                deliveryMode: s.delivery_mode,
                roomId: s.room_id,
                startTime: slotToTime(s.start_slot),
                endTime: slotToTime(s.end_slot),
                durationSlots: s.end_slot - s.start_slot,
            }, null);
        });
    }

    refresh();
}());

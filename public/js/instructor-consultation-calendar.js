/* ═══════════════════════════════════════════════════════════════
   INSTRUCTOR CONSULTATION CALENDAR
   View-only: shows student appointment bookings as badges.
   No slot creation, no event management — that lives on Schedule.
   ═══════════════════════════════════════════════════════════════ */

// ── Global state ─────────────────────────────────────────────
let currentCalendarDate  = new Date();
let selectedDate         = null;
let calendarAppointments = [];

// ── Bootstrap ─────────────────────────────────────────────────
function initConsultationCalendar() {
    calendarAppointments = Array.from(
        document.querySelectorAll('.consultation-card')
    ).map((card, idx) => ({
        id:          card.dataset.id        || `apt-${idx}`,
        type:        'appointment',
        status:      card.dataset.status,
        title:       card.dataset.student,
        studentName: card.dataset.student,
        studentId:   card.dataset.studentid,
        date:        card.dataset.date,
        time:        card.dataset.time,
        duration:    card.dataset.duration,
        topic:       card.dataset.topic,
        requestedAt: card.dataset.requested
    }));

    renderCalendar();
    attachCalendarListeners();
}

// ── Render ────────────────────────────────────────────────────
function renderCalendar() {
    const titleEl = document.getElementById('calViewTitle');
    if (titleEl) {
        titleEl.textContent = currentCalendarDate.toLocaleString('default', {
            month: 'long', year: 'numeric'
        });
    }
    renderCalendarDays(currentCalendarDate.getFullYear(), currentCalendarDate.getMonth());
}

function renderCalendarDays(year, month) {
    const gridEl = document.getElementById('calViewGrid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    const firstDay    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();
    const today       = new Date(); today.setHours(0, 0, 0, 0);

    const allDays = [];
    for (let i = firstDay - 1; i >= 0; i--)
        allDays.push({ day: daysInPrev - i, date: new Date(year, month - 1, daysInPrev - i), isOtherMonth: true });
    for (let d = 1; d <= daysInMonth; d++)
        allDays.push({ day: d, date: new Date(year, month, d), isOtherMonth: false });
    const rem = allDays.length % 7 === 0 ? 0 : 7 - (allDays.length % 7);
    for (let d = 1; d <= rem; d++)
        allDays.push({ day: d, date: new Date(year, month + 1, d), isOtherMonth: true });

    for (let i = 0; i < allDays.length; i += 7) {
        const row = document.createElement('div');
        row.className = 'calendar-week-row';
        allDays.slice(i, i + 7).forEach(({ day, date, isOtherMonth }) => {
            row.appendChild(createDayCell(day, date, isOtherMonth, today));
        });
        gridEl.appendChild(row);
    }
}

function createDayCell(day, date, isOtherMonth, today) {
    const cell = document.createElement('div');
    cell.className    = 'calendar-day-cell';
    cell.dataset.date = formatDateISO(date);

    const isToday = date.getTime() === today.getTime();
    if (isOtherMonth) cell.classList.add('other-month');
    if (isToday)      cell.classList.add('today');

    const dayNum = document.createElement('div');
    dayNum.className   = 'calendar-day-number';
    dayNum.textContent = day;
    cell.appendChild(dayNum);

    const eventsWrap = document.createElement('div');
    eventsWrap.className = 'calendar-events-container';

    const dayApts = getAppointmentsForDate(date);
    if (dayApts.length > 0) cell.classList.add('has-events');

    const MAX_VISIBLE = 10;
    dayApts.slice(0, MAX_VISIBLE).forEach(apt => {
        const badge = document.createElement('div');
        badge.className      = `calendar-event-badge appointment ${apt.status || ''}`;
        badge.textContent    = (apt.time ? apt.time + ' ' : '') + apt.studentName;
        badge.dataset.eventId = apt.id;
        badge.title          = `${apt.studentName}${apt.time ? ' at ' + apt.time : ''}`;
        badge.addEventListener('click', e => { e.stopPropagation(); openAptPopover(badge, apt); });
        eventsWrap.appendChild(badge);
    });

    if (dayApts.length > MAX_VISIBLE) {
        const more = document.createElement('div');
        more.className   = 'calendar-event-more';
        more.textContent = `+${dayApts.length - MAX_VISIBLE} more`;
        more.addEventListener('click', e => { e.stopPropagation(); openDayPanel(cell, date, dayApts); });
        eventsWrap.appendChild(more);
    }

    cell.appendChild(eventsWrap);

    // Single click → select; Double click → day panel
    let clickTimer = null, clicks = 0;
    cell.addEventListener('click', e => {
        if (e.target.closest('.calendar-event-badge, .calendar-event-more')) return;
        clicks++;
        if (clicks === 1) {
            handleCellSelect(cell, date);
            clickTimer = setTimeout(() => { clicks = 0; }, 280);
        } else if (clicks === 2) {
            clearTimeout(clickTimer);
            clicks = 0;
            handleCellDoubleClick(cell, date, dayApts);
        }
    });

    return cell;
}

// ── Cell interactions ─────────────────────────────────────────

function handleCellSelect(cell, date) {
    const already = cell.classList.contains('selected');
    document.querySelectorAll('.calendar-day-cell.selected').forEach(c => c.classList.remove('selected'));
    if (already) { selectedDate = null; }
    else         { cell.classList.add('selected'); selectedDate = date; }
}

function handleCellDoubleClick(cell, date, dayApts) {
    const apts = dayApts.filter(a => a.type === 'appointment');
    if (apts.length === 0) { showNoneHint(cell, date); return; }
    if (apts.length === 1) {
        const badge = cell.querySelector(`.calendar-event-badge[data-event-id="${apts[0].id}"]`) || cell;
        openAptPopover(badge, apts[0]);
        return;
    }
    openDayPanel(cell, date, apts);
}

// ── Day Panel — all appointments for a cell ───────────────────
// Shows every appointment as a row with status badge + name/time
// + Approve/Decline buttons. Clicking the row opens the detail popover.

function openDayPanel(anchorCell, date, appointments) {
    closeDayPanel(); // close any existing

    const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    const panel = document.createElement('div');
    panel.id        = 'aptDayPanel';
    panel.className = 'apt-day-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `Appointments for ${label}`);

    // Header
    const header = document.createElement('div');
    header.className = 'apt-day-panel-header';
    header.innerHTML = `
        <div class="apt-day-panel-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            <span>${label}</span>
        </div>
        <span class="apt-day-panel-count">${appointments.length} appointment${appointments.length !== 1 ? 's' : ''}</span>
        <button class="apt-day-panel-close" id="aptDayPanelClose" aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>`;
    panel.appendChild(header);

    // List
    const list = document.createElement('div');
    list.className = 'apt-day-panel-list';

    appointments.forEach(apt => {
        const row = document.createElement('div');
        row.className = `apt-day-panel-row apt-day-row-${apt.status || 'pending'}`;

        const statusDot = apt.status === 'confirmed' ? '#10b981'
                        : apt.status === 'declined'  ? '#ef4444'
                        : '#f59e0b';

        row.innerHTML = `
            <div class="apt-day-row-left">
                <span class="apt-day-row-dot" style="background:${statusDot}"></span>
                <div class="apt-day-row-info">
                    <span class="apt-day-row-name">${apt.studentName || '—'}</span>
                    <span class="apt-day-row-meta">${apt.time || '—'} · ${apt.duration || '—'}</span>
                    <span class="apt-day-row-topic">${apt.topic || '—'}</span>
                </div>
            </div>
            <div class="apt-day-row-actions">
                ${apt.status === 'pending' ? `
                    <button class="apt-day-approve-btn" data-id="${apt.id}" title="Approve">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                    <button class="apt-day-decline-btn" data-id="${apt.id}" title="Decline">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                ` : `<span class="apt-day-status-pill apt-day-status-${apt.status}">${apt.status}</span>`}
                <button class="apt-day-view-btn" data-id="${apt.id}" title="View details">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            </div>`;

        // Click row (not buttons) → open detail popover
        row.addEventListener('click', e => {
            if (e.target.closest('.apt-day-approve-btn, .apt-day-decline-btn, .apt-day-view-btn')) return;
            const badge = document.querySelector(`.calendar-event-badge[data-event-id="${apt.id}"]`) || anchorCell;
            closeDayPanel();
            openAptPopover(badge, apt);
        });

        list.appendChild(row);
    });

    panel.appendChild(list);
    document.body.appendChild(panel);

    // Position panel next to cell
    _positionDayPanel(panel, anchorCell);

    // Wire buttons
    panel.querySelector('#aptDayPanelClose').addEventListener('click', closeDayPanel);

    panel.querySelectorAll('.apt-day-view-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const apt = appointments.find(a => a.id === btn.dataset.id);
            if (!apt) return;
            const badge = document.querySelector(`.calendar-event-badge[data-event-id="${apt.id}"]`) || anchorCell;
            closeDayPanel();
            openAptPopover(badge, apt);
        });
    });

    panel.querySelectorAll('.apt-day-approve-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            _dayPanelApprove(btn.dataset.id, btn, appointments, anchorCell, date);
        });
    });

    panel.querySelectorAll('.apt-day-decline-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            _dayPanelDecline(btn.dataset.id, btn, appointments, anchorCell, date);
        });
    });

    // ESC closes
    panel._escHandler = e => { if (e.key === 'Escape') closeDayPanel(); };
    document.addEventListener('keydown', panel._escHandler);

    // Outside click closes
    panel._outsideHandler = e => {
        if (!panel.contains(e.target) && !anchorCell.contains(e.target)) closeDayPanel();
    };
    setTimeout(() => document.addEventListener('click', panel._outsideHandler), 10);
}

function closeDayPanel() {
    const existing = document.getElementById('aptDayPanel');
    if (!existing) return;
    if (existing._escHandler)     document.removeEventListener('keydown',  existing._escHandler);
    if (existing._outsideHandler) document.removeEventListener('click',    existing._outsideHandler);
    existing.remove();
}

function _positionDayPanel(panel, anchor) {
    const rect  = anchor.getBoundingClientRect();
    const pw    = 300;
    const gap   = 8;
    const vw    = window.innerWidth;
    const vh    = window.innerHeight;

    panel.style.position = 'fixed';
    panel.style.width    = pw + 'px';
    panel.style.zIndex   = '1600';

    // Try right of cell first
    let left = rect.right + gap;
    if (left + pw > vw - 8) left = rect.left - pw - gap;
    left = Math.max(8, left);

    let top = rect.top;
    // Will adjust after render when we know height
    panel.style.left = left + 'px';
    panel.style.top  = '-9999px';
    panel.style.visibility = 'hidden';

    requestAnimationFrame(() => {
        const ph = panel.offsetHeight || 200;
        top = Math.min(rect.top, vh - ph - 8);
        top = Math.max(8, top);
        panel.style.top        = top + 'px';
        panel.style.visibility = 'visible';
    });
}

// ── Day Panel quick-approve / quick-decline ───────────────────

function _dayPanelApprove(id, btn, appointments, anchorCell, date) {
    btn.disabled = true;
    btn.textContent = '…';

    fetch(`/instructor/consultations/${id}/approve`, { method: 'POST' })
        .then(r => r.json())
        .then(() => {
            const apt = calendarAppointments.find(a => a.id === id);
            if (apt) apt.status = 'confirmed';
            _syncCardStatus(id, 'confirmed');
            renderCalendar();
            if (typeof renderPage === 'function') renderPage();
            // Reopen panel with updated data
            const updated = calendarAppointments.filter(a => normalizeDate(a.date) === formatDateISO(date));
            closeDayPanel();
            if (updated.length > 1) openDayPanel(anchorCell, date, updated);
            _showToast('Appointment confirmed', 'success');
        })
        .catch(() => { btn.disabled = false; btn.textContent = '✓'; _showToast('Could not approve', 'error'); });
}

function _dayPanelDecline(id, btn, appointments, anchorCell, date) {
    // Inline reason input inside the row
    const row = btn.closest('.apt-day-panel-row');
    if (row.querySelector('.apt-day-decline-form')) return; // already open

    const actionsDiv = row.querySelector('.apt-day-row-actions');
    actionsDiv.style.display = 'none';

    const form = document.createElement('div');
    form.className = 'apt-day-decline-form';
    form.innerHTML = `
        <textarea class="apt-day-decline-ta" placeholder="Reason for declining…" rows="2"></textarea>
        <div class="apt-day-decline-btns">
            <button class="apt-day-df-cancel">Cancel</button>
            <button class="apt-day-df-confirm">Decline & Notify</button>
        </div>`;
    row.appendChild(form);
    form.querySelector('.apt-day-decline-ta').focus();

    form.querySelector('.apt-day-df-cancel').addEventListener('click', () => {
        form.remove();
        actionsDiv.style.display = '';
    });

    form.querySelector('.apt-day-df-confirm').addEventListener('click', () => {
        const reason = form.querySelector('.apt-day-decline-ta').value.trim();
        if (!reason) {
            form.querySelector('.apt-day-decline-ta').style.borderColor = '#ef4444';
            form.querySelector('.apt-day-decline-ta').focus();
            return;
        }
        const confirmBtn = form.querySelector('.apt-day-df-confirm');
        confirmBtn.disabled = true;
        confirmBtn.textContent = '…';

        fetch(`/instructor/consultations/${id}/decline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        })
        .then(r => r.json())
        .then(() => {
            const apt = calendarAppointments.find(a => a.id === id);
            if (apt) apt.status = 'declined';
            _syncCardStatus(id, 'declined');
            renderCalendar();
            if (typeof renderPage === 'function') renderPage();
            const updated = calendarAppointments.filter(a => normalizeDate(a.date) === formatDateISO(date));
            closeDayPanel();
            if (updated.length > 1) openDayPanel(anchorCell, date, updated);
            _showToast('Student notified', 'success');
        })
        .catch(() => { confirmBtn.disabled = false; confirmBtn.textContent = 'Decline & Notify'; _showToast('Could not decline', 'error'); });
    });
}

// ── "No appointments" hint ────────────────────────────────────

function showNoneHint(cell, date) {
    const pop      = document.getElementById('aptPopover');
    const backdrop = document.getElementById('aptPopoverBackdrop');
    if (!pop || !backdrop) return;

    _aptPopAnchor = cell;
    const label = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    document.getElementById('aptPopStripe').className      = 'apt-pop-stripe confirmed';
    document.getElementById('aptPopName').textContent      = label;
    document.getElementById('aptPopId').textContent        = 'No appointments scheduled';
    document.getElementById('aptPopWhen').textContent      = '—';
    document.getElementById('aptPopDuration').textContent  = '—';
    document.getElementById('aptPopTopic').textContent     = '—';
    document.getElementById('aptPopRequested').textContent = '—';
    const pill = document.getElementById('aptPopStatus');
    pill.textContent = 'Free'; pill.className = 'apt-pop-status confirmed';
    document.getElementById('aptPopActions').style.display = 'none';
    document.getElementById('aptPopDeclinePanel').classList.remove('open');
    document.getElementById('aptPopResolved').classList.remove('open', 'approved', 'declined');
    document.getElementById('aptPopAptId').value = '';

    pop.style.visibility = 'hidden';
    pop.style.left = '-9999px'; pop.style.top = '-9999px';
    pop.classList.add('open'); backdrop.classList.add('open');

    requestAnimationFrame(() => {
        _aptPopPosition();
        pop.style.visibility = 'visible';
        _aptPopScrollEl = document.querySelector('.instructor-main') || window;
        _aptPopScrollEl.addEventListener('scroll', _aptPopOnScroll, { passive: true });
        window.addEventListener('resize', _aptPopOnScroll, { passive: true });
    });
    setTimeout(closeAptPopover, 2000);
}

// ── Appointment data helpers ──────────────────────────────────

function getAppointmentsForDate(date) {
    const iso = formatDateISO(date);
    return calendarAppointments.filter(a => normalizeDate(a.date) === iso);
}

function normalizeDate(str) {
    if (!str) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    try { const d = new Date(str); if (!isNaN(d.getTime())) return formatDateISO(d); } catch (_) {}
    return str;
}

function formatDateISO(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

// ── Nav + view toggle ─────────────────────────────────────────

function attachCalendarListeners() {
    document.getElementById('calViewPrev')?.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1); renderCalendar();
    });
    document.getElementById('calViewNext')?.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1); renderCalendar();
    });
    document.getElementById('calViewToday')?.addEventListener('click', () => {
        currentCalendarDate = new Date(); renderCalendar();
    });
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleView(btn.dataset.view));
    });
}

function toggleView(view) {
    const listView     = document.getElementById('listView');
    const calendarView = document.getElementById('calendarView');
    if (view === 'calendar') {
        if (listView)     listView.style.display     = 'none';
        if (calendarView) calendarView.style.display = 'block';
        renderCalendar();
    } else {
        if (listView)     listView.style.display     = 'block';
        if (calendarView) calendarView.style.display = 'none';
        if (typeof renderPage === 'function') renderPage();
    }
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
}

// ════════════════════════════════════════════════════════════════
//  APPOINTMENT DETAIL POPOVER
// ════════════════════════════════════════════════════════════════

let _aptPopAnchor    = null;
let _aptPopScrollEl  = null;
let _aptPopScrollRAF = null;
const APT_POP_W = 288, APT_POP_GAP = 10;

function _aptPopPosition() {
    const pop = document.getElementById('aptPopover');
    if (!pop || !_aptPopAnchor) return;
    if (window.innerWidth <= 600) return;

    const rect = _aptPopAnchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const actualH = pop.offsetHeight || 300;

    const visible = rect.bottom > 0 && rect.top < vh;
    pop.style.opacity       = visible ? '1' : '0';
    pop.style.pointerEvents = visible ? '' : 'none';

    let left = rect.right + APT_POP_GAP;
    if (left + APT_POP_W > vw - 8) left = rect.left - APT_POP_W - APT_POP_GAP;
    left = Math.max(8, Math.min(left, vw - APT_POP_W - 8));

    let top = rect.top;
    if (top + actualH > vh - 8) top = vh - actualH - 8;
    top = Math.max(8, top);

    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
}

function _aptPopOnScroll() {
    if (_aptPopScrollRAF) cancelAnimationFrame(_aptPopScrollRAF);
    _aptPopScrollRAF = requestAnimationFrame(_aptPopPosition);
}

function openAptPopover(badgeEl, appointment) {
    const pop = document.getElementById('aptPopover');
    const backdrop = document.getElementById('aptPopoverBackdrop');
    if (!pop || !backdrop) return;

    // Close day panel if open
    closeDayPanel();

    _aptPopAnchor = badgeEl;
    const status = appointment.status || 'pending';

    document.getElementById('aptPopName').textContent      = appointment.studentName || '—';
    document.getElementById('aptPopId').textContent        = appointment.studentId   || '—';
    document.getElementById('aptPopWhen').textContent      = `${appointment.date || '—'} · ${appointment.time || '—'}`;
    document.getElementById('aptPopDuration').textContent  = appointment.duration    || '—';
    document.getElementById('aptPopTopic').textContent     = appointment.topic       || '—';
    document.getElementById('aptPopRequested').textContent = appointment.requestedAt || '—';

    document.getElementById('aptPopStripe').className = `apt-pop-stripe ${status}`;
    const pill = document.getElementById('aptPopStatus');
    pill.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    pill.className   = `apt-pop-status ${status}`;

    document.getElementById('aptPopActions').style.display = status === 'pending' ? 'flex' : 'none';
    document.getElementById('aptPopDeclinePanel').classList.remove('open');
    document.getElementById('aptPopDeclineReason').value = '';
    document.getElementById('aptPopResolved').classList.remove('open', 'approved', 'declined');
    document.getElementById('aptPopAptId').value = appointment.id || '';

    pop.style.visibility = 'hidden';
    pop.style.opacity = '1'; pop.style.pointerEvents = '';
    pop.style.left = '-9999px'; pop.style.top = '-9999px';
    pop.classList.add('open'); backdrop.classList.add('open');

    requestAnimationFrame(() => {
        _aptPopPosition();
        pop.style.visibility = 'visible';
        _aptPopScrollEl = document.querySelector('.instructor-main') || window;
        _aptPopScrollEl.addEventListener('scroll', _aptPopOnScroll, { passive: true });
        window.addEventListener('resize', _aptPopOnScroll, { passive: true });
    });
}

function closeAptPopover() {
    const pop = document.getElementById('aptPopover');
    const backdrop = document.getElementById('aptPopoverBackdrop');
    if (pop)      pop.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    _aptPopAnchor = null;
    if (_aptPopScrollRAF) { cancelAnimationFrame(_aptPopScrollRAF); _aptPopScrollRAF = null; }
    if (_aptPopScrollEl) {
        _aptPopScrollEl.removeEventListener('scroll', _aptPopOnScroll);
        window.removeEventListener('resize', _aptPopOnScroll);
        _aptPopScrollEl = null;
    }
}

function _showResolved(type, msg) {
    document.getElementById('aptPopDeclinePanel').classList.remove('open');
    document.getElementById('aptPopActions').style.display = 'none';

    const resolved = document.getElementById('aptPopResolved');
    const icon     = document.getElementById('aptPopResolvedIcon');
    const msgEl    = document.getElementById('aptPopResolvedMsg');

    icon.innerHTML = type === 'approved'
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    msgEl.textContent  = msg;
    resolved.className = `apt-pop-resolved open ${type}`;

    const status = type === 'approved' ? 'confirmed' : 'declined';
    document.getElementById('aptPopStripe').className = `apt-pop-stripe ${status}`;
    const pill = document.getElementById('aptPopStatus');
    pill.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    pill.className   = `apt-pop-status ${status}`;

    requestAnimationFrame(_aptPopPosition);
    setTimeout(closeAptPopover, 1800);
}

function initAptPopover() {
    const pop      = document.getElementById('aptPopover');
    const backdrop = document.getElementById('aptPopoverBackdrop');
    if (!pop) return;

    document.getElementById('aptPopClose')?.addEventListener('click', closeAptPopover);
    backdrop?.addEventListener('click', closeAptPopover);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && pop.classList.contains('open')) closeAptPopover();
    });

    document.getElementById('aptPopApprove')?.addEventListener('click', () => {
        const id = document.getElementById('aptPopAptId').value;
        if (!id) return;
        fetch(`/instructor/consultations/${id}/approve`, { method: 'POST' })
            .then(r => r.json())
            .then(() => {
                const apt = calendarAppointments.find(a => a.id === id);
                if (apt) apt.status = 'confirmed';
                _syncCardStatus(id, 'confirmed');
                _showResolved('approved', 'Appointment confirmed');
                renderCalendar();
                if (typeof renderPage === 'function') renderPage();
            })
            .catch(() => _showToast('Could not approve appointment', 'error'));
    });

    document.getElementById('aptPopDeclineBtn')?.addEventListener('click', () => {
        document.getElementById('aptPopActions').style.display = 'none';
        document.getElementById('aptPopDeclinePanel').classList.add('open');
        setTimeout(() => document.getElementById('aptPopDeclineReason').focus(), 60);
        requestAnimationFrame(_aptPopPosition);
    });

    document.getElementById('aptPopDeclineCancel')?.addEventListener('click', () => {
        document.getElementById('aptPopDeclinePanel').classList.remove('open');
        document.getElementById('aptPopActions').style.display = 'flex';
        requestAnimationFrame(_aptPopPosition);
    });

    document.getElementById('aptPopDeclineConfirm')?.addEventListener('click', () => {
        const id     = document.getElementById('aptPopAptId').value;
        const reason = document.getElementById('aptPopDeclineReason').value.trim();
        if (!id) return;
        if (!reason) {
            const ta = document.getElementById('aptPopDeclineReason');
            ta.style.borderColor = '#ef4444'; ta.focus();
            setTimeout(() => ta.style.borderColor = '', 1500);
            return;
        }
        fetch(`/instructor/consultations/${id}/decline`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason })
        })
        .then(r => r.json())
        .then(() => {
            const apt = calendarAppointments.find(a => a.id === id);
            if (apt) apt.status = 'declined';
            _syncCardStatus(id, 'declined');
            _showResolved('declined', 'Student notified');
            renderCalendar();
            if (typeof renderPage === 'function') renderPage();
        })
        .catch(() => _showToast('Could not decline appointment', 'error'));
    });
}

// ── Shared helpers ────────────────────────────────────────────

function _syncCardStatus(id, newStatus) {
    const card = document.querySelector(`.consultation-card[data-id="${id}"]`);
    if (!card) return;
    card.dataset.status = newStatus;
    const badge = card.querySelector('.consult-status-badge');
    if (badge) { badge.textContent = newStatus.charAt(0).toUpperCase() + newStatus.slice(1); badge.className = `consult-status-badge ${newStatus}`; }
    card.querySelectorAll('.btn-approve-full, .btn-decline-full').forEach(b => b.remove());
}

function _showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<div class="toast-content"><p class="toast-message">${message}</p></div>`;
    container.appendChild(toast);
    setTimeout(() => { toast.style.animation = 'slideOutRight 0.4s ease'; setTimeout(() => toast.remove(), 400); }, 3000);
}

// ── Init ──────────────────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initConsultationCalendar(); initAptPopover(); });
} else {
    initConsultationCalendar();
    initAptPopover();
}

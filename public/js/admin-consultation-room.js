// ══════════════════════════════════════════════════════════════
// Admin Consultation Room — Week-View Calendar
// ══════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────
let allSlots     = [];
let syncCounts   = [];
let dailyLimit   = window.CONSULT_DATA.currentLimit;
let currentWeekStart = getWeekStart(new Date());   // Monday of current week
let miniCalDate  = new Date(currentWeekStart);     // month shown in mini-cal

let filters = {
    instructorId : null,
    programCode  : null,
    status       : null,
    mode         : null
};

// Calendar hours shown: 7 AM – 8 PM
const HOUR_START = 7;
const HOUR_END   = 20;
const HOUR_PX    = 60;   // px per hour — must match CSS .cr-hour-label height

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initWeekNav();
    initFilters();
    initSettings();
    loadAllData();
    setInterval(loadAllData, 30000);
});

// ══════════════════════════════════════════════════════════════
// Week Navigation
// ══════════════════════════════════════════════════════════════

function initWeekNav() {
    document.getElementById('prevWeekBtn').addEventListener('click', () => {
        currentWeekStart = addDays(currentWeekStart, -7);
        miniCalDate = new Date(currentWeekStart);
        loadAllData();
    });
    document.getElementById('nextWeekBtn').addEventListener('click', () => {
        currentWeekStart = addDays(currentWeekStart, 7);
        miniCalDate = new Date(currentWeekStart);
        loadAllData();
    });
    document.getElementById('todayBtn').addEventListener('click', () => {
        currentWeekStart = getWeekStart(new Date());
        miniCalDate = new Date();
        loadAllData();
    });
    document.getElementById('refreshBtn').addEventListener('click', loadAllData);
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;   // Monday
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// ══════════════════════════════════════════════════════════════
// Filters
// ══════════════════════════════════════════════════════════════

function initFilters() {
    document.getElementById('applyFiltersBtn').addEventListener('click', () => {
        filters.instructorId = document.getElementById('filterInstructor').value || null;
        filters.programCode  = document.getElementById('filterProgram').value  || null;
        filters.status       = document.getElementById('filterStatus').value   || null;
        filters.mode         = document.getElementById('filterMode').value     || null;
        loadAllData();
    });

    document.getElementById('clearFiltersBtn').addEventListener('click', () => {
        document.getElementById('filterInstructor').value = '';
        document.getElementById('filterProgram').value    = '';
        document.getElementById('filterStatus').value     = '';
        document.getElementById('filterMode').value       = '';
        filters = { instructorId: null, programCode: null, status: null, mode: null };
        loadAllData();
    });
}

// ══════════════════════════════════════════════════════════════
// Data Loading
// ══════════════════════════════════════════════════════════════

async function loadAllData() {
    const weekEnd = addDays(currentWeekStart, 6);

    try {
        await Promise.all([
            fetchSlots(isoDate(currentWeekStart), isoDate(weekEnd)),
            fetchSyncCounts(isoDate(currentWeekStart), isoDate(weekEnd))
        ]);
        renderWeekLabel();
        renderMiniCal();
        renderWeekCalendar();
        renderNowLine();
        updateStats();
    } catch (err) {
        console.error('[ConsultRoom] load error:', err);
        showToast('Failed to load data', 'error');
    }
}

async function fetchSlots(startDate, endDate) {
    const p = new URLSearchParams({ startDate, endDate });
    if (filters.instructorId) p.append('instructorId', filters.instructorId);
    if (filters.programCode)  p.append('programCode',  filters.programCode);
    if (filters.status)       p.append('status',       filters.status);
    if (filters.mode)         p.append('mode',         filters.mode);

    const res  = await fetch(`/admin/consultation-room/multi-day-slots?${p}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    allSlots = data.slots;
}

async function fetchSyncCounts(startDate, endDate) {
    const p   = new URLSearchParams({ startDate, endDate });
    const res  = await fetch(`/admin/consultation-room/multi-day-sync-counts?${p}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    syncCounts = data.counts;
    dailyLimit = data.limit;
    document.getElementById('currentLimitDisplay').textContent = dailyLimit;
}

// ══════════════════════════════════════════════════════════════
// Week Label
// ══════════════════════════════════════════════════════════════

function renderWeekLabel() {
    const end   = addDays(currentWeekStart, 6);
    const fmt   = { month: 'short', day: 'numeric', year: 'numeric' };
    const label = `${currentWeekStart.toLocaleDateString('en-US', fmt)} – ${end.toLocaleDateString('en-US', fmt)}`;
    document.getElementById('weekLabel').textContent = label;

    // ISO week number
    const jan1  = new Date(currentWeekStart.getFullYear(), 0, 1);
    const weekN = Math.ceil(((currentWeekStart - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    document.getElementById('weekBadge').textContent = `Week ${weekN}`;
}

// ══════════════════════════════════════════════════════════════
// Mini Month Calendar
// ══════════════════════════════════════════════════════════════

function renderMiniCal() {
    const yr  = miniCalDate.getFullYear();
    const mo  = miniCalDate.getMonth();
    const today = new Date(); today.setHours(0,0,0,0);
    const weekEnd = addDays(currentWeekStart, 6);

    document.getElementById('miniMonthLabel').textContent =
        miniCalDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const grid = document.getElementById('miniCalGrid');
    grid.innerHTML = '';

    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    days.forEach(d => {
        const lbl = document.createElement('div');
        lbl.className = 'cr-mini-day-label';
        lbl.textContent = d;
        grid.appendChild(lbl);
    });

    // First day of month (adjust: 0=Sun→6, 1=Mon→0, …)
    const firstDay = new Date(yr, mo, 1);
    let startOffset = firstDay.getDay() - 1;
    if (startOffset < 0) startOffset = 6;

    const daysInMonth = new Date(yr, mo + 1, 0).getDate();
    const prevDays    = new Date(yr, mo, 0).getDate();

    // Gather dates that have slots
    const slotDates = new Set(allSlots.map(s => s.consultation_date));

    // Blanks from prev month
    for (let i = startOffset - 1; i >= 0; i--) {
        const cell = document.createElement('div');
        cell.className = 'cr-mini-cell cr-mini-other';
        cell.textContent = prevDays - i;
        grid.appendChild(cell);
    }

    // Days of this month
    for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(yr, mo, d);
        dateObj.setHours(0,0,0,0);
        const dateStr = isoDate(dateObj);

        const cell = document.createElement('div');
        cell.className = 'cr-mini-cell';
        cell.textContent = d;

        if (+dateObj === +today)           cell.classList.add('cr-mini-today');
        if (+dateObj >= +currentWeekStart &&
            +dateObj <= +weekEnd)          cell.classList.add('cr-mini-in-week');
        if (+dateObj === +currentWeekStart)cell.classList.add('cr-mini-selected');
        if (slotDates.has(dateStr))        cell.classList.add('cr-mini-has-slots');

        cell.addEventListener('click', () => {
            currentWeekStart = getWeekStart(dateObj);
            miniCalDate = new Date(dateObj);
            loadAllData();
        });

        grid.appendChild(cell);
    }
}

document.getElementById('miniPrevMonth').addEventListener('click', () => {
    miniCalDate.setMonth(miniCalDate.getMonth() - 1);
    renderMiniCal();
});
document.getElementById('miniNextMonth').addEventListener('click', () => {
    miniCalDate.setMonth(miniCalDate.getMonth() + 1);
    renderMiniCal();
});

// ══════════════════════════════════════════════════════════════
// Week Calendar Rendering
// ══════════════════════════════════════════════════════════════

function renderWeekCalendar() {
    const grid  = document.getElementById('weekGrid');
    grid.innerHTML = '';

    const today = new Date(); today.setHours(0,0,0,0);

    // ── Day headers ──────────────────────────────────────────
    // Empty top-left corner (above time gutter)
    const gutterHdr = document.createElement('div');
    gutterHdr.className = 'cr-time-gutter-header';
    grid.appendChild(gutterHdr);

    const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    for (let i = 0; i < 7; i++) {
        const d       = addDays(currentWeekStart, i);
        const dateStr = isoDate(d);
        const isToday = +d === +today;

        const syncEntry = syncCounts.find(c => c.consultation_date === dateStr);
        const syncUsed  = syncEntry ? parseInt(syncEntry.sync_count, 10) : 0;
        const pct       = dailyLimit > 0 ? Math.min((syncUsed / dailyLimit) * 100, 100) : 0;
        const fillCls   = pct >= 100 ? 'full' : pct >= 75 ? 'near' : 'under';

        const hdr = document.createElement('div');
        hdr.className = `cr-day-header${isToday ? ' cr-today-col' : ''}`;
        hdr.innerHTML = `
            <div class="cr-day-name">${dayNames[i]}</div>
            <div class="cr-day-num">${d.getDate()}</div>
            <div class="cr-day-sync-bar"><div class="cr-day-sync-fill ${fillCls}" style="width:${pct}%"></div></div>
            <div class="cr-day-sync-label">${syncUsed}/${dailyLimit} Sync</div>
        `;
        hdr.addEventListener('click', () => {
            currentWeekStart = getWeekStart(d);
            miniCalDate = new Date(d);
            loadAllData();
        });
        grid.appendChild(hdr);
    }

    // ── Time Gutter ──────────────────────────────────────────
    const gutter = document.createElement('div');
    gutter.className = 'cr-time-gutter';

    for (let h = HOUR_START; h <= HOUR_END; h++) {
        const lbl = document.createElement('div');
        lbl.className = 'cr-hour-label';
        lbl.textContent = formatHour(h);
        gutter.appendChild(lbl);
    }
    grid.appendChild(gutter);

    // ── Day Columns ───────────────────────────────────────────
    for (let i = 0; i < 7; i++) {
        const d       = addDays(currentWeekStart, i);
        const dateStr = isoDate(d);
        const isToday = +d === +today;

        const col = document.createElement('div');
        col.className = `cr-day-col${isToday ? ' cr-today-bg' : ''}`;

        // Hour cells (background grid lines)
        for (let h = HOUR_START; h <= HOUR_END; h++) {
            const cell = document.createElement('div');
            cell.className = 'cr-hour-cell cr-half-line';
            col.appendChild(cell);
        }

        // Slot blocks for this day
        const daySlots = allSlots.filter(s => s.consultation_date === dateStr);

        daySlots.forEach(slot => {
            const block = buildSlotBlock(slot);
            if (block) col.appendChild(block);
        });

        grid.appendChild(col);
    }
}

function buildSlotBlock(slot) {
    if (!slot.start_time || !slot.end_time) return null;
    const [sh, sm] = String(slot.start_time).split(':').map(Number);
    const [eh, em] = String(slot.end_time).split(':').map(Number);

    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;
    const gridStart = HOUR_START * 60;

    if (endMins <= gridStart || startMins >= HOUR_END * 60 + 60) return null;

    const top    = Math.max(0, (startMins - gridStart) / 60 * HOUR_PX);
    const height = Math.max(20, (endMins - startMins)  / 60 * HOUR_PX - 2);

    const statusCls = getBlockClass(slot);

    const block = document.createElement('div');
    block.className = `cr-apt-block ${statusCls}`;
    block.style.top    = `${top}px`;
    block.style.height = `${height}px`;

    const timeStr = `${formatTime(slot.start_time)}–${formatTime(slot.end_time)}`;
    const nameStr = slot.instructor_full_name || '';
    const studentStr = slot.student_full_name ? `👤 ${slot.student_full_name}` : '';

    block.innerHTML = `
        <div class="cr-apt-title">${nameStr}</div>
        <div class="cr-apt-time">${timeStr}</div>
        ${studentStr ? `<div class="cr-apt-student">${studentStr}</div>` : ''}
    `;

    block.addEventListener('click', (e) => {
        e.stopPropagation();
        showSlotPopover(slot, block);
    });

    return block;
}

function getBlockClass(slot) {
    const status = slot.computed_status;
    if (status === 'Available') return 'available';
    if (status === 'Booking')   return 'booking';
    if (status === 'Booked') {
        if (slot.appointment_mode === 'Synchronous') return 'booked-sync';
        if (slot.appointment_mode === 'Online')      return 'booked-online';
        return 'booked-pending';
    }
    if (slot.appointment_status === 'pending') return 'booked-pending';
    return 'booked-sync';
}

// ══════════════════════════════════════════════════════════════
// Slot Detail Popover
// ══════════════════════════════════════════════════════════════

let popoverCloseHandler = null;

function showSlotPopover(slot, anchorEl) {
    const pop   = document.getElementById('slotPopover');
    const inner = document.getElementById('slotPopoverInner');

    const date     = new Date(slot.consultation_date);
    const dateFmt  = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr  = `${formatTime(slot.start_time)} – ${formatTime(slot.end_time)}`;
    const statusBadge = `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:.72rem;font-weight:700;background:${statusBg(slot.computed_status)};color:${statusColor(slot.computed_status)};">${slot.computed_status}</span>`;

    inner.innerHTML = `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:.5rem;">
            <p class="cr-pop-title">${slot.instructor_full_name}</p>
            <button class="cr-pop-close" id="popCloseBtn">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
        <div class="cr-pop-row"><span class="cr-pop-label">Date</span><span class="cr-pop-val">${dateFmt}</span></div>
        <div class="cr-pop-row"><span class="cr-pop-label">Time</span><span class="cr-pop-val">${timeStr}</span></div>
        <div class="cr-pop-row"><span class="cr-pop-label">Status</span><span class="cr-pop-val">${statusBadge}</span></div>
        <div class="cr-pop-row"><span class="cr-pop-label">Mode</span><span class="cr-pop-val">${slot.appointment_mode || '—'}</span></div>
        <div class="cr-pop-row"><span class="cr-pop-label">Program</span><span class="cr-pop-val">${slot.program_code || '—'}</span></div>
        <div class="cr-pop-row"><span class="cr-pop-label">Student</span><span class="cr-pop-val">${slot.student_full_name || '—'}</span></div>
        ${slot.room_number ? `<div class="cr-pop-row"><span class="cr-pop-label">Room</span><span class="cr-pop-val">${slot.room_number}</span></div>` : ''}
        ${slot.topic ? `<div class="cr-pop-row"><span class="cr-pop-label">Topic</span><span class="cr-pop-val">${slot.topic}</span></div>` : ''}
    `;

    // Position next to the block
    const rect = anchorEl.getBoundingClientRect();
    const winW = window.innerWidth;
    pop.style.top  = `${rect.top + window.scrollY}px`;
    pop.style.left = rect.right + 290 > winW
        ? `${rect.left + window.scrollX - 290}px`
        : `${rect.right + window.scrollX + 8}px`;

    pop.classList.add('show');

    document.getElementById('popCloseBtn').addEventListener('click', () => {
        pop.classList.remove('show');
    });

    if (popoverCloseHandler) document.removeEventListener('click', popoverCloseHandler);
    popoverCloseHandler = (e) => {
        if (!pop.contains(e.target) && e.target !== anchorEl) {
            pop.classList.remove('show');
        }
    };
    setTimeout(() => document.addEventListener('click', popoverCloseHandler), 10);
}

function statusBg(s) {
    if (s === 'Available') return 'rgba(22,163,74,.1)';
    if (s === 'Booking')   return 'rgba(245,158,11,.15)';
    return 'rgba(107,114,128,.1)';
}
function statusColor(s) {
    if (s === 'Available') return '#15803d';
    if (s === 'Booking')   return '#92400e';
    return '#374151';
}

// ══════════════════════════════════════════════════════════════
// Current Time Indicator
// ══════════════════════════════════════════════════════════════

function renderNowLine() {
    // Remove old line
    document.querySelectorAll('.cr-now-line').forEach(el => el.remove());

    const now     = new Date();
    const today   = isoDate(now);
    const weekEnd = isoDate(addDays(currentWeekStart, 6));

    // Only draw if today is in the current week view
    if (today < isoDate(currentWeekStart) || today > weekEnd) return;

    const dayIndex = (now.getDay() + 6) % 7;   // Mon=0 … Sun=6
    const cols     = document.querySelectorAll('.cr-day-col');
    if (!cols[dayIndex]) return;

    const totalMins  = now.getHours() * 60 + now.getMinutes();
    const gridStart  = HOUR_START * 60;
    if (totalMins < gridStart || totalMins > HOUR_END * 60) return;

    const topPx = (totalMins - gridStart) / 60 * HOUR_PX;

    const line = document.createElement('div');
    line.className = 'cr-now-line';
    line.style.top = `${topPx}px`;
    cols[dayIndex].appendChild(line);
}

// Redraw now-line every minute
setInterval(renderNowLine, 60000);

// ══════════════════════════════════════════════════════════════
// Stats
// ══════════════════════════════════════════════════════════════

function updateStats() {
    const total     = allSlots.length;
    const available = allSlots.filter(s => s.computed_status === 'Available').length;
    const booking   = allSlots.filter(s => s.computed_status === 'Booking').length;
    const booked    = allSlots.filter(s => s.computed_status === 'Booked').length;

    document.getElementById('totalSlotsCount').textContent     = total;
    document.getElementById('availableSlotsCount').textContent = available;
    document.getElementById('bookingSlotsCount').textContent   = booking;
    document.getElementById('bookedSlotsCount').textContent    = booked;
}

// ══════════════════════════════════════════════════════════════
// Settings Modal
// ══════════════════════════════════════════════════════════════

function initSettings() {
    const modal     = document.getElementById('settingsModal');
    const openBtn   = document.getElementById('openSettingsBtn');
    const closeBtn  = document.getElementById('closeSettingsBtn');
    const cancelBtn = document.getElementById('cancelSettingsBtn');
    const form      = document.getElementById('settingsForm');

    openBtn.addEventListener('click',   () => modal.classList.add('show'));
    closeBtn.addEventListener('click',  () => modal.classList.remove('show'));
    cancelBtn.addEventListener('click', () => modal.classList.remove('show'));
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const val = document.getElementById('dailySyncLimit').value;
        if (isNaN(val) || val < 0) { showToast('Enter a valid limit', 'error'); return; }

        try {
            const res  = await fetch('/admin/consultation-room/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ daily_sync_limit: val })
            });
            const data = await res.json();
            if (data.success) {
                dailyLimit = parseInt(val, 10);
                modal.classList.remove('show');
                showToast('Settings saved', 'success');
                loadAllData();
            } else {
                showToast(data.error || 'Failed to save', 'error');
            }
        } catch { showToast('Network error', 'error'); }
    });
}

// ══════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════

function formatTime(t) {
    if (!t) return '';
    const [h, m] = String(t).split(':').map(Number);
    const ampm   = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function formatHour(h) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12} ${ampm}`;
}

function showToast(msg, type = 'info') {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `position:fixed;top:20px;right:20px;padding:11px 20px;
        background:${type==='success'?'#10b981':type==='error'?'#ef4444':'#3b82f6'};
        color:#fff;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.15);
        z-index:10000;font-size:.875rem;font-weight:600;
        animation:cr-toast-in .3s ease;`;
    document.body.appendChild(el);

    const styleId = 'cr-toast-style';
    if (!document.getElementById(styleId)) {
        const s = document.createElement('style');
        s.id = styleId;
        s.textContent = `
            @keyframes cr-toast-in  { from{transform:translateX(120px);opacity:0} to{transform:none;opacity:1} }
            @keyframes cr-toast-out { from{opacity:1} to{opacity:0;transform:translateX(120px)} }
        `;
        document.head.appendChild(s);
    }

    setTimeout(() => {
        el.style.animation = 'cr-toast-out .3s ease forwards';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}

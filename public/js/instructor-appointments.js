
/* =====================================================================
   INSTRUCTOR APPOINTMENTS — Full Page Logic
   Calendar · List · Popover · Day Panel (with Approve/Decline/View)
   ===================================================================== */
(function () {
'use strict';

const RAW = window.APT_DATA || [];
const ITEMS_PER_PAGE = 15;

let appointments = RAW.map(a => Object.assign({}, a));
let calYear, calMonth;
let searchQ = '';
let filterStatus = 'all';
let currentPage = 1;
let currentView = 'calendar';
let activePopAptId = null;
let popoverOpen = false;
let singleClickTimer = null;
let dayPanelEl = null;

const $ = id => document.getElementById(id);
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function aptsByDate(d) { return appointments.filter(a => a.date === d); }
function filteredApts() {
    return appointments.filter(a => {
        if (filterStatus !== 'all' && a.status !== filterStatus) return false;
        if (!searchQ) return true;
        const q = searchQ.toLowerCase();
        return (a.studentName||'').toLowerCase().includes(q)
            || (a.studentId||'').toLowerCase().includes(q)
            || (a.topic||'').toLowerCase().includes(q);
    });
}
function fmtDate(d) {
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

/* ── Stats ── */
function refreshStats() {
    $('aptStatTotal').textContent     = appointments.length;
    $('aptStatPending').textContent   = appointments.filter(a=>a.status==='pending').length;
    $('aptStatConfirmed').textContent = appointments.filter(a=>a.status==='confirmed').length;
    $('aptStatDeclined').textContent  = appointments.filter(a=>a.status==='declined').length;
}

/* ── Calendar ── */
function initCalendar() {
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
    renderCalendar();
    $('aptCalPrev').addEventListener('click', () => { calMonth--; if(calMonth<0){calMonth=11;calYear--;} renderCalendar(); });
    $('aptCalNext').addEventListener('click', () => { calMonth++; if(calMonth>11){calMonth=0;calYear++;} renderCalendar(); });
    $('aptCalToday').addEventListener('click', () => { const n=new Date(); calYear=n.getFullYear(); calMonth=n.getMonth(); renderCalendar(); });
}

function renderCalendar() {
    $('aptCalTitle').textContent = MONTHS[calMonth] + ' ' + calYear;
    const grid = $('aptCalGrid');
    grid.innerHTML = '';
    const today = fmtDate(new Date());
    const first = new Date(calYear, calMonth, 1).getDay();
    const daysIn = new Date(calYear, calMonth+1, 0).getDate();
    const prevDays = new Date(calYear, calMonth, 0).getDate();
    const total = Math.ceil((first + daysIn) / 7) * 7;
    let week = null;

    for (let i = 0; i < total; i++) {
        if (i % 7 === 0) { week = document.createElement('div'); week.className = 'apt-cal-week-row'; grid.appendChild(week); }
        const cell = document.createElement('div');
        cell.className = 'apt-cal-cell';
        let dateStr, isOther = false;
        if (i < first) {
            const d = prevDays - first + i + 1;
            const pm = calMonth===0?11:calMonth-1, py = calMonth===0?calYear-1:calYear;
            dateStr = fmtDate(new Date(py, pm, d)); isOther = true;
        } else if (i >= first + daysIn) {
            const d = i - first - daysIn + 1;
            const nm = calMonth===11?0:calMonth+1, ny = calMonth===11?calYear+1:calYear;
            dateStr = fmtDate(new Date(ny, nm, d)); isOther = true;
        } else {
            dateStr = fmtDate(new Date(calYear, calMonth, i - first + 1));
        }
        if (isOther) cell.classList.add('other-month');
        if (dateStr === today) cell.classList.add('today');
        cell.dataset.date = dateStr;

        const numEl = document.createElement('div');
        numEl.className = 'apt-cal-date-num';
        numEl.textContent = parseInt(dateStr.split('-')[2]);
        cell.appendChild(numEl);

        const dayApts = (filterStatus==='all') ? aptsByDate(dateStr) : aptsByDate(dateStr).filter(a=>a.status===filterStatus);
        const visible = searchQ ? dayApts.filter(a => {
            const q = searchQ.toLowerCase();
            return (a.studentName||'').toLowerCase().includes(q)||(a.studentId||'').toLowerCase().includes(q)||(a.topic||'').toLowerCase().includes(q);
        }) : dayApts;

        const eventsEl = document.createElement('div');
        eventsEl.className = 'apt-cal-events';
        visible.slice(0, 3).forEach(apt => {
            const b = document.createElement('span');
            b.className = `apt-badge ${apt.status}`;
            b.textContent = apt.studentName;
            b.dataset.aptId = apt.id;
            b.addEventListener('click', e => { e.stopPropagation(); openPopover(apt.id, b); });
            eventsEl.appendChild(b);
        });
        if (visible.length > 3) {
            const more = document.createElement('span');
            more.className = 'apt-badge-more';
            more.textContent = `+${visible.length - 3} more`;
            eventsEl.appendChild(more);
        }
        cell.appendChild(eventsEl);
        cell.addEventListener('click', handleCellClick.bind(null, dateStr, cell));
        cell.addEventListener('dblclick', handleCellDblClick.bind(null, dateStr, cell));
        week.appendChild(cell);
    }
}

/* ── Cell click / dblclick ── */
function handleCellClick(dateStr, cellEl, e) {
    if (e.target.closest('.apt-badge')) return;
    if (popoverOpen || dayPanelEl) {
        closePopover(); closeDayPanel();
        document.querySelectorAll('.apt-cal-cell.selected-instant').forEach(c=>c.classList.remove('selected-instant','selected'));
        return;
    }
    if (cellEl.classList.contains('selected-instant')) {
        cellEl.classList.remove('selected-instant','selected'); return;
    }
    document.querySelectorAll('.apt-cal-cell.selected-instant').forEach(c=>c.classList.remove('selected-instant','selected'));
    cellEl.classList.add('selected-instant','selected');
    if (singleClickTimer) clearTimeout(singleClickTimer);
    singleClickTimer = null;
}

function handleCellDblClick(dateStr, cellEl, e) {
    if (e.target.closest('.apt-badge')) return;
    if (singleClickTimer) clearTimeout(singleClickTimer);
    const dayApts = (filterStatus==='all') ? aptsByDate(dateStr) : aptsByDate(dateStr).filter(a=>a.status===filterStatus);
    const visible = searchQ ? dayApts.filter(a => {
        const q = searchQ.toLowerCase();
        return (a.studentName || '').toLowerCase().includes(q)||(a.studentId||'').toLowerCase().includes(q)||(a.topic||'').toLowerCase().includes(q);
    }) : dayApts;
    if (visible.length === 0) { showCellHint(cellEl, 'No appointments scheduled'); }
    else if (visible.length === 1) { openPopover(visible[0].id, cellEl); }
    else { openDayPanel(dateStr, visible, cellEl); }
}

function showCellHint(anchor, msg) {
    document.querySelectorAll('.apt-cell-hint').forEach(h=>h.remove());
    const hint = document.createElement('div');
    hint.className = 'apt-cell-hint'; hint.textContent = msg;
    document.body.appendChild(hint);
    positionNear(hint, anchor);
    setTimeout(() => { hint.style.opacity='0'; hint.style.transition='opacity .3s'; setTimeout(()=>hint.remove(),310); }, 2000);
}

function positionNear(el, anchor) {
    const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    el.style.cssText = 'position:fixed;visibility:hidden;display:block;';
    const ew = el.offsetWidth, eh = el.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + ew > vw - 8) left = vw - ew - 8;
    if (top + eh > vh - 8) top = r.top - eh - 6;
    el.style.left = left+'px'; el.style.top = top+'px'; el.style.visibility = '';
}

/* ── Popover ── */
function openPopover(aptId, anchor) {
    const apt = appointments.find(a => a.id === aptId);
    if (!apt) return;
    closePopover(true);
    activePopAptId = aptId;

    $('popName').textContent      = apt.studentName;
    $('popId').textContent        = apt.studentId;
    $('popWhen').textContent      = `${apt.date}  ·  ${apt.time}`;
    $('popDuration').textContent  = apt.duration || '—';
    $('popTopic').textContent     = apt.topic;
    $('popNotes').textContent     = apt.notes ?? '---';

    $('popStripe').className    = 'pop-stripe ' + apt.status;
    $('popStatusPill').className = 'pop-status-pill ' + apt.status;
    $('popStatusPill').textContent = apt.status.charAt(0).toUpperCase() + apt.status.slice(1);

    $('popActions').style.display = apt.status === 'pending' ? 'flex' : 'none';
    $('popDeclinePanel').classList.remove('open');
    $('popDeclineReason').value = '';
    $('popResolved').classList.remove('open','approved','declined');

    const pop = $('aptPopover');
    pop.classList.add('open');
    $('aptBackdrop').classList.add('open');
    popoverOpen = true;

    if (window.innerWidth > 600) positionPopover(pop, anchor);
    window._aptScroll = () => { if (popoverOpen) positionPopover(pop, anchor); };
    window.addEventListener('scroll', window._aptScroll, true);
}

function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 260;
    const vis = r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    pop.style.opacity = vis ? '1' : '0';
    if (!vis) return;

    // Get header and footer heights so popover never overlaps them
    const headerEl = document.querySelector('.main-header');
    const footerEl = document.querySelector('.main-footer');
    const topBound    = headerEl ? headerEl.getBoundingClientRect().bottom + 6 : 8;
    const bottomBound = footerEl ? footerEl.getBoundingClientRect().top - 6   : vh - 8;

    // Try right side first, fall back to left
    let left = r.right + 10;
    let top  = r.top;
    if (left + pw > vw - 8) left = r.left - pw - 10;
    if (left < 8) left = 8;

    // Clamp vertically: stay between header bottom and footer top
    if (top + ph > bottomBound) top = bottomBound - ph;
    if (top < topBound) top = topBound;

    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
}

function closePopover(instant) {
    if (!popoverOpen && !$('aptPopover').classList.contains('open')) return;
    $('aptPopover').classList.remove('open');
    $('aptBackdrop').classList.remove('open');
    popoverOpen = false; activePopAptId = null;
    if (window._aptScroll) window.removeEventListener('scroll', window._aptScroll, true);
}

function initPopover() {
    // Backdrop click — only fires on mobile (pointer-events:none on desktop)
    $('aptBackdrop').addEventListener('click', () => { closePopover(); closeDayPanel(); });
    $('popClose').addEventListener('click', () => closePopover());

    document.addEventListener('click', e => {
        if (!popoverOpen && !dayPanelEl) return;
        const pop = $('aptPopover');
        const panel = document.getElementById('aptDayPanel');
        if (!pop.contains(e.target) && !(panel&&panel.contains(e.target))
            && !e.target.closest('.apt-badge') && !e.target.closest('.apt-cal-cell')) {
            closePopover(); closeDayPanel();
        }
    });

    $('popApprove').addEventListener('click', () => {
        if (!activePopAptId) return;
        const btn = $('popApprove');
        btn.disabled = true;
        doApprove(
            activePopAptId,
            () => showPopResolved('approved', '✓ Appointment confirmed'),
            () => { btn.disabled = false; }
        );
    });

    $('popDeclineBtn').addEventListener('click', () => {
        $('popActions').style.display = 'none';
        $('popDeclinePanel').classList.add('open');
        $('popDeclineReason').focus();
    });

    $('popDeclineCancel').addEventListener('click', () => {
        $('popDeclinePanel').classList.remove('open');
        $('popActions').style.display = 'flex';
        $('popDeclineReason').value = '';
    });

    $('popDeclineConfirm').addEventListener('click', () => {
        const reason = $('popDeclineReason').value.trim();
        if (!reason) {
            $('popDeclineReason').style.borderColor = '#ef4444';
            $('popDeclineReason').focus();
            setTimeout(() => { $('popDeclineReason').style.borderColor = ''; }, 1400);
            return;
        }
        if (!activePopAptId) return;
        const btn = $('popDeclineConfirm');
        btn.disabled = true;
        doDecline(
            activePopAptId,
            reason,
            () => showPopResolved('declined', '✗ Student notified'),
            () => { btn.disabled = false; }
        );
    });

    document.addEventListener('keydown', e => { if (e.key==='Escape') { closePopover(); closeDayPanel(); } });
}

function showPopResolved(type, msg) {
    $('popActions').style.display = 'none';
    $('popDeclinePanel').classList.remove('open');
    const res = $('popResolved');
    res.className = 'pop-resolved open ' + type;
    $('popResolvedMsg').textContent = msg;
    $('popResolvedIcon').innerHTML = type==='approved'
        ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    setTimeout(() => closePopover(), 1800);
}

/* ── Day Panel — shows all appointments for a double-clicked date ──
   Each row has: dot · name + meta · status pill · View / Approve / Decline buttons
   Decline expands an inline reason textarea per row (no separate modal)
─────────────────────────────────────────────────────────────────── */
function openDayPanel(dateStr, apts, anchor) {
    closeDayPanel();
    const panel = document.createElement('div');
    panel.className = 'apt-day-panel'; panel.id = 'aptDayPanel';
    dayPanelEl = panel;

    const label = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    panel.innerHTML =
        `<div class="day-panel-header">
           <span class="day-panel-title">${label}</span>
           <span class="day-panel-count">${apts.length} appointment${apts.length!==1?'s':''}</span>
           <button class="day-panel-close" id="dayPanelClose">
             <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
           </button>
         </div>
         <div class="day-panel-list" id="dayPanelList"></div>`;

    document.body.appendChild(panel);
    panel.querySelector('#dayPanelClose').addEventListener('click', closeDayPanel);

    const list = panel.querySelector('#dayPanelList');

    apts.forEach(apt => {
        const isPending = apt.status === 'pending';

        /* ── row wrapper ── */
        const wrap = document.createElement('div');
        wrap.className = 'day-panel-apt-wrap';
        wrap.dataset.aptId = apt.id;

        /* ── main info row ── */
        const row = document.createElement('div');
        row.className = 'day-panel-row';
        row.innerHTML =
            `<span class="day-panel-dot ${apt.status}"></span>
             <div class="day-panel-info">
               <div class="day-panel-name">${apt.studentName}</div>
               <div class="day-panel-meta">${apt.time} · ${apt.duration||'—'} · <em style="color:#94a3b8;">${apt.topic}</em></div>
             </div>
             <span class="day-panel-status ${apt.status}">${apt.status}</span>`;

        /* ── action buttons ── */
        const actions = document.createElement('div');
        actions.className = 'day-panel-actions';

        /* View button — always shown */
        const viewBtn = document.createElement('button');
        viewBtn.className = 'day-panel-btn view';
        viewBtn.title = 'View details';
        viewBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View`;
        viewBtn.addEventListener('click', e => { e.stopPropagation(); closeDayPanel(); openPopover(apt.id, anchor); });
        actions.appendChild(viewBtn);

        if (isPending) {
            /* Approve button */
            const appBtn = document.createElement('button');
            appBtn.className = 'day-panel-btn approve';
            appBtn.title = 'Approve';
            appBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Approve`;
            appBtn.addEventListener('click', e => {
                e.stopPropagation();
                appBtn.disabled = true;
                doApprove(
                    apt.id,
                    () => { markRowDone(wrap, 'confirmed', '✓ Confirmed'); },
                    () => { appBtn.disabled = false; }
                );
            });
            actions.appendChild(appBtn);

            /* Decline button */
            const decBtn = document.createElement('button');
            decBtn.className = 'day-panel-btn decline';
            decBtn.title = 'Decline';
            decBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline`;

            /* Inline decline reason panel — per row */
            const decPanel = document.createElement('div');
            decPanel.className = 'day-panel-decline-form';
            decPanel.innerHTML =
                `<textarea class="day-panel-decline-ta" placeholder="Reason for declining…" rows="2"></textarea>
                 <div class="day-panel-decline-btns">
                   <button class="day-panel-df-cancel">Cancel</button>
                   <button class="day-panel-df-confirm">Decline &amp; Notify</button>
                 </div>`;

            decBtn.addEventListener('click', e => {
                e.stopPropagation();
                const open = decPanel.classList.contains('open');
                decPanel.classList.toggle('open', !open);
                if (!open) decPanel.querySelector('.day-panel-decline-ta').focus();
            });

            decPanel.querySelector('.day-panel-df-cancel').addEventListener('click', e => {
                e.stopPropagation();
                decPanel.classList.remove('open');
                decPanel.querySelector('.day-panel-decline-ta').value = '';
            });

            decPanel.querySelector('.day-panel-df-confirm').addEventListener('click', e => {
                e.stopPropagation();
                const reason = decPanel.querySelector('.day-panel-decline-ta').value.trim();
                if (!reason) {
                    const ta = decPanel.querySelector('.day-panel-decline-ta');
                    ta.style.borderColor = '#ef4444'; ta.focus();
                    setTimeout(() => { ta.style.borderColor = ''; }, 1400);
                    return;
                }
                const confirmBtn = decPanel.querySelector('.day-panel-df-confirm');
                confirmBtn.disabled = true;
                doDecline(
                    apt.id,
                    reason,
                    () => { markRowDone(wrap, 'declined', '✗ Notified'); },
                    () => { confirmBtn.disabled = false; }
                );
            });

            actions.appendChild(decBtn);
            wrap.appendChild(row);
            wrap.appendChild(actions);
            wrap.appendChild(decPanel);
        } else {
            wrap.appendChild(row);
            wrap.appendChild(actions);
        }

        list.appendChild(wrap);
    });

    if (window.innerWidth > 600) positionNear(panel, anchor);
    $('aptBackdrop').classList.add('open');
}

function markRowDone(wrap, status, msg) {
    /* update the status pill */
    const pill = wrap.querySelector('.day-panel-status');
    if (pill) { pill.className = `day-panel-status ${status}`; pill.textContent = status; }
    const dot  = wrap.querySelector('.day-panel-dot');
    if (dot)  { dot.className = `day-panel-dot ${status}`; }
    /* replace action area with feedback */
    const actions = wrap.querySelector('.day-panel-actions');
    const decForm = wrap.querySelector('.day-panel-decline-form');
    if (actions) actions.innerHTML = `<span class="day-panel-done-msg ${status}">${msg}</span>`;
    if (decForm) decForm.remove();
    /* refresh stats + calendar */
    refreshStats(); renderCalendar();
    if (currentView === 'list') renderListView();
}

function closeDayPanel() {
    if (dayPanelEl) { dayPanelEl.remove(); dayPanelEl = null; }
    if (!popoverOpen) $('aptBackdrop').classList.remove('open');
}

/* ── List view ── */
function renderListView() {
    const all = filteredApts();
    const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const inner = $('aptListInner');
    inner.innerHTML = '';

    if (!all.length) {
        inner.innerHTML = `
          <div class="apt-lv-empty">
            <div class="apt-lv-empty-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <p class="apt-lv-empty-title">No appointments found</p>
            <p class="apt-lv-empty-sub">Try adjusting your search or filter</p>
          </div>`;
    } else {
        all.slice(start, start + ITEMS_PER_PAGE).forEach(apt => inner.appendChild(buildCard(apt)));
    }

    // Update list header count
    const hdr = document.getElementById('aptListHeaderCount');
    if (hdr) hdr.textContent = all.length + ' appointment' + (all.length !== 1 ? 's' : '');

    const info = $('aptPgInfo'), ctrl = $('aptPgCtrl');
    info.textContent = all.length
        ? `${start + 1}–${Math.min(start + ITEMS_PER_PAGE, all.length)} of ${all.length}`
        : '';
    ctrl.innerHTML = '';
    if (totalPages > 1) {
        const mk = (html, page, disabled, active) => {
            const b = document.createElement('button');
            b.className = 'apt-pg-btn' + (active ? ' active' : '');
            b.innerHTML = html; b.disabled = disabled;
            if (!disabled && !active) b.addEventListener('click', () => { currentPage = page; renderListView(); });
            return b;
        };
        ctrl.appendChild(mk('&larr;', currentPage - 1, currentPage === 1));
        let s = Math.max(1, currentPage - 2), e = Math.min(totalPages, s + 4);
        s = Math.max(1, e - 4);
        for (let p = s; p <= e; p++) ctrl.appendChild(mk(p, p, false, p === currentPage));
        ctrl.appendChild(mk('&rarr;', currentPage + 1, currentPage === totalPages));
    }
}

function getInitials(firstName, lastName) {
    return firstName[0] + lastName[0];
}

function buildCard(apt) {
    const card = document.createElement('div');
    card.className = 'apt-lv-card';
    card.dataset.status = apt.status;
    card.dataset.aptId  = apt.id;

    const isPending  = apt.status === 'pending';
    const isDeclined = apt.status === 'declined';
    const initials   = getInitials(apt.firstName, apt.lastName);

    // Avatar col
    const avatarCol = document.createElement('div');
    avatarCol.className = 'apt-lv-avatar-col';
    avatarCol.innerHTML = `<div class="apt-lv-avatar">${initials}</div>`;

    // Body col
    const body = document.createElement('div');
    body.className = 'apt-lv-body';
    body.innerHTML = `
        <div class="apt-lv-top">
            <div style="min-width:0">
                <p class="apt-lv-name">${apt.studentName}</p>
                <span class="apt-lv-sid">${apt.studentId}</span>
            </div>
            <span class="apt-lv-status ${apt.status}">${apt.status}</span>
        </div>
        <p class="apt-lv-topic">${apt.topic}</p>
        <div class="apt-lv-meta">
            <span class="apt-lv-meta-chip">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                ${apt.date}
            </span>
            <span class="apt-lv-meta-chip">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                ${apt.time}${apt.duration ? ' · ' + apt.duration : ''}
            </span>
            ${apt.requestedAt && apt.requestedAt !== '—'
                ? `<span class="apt-lv-meta-chip requested">Requested ${apt.requestedAt}</span>`
                : ''}
        </div>`;

    // Actions col
    const actions = document.createElement('div');
    actions.className = 'apt-lv-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'apt-lv-btn view';
    viewBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>View`;
    viewBtn.addEventListener('click', (e) => { e.stopPropagation(); openPopover(apt.id, viewBtn); });
    actions.appendChild(viewBtn);

    let declineForm = null;

    if (isPending) {
        const approveBtn = document.createElement('button');
        approveBtn.className = 'apt-lv-btn approve';
        approveBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Approve`;
        approveBtn.addEventListener('click', () => {
            approveBtn.disabled = true;
            doApprove(
                apt.id,
                () => { showToast('success', 'Approved', `${apt.studentName}'s appointment confirmed.`); },
                () => { approveBtn.disabled = false; }
            );
        });

        const declineBtn = document.createElement('button');
        declineBtn.className = 'apt-lv-btn decline';
        declineBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Decline`;

        // Inline decline form
        declineForm = document.createElement('div');
        declineForm.className = 'apt-lv-decline-form';
        declineForm.innerHTML = `
            <span class="apt-lv-decline-lbl">Reason for declining</span>
            <textarea class="apt-lv-decline-ta" placeholder="e.g. Schedule conflict, fully booked…" rows="2"></textarea>
            <div class="apt-lv-decline-row">
                <button class="apt-lv-df-cancel">Cancel</button>
                <button class="apt-lv-df-confirm">Decline &amp; Notify</button>
            </div>`;

        declineBtn.addEventListener('click', () => {
            const isOpen = declineForm.classList.contains('open');
            declineForm.classList.toggle('open', !isOpen);
            if (!isOpen) declineForm.querySelector('.apt-lv-decline-ta').focus();
        });

        declineForm.querySelector('.apt-lv-df-cancel').addEventListener('click', () => {
            declineForm.classList.remove('open');
            declineForm.querySelector('.apt-lv-decline-ta').value = '';
        });

        declineForm.querySelector('.apt-lv-df-confirm').addEventListener('click', () => {
            const reason = declineForm.querySelector('.apt-lv-decline-ta').value.trim();
            if (!reason) {
                const ta = declineForm.querySelector('.apt-lv-decline-ta');
                ta.style.borderColor = '#ef4444'; ta.focus();
                setTimeout(() => { ta.style.borderColor = ''; }, 1400);
                return;
            }
            const confirmBtn = declineForm.querySelector('.apt-lv-df-confirm');
            confirmBtn.disabled = true;
            doDecline(
                apt.id,
                reason,
                () => { showToast('success', 'Declined', `${apt.studentName} has been notified.`); },
                () => { confirmBtn.disabled = false; }
            );
        });

        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
    }

    // Declined reason display
    let declinedReason = null;
    if (isDeclined && apt.declineReason) {
        declinedReason = document.createElement('div');
        declinedReason.className = 'apt-lv-declined-reason';
        declinedReason.innerHTML = `<strong>Reason:</strong> ${apt.declineReason}`;
    }

    card.appendChild(avatarCol);
    card.appendChild(body);
    card.appendChild(actions);
    if (declineForm)    card.appendChild(declineForm);
    if (declinedReason) card.appendChild(declinedReason);

    return card;
}

/* ── API calls ── */
function doApprove(aptId, onSuccess, onError) {
    fetch(`/instructor/appointments/${encodeURIComponent(aptId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(r => r.json())
    .then(d => {
        if (!d.success) {
            showToast('error', 'Error', d.error || 'Failed to approve appointment.');
            if (onError) onError();
            return;
        }
        const apt = appointments.find(a => a.id === aptId);
        if (apt) apt.status = 'confirmed';
        refreshStats();
        renderCalendar();
        if (currentView === 'list') renderListView();
        if (onSuccess) onSuccess();
    })
    .catch(() => {
        showToast('error', 'Error', 'Network error. Please try again.');
        if (onError) onError();
    });
}

function doDecline(aptId, reason, onSuccess, onError) {
    fetch(`/instructor/appointments/${encodeURIComponent(aptId)}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
    })
    .then(r => r.json())
    .then(d => {
        if (!d.success) {
            showToast('error', 'Error', d.error || 'Failed to decline appointment.');
            if (onError) onError();
            return;
        }
        const apt = appointments.find(a => a.id === aptId);
        if (apt) {
            apt.status = 'declined';
            apt.declineReason = reason;
        }
        refreshStats();
        renderCalendar();
        if (currentView === 'list') renderListView();
        if (onSuccess) onSuccess();
    })
    .catch(() => {
        showToast('error', 'Error', 'Network error. Please try again.');
        if (onError) onError();
    });
}

/* ── Search / filter / view toggle / toast / init ── */
function initSearchFilter() {
    $('aptSearch').addEventListener('input', function() { 
        searchQ=this.value.trim(); 
        currentPage=1; 
        renderCalendar(); 
        if(currentView==='list') renderListView(); 
    });
    $('aptStatusFilter').addEventListener('change', function() { 
        filterStatus=this.value; 
        currentPage=1; 
        renderCalendar(); 
        if(currentView==='list') renderListView(); 
    });
}
function initViewToggle() {
    document.querySelectorAll('.apt-view-btn').forEach(btn => btn.addEventListener('click', function() {
        document.querySelectorAll('.apt-view-btn').forEach(b=>b.classList.remove('active'));
        this.classList.add('active'); 
        currentView=this.dataset.view; 
        currentPage=1;
        if (currentView==='calendar') { 
            $('aptCalView').style.display='block'; 
            $('aptListView').style.display='none'; 
        } else { 
            $('aptCalView').style.display='none'; 
            $('aptListView').style.display='block'; 
            renderListView(); 
        }
        closePopover(); 
        closeDayPanel();
    }));
}
function showToast(type, title, msg) {
    const c = $('aptToastContainer'); if(!c) return;
    const t = document.createElement('div'); t.className=`toast ${type}`;
    t.innerHTML=`<div class="toast-content"><p class="toast-title">${title}</p><p class="toast-message">${msg}</p></div>`;
    c.appendChild(t);
    setTimeout(()=>{ 
        t.style.opacity ='0'; 
        t.style.transition ='opacity .3s'; 
        setTimeout(() => t.remove(), 320); 
    }, 4000);
}

document.addEventListener('DOMContentLoaded', () => {
    refreshStats(); initCalendar(); initPopover(); initSearchFilter(); initViewToggle();
});

})();

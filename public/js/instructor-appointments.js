
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
let popReschedPicker = null;

const $ = id => document.getElementById(id);

// Below this width the calendar cells are too small for name badges, so a day
// with appointments is shown as a filled cell and opens its list on one tap.
const MOBILE_CAL = '(max-width: 640px)';
const isMobileCal = () => window.matchMedia(MOBILE_CAL).matches;

/** Short label for the consultation venue, shown wherever an appointment is listed. */
function modeLabel(apt) {
    return apt.mode === 'Online' ? 'Online' : 'Face-to-Face';
}
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
    // Approving or declining the last pending request retires the bulk button,
    // and an approval may have just created something completable
    if (window.syncApproveAllButton) window.syncApproveAllButton();
    if (window.syncCompleteAllButton) window.syncCompleteAllButton();
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

        if (isMobileCal()) {
            // One glance: does this day have anything on it?
            if (visible.length) {
                cell.classList.add('has-apts');
                const count = document.createElement('span');
                count.className = 'apt-cal-count';
                count.textContent = visible.length;
                eventsEl.appendChild(count);
            }
            // A cell this narrow cannot hold the chips, so an own entry gets a
            // marker; tapping the day lists it in the panel.
            if (ownEventsOn(dateStr).length) {
                cell.classList.add('has-own');
                const dot = document.createElement('span');
                dot.className = 'apt-cal-own-dot';
                eventsEl.appendChild(dot);
            }
        } else {
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
                // Clicking "+N more" should show the whole day, not select the cell
                more.addEventListener('click', e => {
                    e.stopPropagation();
                    if (singleClickTimer) { clearTimeout(singleClickTimer); singleClickTimer = null; }
                    openDayPanel(dateStr, visible, cell);
                });
                eventsEl.appendChild(more);
            }

            // Imported calendar events sit below the bookings, styled apart so
            // they are never mistaken for something a student can be seen about
            calendarEventsOn(dateStr).slice(0, 2).forEach(ev => {
                const chip = document.createElement('span');
                chip.className = 'apt-cal-ext' +
                    (ev.blocks ? ' blocks' : '') +
                    (ev.decision === 'pending' ? ' pending' : '');
                chip.textContent = (ev.all_day ? '' : slotLabel(ev.start_slot) + ' ') +
                    (ev.summary || 'Busy');
                chip.title = `${ev.calendar_name}${ev.blocks ? ' · blocks appointments' : ''}`;
                eventsEl.appendChild(chip);
            });

            // The instructor's own entries. Same row as imported events because
            // to a student they mean the same thing, but marked as editable —
            // these are the only ones clicking can change.
            //
            // Not capped the way imported events are: hiding one the instructor
            // has just added makes it look as though the save failed, and there
            // is no "+N more" affordance to recover it from.
            ownEventsOn(dateStr).forEach(ev => {
                const chip = document.createElement('span');
                chip.className = 'apt-cal-own' + (ev.blocks ? ' blocks' : '') +
                    (ev.kind === 'task' ? ' task' : '');
                chip.textContent = (ev.allDay ? '' : shortTime(ev.startTime) + ' ') + ev.title;
                chip.title = `${ev.kind === 'task' ? 'Task' : 'Event'}` +
                    (ev.blocks ? ' · blocks appointments' : ' · does not block') +
                    ' · click to edit';
                chip.addEventListener('click', e => { e.stopPropagation(); openEventModal(ev); });
                eventsEl.appendChild(chip);
            });
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

    // On mobile there is no hover or double-click — tapping a day opens its list
    if (isMobileCal()) {
        if (popoverOpen || dayPanelEl) { closePopover(); closeDayPanel(); return; }
        const visible = visibleAptsOn(dateStr);
        // A day with only an event and no bookings still has something to show
        if (visible.length || ownEventsOn(dateStr).length) openDayPanel(dateStr, visible, cellEl);
        else showCellHint(cellEl, 'Nothing scheduled');
        return;
    }

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

function visibleAptsOn(dateStr) {
    const dayApts = (filterStatus === 'all')
        ? aptsByDate(dateStr)
        : aptsByDate(dateStr).filter(a => a.status === filterStatus);
    if (!searchQ) return dayApts;
    const q = searchQ.toLowerCase();
    return dayApts.filter(a =>
        (a.studentName || '').toLowerCase().includes(q) ||
        (a.studentId || '').toLowerCase().includes(q) ||
        (a.topic || '').toLowerCase().includes(q));
}

function handleCellDblClick(dateStr, cellEl, e) {
    if (e.target.closest('.apt-badge')) return;
    if (singleClickTimer) clearTimeout(singleClickTimer);
    const visible = visibleAptsOn(dateStr);
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
    // Measure without clobbering the element's own display mode — the day panel
    // is a flex column so its list can scroll inside a capped height.
    el.style.position = 'fixed';
    el.style.visibility = 'hidden';
    const ew = el.offsetWidth, eh = el.offsetHeight;

    let left = r.left;
    if (left + ew > vw - 8) left = vw - ew - 8;
    if (left < 8) left = 8;

    // Prefer below the cell, flip above if it will not fit, then clamp to the
    // viewport so a tall panel is always reachable instead of scrolled away.
    let top = r.bottom + 6;
    if (top + eh > vh - 8) top = r.top - eh - 6;
    if (top + eh > vh - 8) top = vh - eh - 8;
    if (top < 8) top = 8;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.visibility = '';
}
function formatFullDate(dateStr) {
    const d = new Date(dateStr + (dateStr.includes('T') ? '' : 'T00:00:00'));
    return d.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
}
/* ── Popover ── */
function openPopover(aptId, anchor) {
    const apt = appointments.find(a => a.id === aptId);
    if (!apt) return;
    closePopover(true);
    activePopAptId = aptId;

    $('popName').textContent      = apt.studentName;
    $('popId').textContent        = apt.studentId;
    $('popWhen').textContent      = `${formatFullDate(apt.date)}  ·  ${apt.time}`;
    $('popDuration').textContent  = apt.duration || '—';
    // Online consultations carry their venue as a link. Hidden entirely for
    // face-to-face, where the row would only ever be a dash.
    const linkRow = $('popLinkRow');
    if (linkRow) {
        const online = apt.mode === 'Online';
        linkRow.hidden = !online;
        if (online) {
            const anchor = $('popLink');
            const copy = $('popLinkCopy');
            if (apt.meetingLink) {
                anchor.textContent = apt.meetingLink;
                anchor.href = apt.meetingLink;
                anchor.removeAttribute('aria-disabled');
                copy.hidden = false;
                copy.dataset.link = apt.meetingLink;
            } else {
                // Said plainly rather than left blank: no link is a state the
                // instructor may need to act on, not a rendering gap.
                anchor.textContent = 'No meeting link yet';
                anchor.removeAttribute('href');
                anchor.setAttribute('aria-disabled', 'true');
                copy.hidden = true;
            }
        }
    }

    $('popTopic').textContent     = apt.topic;
    $('popNotes').textContent     = apt.notes ?? '---';

    $('popStripe').className    = 'pop-stripe ' + apt.status;
    $('popStatusPill').className = 'pop-status-pill ' + apt.status;
    $('popStatusPill').textContent = apt.status.charAt(0).toUpperCase() + apt.status.slice(1);

    $('popActions').style.display = apt.status === 'pending' ? 'flex' : 'none';
    // Same rule as the list view and day panel: only once it has actually ended.
    const completeRow = $('popCompleteActions');
    if (completeRow) {
        completeRow.style.display = apt.status === 'confirmed' && hasEnded(apt) ? 'flex' : 'none';
        $('popComplete').disabled = false;
    }
    $('popDeclinePanel').classList.remove('open');
    $('popDeclineReason').value = '';
    $('popResolved').classList.remove('open','approved','declined');

    $('popReschedCheck').checked = false;
    $('popReschedContainer').style.display = 'none';
    $('popReschedContainer').innerHTML = '';
    $('popDeclineConfirm').textContent = 'Decline & Notify';
    popReschedPicker = null;

    const pop = $('aptPopover');
    pop.classList.add('open');
    $('aptBackdrop').classList.add('open');
    popoverOpen = true;

    if (window.innerWidth > 600) positionPopover(pop, anchor);
    window._aptScroll = () => { if (popoverOpen) positionPopover(pop, anchor); };
    window.addEventListener('scroll', window._aptScroll, true);
}

function positionPopover(pop, anchor) {
    // Below 600px the popover is a full-width bottom sheet positioned by CSS —
    // anchoring it to a cell here would fight that layout.
    if (window.innerWidth <= 600) { pop.style.opacity = '1'; pop.style.maxHeight = ''; return; }

    const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;

    // An anchor that has left the document — a re-render replaced it — measures
    // 0x0 at 0,0, which the visibility test below reads as "scrolled away" and
    // hides. To the user that is a popover that never opened, with a dimmed
    // backdrop and nothing to dismiss. Centre it instead: the content is what
    // they asked for, only its anchoring is lost.
    if (!r.width && !r.height) {
        pop.style.opacity = '1';
        pop.style.maxHeight = '';
        pop.style.left = Math.max(8, (vw - (pop.offsetWidth || 300)) / 2) + 'px';
        pop.style.top  = Math.max(8, (vh - (pop.offsetHeight || 260)) / 2) + 'px';
        return;
    }

    const vis = r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
    pop.style.opacity = vis ? '1' : '0';
    if (!vis) return;

    // Get header and footer heights so the popover never overlaps them
    const headerEl = document.querySelector('.main-header');
    const footerEl = document.querySelector('.main-footer');
    const topBound    = headerEl ? headerEl.getBoundingClientRect().bottom + 6 : 8;
    const bottomBound = footerEl ? footerEl.getBoundingClientRect().top - 6   : vh - 8;

    // Cap the height BEFORE measuring, so opening the reschedule picker makes
    // the popover scroll rather than grow past the bottom of the screen.
    pop.style.maxHeight = Math.max(160, bottomBound - topBound) + 'px';

    const pw = pop.offsetWidth || 300;
    const ph = pop.offsetHeight || 260;

    // Try the right side first, fall back to the left
    let left = r.right + 10;
    if (left + pw > vw - 8) left = r.left - pw - 10;
    if (left < 8) left = 8;

    // Clamp vertically: stay between header bottom and footer top
    let top = r.top;
    if (top + ph > bottomBound) top = bottomBound - ph;
    if (top < topBound) top = topBound;

    pop.style.left = left + 'px';
    pop.style.top  = top  + 'px';
}

/**
 * Re-place the open popover after its contents change size. Without this the
 * popover keeps the position it had when it was short and slides off-screen.
 */
function repositionPopover() {
    if (!popoverOpen || !window._aptScroll) return;
    window._aptScroll();
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
    // Copying the link out of the popup. An instructor pasting it into a
    // group chat or an email is the common way it actually reaches students.
    const popCopy = $('popLinkCopy');
    if (popCopy) {
        popCopy.addEventListener('click', () => {
            const link = popCopy.dataset.link;
            if (!link) return;

            const done = (ok) => {
                popCopy.textContent = ok ? 'Copied' : 'Press Ctrl+C';
                setTimeout(() => { popCopy.textContent = 'Copy'; }, 2000);
            };

            // clipboard.writeText needs a secure context, and this app is
            // reached over plain http on the campus network as well as https.
            const fallback = () => {
                const field = document.createElement('textarea');
                field.value = link;
                field.setAttribute('readonly', '');
                field.style.position = 'fixed';
                field.style.opacity = '0';
                document.body.appendChild(field);
                field.select();
                let ok = false;
                try { ok = document.execCommand('copy'); } catch { ok = false; }
                document.body.removeChild(field);
                return ok;
            };

            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(link).then(() => done(true), () => done(fallback()));
            } else {
                done(fallback());
            }
        });
    }

    $('popClose').addEventListener('click', () => closePopover());

    const popComplete = $('popComplete');
    if (popComplete) popComplete.addEventListener('click', () => {
        if (!activePopAptId) return;
        popComplete.disabled = true;
        // doComplete updates every view and shows the success toast itself;
        // the popover just gets out of the way once it is done.
        doComplete(activePopAptId, () => closePopover(), () => { popComplete.disabled = false; });
    });

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
        repositionPopover();
    });

    $('popDeclineCancel').addEventListener('click', () => {
        $('popDeclinePanel').classList.remove('open');
        $('popActions').style.display = 'flex';
        $('popDeclineReason').value = '';
        repositionPopover();
    });

    $('popReschedCheck').addEventListener('change', function() {
        const container = $('popReschedContainer');
        const confirmBtn = $('popDeclineConfirm');
        if (this.checked) {
            const current = appointments.find(a => a.id === activePopAptId);
            popReschedPicker = buildReschedulePicker(
                () => { confirmBtn.disabled = false; },
                current && current.mode,
                repositionPopover
            );
            container.innerHTML = '';
            container.appendChild(popReschedPicker.el);
            container.style.display = 'block';
            confirmBtn.textContent = 'Reschedule & Notify';
            confirmBtn.disabled = true;
        } else {
            container.style.display = 'none';
            container.innerHTML = '';
            popReschedPicker = null;
            confirmBtn.textContent = 'Decline & Notify';
            confirmBtn.disabled = false;
        }
        repositionPopover();
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

        if ($('popReschedCheck').checked) {
            const sel = popReschedPicker && popReschedPicker.getSelected();
            if (!sel) { showToast('error', 'Select a Slot', 'Please choose a new date and time.'); btn.disabled = false; return; }
            doReschedule(activePopAptId, sel.id, reason, sel.mode,
                () => showPopResolved('rescheduled', 'Student notified'),
                () => { btn.disabled = false; });
        } else {
            doDecline(activePopAptId, reason, () => showPopResolved('declined', 'Student notified'), () => { btn.disabled = false; });
        }
    });

    document.addEventListener('keydown', e => { if (e.key==='Escape') { closePopover(); closeDayPanel(); } });

    window.addEventListener('resize', () => {
        repositionPopover();
        if (dayPanelEl) closeDayPanel();
    });
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
               <div class="day-panel-meta">${apt.time} · ${apt.duration||'—'}</div>
               <div class="day-panel-meta">
                 <span class="day-panel-mode ${apt.mode === 'Online' ? 'online' : 'f2f'}">${modeLabel(apt)}</span>
                 <em style="color:#94a3b8;">${apt.topic}</em>
               </div>
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

        /* Confirmed consultations: switch mode, and close out once the slot has ended */
        if (apt.status === 'confirmed') {
            const modeBtn = document.createElement('button');
            modeBtn.className = 'day-panel-btn mode';
            const nextMode = apt.mode === 'Online' ? 'Face-to-Face' : 'Online';
            modeBtn.title = 'Switch to ' + nextMode;
            modeBtn.textContent = apt.mode === 'Online' ? 'Online' : 'F2F';
            modeBtn.addEventListener('click', e => {
                e.stopPropagation();
                modeBtn.disabled = true;
                switchMode(apt.id, nextMode, modeBtn);
            });
            actions.appendChild(modeBtn);

            // Only offer completion after the consultation has actually ended
            if (hasEnded(apt)) {
                const cmpBtn = document.createElement('button');
                cmpBtn.className = 'day-panel-btn complete';
                cmpBtn.title = 'Mark as completed';
                cmpBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Complete';
                cmpBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    cmpBtn.disabled = true;
                    doComplete(apt.id,
                        () => markRowDone(wrap, 'completed', '✓ Completed'),
                        () => { cmpBtn.disabled = false; });
                });
                actions.appendChild(cmpBtn);
            }
        }

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
                <label class="resched-check">
                <input type="checkbox" class="day-panel-resched-checkbox">
                Reschedule instead of declining
                </label>
                <div class="day-panel-resched-container" style="display:none;"></div>
                <div class="day-panel-decline-btns">
                <button class="day-panel-df-cancel">Cancel</button>
                <button class="day-panel-df-confirm">Decline &amp; Notify</button>
                </div>`;

            let dpReschedPicker = null;
            const dpReschedCheck = decPanel.querySelector('.day-panel-resched-checkbox');
            const dpReschedContainer = decPanel.querySelector('.day-panel-resched-container');
            const dfConfirmBtn = decPanel.querySelector('.day-panel-df-confirm');

            dpReschedCheck.addEventListener('change', function() {
                if (this.checked) {
                    dpReschedPicker = buildReschedulePicker(
                        () => { dfConfirmBtn.disabled = false; }, apt.mode);
                    dpReschedContainer.innerHTML = '';
                    dpReschedContainer.appendChild(dpReschedPicker.el);
                    dpReschedContainer.style.display = 'block';
                    dfConfirmBtn.textContent = 'Reschedule & Notify';
                    dfConfirmBtn.disabled = true;
                } else {
                    dpReschedContainer.style.display = 'none';
                    dpReschedContainer.innerHTML = '';
                    dpReschedPicker = null;
                    dfConfirmBtn.textContent = 'Decline & Notify';
                    dfConfirmBtn.disabled = false;
                }
            });

            dfConfirmBtn.addEventListener('click', e => {
                e.stopPropagation();
                const reason = decPanel.querySelector('.day-panel-decline-ta').value.trim();
                if (!reason) {
                    const ta = decPanel.querySelector('.day-panel-decline-ta');
                    ta.style.borderColor = '#ef4444'; ta.focus();
                    setTimeout(() => { ta.style.borderColor = ''; }, 1400);
                    return;
                }
                dfConfirmBtn.disabled = true;
                if (dpReschedCheck.checked) {
                    const sel = dpReschedPicker && dpReschedPicker.getSelected();
                    if (!sel) { showToast('error', 'Select a Slot', 'Please choose a new date and time.'); dfConfirmBtn.disabled = false; return; }
                    doReschedule(apt.id, sel.id, reason, sel.mode,
                        () => markRowDone(wrap, 'rescheduled', '↻ Notified'),
                        () => { dfConfirmBtn.disabled = false; });
                } else {
                    doDecline(apt.id, reason, () => markRowDone(wrap, 'declined', '✗ Notified'), () => { dfConfirmBtn.disabled = false; });
                }
            });

            decPanel.querySelector('.day-panel-df-cancel').addEventListener('click', e => {
                e.stopPropagation();
                decPanel.classList.remove('open');
                decPanel.querySelector('.day-panel-decline-ta').value = '';
                dpReschedCheck.checked = false;
                dpReschedContainer.style.display = 'none';
                dpReschedContainer.innerHTML = '';
                dpReschedPicker = null;
                dfConfirmBtn.textContent = 'Decline & Notify';
                dfConfirmBtn.disabled = false;
            });

            decBtn.addEventListener('click', e => {
                e.stopPropagation();
                const open = decPanel.classList.contains('open');
                decPanel.classList.toggle('open', !open);
                if (!open) decPanel.querySelector('.day-panel-decline-ta').focus();
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

    // The instructor's own entries for this day. On a phone the calendar cell
    // is too narrow for the chips desktop shows, so this panel is the only
    // place they are reachable — without them they would be invisible on mobile.
    const dayOwn = ownEventsOn(dateStr);
    if (dayOwn.length) {
        const head = document.createElement('div');
        head.className = 'day-panel-subhead';
        head.textContent = 'My calendar';
        list.appendChild(head);

        dayOwn.forEach(ev => {
            const row = document.createElement('div');
            row.className = 'day-panel-own';
            row.innerHTML =
                `<span class="day-panel-own-dot ${ev.blocks ? 'blocks' : ''}"></span>
                 <div class="day-panel-info">
                   <div class="day-panel-name">${escapeHtml(ev.title)}</div>
                   <div class="day-panel-meta">
                     ${ev.allDay ? 'All day' : escapeHtml(shortTime(ev.startTime) + ' – ' + shortTime(ev.endTime))}
                     · ${ev.kind === 'task' ? 'Task' : 'Event'}${ev.blocks ? ' · blocks booking' : ''}
                   </div>
                 </div>`;

            const edit = document.createElement('button');
            edit.className = 'day-panel-btn';
            edit.textContent = 'Edit';
            edit.addEventListener('click', () => { closeDayPanel(); openEventModal(ev); });
            row.appendChild(edit);

            list.appendChild(row);
        });
    }

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

    const isPending   = apt.status === 'pending';
    const isDeclined  = apt.status === 'declined';
    // Manual completion is only ever offered for a confirmed consultation
    // that has actually happened — the server enforces the same rule.
    const isCompletable = apt.status === 'confirmed' && hasEnded(apt);
    const initials    = getInitials(apt.firstName, apt.lastName);

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
                ${formatFullDate(apt.date)}
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
            <label class="resched-check">
                <input type="checkbox" class="apt-lv-resched-checkbox">
                Reschedule instead of declining
            </label>
            <div class="apt-lv-resched-container" style="display:none;"></div>
            <div class="apt-lv-decline-row">
                <button class="apt-lv-df-cancel">Cancel</button>
                <button class="apt-lv-df-confirm">Decline &amp; Notify</button>
            </div>`;

        let lvReschedPicker = null;
        const lvReschedCheck = declineForm.querySelector('.apt-lv-resched-checkbox');
        const lvReschedContainer = declineForm.querySelector('.apt-lv-resched-container');
        const lvConfirmBtn = declineForm.querySelector('.apt-lv-df-confirm');

        lvReschedCheck.addEventListener('change', function() {
            if (this.checked) {
                lvReschedPicker = buildReschedulePicker(
                    () => { lvConfirmBtn.disabled = false; }, apt.mode);
                lvReschedContainer.innerHTML = '';
                lvReschedContainer.appendChild(lvReschedPicker.el);
                lvReschedContainer.style.display = 'block';
                lvConfirmBtn.textContent = 'Reschedule & Notify';
                lvConfirmBtn.disabled = true;
            } else {
                lvReschedContainer.style.display = 'none';
                lvReschedContainer.innerHTML = '';
                lvReschedPicker = null;
                lvConfirmBtn.textContent = 'Decline & Notify';
                lvConfirmBtn.disabled = false;
            }
        });

        declineBtn.addEventListener('click', () => {
            const isOpen = declineForm.classList.contains('open');
            declineForm.classList.toggle('open', !isOpen);
            if (!isOpen) declineForm.querySelector('.apt-lv-decline-ta').focus();
        });

        declineForm.querySelector('.apt-lv-df-cancel').addEventListener('click', () => {
            declineForm.classList.remove('open');
            declineForm.querySelector('.apt-lv-decline-ta').value = '';
            lvReschedCheck.checked = false;
            lvReschedContainer.style.display = 'none';
            lvReschedContainer.innerHTML = '';
            lvReschedPicker = null;
            lvConfirmBtn.textContent = 'Decline & Notify';
        });

        lvConfirmBtn.addEventListener('click', () => {
            const reason = declineForm.querySelector('.apt-lv-decline-ta').value.trim();
            if (!reason) {
                const ta = declineForm.querySelector('.apt-lv-decline-ta');
                ta.style.borderColor = '#ef4444'; ta.focus();
                setTimeout(() => { ta.style.borderColor = ''; }, 1400);
                return;
            }
            lvConfirmBtn.disabled = true;
            if (lvReschedCheck.checked) {
                const sel = lvReschedPicker && lvReschedPicker.getSelected();
                if (!sel) { showToast('error', 'Select a Slot', 'Please choose a new date and time.'); lvConfirmBtn.disabled = false; return; }
                doReschedule(apt.id, sel.id, reason, sel.mode,
                    () => showToast('success', 'Rescheduled', `${apt.studentName} has been notified.`),
                    () => { lvConfirmBtn.disabled = false; });
            } else {
                doDecline(apt.id, reason, () => showToast('success', 'Declined', `${apt.studentName} has been notified.`), () => { lvConfirmBtn.disabled = false; });
            }
        });

        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
    }

    if (isCompletable) {
        const completeBtn = document.createElement('button');
        completeBtn.className = 'apt-lv-btn complete';
        completeBtn.title = 'Manually mark this consultation as completed';
        completeBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Complete`;
        completeBtn.addEventListener('click', () => {
            completeBtn.disabled = true;
            doComplete(
                apt.id,
                () => { showToast('success', 'Completed', `${apt.studentName}'s consultation is now marked complete.`); },
                () => { completeBtn.disabled = false; }
            );
        });
        actions.appendChild(completeBtn);
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

/**
 * Slot picker shown when declining-with-reschedule.
 *
 * The server only offers slots inside a three-week window, so a month grid with
 * navigation would mostly show empty months. A flat list of the open days reads
 * better and makes the limit obvious.
 *
 * @param {function} onSelect  called once a slot is chosen
 * @param {string} currentMode the appointment's present mode, pre-selected
 * @param {function} [onResize] called after the slot list renders, so a host
 *                              popover can re-place itself around the new height
 */
function buildReschedulePicker(onSelect, currentMode, onResize) {
    const wrap = document.createElement('div');
    wrap.className = 'resched-picker';
    wrap.innerHTML = `
        <div class="resched-mode">
            <span class="resched-mode-label">Consultation mode</span>
            <div class="resched-mode-opts">
                <button type="button" class="resched-mode-btn" data-mode="Face-to-Face">Face-to-Face</button>
                <button type="button" class="resched-mode-btn" data-mode="Online">Online</button>
            </div>
        </div>
        <p class="resched-window"></p>
        <div class="resched-days"></div>
        <div class="resched-selected" style="display:none;"></div>
    `;

    let selected = null;
    let mode = currentMode === 'Online' ? 'Online' : 'Face-to-Face';

    const daysEl   = wrap.querySelector('.resched-days');
    const selEl    = wrap.querySelector('.resched-selected');
    const windowEl = wrap.querySelector('.resched-window');

    function paintMode() {
        wrap.querySelectorAll('.resched-mode-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
    }
    wrap.querySelectorAll('.resched-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            mode = btn.dataset.mode;
            paintMode();
            // Switching the venue does not invalidate the slot, but the caller
            // may want to re-enable its confirm button
            if (selected && onSelect) onSelect(getSelected());
        });
    });
    paintMode();

    function getSelected() {
        return selected ? { id: selected.id, label: selected.label, mode: mode } : null;
    }

    function renderDays(groups) {
        daysEl.innerHTML = '';
        groups.forEach(group => {
            const day = document.createElement('div');
            day.className = 'resched-day-group';

            const head = document.createElement('p');
            head.className = 'resched-slot-date';
            head.textContent = `${group.day}, ${formatFullDate(group.date)}`;
            day.appendChild(head);

            const row = document.createElement('div');
            row.className = 'resched-slot-row';
            group.subSlots.forEach(sub => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'resched-slot-btn';
                b.textContent = `${sub.timeStart}–${sub.timeEnd}`;
                b.addEventListener('click', () => {
                    daysEl.querySelectorAll('.resched-slot-btn').forEach(x => x.classList.remove('active'));
                    b.classList.add('active');
                    selected = {
                        id: sub.id,
                        label: `${group.day}, ${formatFullDate(group.date)} · ${sub.timeStart}–${sub.timeEnd}`,
                    };
                    selEl.innerHTML = '<strong>New time:</strong> ' + selected.label;
                    selEl.style.display = 'block';
                    if (onSelect) onSelect(getSelected());
                });
                row.appendChild(b);
            });
            day.appendChild(row);
            daysEl.appendChild(day);
        });
    }

    daysEl.innerHTML = '<p class="resched-slot-date">Loading available slots…</p>';

    fetch('/instructor/appointments/reschedule-options')
        .then(r => r.json())
        .then(d => {
            if (!d.success) { daysEl.innerHTML = '<p class="resched-error">Failed to load slots.</p>'; return; }

            windowEl.textContent = d.minDate && d.maxDate
                ? `Open slots between ${formatFullDate(d.minDate)} and ${formatFullDate(d.maxDate)}.`
                : '';

            const groups = (d.slots || []).filter(g => g.subSlots && g.subSlots.length);
            if (!groups.length) {
                daysEl.innerHTML =
                    '<p class="resched-error">No open slots in the next three weeks. Add consultation hours first.</p>';
            } else {
                renderDays(groups);
            }
            if (onResize) onResize();
        })
        .catch(() => {
            daysEl.innerHTML = '<p class="resched-error">Failed to load slots.</p>';
            if (onResize) onResize();
        });

    return { el: wrap, getSelected: getSelected };
}

function doReschedule(aptId, newSlotId, reason, mode, onSuccess, onError) {
    fetch(`/instructor/appointments/${encodeURIComponent(aptId)}/reschedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newSlotId, reason, mode })
    })
    .then(r => r.json())
    .then(d => {
        if (!d.success) { showToast('error', 'Error', d.error || 'Failed to reschedule.'); if (onError) onError(); return; }
        const apt = appointments.find(a => a.id === aptId);
        if (apt) apt.status = 'rescheduled';
        refreshStats(); renderCalendar();
        if (currentView === 'list') renderListView();
        if (onSuccess) onSuccess();
        setTimeout(() => { window.location.reload(); }, 1500);
    })
    .catch(() => { showToast('error', 'Error', 'Network error. Please try again.'); if (onError) onError(); });
}

/* ── Imported calendar events ── */

// Filled by loadCalendarEvents(); the calendar renders whatever is here.
/* ── The instructor's own events and tasks ───────────────────────────────── */

let ownEvents = [];

function ownEventsOn(dateStr) {
    return ownEvents.filter(e => e.date === dateStr);
}

/** '14:30' -> '2:30 PM', for the compact chip on a day cell. */
function shortTime(value) {
    if (!value) return '';
    const [h, m] = value.split(':').map(Number);
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function loadOwnEvents() {
    // A generous window either side of the month on screen, so paging back and
    // forth does not refetch on every click
    const start = fmtDate(new Date(calYear, calMonth - 1, 1));
    const end = fmtDate(new Date(calYear, calMonth + 2, 0));

    return fetch(`/instructor/events?start=${start}&end=${end}`, {
        headers: { Accept: 'application/json' },
    })
        .then(r => r.json())
        .then(d => { ownEvents = d.success ? d.events : []; })
        .catch(() => { ownEvents = []; });
}

let editingEventId = null;

function openEventModal(existing, presetDate) {
    const modal = $('eventModal');
    if (!modal) return;

    editingEventId = existing ? existing.id : null;

    $('eventModalTitle').textContent = existing
        ? (existing.kind === 'task' ? 'Edit task' : 'Edit event')
        : 'Add to my calendar';
    $('eventDelete').hidden = !existing;
    $('eventConflicts').hidden = true;
    $('eventError').hidden = true;

    $('eventKind').value = existing ? existing.kind : 'event';
    $('eventTitle').value = existing ? existing.title : '';
    $('eventNotes').value = existing ? existing.notes : '';
    $('eventDate').value = existing ? existing.date : (presetDate || fmtDate(new Date()));
    $('eventAllDay').checked = existing ? existing.allDay : false;
    $('eventStart').value = existing && existing.startTime ? existing.startTime : '09:00';
    $('eventEnd').value = existing && existing.endTime ? existing.endTime : '10:00';
    $('eventBlocks').checked = existing ? existing.blocks : true;

    syncEventForm();
    modal.classList.add('show');
    $('eventTitle').focus();
}

function closeEventModal() {
    const modal = $('eventModal');
    if (modal) modal.classList.remove('show');
    editingEventId = null;
}

/** Show only the controls that apply to the current all-day choice. */
function syncEventForm() {
    $('eventTimeRow').hidden = $('eventAllDay').checked;
    $('eventBlocksHint').textContent = $('eventBlocks').checked
        ? 'Students cannot book consultations during this time.'
        : 'Shown on your calendar only. Students can still book.';
}

function eventPayload() {
    return {
        kind: $('eventKind').value,
        title: $('eventTitle').value.trim(),
        notes: $('eventNotes').value.trim(),
        eventDate: $('eventDate').value,
        allDay: $('eventAllDay').checked,
        startTime: $('eventStart').value,
        endTime: $('eventEnd').value,
        blocks: $('eventBlocks').checked,
    };
}

/** Warn about consultations already inside the hours this would block. */
function checkEventConflicts() {
    const box = $('eventConflicts');
    if (!$('eventBlocks').checked) { box.hidden = true; return; }

    fetch('/instructor/events/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload()),
    })
        .then(r => r.json())
        .then(d => {
            if (!d.success || !d.conflicts.length) { box.hidden = true; return; }
            box.hidden = false;
            box.innerHTML =
                `<strong>${d.conflicts.length} consultation${d.conflicts.length === 1 ? '' : 's'} already booked in this time.</strong>` +
                '<ul>' + d.conflicts.map(c =>
                    `<li>${escapeHtml(c.time)} — ${escapeHtml(c.student)}</li>`).join('') + '</ul>' +
                '<span>Blocking the hours will not cancel them; handle those from the appointment itself.</span>';
        })
        .catch(() => { box.hidden = true; });
}

function saveEvent() {
    const btn = $('eventSave');
    const err = $('eventError');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const url = editingEventId ? `/instructor/events/${editingEventId}` : '/instructor/events';

    fetch(url, {
        method: editingEventId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventPayload()),
    })
        .then(r => r.json())
        .then(d => {
            if (!d.success) {
                err.textContent = d.error || 'Could not save.';
                err.hidden = false;
                return;
            }
            closeEventModal();
            // A blocking event changes what students can book, so the slot
            // counts on the page are stale until this reloads.
            loadOwnEvents().then(renderCalendar);
        })
        .catch(() => { err.textContent = 'Network error. Please try again.'; err.hidden = false; })
        .finally(() => { btn.disabled = false; btn.textContent = 'Save'; });
}

function deleteEvent() {
    if (!editingEventId) return;
    if (!window.confirm('Delete this entry?')) return;

    fetch(`/instructor/events/${editingEventId}`, { method: 'DELETE' })
        .then(r => r.json())
        .then(d => {
            if (!d.success) return;
            closeEventModal();
            loadOwnEvents().then(renderCalendar);
        })
        .catch(() => {});
}

function initOwnEvents() {
    const modal = $('eventModal');
    if (!modal) return;

    // Opens on today; the date field is editable, and clicking a chip on a day
    // opens that entry instead.
    $('btnAddEvent').addEventListener('click', () => openEventModal(null, null));
    $('eventClose').addEventListener('click', closeEventModal);
    $('eventCancel').addEventListener('click', closeEventModal);
    $('eventSave').addEventListener('click', saveEvent);
    $('eventDelete').addEventListener('click', deleteEvent);

    modal.addEventListener('click', e => { if (e.target === modal) closeEventModal(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('show')) closeEventModal();
    });

    ['eventAllDay', 'eventKind', 'eventBlocks'].forEach(id =>
        $(id).addEventListener('change', syncEventForm));

    // Re-check whenever the window being blocked changes
    ['eventDate', 'eventStart', 'eventEnd', 'eventAllDay', 'eventBlocks'].forEach(id =>
        $(id).addEventListener('change', checkEventConflicts));

    loadOwnEvents().then(renderCalendar);
}

let externalEvents = [];

function calendarEventsOn(dateStr) {
    return externalEvents.filter(e => String(e.event_date).slice(0, 10) === dateStr);
}

function slotLabel(slot) {
    if (slot == null) return '';
    const total = slot * 30;
    const h = Math.floor(total / 60), m = total % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''}${period}`;
}

function loadCalendarEvents() {
    return fetch('/instructor/calendar/events')
        .then(r => r.json())
        .then(d => {
            if (!d.success) return;
            externalEvents = d.events || [];
            renderCalendar();
            renderPendingBanner();
        })
        .catch(() => { /* the calendar still works without imported events */ });
}

/**
 * The blocking prompt. It is a banner rather than a modal on purpose: syncs
 * run on a schedule, so there may be nobody at the screen when one lands, and
 * an unanswered event stays non-blocking until the instructor says otherwise.
 */
function renderPendingBanner() {
    const banner = $('calPendingBanner');
    if (!banner) return;

    const pending = externalEvents.filter(e => e.decision === 'pending');
    banner.hidden = pending.length === 0;
    if (!pending.length) return;

    $('calPendingCount').textContent = pending.length;
    $('calPendingWord').textContent = pending.length === 1 ? 'event needs' : 'events need';

    const list = $('calPendingList');
    list.innerHTML = pending.map(e => `
        <li data-event-id="${e.id}">
            <div class="cal-pending-what">
                <strong>${escapeHtml(e.summary || 'Busy')}</strong>
                <span>${escapeHtml(String(e.event_date).slice(0, 10))}${
                    e.all_day ? ' · all day' : ' · ' + slotLabel(e.start_slot) + '–' + slotLabel(e.end_slot)
                } · ${escapeHtml(e.calendar_name || '')}</span>
            </div>
            <div class="cal-pending-actions">
                <button type="button" class="cal-decide block" data-blocks="1">Block</button>
                <button type="button" class="cal-decide allow" data-blocks="0">Allow</button>
            </div>
        </li>`).join('');
}

/**
 * The imported-events list opens and closes like a dropdown. Collapsed by
 * default so a large import does not push the calendar down; the choice is
 * remembered per browser, so an instructor who keeps it open finds it open.
 */
const PENDING_OPEN_KEY = 'facitrack.calPendingOpen';
function setPendingOpen(open) {
    const toggle = $('calPendingToggle');
    const list = $('calPendingList');
    if (!toggle || !list) return;
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    try { localStorage.setItem(PENDING_OPEN_KEY, open ? '1' : '0'); } catch (e) { /* private mode */ }
}

function initCalendarSync() {
    const banner = $('calPendingBanner');
    if (banner) {
        let startOpen = false;
        try { startOpen = localStorage.getItem(PENDING_OPEN_KEY) === '1'; } catch (e) { /* private mode */ }
        setPendingOpen(startOpen);

        banner.addEventListener('click', e => {
            if (e.target.closest('#calPendingToggle')) {
                setPendingOpen($('calPendingToggle').getAttribute('aria-expanded') !== 'true');
                return;
            }
            const button = e.target.closest('.cal-decide');
            if (button) {
                const row = button.closest('li');
                decideEvents([Number(row.dataset.eventId)], button.dataset.blocks === '1', button);
                return;
            }
            if (e.target.closest('#calPendingAllowAll')) {
                const ids = externalEvents.filter(x => x.decision === 'pending').map(x => x.id);
                decideEvents(ids, false, e.target);
            }
            if (e.target.closest('#calPendingBlockAll')) {
                const ids = externalEvents.filter(x => x.decision === 'pending').map(x => x.id);
                decideEvents(ids, true, e.target);
            }
        });
    }

    const syncBtn = $('calSyncBtn');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            const label = syncBtn.textContent;
            syncBtn.textContent = 'Syncing…';
            fetch('/instructor/calendar/sync', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                    syncBtn.disabled = false;
                    syncBtn.textContent = label;
                    if (!d.success) { showToast('error', 'Sync failed', d.error || 'Please try again.'); return; }
                    if (d.failures && d.failures.length) {
                        showToast('error', d.failures[0].name, d.failures[0].error);
                    } else {
                        showToast('success', 'Calendars synced',
                            `${d.imported} event${d.imported === 1 ? '' : 's'} imported.`);
                    }
                    loadCalendarEvents();
                })
                .catch(() => {
                    syncBtn.disabled = false;
                    syncBtn.textContent = label;
                    showToast('error', 'Sync failed', 'Network error.');
                });
        });
    }

    loadCalendarEvents();
}

function decideEvents(ids, blocks, button) {
    if (!ids.length) return;
    if (button) button.disabled = true;

    fetch('/instructor/calendar/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventIds: ids, blocks: blocks }),
    })
        .then(r => r.json())
        .then(d => {
            if (button) button.disabled = false;
            if (!d.success) { showToast('error', 'Error', d.error || 'Could not save that.'); return; }
            // Reload rather than patch in place: blocking changes what the
            // calendar should show, and the server is the authority on it
            loadCalendarEvents();
            showToast('success', blocks ? 'Time blocked' : 'Time left open',
                blocks ? 'Students can no longer book over it.' : 'Students can still book that time.');
        })
        .catch(() => {
            if (button) button.disabled = false;
            showToast('error', 'Error', 'Network error.');
        });
}

/* ── Approve all pending ── */
function initApproveAll() {
    const btn = $('approveAllBtn');
    if (!btn) return;

    const modal   = $('approveAllModal');
    const prompt  = $('approveAllPrompt');
    const result  = $('approveAllResult');
    const list    = $('approveAllList');
    const confirm = $('approveAllConfirm');
    const cancel  = $('approveAllCancel');
    let ran = false;

    /** The button only exists while there is something to approve. */
    function syncButton() {
        const pending = appointments.filter(a => a.status === 'pending');
        btn.hidden = pending.length === 0;
        $('approveAllCount').textContent = pending.length;
        return pending;
    }

    function close() {
        modal.classList.remove('show');
        // Approving rewrites several rows at once, so let the page catch up
        if (ran) window.location.reload();
    }

    function open() {
        const pending = syncButton();
        if (!pending.length) return;

        ran = false;
        prompt.hidden = false;
        result.hidden = true;
        result.innerHTML = '';
        confirm.hidden = false;
        confirm.disabled = false;
        confirm.textContent = 'Approve all';
        cancel.textContent = 'Cancel';

        $('approveAllTotal').textContent = pending.length;
        $('approveAllPlural').textContent = pending.length === 1 ? '' : 's';

        // Name them, so this is never a blind confirmation
        list.innerHTML = pending.map(a =>
            `<li><strong>${escapeHtml(a.studentName)}</strong>` +
            `<span>${escapeHtml(formatFullDate(a.date))} · ${escapeHtml(a.time)}</span></li>`).join('');

        modal.classList.add('show');
    }

    btn.addEventListener('click', open);
    $('approveAllClose').addEventListener('click', close);
    cancel.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    confirm.addEventListener('click', () => {
        confirm.disabled = true;
        confirm.textContent = 'Approving…';

        fetch('/instructor/appointments/approve-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        })
        .then(r => r.json())
        .then(d => {
            if (!d.success) {
                confirm.disabled = false;
                confirm.textContent = 'Approve all';
                showResult(`<p class="apt-approve-note bad">${escapeHtml(d.error || 'Could not approve the requests.')}</p>`);
                return;
            }
            ran = d.approved > 0;
            showResult(summarise(d));
            confirm.hidden = true;
            cancel.textContent = 'Close';
        })
        .catch(() => {
            confirm.disabled = false;
            confirm.textContent = 'Approve all';
            showResult('<p class="apt-approve-note bad">Network error. Please try again.</p>');
        });
    });

    function showResult(html) {
        prompt.hidden = true;
        result.hidden = false;
        result.innerHTML = html;
    }

    function summarise(d) {
        let html = `<p class="apt-approve-note ok"><strong>${d.approved} of ${d.total}</strong> ` +
                   `request${d.total === 1 ? '' : 's'} approved. ` +
                   `${d.approved ? 'Each student has been notified.' : ''}</p>`;
        if (d.skipped.length) {
            html += '<p class="apt-approve-heading">Left pending:</p><ul class="apt-approve-list">';
            d.skipped.forEach(s => {
                html += `<li><strong>${escapeHtml(s.student)}</strong><span>${escapeHtml(s.reason)}</span></li>`;
            });
            html += '</ul>';
        }
        return html;
    }

    // Approving or declining one request can empty the queue
    window.syncApproveAllButton = syncButton;
    syncButton();
}

/* ── Complete all finished consultations ── */
function initCompleteAll() {
    const btn = $('completeAllBtn');
    if (!btn) return;

    const modal   = $('completeAllModal');
    const prompt  = $('completeAllPrompt');
    const result  = $('completeAllResult');
    const list    = $('completeAllList');
    const confirm = $('completeAllConfirm');
    const cancel  = $('completeAllCancel');
    let ran = false;

    /**
     * Confirmed consultations whose slot has already ended. The server checks
     * this again per appointment — this is only so the button can show an
     * honest count instead of offering to complete something still to come.
     */
    function finished() {
        const now = Date.now();
        return appointments.filter(a => {
            if (a.status !== 'confirmed' || !a.endsAt) return false;
            const ends = new Date(a.endsAt).getTime();
            return Number.isFinite(ends) && ends <= now;
        });
    }

    function syncButton() {
        const done = finished();
        btn.hidden = done.length === 0;
        $('completeAllCount').textContent = done.length;
        return done;
    }

    function close() {
        modal.classList.remove('show');
        if (ran) window.location.reload();
    }

    function open() {
        const done = syncButton();
        if (!done.length) return;

        ran = false;
        prompt.hidden = false;
        result.hidden = true;
        result.innerHTML = '';
        confirm.hidden = false;
        confirm.disabled = false;
        confirm.textContent = 'Complete all';
        cancel.textContent = 'Cancel';

        $('completeAllTotal').textContent = done.length;
        $('completeAllPlural').textContent = done.length === 1 ? '' : 's';

        list.innerHTML = done.map(a =>
            `<li><strong>${escapeHtml(a.studentName)}</strong>` +
            `<span>${escapeHtml(a.date)} · ${escapeHtml(a.time)}</span></li>`).join('');

        modal.classList.add('show');
    }

    btn.addEventListener('click', open);
    $('completeAllClose').addEventListener('click', close);
    cancel.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    confirm.addEventListener('click', () => {
        confirm.disabled = true;
        confirm.textContent = 'Completing…';

        fetch('/instructor/appointments/complete-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        })
        .then(r => r.json())
        .then(d => {
            if (!d.success) {
                confirm.disabled = false;
                confirm.textContent = 'Complete all';
                showResult(`<p class="apt-approve-note bad">${escapeHtml(d.error || 'Could not complete the consultations.')}</p>`);
                return;
            }
            ran = d.completed > 0;
            showResult(summarise(d));
            confirm.hidden = true;
            cancel.textContent = 'Close';
        })
        .catch(() => {
            confirm.disabled = false;
            confirm.textContent = 'Complete all';
            showResult('<p class="apt-approve-note bad">Network error. Please try again.</p>');
        });
    });

    function showResult(html) {
        prompt.hidden = true;
        result.hidden = false;
        result.innerHTML = html;
    }

    function summarise(d) {
        let html = `<p class="apt-approve-note ok"><strong>${d.completed} of ${d.total}</strong> ` +
                   `consultation${d.total === 1 ? '' : 's'} completed.</p>`;
        if (d.skipped.length) {
            html += '<p class="apt-approve-heading">Left as they were:</p><ul class="apt-approve-list">';
            d.skipped.forEach(s => {
                html += `<li><strong>${escapeHtml(s.student)}</strong><span>${escapeHtml(s.reason)}</span></li>`;
            });
            html += '</ul>';
        }
        return html;
    }

    // Approving a request creates a confirmed one, which may become completable
    window.syncCompleteAllButton = syncButton;
    syncButton();
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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
        if (apt) {
            apt.status = 'confirmed';
            // Approving an online consultation is what creates its Meet, so the
            // link arrives with this response rather than on the next load.
            if (d.meetingLink) apt.meetingLink = d.meetingLink;
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
/** True once the appointment's end time has passed. */
function hasEnded(apt) {
    if (!apt.date) return false;
    // apt.time is "9:00 AM – 9:30 AM"; take the end half
    const parts = String(apt.time || '').split(/[–-]/);
    const endLabel = (parts[1] || parts[0] || '').trim();
    const m = endLabel.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return false;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const mer = m[3].toUpperCase();
    if (mer === 'PM' && h !== 12) h += 12;
    if (mer === 'AM' && h === 12) h = 0;
    const d = new Date(String(apt.date).slice(0, 10) + 'T00:00:00');
    d.setHours(h, min, 0, 0);
    return d.getTime() < Date.now();
}

function doComplete(aptId, onSuccess, onError) {
    fetch(`/instructor/appointments/${encodeURIComponent(aptId)}/complete`, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                showToast('error', 'Could Not Complete', data.error || 'Please try again.');
                if (onError) onError();
                return;
            }
            // Same sync pattern as doApprove/doDecline — without this, completing
            // from one view (e.g. the calendar day panel) left the appointment
            // showing as "Confirmed" everywhere else until a full page reload.
            const apt = appointments.find(a => a.id === aptId);
            if (apt) apt.status = 'completed';
            refreshStats();
            renderCalendar();
            if (currentView === 'list') renderListView();
            showToast('success', 'Consultation Completed', 'This consultation is now closed.');
            if (onSuccess) onSuccess();
        })
        .catch(() => { showToast('error', 'Network Error', 'Please try again.'); if (onError) onError(); });
}

function switchMode(id, mode, btn) {
    fetch(`/instructor/appointments/${id}/mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
    })
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                showToast('error', 'Could Not Change Mode', data.error || 'Please try again.');
                if (btn) btn.disabled = false;
                return;
            }
            const where = data.mode === 'Online' ? 'an online meeting' : 'a consultation room';
            showToast('success', 'Mode Updated', `Now set to ${data.mode} — ${where}.`);
            setTimeout(() => window.location.reload(), 900);
        })
        .catch(() => { showToast('error', 'Network Error', 'Please try again.'); if (btn) btn.disabled = false; });
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
    initApproveAll();
    initCompleteAll();
    refreshStats(); initCalendar(); initPopover(); initSearchFilter(); initViewToggle();
    // After initCalendar(), which is what sets calYear/calMonth — the fetch
    // window is derived from them, so running earlier asked for an
    // Invalid Date range and quietly came back empty.
    initOwnEvents();
    initCalendarSync();

    const params = new URLSearchParams(window.location.search);
    const openAptId = params.get('openApt');
    if (openAptId) {
        const targetId = parseInt(openAptId, 10);
        const apt = appointments.find(a => a.id === targetId);
        if (apt) {
            // Keep calendar view
            currentView = 'calendar';
            document.querySelectorAll('.apt-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'calendar'));
            $('aptCalView').style.display = 'block';
            $('aptListView').style.display = 'none';

            // Find the date of the appointment and navigate calendar to that month
            const aptDate = new Date(apt.date + 'T00:00:00');
            calYear = aptDate.getFullYear();
            calMonth = aptDate.getMonth();
            
            // Re-render calendar with the target date
            renderCalendar();

            // Find the calendar cell for that date
            const dateStr = fmtDate(aptDate);
            const cell = document.querySelector(`.apt-cal-cell[data-date="${dateStr}"]`);
            
            if (cell) {
                // Scroll to the cell
                cell.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Highlight the cell
                document.querySelectorAll('.apt-cal-cell.selected-instant').forEach(c => c.classList.remove('selected-instant', 'selected'));
                cell.classList.add('selected-instant', 'selected');

                // Open the popover after the scroll, but look the anchor up again
                // at that moment rather than reusing the nodes captured above.
                // loadCalendarEvents() resolves on its own schedule and calls
                // renderCalendar(), so anything held across this gap can be a
                // detached node by now — and a detached anchor measures 0x0 at
                // 0,0, which positionPopover reads as "off-screen" and hides.
                setTimeout(() => {
                    const liveCell = document.querySelector(`.apt-cal-cell[data-date="${dateStr}"]`);
                    if (!liveCell) return;
                    liveCell.classList.add('selected-instant', 'selected');

                    // The badge is preferred; the cell is the fallback when this
                    // appointment is filtered out of the badge list.
                    const liveBadge = liveCell.querySelector(`.apt-badge[data-apt-id="${targetId}"]`);
                    openPopover(targetId, liveBadge || liveCell);
                }, 400);
            } else {
                // If cell not found (appointment date might be in another month), try list view as fallback
                currentView = 'list';
                document.querySelectorAll('.apt-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'list'));
                $('aptCalView').style.display = 'none';
                $('aptListView').style.display = 'block';

                const all = filteredApts();
                const idx = all.findIndex(a => a.id === targetId);
                if (idx >= 0) {
                    currentPage = Math.floor(idx / ITEMS_PER_PAGE) + 1;
                }
                renderListView();

                setTimeout(() => {
                    const card = document.querySelector(`.apt-lv-card[data-apt-id="${targetId}"]`);
                    if (card) {
                        const viewBtn = card.querySelector('.apt-lv-btn.view');
                        openPopover(targetId, viewBtn || card);
                    }
                }, 50);
            }
        }
        window.history.replaceState({}, '', window.location.pathname);
    }
});

})();

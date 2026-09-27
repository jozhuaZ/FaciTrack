(function () {
  'use strict';

  /* ── Constants ── */
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_CLASSES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  // 7:00 AM → 8:00 PM in 30-min slots
  // Each slot is a number of half-hours from midnight: 7:00 AM = 14, 7:30 AM = 15 … 8:00 PM = 40
  const START_SLOT = 14;  // 7:00 AM  (7*2)
  const END_SLOT = 40;  // 8:00 PM  (20*2)  — last draggable end

  // All slot indices
  const SLOTS = [];
  for (let s = START_SLOT; s < END_SLOT; s++) SLOTS.push(s);

  const SLOT_H = 28; // px per 30-min row — no border between :00 and :30

  const TYPE_COLORS = {
    'Lecture': '#f97316',
    'Laboratory': '#eab308',
    'Online': '#0ea5e9',
    'Make Up Class': '#10b981'
  };
  function typeColor(t) { return TYPE_COLORS[t] || '#3b82f6'; }

  // slot index → "7:00 AM", "7:30 AM", "12:00 PM" …
  function slotLabel(s) {
    const totalMins = s * 30;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  // range label e.g. "8:00 AM – 9:30 AM"
  function rangeLabel(startSlot, endSlot) {
    return slotLabel(startSlot) + ' – ' + slotLabel(endSlot);
  }

  const LS_KEY = 'facitrack_workload_v5';

  /* ── State ── */
  // key: `${day}_${startSlot}`
  // value: { day, startSlot, endSlot, subjectCode, subjectName, room, section, type }
  let blocks = {};
  let editingKey = null;

  // Drag state (slot indices)
  let dragDay = null;
  let dragStart = null;
  let dragEnd = null;
  let isDragging = false;
  // Touch scroll-vs-drag detection
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;
  let pendingCell = null;

  /* ── Auto-save ── */
  let saveTimer = null;
  function autoSave() {
    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const subjects = [];
        const serverBlocks = {};
        Object.values(blocks).forEach(b => {
          if (b.type === 'Make Up Class') return;
          if (!subjects.find(s => s.code === b.subjectCode)) {
            subjects.push({ id: b.subjectCode, code: b.subjectCode, name: b.subjectName, color: typeColor(b.type), units: 0 });
          }
          serverBlocks[`${b.day}_${b.startSlot}`] = {
            subjectId: b.subjectCode, roomId: b.roomId, room: b.room, section: b.section,
            type: b.type, duration: b.endSlot - b.startSlot, color: typeColor(b.type)
          };
        });
        const r = await fetch('/instructor/workload/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subjects, blocks: serverBlocks })
        });
        console.log('[autoSave] response status:', r.status);
        const j = await r.json();
        console.log('[autoSave] response body:', j);
        if (!j.success) throw new Error('fail');
        setStatus('saved');
      } catch (e) { setStatus('local'); }
    }, 800);
  }

  function setStatus(s) {
    const text = document.getElementById('autoSaveText');
    const wrap = document.getElementById('autoSaveStatus');
    if (!text || !wrap) return;
    if (s === 'saving') { wrap.style.color = '#f59e0b'; text.textContent = 'Saving...'; }
    else if (s === 'saved') { wrap.style.color = '#16a34a'; text.textContent = 'All changes saved'; setTimeout(() => { wrap.style.color = '#94a3b8'; }, 3000); }
    else { wrap.style.color = '#94a3b8'; text.textContent = 'Saved locally'; }
  }

  /* ── Build grid ── */
  function buildGrid() {
    const grid = document.getElementById('calGrid');
    if (!grid) return;
    grid.innerHTML = '';

    // Corner
    const corner = document.createElement('div');
    corner.className = 'cal-time-hdr';
    grid.appendChild(corner);

    // Day headers — full names
    DAYS.forEach((day, i) => {
      const hdr = document.createElement('div');
      hdr.className = `cal-day-hdr ${DAY_CLASSES[i]}`;
      hdr.textContent = day;
      grid.appendChild(hdr);
    });

    // Slot rows
    SLOTS.forEach(slot => {
      const isHour = (slot % 2 === 0); // even = on-the-hour

      // Time label — only show on-the-hour; :30 row is blank (no line)
      const tl = document.createElement('div');
      tl.className = 'cal-time' + (isHour ? '' : ' cal-time-half');
      tl.textContent = isHour ? slotLabel(slot) : '';
      grid.appendChild(tl);

      // Day cells
      DAYS.forEach(day => {
        const cell = document.createElement('div');
        cell.className = 'cal-cell' + (isHour ? ' cal-cell-hour' : ' cal-cell-half');
        cell.dataset.day = day;
        cell.dataset.slot = slot;
        grid.appendChild(cell);
      });
    });

    attachDragListeners();
    renderBlocks();
  }

  /* ── Drag-to-create ── */
  function attachDragListeners() {
    const grid = document.getElementById('calGrid');
    if (!grid) return;
    grid.addEventListener('mousedown', onDragStart);
    grid.addEventListener('mousemove', onDragMove);
    grid.addEventListener('mouseup', onDragEnd);
    grid.addEventListener('mouseleave', onDragCancel);
    grid.addEventListener('touchstart', onTouchStart, { passive: false });
    grid.addEventListener('touchmove', onTouchMove, { passive: false });
    grid.addEventListener('touchend', onTouchEnd);
  }

  function cellAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('.cal-cell') : null;
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    const cell = e.target.closest('.cal-cell');

    if (!cell) return;

    if(e.target.closest('.cal-block')) return;

    isDragging = true;
    dragDay = cell.dataset.day;
    dragStart = parseInt(cell.dataset.slot);
    dragEnd = dragStart;
    
    showGhost();
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const cell = cellAt(e.clientX, e.clientY);
    if (cell && cell.dataset.day === dragDay) {
      const s = parseInt(cell.dataset.slot);
      if (s !== dragEnd) { dragEnd = s; showGhost(); }
    }
  }

  function onDragEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    const startSlot = Math.min(dragStart, dragEnd);
    const endSlot = Math.max(dragStart, dragEnd) + 1;
    clearGhost();

    if (endSlot > startSlot) {
      // check overlap before opening modal
      for (let s = startSlot; s < endSlot; s++) {
        const conflict = Object.entries(blocks).find(([k, b]) =>
          b.day === dragDay && b.startSlot <= s && s < b.endSlot
        );
        if (conflict) {
          toast(`Time slot conflict at ${slotLabel(s)} on ${dragDay}. Clear that block first.`, 'error');
          dragDay = dragStart = dragEnd = null;
          return; // don't open modal
        }
      }
      openModal(null, dragDay, startSlot, endSlot);
    }
    dragDay = dragStart = dragEnd = null;
  }

  function onDragCancel() {
    if (isDragging) { isDragging = false; clearGhost(); dragDay = dragStart = dragEnd = null; }
  }

  function onTouchStart(e) {
    const t = e.touches[0];
    const cell = cellAt(t.clientX, t.clientY);
    if (!cell) return;
    // Record start position to distinguish scroll vs drag
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchMoved = false;
    isDragging = false;
    pendingCell = cell;
    // Don't preventDefault yet — wait to see if it's a vertical drag
  }
  function onTouchMove(e) {
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - touchStartX);
    const dy = Math.abs(t.clientY - touchStartY);

    // If horizontal movement dominates → it's a scroll, cancel any drag
    if (!touchMoved && dx > dy && dx > 6) {
      isDragging = false;
      pendingCell = null;
      return; // let native scroll handle it
    }

    // Vertical drag → start drag-to-create
    if (!touchMoved && dy > 6 && pendingCell) {
      touchMoved = true;
      isDragging = true;
      dragDay = pendingCell.dataset.day;
      dragStart = parseInt(pendingCell.dataset.slot);
      dragEnd = dragStart;
      showGhost();
      e.preventDefault(); // only block scroll once we're sure it's a drag
    }

    if (!isDragging) return;
    const cell = cellAt(t.clientX, t.clientY);
    if (cell && cell.dataset.day === dragDay) {
      const s = parseInt(cell.dataset.slot);
      if (s !== dragEnd) { dragEnd = s; showGhost(); }
    }
    e.preventDefault();
  }
  function onTouchEnd() {
    pendingCell = null;
    touchMoved = false;
    onDragEnd({});
  }

  function durationLabel(halfHours) {
    const hrs = Math.floor(halfHours / 2);
    const mins = (halfHours % 2) * 30;
    if (hrs === 0) return `${mins} min`;
    if (mins === 0) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
    return `${hrs} hr${hrs > 1 ? 's' : ''} 30 min`;
  }

  /* ── Ghost preview ── */
  let ghostEl = null;
  function showGhost() {
    clearGhost();
    if (!isDragging) return;
    const startSlot = Math.min(dragStart, dragEnd);
    const endSlot = Math.max(dragStart, dragEnd) + 1;
    const anchor = document.querySelector(`.cal-cell[data-day="${dragDay}"][data-slot="${startSlot}"]`);
    if (!anchor) return;
    const duration = endSlot - startSlot;
    ghostEl = document.createElement('div');
    ghostEl.className = 'drag-ghost';
    ghostEl.style.cssText = `top:0;height:${duration * SLOT_H - 3}px`;
    ghostEl.innerHTML = `
    <span class="dg-range">${rangeLabel(startSlot, endSlot)}</span>
    <span class="dg-dur">${durationLabel(duration)}</span>
  `;
    anchor.appendChild(ghostEl);
  }
  function clearGhost() {
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
  }

  /* ── Render blocks ── */
  function renderBlocks() {
    document.querySelectorAll('.cal-block').forEach(el => el.remove());

    Object.entries(blocks).forEach(([key, b]) => {
      const anchor = document.querySelector(`.cal-cell[data-day="${b.day}"][data-slot="${b.startSlot}"]`);
      if (!anchor) return;

      const duration = b.endSlot - b.startSlot; // half-hour units
      const el = document.createElement('div');
      el.className = 'cal-block';
      el.dataset.key = key;
      el.style.cssText = `background:${typeColor(b.type)};top:1px;height:${duration * SLOT_H - 4}px`;

      el.innerHTML = `
      <button class="cb-del" title="Remove">✕</button>
      <span class="cb-code">${esc(b.subjectCode)}</span>
      <span class="cb-time">${rangeLabel(b.startSlot, b.endSlot)}</span>
      ${b.room ? `<span class="cb-room">📍 ${esc(b.room)}</span>` : ''}
      ${b.section ? `<span class="cb-sect">${esc(b.section)}</span>` : ''}
    `;

    el.querySelector('.cb-del').addEventListener('click', e => {
        e.stopPropagation();
        if(b.type === 'Make Up Class'){
            toast('Make-up class blocks can only be removed through the request flow.', 'error');
            return;
        }
        openRemoveConfirm(key);
    });

      el.addEventListener('click', e => {
        if (e.target.classList.contains('cb-del')) return;
        openModal(key, b.day, b.startSlot, b.endSlot);
      });

      anchor.appendChild(el);
    });

    updateStats();
    renderLegend();
  }

  function populateTimeSelects(startSlot, endSlot) {
    const startSel = document.getElementById('cmStartSlot');
    const endSel = document.getElementById('cmEndSlot');
    if (!startSel || !endSel) return;

    startSel.innerHTML = '';
    endSel.innerHTML = '';

    // Start: 7:00 AM to 7:30 PM
    for (let s = START_SLOT; s < END_SLOT - 1; s++) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = slotLabel(s);
      if (s === startSlot) opt.selected = true;
      startSel.appendChild(opt);
    }

    // End: 7:30 AM to 8:00 PM
    for (let s = START_SLOT + 1; s <= END_SLOT; s++) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = slotLabel(s);
      if (s === endSlot) opt.selected = true;
      endSel.appendChild(opt);
    }

    // When start changes, filter end options to be after start
    startSel.addEventListener('change', function () {
      const newStart = parseInt(this.value);
      Array.from(endSel.options).forEach(opt => {
        opt.disabled = parseInt(opt.value) <= newStart;
      });
      // Auto-advance end if it's now invalid
      if (parseInt(endSel.value) <= newStart) {
        endSel.value = newStart + 1;
      }
    });
  }

  let pendingRemoveKey = null;

  function openRemoveConfirm(key) {
    pendingRemoveKey = key;
    const b = blocks[key];
    document.getElementById('removeBlockMeta').textContent =
      `${b.subjectCode} · ${b.day} · ${rangeLabel(b.startSlot, b.endSlot)}`;
    hideMo('cellModal');
    showMo('removeBlockModal');
  }

  function confirmRemoveBlock() {
    if (!pendingRemoveKey) return;
    if (blocks[pendingRemoveKey]?.type === 'Make Up Class') {
      toast('Make-up class blocks can only be removed through the request flow.', 'error');
      hideMo('removeBlockModal');
      return;
    }
    delete blocks[pendingRemoveKey];
    pendingRemoveKey = null;
    hideMo('removeBlockModal');
    renderBlocks();
    autoSave();
    toast('Block removed', 'info');
  }

  /* ── Clear all ── */

  // A make-up class block is created by an approved request, so it is not the
  // instructor's to delete from here — same rule confirmRemoveBlock enforces.
  // WorkloadModel.pruneBlocks holds the server half of it.
  function clearableKeys() {
    return Object.keys(blocks).filter(k => blocks[k].type !== 'Make Up Class');
  }

  function openClearConfirm() {
    const removable = clearableKeys().length;
    if (!removable) { toast('There is nothing to clear.', 'info'); return; }

    const kept = Object.keys(blocks).length - removable;
    document.getElementById('clearMeta').textContent =
      `This removes ${removable} class block${removable === 1 ? '' : 's'}` +
      (kept ? `, and keeps ${kept} make-up class block${kept === 1 ? '' : 's'}.` : '.');
    showMo('clearModal');
  }

  function confirmClearAll() {
    clearableKeys().forEach(k => { delete blocks[k]; });
    hideMo('clearModal');
    renderBlocks();   // also repaints the legend
    autoSave();
    toast('Schedule cleared', 'info');
  }

  /* ── Modal ── */
  function openModal(key, day, startSlot, endSlot) {
    editingKey = key;
    const b = key ? blocks[key] : null;
    const isMakeUp = b && b.type === 'Make Up Class';

    document.getElementById('cmTitle').textContent = b ? (isMakeUp ? 'Make-Up Class (Read Only)' : 'Edit Class Block') : 'Add Class Block';
    document.getElementById('cmMetaText').textContent = `${day}  ·  ${rangeLabel(startSlot, endSlot)}`;
    document.getElementById('cmSubjectCode').value = b ? b.subjectCode : '';
    document.getElementById('cmSubjectName').value = b ? b.subjectName : '';
    document.getElementById('cmRoom').value = b ? (b.roomId || '') : '';
    document.getElementById('cmSection').value = b ? (b.section || '') : '';
    document.getElementById('cmType').value = b ? (b.type || 'Lecture') : 'Lecture';
    document.getElementById('cmRemove').style.display = (b && !isMakeUp) ? 'inline-flex' : 'none';    populateTimeSelects(startSlot, endSlot);

    ['cmSubjectCode', 'cmSubjectName', 'cmRoom', 'cmSection', 'cmType', 'cmStartSlot', 'cmEndSlot'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = isMakeUp;
    });

    const saveBtn = document.getElementById('cmSave');
    if (saveBtn) saveBtn.style.display = isMakeUp ? 'none' : '';

    const modal = document.getElementById('cellModal');
    modal.dataset.day = day;

    showMo('cellModal');
    if (!isMakeUp) setTimeout(() => document.getElementById('cmSubjectCode').focus(), 80);
  }

  function saveCell() {
    if (editingKey && blocks[editingKey] && blocks[editingKey].type === 'Make Up Class') return;

    const code = document.getElementById('cmSubjectCode').value.trim();
    const name = document.getElementById('cmSubjectName').value.trim();
    const section = document.getElementById('cmSection').value.trim();
    const startSlot = parseInt(document.getElementById('cmStartSlot').value);
    const endSlot = parseInt(document.getElementById('cmEndSlot').value);
    const day = document.getElementById('cellModal').dataset.day;
    const type = document.getElementById('cmType').value;

    if (!code) { toast('Subject code is required', 'error'); return; }
    if (!name) { toast('Subject name is required', 'error'); return; }
    if (!section) { toast('Section is required', 'error'); return; }
    if (endSlot <= startSlot) { toast('End time must be after start time', 'error'); return; }

    // Overlap check (exclude current editing key)
    for (let s = startSlot; s < endSlot; s++) {
      const conflict = Object.entries(blocks).find(([k, b]) =>
        k !== editingKey && b.day === day && b.startSlot <= s && s < b.endSlot
      );
      if (conflict) {
        toast(`Conflict at ${slotLabel(s)} on ${day}. Clear that block first.`, 'error');
        return;
      }
    }

    if (editingKey) delete blocks[editingKey];

    const roomSelect = document.getElementById('cmRoom');
    const roomId = roomSelect.value || null;
    const roomLabel = roomSelect.options[roomSelect.selectedIndex]?.text || '';

    const newKey = `${day}_${startSlot}`;
    blocks[newKey] = {
      day, startSlot, endSlot,
      subjectCode: code,
      subjectName: name,
      roomId,
      room: roomLabel,
      section, type
    };

    hideMo('cellModal');
    renderBlocks();
    autoSave();
    toast('Block saved', 'success');
  }

  function removeCell() {
    if (!editingKey) return;
    // Make Up Class blocks are server-authoritative and cannot be deleted from the editor
    if (blocks[editingKey] && blocks[editingKey].type === 'Make Up Class') {
      toast('Make-up class blocks can only be removed through the request flow.', 'error');
      return;
    }
    delete blocks[editingKey];
    hideMo('cellModal');
    renderBlocks();
    autoSave();
    toast('Block removed', 'info');
  }

  /* ── Legend ── */
  function renderLegend() {
    const tbody = document.getElementById('legendBody');
    if (!tbody) return;
    const all = Object.values(blocks);
    if (!all.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="padding:1.5rem;text-align:center;color:#94a3b8;font-size:.82rem">No subjects placed yet.</td></tr>';
      return;
    }
    const seen = {};
    all.forEach(b => { if (!seen[b.subjectCode]) seen[b.subjectCode] = b; });
    tbody.innerHTML = '';
    Object.values(seen).forEach(b => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #f1f5f9';
      tr.innerHTML = `
      <td style="padding:.6rem 1rem">
        <div style="display:inline-flex;align-items:center;gap:.5rem">
          <span style="width:14px;height:14px;border-radius:3px;background:${typeColor(b.type)};display:inline-block;flex-shrink:0"></span>
          <span style="font-size:.78rem;color:#475569">${esc(b.type)}</span>
        </div>
      </td>
      <td style="padding:.6rem 1rem;font-weight:700;font-size:.85rem;color:#0f172a">${esc(b.subjectCode)}</td>
      <td style="padding:.6rem 1rem;font-size:.82rem;color:#475569">${esc(b.subjectName)}</td>
    `;
      tbody.appendChild(tr);
    });
  }

  /* ── Stats ── */
  function updateStats() {
    const all = Object.values(blocks);
    // duration in half-hour units → convert to hours
    const totalHalfHours = all.reduce((s, b) => s + (b.endSlot - b.startSlot), 0);
    document.getElementById('statBlocks').textContent = all.length;
    document.getElementById('statHours').textContent = (totalHalfHours / 2).toFixed(1).replace('.0', '');
    document.getElementById('statSubjects').textContent = new Set(all.map(b => b.subjectCode)).size;
    document.getElementById('statRooms').textContent = new Set(all.map(b => b.room).filter(Boolean)).size;
  }

  /* ── Export ── */
  function openExportModal() {
    const y = new Date().getFullYear();
    document.getElementById('exportSchoolYear').value = `${y}-${y + 1}`;
    showMo('exportModal');
  }

  function exportWorkload() {
    const semester = document.getElementById('exportSemester').value.trim();
    const schoolYear = document.getElementById('exportSchoolYear').value.trim();
    const effectiveDate = document.getElementById('exportEffectiveDate').value.trim();

    if (!semester || !schoolYear) { toast('Semester and School Year are required', 'error'); return; }
    hideMo('exportModal');
    if (!window.ExportSystem) { toast('Export is unavailable right now', 'error'); return; }

    // The shared preview shows the workload form itself; Print prints it and
    // Save as PDF/DOCX/XLSX uses the same schedule as table rows.
    window.ExportSystem.openPreview(Object.assign(
      buildWorkloadPayload(semester, schoolYear, effectiveDate),
      { html: buildExportHTML(semester, schoolYear, effectiveDate) }
    ));
  }

  /** The schedule as rows for Save as PDF/DOCX/XLSX: the weekly grid, then a subject legend. */
  function buildWorkloadPayload(semester, schoolYear, effectiveDate) {
    const all = Object.values(blocks);
    const rows = [];

    SLOTS.filter(s => s % 2 === 0).forEach(slot => {
      const row = [slotLabel(slot)];
      DAYS.forEach(day => {
        const b = all.find(b => b.day === day && b.startSlot === slot);
        row.push(b ? b.subjectCode + ' - ' + b.subjectName + (b.room ? ' (' + b.room + ')' : '') : '');
      });
      rows.push(row);
    });

    rows.push([]);
    rows.push(['Subject Type', 'Subject Code', 'Subject Name', 'Room']);
    const seen = {};
    all.forEach(b => { if (!seen[b.subjectCode]) seen[b.subjectCode] = b; });
    Object.values(seen).forEach(b => rows.push([b.type, b.subjectCode, b.subjectName, b.room || '']));

    return {
      title: 'Class Plotting - ' + semester + ', SY ' + schoolYear,
      subtitle: 'Workload Schedule' + (effectiveDate ? ' - Effective: ' + effectiveDate : ''),
      columns: ['Time'].concat(DAYS),
      rows: rows,
      meta: ['Semester: ' + semester, 'School Year: ' + schoolYear],
    };
  }

  function buildExportHTML(semester, schoolYear, effectiveDate) {
    const instructorName = 'Dr. Maria Santos';
    // Export uses hourly rows only
    const exportSlots = SLOTS.filter(s => s % 2 === 0);
    let trows = '';
    exportSlots.forEach(slot => {
      trows += `<tr><td class="tc">${slotLabel(slot)}</td>`;
      DAYS.forEach(day => {
        // Find block starting at this slot or spanning through it
        const b = Object.values(blocks).find(b => b.day === day && b.startSlot === slot);
        const spanned = Object.values(blocks).find(b => b.day === day && b.startSlot < slot && b.endSlot > slot);
        if (spanned) return; // covered by rowspan
        if (b) {
          // rowspan = ceil(duration / 2) in hourly rows
          const rs = Math.ceil((b.endSlot - b.startSlot) / 2);
          trows += `<td rowspan="${rs}" class="dc" style="background:${typeColor(b.type)}">
          <div class="bi"><b>${esc(b.subjectCode)}</b>
          <span class="bi-time">${rangeLabel(b.startSlot, b.endSlot)}</span>
          <span class="bi-instr">${esc(instructorName)}</span>
          ${b.room ? `<span class="bi-room">${esc(b.room)}</span>` : ''}
          ${b.section ? `<span class="bi-sect">${esc(b.section)}</span>` : ''}
          </div></td>`;
        } else {
          trows += '<td class="dc"></td>';
        }
      });
      trows += '</tr>';
    });

    const seen = {};
    Object.values(blocks).forEach(b => { if (!seen[b.subjectCode]) seen[b.subjectCode] = b; });
    let lrows = Object.values(seen).map(b =>
      `<tr><td class="lc"><div class="lb" style="background:${typeColor(b.type)}">${esc(b.type)}</div></td>
     <td class="lcode">${esc(b.subjectCode)}</td><td class="lname">${esc(b.subjectName)}</td></tr>`
    ).join('') || '<tr><td colspan="3" class="lempty">No subjects</td></tr>';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@page{size:A4 landscape;margin:10mm 15mm}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial,sans-serif;font-size:7.5pt;color:#000;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.hdr{width:100%;border-collapse:collapse;margin-bottom:2pt}.hdr td{padding:0;vertical-align:top}
.logo-td{width:50pt;padding-right:8pt}.logo-td img{width:50pt;height:50pt;display:block}
.school-info{font-size:7.5pt;line-height:1.3}.school-name{font-size:11pt;font-weight:700}.college-name{font-size:18pt;font-weight:700;text-align:right;letter-spacing:1pt}
.code-ref{font-size:6.5pt;text-align:right;color:#666}
.separator{height:1.5pt;background:#000;margin:4pt 0}
.title-section{text-align:center;margin:8pt 0}
.title-main{font-size:22pt;font-weight:700;letter-spacing:.5pt}.title-sub{font-size:8.5pt;margin-top:2pt}
.schedule-table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:6pt}
.schedule-table thead tr{background:#000;color:#fff}
.schedule-table th{font-size:8pt;font-weight:700;text-align:center;padding:4pt 2pt;border:1pt solid #000;color:#fff}
.time-cell{width:50pt}.schedule-table td{border:1pt solid #000;padding:0;height:22pt;vertical-align:middle}
.time-col{font-size:7pt;text-align:center;padding:2pt;background:#f5f5f5;font-weight:600}
.class-cell{background:#fff;padding:1pt}
.class-content{text-align:center;padding:1pt 2pt;line-height:1.2}
.class-code{font-size:7pt;font-weight:700;color:#fff;display:block}
.class-time{font-size:6pt;color:rgba(255,255,255,.9);display:block}
.class-info{font-size:6pt;color:rgba(255,255,255,.85);display:block}
.legend-table{width:100%;border-collapse:collapse;margin-bottom:4pt}
.legend-table th{background:#f0f0f0;font-size:7.5pt;font-weight:700;padding:3pt;border:1pt solid #000;text-align:left}
.legend-table td{border:1pt solid #000;padding:2pt 3pt;font-size:7pt}
.legend-type{width:60pt;text-align:center;vertical-align:middle}
.legend-code{width:80pt;font-weight:700}
.legend-name{text-align:left}
.footer-section{margin-top:6pt;font-size:7.5pt}
.footer-row{display:flex;justify-content:space-between;padding-top:2pt}
.bottom-line{height:2pt;background:#000;margin-top:4pt}
</style></head><body>
<table class="hdr"><tr>
<td class="logo-td"><img src="/images/CSPC-logo.png" alt="CSPC"></td>
<td><div class="school-info">Republic of the Philippines</div><div class="school-name">CAMARINES SUR POLYTECHNIC COLLEGES</div><div class="school-info">Nabua, Camarines Sur</div></td>
<td style="text-align:right;vertical-align:top"><div class="college-name">COLLEGE of COMPUTER STUDIES</div><div class="code-ref">CSPC-F-COL-37<br/>File Code 1.7.3</div></td>
</tr></table>
<div class="separator"></div>
<div class="title-section"><div class="title-main">CLASS PLOTTING</div><div class="title-sub">${esc(semester)}, School Year ${esc(schoolYear)}</div></div>
<table class="schedule-table"><thead><tr><th class="time-cell">Time</th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${trows}</tbody></table>
<div style="font-weight:700;font-size:8pt;margin-bottom:3pt">Subject Color Legend</div>
<table class="legend-table"><thead><tr><th style="width:70pt">Type</th><th style="width:120pt">Subject Code</th><th>Subject Name</th></tr></thead><tbody>${lrows}</tbody></table>
<div class="footer-section"><div class="footer-row"><div>Effective Date: ${effectiveDate ? esc(effectiveDate) : 'N/A'}</div><div>Page 1 of 1</div></div></div>
<div class="bottom-line"></div>
</body></html>`;
  }

  /* ── Helpers ── */
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function showMo(id) { document.getElementById(id).classList.add('open'); }
  function hideMo(id) { document.getElementById(id).classList.remove('open'); }
  function toast(msg, type = 'info') {
    const wrap = document.getElementById('toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  /* ── Import from a workload form (.docx or .pdf) ── */

  let importData = null;

  /** The rooms the page already renders into the block editor's picker. */
  function roomOptions() {
    return Array.from(document.querySelectorAll('#cmRoom option'))
      .filter(o => o.value)
      .map(o => ({ id: o.value, label: o.textContent.trim(), type: o.dataset.roomtype || '' }));
  }

  // A physical room decides the class type — the server rejects a Laboratory
  // room saved as anything else. With no room, the caller's guess stands.
  function typeForRoomType(roomType, fallback) {
    if (roomType === 'Laboratory') return 'Laboratory';
    return roomType ? 'Lecture' : (fallback || 'Lecture');
  }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                       // so the same file can be picked twice
    if (!file) return;

    importData = null;
    document.getElementById('impResult').hidden = true;
    document.getElementById('impError').hidden = true;
    document.getElementById('impLoading').hidden = false;
    document.getElementById('impConfirm').disabled = true;
    document.getElementById('impMeta').textContent = file.name;
    showMo('importModal');

    try {
      const body = new FormData();
      body.append('workload', file);
      const res = await fetch('/instructor/workload/import', { method: 'POST', body });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not read that file.');
      renderImportPreview(json);
    } catch (err) {
      document.getElementById('impLoading').hidden = true;
      const box = document.getElementById('impError');
      box.textContent = err.message || 'Could not read that file.';
      box.hidden = false;
    }
  }

  function renderImportPreview(data) {
    importData = data;
    const rooms = roomOptions();

    document.getElementById('impLoading').hidden = true;
    document.getElementById('impResult').hidden = false;
    document.getElementById('impConfirm').disabled = false;
    document.getElementById('impConfirm').textContent = `Import ${data.blocks.length} class${data.blocks.length === 1 ? '' : 'es'}`;
    document.getElementById('impMeta').textContent = [data.fileName, data.semester].filter(Boolean).join(' · ');

    const hours = data.blocks.reduce((n, b) => n + (b.endSlot - b.startSlot), 0) / 2;
    document.getElementById('impSummary').textContent =
      `${data.blocks.length} classes · ${hours} teaching hours per week`;

    // Rooms the form names but the system does not recognise outright
    const needsMapping = data.rooms.filter(r => r.confidence !== 'exact');
    const roomsSection = document.getElementById('impRoomsSection');
    roomsSection.hidden = !needsMapping.length;
    document.getElementById('impRooms').innerHTML = needsMapping.map(r => `
      <div class="imp-maprow">
        <code title="${esc(r.label)}">${esc(r.roomName || r.label)}
          ${r.building ? `<em>${esc(r.building)}</em>` : ''}
        </code>
        <select data-room-label="${esc(r.label)}">
          <option value="">Leave without a room</option>
          ${rooms.map(o => `<option value="${o.id}"${String(o.id) === String(r.roomId) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        ${r.confidence === 'unknown-building'
          ? `<small class="imp-maphint">${esc(r.building)} is not a building in the system, so nothing was suggested.</small>`
          : ''}
      </div>`).join('');

    // Classes found
    document.getElementById('impBlockCount').textContent = `(${data.blocks.length})`;
    document.getElementById('impBlocks').innerHTML = data.blocks.map(b => `
      <div class="imp-row">
        <span class="imp-when">${esc(b.day.slice(0, 3))} · ${esc(rangeLabel(b.startSlot, b.endSlot))}</span>
        <span class="imp-what">${esc(b.subjectCode)}
          <small>${esc([b.section, b.roomLabel].filter(Boolean).join(' · ') || 'No section or room')}</small>
        </span>
        ${b.type === 'Laboratory' ? '<span class="imp-tag lab">Lab</span>' : ''}
        ${b.overload ? '<span class="imp-tag overload">Overload</span>' : ''}
      </div>`).join('');

    // Cells the form has that are not teaching load
    document.getElementById('impSkippedSection').hidden = !data.skipped.length;
    document.getElementById('impSkippedCount').textContent = `(${data.skipped.length})`;
    document.getElementById('impSkipped').innerHTML = data.skipped.map(s => `
      <div class="imp-row">
        <span class="imp-when">${esc(s.day.slice(0, 3))} · ${esc(rangeLabel(s.startSlot, s.endSlot))}</span>
        <span class="imp-what">${esc(s.label)}<small>${esc(s.reason)}</small></span>
      </div>`).join('');

    document.getElementById('impWarnSection').hidden = !data.warnings.length;
    document.getElementById('impWarnings').innerHTML =
      data.warnings.map(w => `<li>${esc(w)}</li>`).join('');

    const existing = Object.values(blocks).filter(b => b.type !== 'Make Up Class').length;
    document.getElementById('impReplaceHint').textContent = existing
      ? `Removes the ${existing} block${existing === 1 ? '' : 's'} already on my schedule`
      : 'My schedule is empty, so nothing is removed';
  }

  /** One imported row, resolved into the shape `blocks` stores. */
  function prepareImported(b, chosen, rooms) {
    const roomId = b.roomLabel in chosen ? chosen[b.roomLabel] : (b.roomId || null);
    const room = rooms.find(o => String(o.id) === String(roomId));
    const type = typeForRoomType(room && room.type, b.type);

    return {
      day: b.day,
      startSlot: b.startSlot,
      endSlot: b.endSlot,
      subjectCode: b.subjectCode,
      // The form carries codes only — the instructor fills in real names later.
      subjectName: b.subjectName || b.subjectCode,
      roomId: roomId || null,
      room: room ? room.label : b.roomLabel,
      section: b.section || '',
      type,
      color: typeColor(type),
    };
  }

  /**
   * Existing blocks an incoming one would sit on top of. Two blocks cannot share
   * hours on the same day, so one of them has to give way. Make-up classes are
   * never candidates: they belong to an approved request.
   */
  function overlappingKeys(b) {
    return Object.keys(blocks).filter(k => {
      const e = blocks[k];
      return e.day === b.day && e.type !== 'Make Up Class'
        && b.startSlot < e.endSlot && e.startSlot < b.endSlot;
    });
  }

  /**
   * Make-up classes an incoming block would land on. Excluding them from
   * overlappingKeys only stops them being deleted — writing blocks[day_slot]
   * would still overwrite one that happens to share the key. The import has to
   * give way instead, so these rows are skipped rather than offered as a choice.
   */
  function makeupCollisions(b) {
    return Object.keys(blocks).filter(k => {
      const e = blocks[k];
      return e.type === 'Make Up Class' && e.day === b.day
        && b.startSlot < e.endSlot && e.startSlot < b.endSlot;
    });
  }

  function applyImport() {
    if (!importData) return;

    const mode = document.querySelector('input[name="impMode"]:checked').value;
    const rooms = roomOptions();

    // Rooms the instructor mapped by hand override what the server matched.
    const chosen = {};
    document.querySelectorAll('#impRooms select').forEach(sel => {
      chosen[sel.dataset.roomLabel] = sel.value || null;
    });

    const prepared = importData.blocks.map(b => prepareImported(b, chosen, rooms));

    // Replace was already an explicit "clear my schedule first", so there is
    // nothing left to ask about. Make-up classes survive it, matching what the
    // server does when it prunes.
    if (mode === 'replace') {
      Object.keys(blocks).forEach(k => {
        if (blocks[k].type !== 'Make Up Class') delete blocks[k];
      });
      commitImport(prepared, prepared.map(() => 'incoming'));
      return;
    }

    // Merge promises to keep what is already there, so an overlap is a question
    // rather than something to resolve quietly in the importer's favour.
    const conflicts = prepared.map(overlappingKeys);
    if (!conflicts.some(keys => keys.length)) {
      commitImport(prepared, prepared.map(() => 'incoming'));
      return;
    }

    pendingMerge = {
      prepared,
      conflicts,
      // Conflicting rows default to keeping what the instructor already has;
      // everything else imports as normal.
      decisions: prepared.map((_, i) => (conflicts[i].length ? 'existing' : 'incoming')),
    };
    hideMo('importModal');
    renderMergeConflicts();
    showMo('mergeConflictModal');
  }

  /* ── Import: merge conflicts ── */

  // Held only while the conflict dialog is open.
  let pendingMerge = null;

  function renderMergeConflicts() {
    const { prepared, conflicts, decisions } = pendingMerge;
    const rows = [];

    prepared.forEach((b, i) => {
      if (!conflicts[i].length) return;

      const mine = conflicts[i].map(k => {
        const e = blocks[k];
        const where = e.room ? ` · ${esc(e.room)}` : '';
        return `${esc(e.subjectCode)} · ${esc(rangeLabel(e.startSlot, e.endSlot))}${where}`;
      }).join('<br>');

      const incoming = `${esc(b.subjectCode)} · ${esc(rangeLabel(b.startSlot, b.endSlot))}`
        + (b.section ? ` · ${esc(b.section)}` : '');

      rows.push(
        `<div class="mc-row" data-i="${i}">
           <p class="mc-when">${esc(b.day)} · ${esc(rangeLabel(b.startSlot, b.endSlot))}</p>
           <div class="mc-opts">
             <label class="imp-radio">
               <input type="radio" name="mc${i}" value="existing"${decisions[i] === 'existing' ? ' checked' : ''}>
               <span><strong>Keep mine</strong><small>${mine}</small></span>
             </label>
             <label class="imp-radio">
               <input type="radio" name="mc${i}" value="incoming"${decisions[i] === 'incoming' ? ' checked' : ''}>
               <span><strong>Use imported</strong><small>${incoming}</small></span>
             </label>
           </div>
         </div>`
      );
    });

    document.getElementById('mcMeta').textContent =
      `${rows.length} imported class${rows.length === 1 ? '' : 'es'} overlap${rows.length === 1 ? 's' : ''} your schedule.`;
    document.getElementById('mcList').innerHTML = rows.join('');
  }

  function setAllMergeDecisions(value) {
    if (!pendingMerge) return;
    pendingMerge.conflicts.forEach((keys, i) => {
      if (keys.length) pendingMerge.decisions[i] = value;
    });
    renderMergeConflicts();
  }

  /**
   * Write the prepared blocks in, honouring one decision per row.
   * Overlaps are recomputed here rather than reused from the dialog: an earlier
   * row in this same pass may already have changed what is on the grid.
   */
  function commitImport(prepared, decisions) {
    let added = 0, displaced = 0, kept = 0, blocked = 0;

    prepared.forEach((b, i) => {
      if (decisions[i] === 'existing') { kept++; return; }
      if (makeupCollisions(b).length) { blocked++; return; }
      overlappingKeys(b).forEach(k => { delete blocks[k]; displaced++; });
      blocks[`${b.day}_${b.startSlot}`] = b;
      added++;
    });

    pendingMerge = null;
    hideMo('mergeConflictModal');
    hideMo('importModal');
    renderBlocks();
    autoSave();

    const parts = [`Imported ${added} class${added === 1 ? '' : 'es'}`];
    if (displaced) parts.push(`${displaced} block${displaced === 1 ? '' : 's'} replaced`);
    if (kept) parts.push(`${kept} of yours kept`);
    if (blocked) parts.push(`${blocked} skipped over a make-up class`);
    toast(parts.join(' · '), blocked ? 'info' : 'success');
  }

  /* ── Wire ── */
  function wire() {
    document.getElementById('cmSave').addEventListener('click', saveCell);
    document.getElementById('cmCancel').addEventListener('click', () => {
      // Re-enable inputs in case a make-up class modal was open
      ['cmSubjectCode', 'cmSubjectName', 'cmRoom', 'cmSection', 'cmType'].forEach(id => {
        const el = document.getElementById(id); if (el) el.disabled = false;
      });
      const saveBtn = document.getElementById('cmSave'); if (saveBtn) saveBtn.style.display = '';
      hideMo('cellModal');
    });
    document.getElementById('cmClose').addEventListener('click', () => {
      ['cmSubjectCode', 'cmSubjectName', 'cmRoom', 'cmSection', 'cmType'].forEach(id => {
        const el = document.getElementById(id); if (el) el.disabled = false;
      });
      const saveBtn = document.getElementById('cmSave'); if (saveBtn) saveBtn.style.display = '';
      hideMo('cellModal');
    });
    document.getElementById('btnExportWorkload').addEventListener('click', (e) => {
      const dropdown = document.getElementById('exportWorkloadDropdown');
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });
    document.querySelectorAll('.dropdown-item-wl').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.getElementById('exportWorkloadDropdown').style.display = 'none';
        openExportModal();
      });
    });
    // Close export dropdown on outside click
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('exportWorkloadDropdown');
      const btn = document.getElementById('btnExportWorkload');
      if (btn && dropdown && !btn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
    document.getElementById('cmRoom').addEventListener('change', function () {
      const roomType = this.options[this.selectedIndex]?.dataset.roomtype || '';
      document.getElementById('cmType').value = typeForRoomType(roomType, 'Lecture');
    });

    // Import from a workload form
    document.getElementById('btnImportWorkload').addEventListener('click', () => {
      document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', onImportFile);
    document.getElementById('impConfirm').addEventListener('click', applyImport);
    ['impCancel', 'impClose'].forEach(id => {
      document.getElementById(id).addEventListener('click', () => hideMo('importModal'));
    });
    document.getElementById('exportClose').addEventListener('click', () => hideMo('exportModal'));
    document.getElementById('exportCancel').addEventListener('click', () => hideMo('exportModal'));
    document.getElementById('exportConfirm').addEventListener('click', exportWorkload);
    ['cellModal', 'clearModal', 'exportModal'].forEach(id => {
      document.getElementById(id).addEventListener('click', function (e) {
        if (e.target === this) {
          if (id === 'cellModal') {
            ['cmSubjectCode', 'cmSubjectName', 'cmRoom', 'cmSection', 'cmType'].forEach(fid => {
              const el = document.getElementById(fid); if (el) el.disabled = false;
            });
            const saveBtn = document.getElementById('cmSave'); if (saveBtn) saveBtn.style.display = '';
          }
          hideMo(id);
        }
      });
    });
    document.getElementById('cmRemove').addEventListener('click', () => {
      if(editingKey) {
        hideMo('cellModal');          // close edit modal first
        openRemoveConfirm(editingKey); // then open confirm
      }
    });
    document.getElementById('removeBlockCancel').addEventListener('click', () => hideMo('removeBlockModal'));
    document.getElementById('removeBlockConfirm').addEventListener('click', confirmRemoveBlock);

    // Merge conflicts
    document.getElementById('mcList').addEventListener('change', function (e) {
      const input = e.target.closest('input[type="radio"]');
      const row = input && input.closest('.mc-row');
      if (row && pendingMerge) pendingMerge.decisions[Number(row.dataset.i)] = input.value;
    });
    document.getElementById('mcKeepAll').addEventListener('click', () => setAllMergeDecisions('existing'));
    document.getElementById('mcTakeAll').addEventListener('click', () => setAllMergeDecisions('incoming'));
    document.getElementById('mcConfirm').addEventListener('click', () => {
      if (pendingMerge) commitImport(pendingMerge.prepared, pendingMerge.decisions);
    });
    // Back returns to the preview with the import still loaded; close abandons it.
    document.getElementById('mcCancel').addEventListener('click', () => {
      pendingMerge = null;
      hideMo('mergeConflictModal');
      showMo('importModal');
    });
    document.getElementById('mcClose').addEventListener('click', () => {
      pendingMerge = null;
      hideMo('mergeConflictModal');
    });

    document.getElementById('btnClearWorkload').addEventListener('click', openClearConfirm);
    document.getElementById('clearCancel').addEventListener('click', () => hideMo('clearModal'));
    document.getElementById('clearConfirm').addEventListener('click', confirmClearAll);

    ['cellModal', 'clearModal', 'exportModal', 'removeBlockModal', 'importModal', 'mergeConflictModal'].forEach(id => {
      document.getElementById(id)?.addEventListener('click', function (e) {
        if (e.target === this) hideMo(id);
      });
    });
  }

  async function init() {
    localStorage.removeItem('facitrack_workload_v5');

    blocks = {}; // start fresh from server data only
    try {
      const j = window.__WORKLOAD_DATA__ || { subjects: [], blocks: {} };
      const subjectMap = {};
      (j.subjects || []).forEach(s => {
        if (s && s.code) subjectMap[s.code] = s.name || s.code;
      });


      if (j.blocks && typeof j.blocks === 'object') {
        Object.entries(j.blocks).forEach(([key, sb]) => {
          const under = key.indexOf('_');
          if (under < 0) return;
          const day = key.slice(0, under);
          const startSlot = parseInt(key.slice(under + 1));
          const endSlot = startSlot + (sb.duration || 1);
          blocks[key] = {
            day, startSlot, endSlot,
            subjectCode: sb.subjectId || '',
            subjectName: subjectMap[sb.subjectId] || sb.subjectName || '',
            roomId: sb.roomId,
            room: sb.room || '',
            section: sb.section || '',
            type: sb.type || 'Lecture',
            color: sb.color || typeColor(sb.type),
          };
        });
      }
    } catch (e) {
      console.warn('[init] Failed to parse workload data', e);
    }
    buildGrid();
    wire();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

})();

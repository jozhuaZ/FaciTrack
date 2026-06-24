(function(){
'use strict';

/* ── Constants ── */
const DAYS        = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_CLASSES = ['mon','tue','wed','thu','fri','sat','sun'];

// 7:00 AM → 8:00 PM in 30-min slots
// Each slot is a number of half-hours from midnight: 7:00 AM = 14, 7:30 AM = 15 … 8:00 PM = 40
const START_SLOT = 14;  // 7:00 AM  (7*2)
const END_SLOT   = 40;  // 8:00 PM  (20*2)  — last draggable end

// All slot indices
const SLOTS = [];
for (let s = START_SLOT; s < END_SLOT; s++) SLOTS.push(s);

const SLOT_H = 28; // px per 30-min row — no border between :00 and :30

const TYPE_COLORS = {
  'Lecture':        '#f97316',
  'Laboratory':     '#eab308',
  'Online':         '#0ea5e9',
  'Make Up Class':  '#10b981'
};
function typeColor(t){ return TYPE_COLORS[t] || '#3b82f6'; }

// slot index → "7:00 AM", "7:30 AM", "12:00 PM" …
function slotLabel(s){
  const totalMins = s * 30;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2,'0')} ${period}`;
}

// range label e.g. "8:00 AM – 9:30 AM"
function rangeLabel(startSlot, endSlot){
  return slotLabel(startSlot) + ' – ' + slotLabel(endSlot);
}

const LS_KEY = 'facitrack_workload_v5';

/* ── State ── */
// key: `${day}_${startSlot}`
// value: { day, startSlot, endSlot, subjectCode, subjectName, room, section, type }
let blocks     = {};
let editingKey = null;

// Drag state (slot indices)
let dragDay    = null;
let dragStart  = null;
let dragEnd    = null;
let isDragging = false;
// Touch scroll-vs-drag detection
let touchStartX = 0;
let touchStartY = 0;
let touchMoved  = false;
let pendingCell = null;

/* ── Persistence ── */
function lsSave(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(blocks)); }catch(e){}
}
function lsLoad(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){ const d = JSON.parse(raw); if(d && typeof d==='object') blocks = d; }
  }catch(e){}
}

/* ── Auto-save ── */
let saveTimer = null;
function autoSave(){
  setStatus('saving'); lsSave();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async ()=>{
    try{
      const subjects = [];
      const serverBlocks = {};
      Object.values(blocks).forEach(b => {
        // Make Up Class blocks are server-authoritative — don't send them back in saves.
        // They are written by the dean approval route and preserved by the save route.
        if(b.type === 'Make Up Class') return;
        if(!subjects.find(s => s.code === b.subjectCode)){
          subjects.push({ id: b.subjectCode, code: b.subjectCode, name: b.subjectName, color: typeColor(b.type), units: 0 });
        }
        serverBlocks[`${b.day}_${b.startSlot}`] = {
          subjectId: b.subjectCode, room: b.room, section: b.section,
          type: b.type, duration: b.endSlot - b.startSlot, color: typeColor(b.type)
        };
      });
      const r = await fetch('/instructor/workload/save',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ subjects, blocks: serverBlocks })
      });
      const j = await r.json();
      if(!j.success) throw new Error('fail');
      setStatus('saved');
    }catch(e){ setStatus('local'); }
  }, 800);
}

function setStatus(s){
  const text = document.getElementById('autoSaveText');
  const wrap = document.getElementById('autoSaveStatus');
  if(!text||!wrap) return;
  if(s==='saving'){ wrap.style.color='#f59e0b'; text.textContent='Saving...'; }
  else if(s==='saved'){ wrap.style.color='#16a34a'; text.textContent='All changes saved'; setTimeout(()=>{ wrap.style.color='#94a3b8'; },3000); }
  else { wrap.style.color='#94a3b8'; text.textContent='Saved locally'; }
}

/* ── Build grid ── */
function buildGrid(){
  const grid = document.getElementById('calGrid');
  if(!grid) return;
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
      cell.dataset.day  = day;
      cell.dataset.slot = slot;
      grid.appendChild(cell);
    });
  });

  attachDragListeners();
  renderBlocks();
}

/* ── Drag-to-create ── */
function attachDragListeners(){
  const grid = document.getElementById('calGrid');
  if(!grid) return;
  grid.addEventListener('mousedown',  onDragStart);
  grid.addEventListener('mousemove',  onDragMove);
  grid.addEventListener('mouseup',    onDragEnd);
  grid.addEventListener('mouseleave', onDragCancel);
  grid.addEventListener('touchstart', onTouchStart, { passive: false });
  grid.addEventListener('touchmove',  onTouchMove,  { passive: false });
  grid.addEventListener('touchend',   onTouchEnd);
}

function cellAt(x, y){
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.cal-cell') : null;
}

function onDragStart(e){
  if(e.button !== 0) return;
  const cell = e.target.closest('.cal-cell');
  if(!cell) return;
  isDragging = true;
  dragDay    = cell.dataset.day;
  dragStart  = parseInt(cell.dataset.slot);
  dragEnd    = dragStart;
  showGhost();
  e.preventDefault();
}

function onDragMove(e){
  if(!isDragging) return;
  const cell = cellAt(e.clientX, e.clientY);
  if(cell && cell.dataset.day === dragDay){
    const s = parseInt(cell.dataset.slot);
    if(s !== dragEnd){ dragEnd = s; showGhost(); }
  }
}

function onDragEnd(e){
  if(!isDragging) return;
  isDragging = false;
  const startSlot = Math.min(dragStart, dragEnd);
  const endSlot   = Math.max(dragStart, dragEnd) + 1; // +1 = at least 30 min
  clearGhost();
  if(endSlot > startSlot) openModal(null, dragDay, startSlot, endSlot);
  dragDay = dragStart = dragEnd = null;
}

function onDragCancel(){
  if(isDragging){ isDragging = false; clearGhost(); dragDay = dragStart = dragEnd = null; }
}

function onTouchStart(e){
  const t = e.touches[0];
  const cell = cellAt(t.clientX, t.clientY);
  if(!cell) return;
  // Record start position to distinguish scroll vs drag
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchMoved  = false;
  isDragging  = false;
  pendingCell = cell;
  // Don't preventDefault yet — wait to see if it's a vertical drag
}
function onTouchMove(e){
  const t = e.touches[0];
  const dx = Math.abs(t.clientX - touchStartX);
  const dy = Math.abs(t.clientY - touchStartY);

  // If horizontal movement dominates → it's a scroll, cancel any drag
  if(!touchMoved && dx > dy && dx > 6){
    isDragging  = false;
    pendingCell = null;
    return; // let native scroll handle it
  }

  // Vertical drag → start drag-to-create
  if(!touchMoved && dy > 6 && pendingCell){
    touchMoved = true;
    isDragging = true;
    dragDay    = pendingCell.dataset.day;
    dragStart  = parseInt(pendingCell.dataset.slot);
    dragEnd    = dragStart;
    showGhost();
    e.preventDefault(); // only block scroll once we're sure it's a drag
  }

  if(!isDragging) return;
  const cell = cellAt(t.clientX, t.clientY);
  if(cell && cell.dataset.day === dragDay){
    const s = parseInt(cell.dataset.slot);
    if(s !== dragEnd){ dragEnd = s; showGhost(); }
  }
  e.preventDefault();
}
function onTouchEnd(){
  pendingCell = null;
  touchMoved  = false;
  onDragEnd({});
}

function durationLabel(halfHours){
  const hrs  = Math.floor(halfHours / 2);
  const mins = (halfHours % 2) * 30;
  if(hrs === 0)  return `${mins} min`;
  if(mins === 0) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
  return `${hrs} hr${hrs > 1 ? 's' : ''} 30 min`;
}

/* ── Ghost preview ── */
let ghostEl = null;
function showGhost(){
  clearGhost();
  if(!isDragging) return;
  const startSlot = Math.min(dragStart, dragEnd);
  const endSlot   = Math.max(dragStart, dragEnd) + 1;
  const anchor = document.querySelector(`.cal-cell[data-day="${dragDay}"][data-slot="${startSlot}"]`);
  if(!anchor) return;
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
function clearGhost(){
  if(ghostEl){ ghostEl.remove(); ghostEl = null; }
}

/* ── Render blocks ── */
function renderBlocks(){
  document.querySelectorAll('.cal-block').forEach(el => el.remove());

  Object.entries(blocks).forEach(([key, b]) => {
    const anchor = document.querySelector(`.cal-cell[data-day="${b.day}"][data-slot="${b.startSlot}"]`);
    if(!anchor) return;

    const duration = b.endSlot - b.startSlot; // half-hour units
    const el = document.createElement('div');
    el.className = 'cal-block';
    el.dataset.key = key;
    el.style.cssText = `background:${typeColor(b.type)};top:1px;height:${duration * SLOT_H - 4}px`;

    el.innerHTML = `
      <button class="cb-del" title="Remove">✕</button>
      <span class="cb-code">${esc(b.subjectCode)}</span>
      <span class="cb-time">${rangeLabel(b.startSlot, b.endSlot)}</span>
      ${b.room    ? `<span class="cb-room">📍 ${esc(b.room)}</span>` : ''}
      ${b.section ? `<span class="cb-sect">${esc(b.section)}</span>` : ''}
    `;

    el.querySelector('.cb-del').addEventListener('click', e => {
      e.stopPropagation();
      if(b.type === 'Make Up Class'){
        toast('Make-up class blocks can only be removed through the request flow.','error');
        return;
      }
      delete blocks[key];
      el.remove();
      lsSave(); autoSave(); updateStats(); renderLegend();
      toast('Block removed','info');
    });

    el.addEventListener('click', e => {
      if(e.target.classList.contains('cb-del')) return;
      openModal(key, b.day, b.startSlot, b.endSlot);
    });

    anchor.appendChild(el);
  });

  updateStats();
  renderLegend();
}

/* ── Modal ── */
function openModal(key, day, startSlot, endSlot){
  editingKey = key;
  const b = key ? blocks[key] : null;

  // Make Up Class blocks are read-only — show info only, no editing
  const isMakeUp = b && b.type === 'Make Up Class';

  document.getElementById('cmTitle').textContent    = b ? (isMakeUp ? 'Make-Up Class (Read Only)' : 'Edit Class Block') : 'Add Class Block';
  document.getElementById('cmMetaText').textContent = `${day}  ·  ${rangeLabel(startSlot, endSlot)}`;
  document.getElementById('cmSubjectCode').value    = b ? b.subjectCode : '';
  document.getElementById('cmSubjectName').value    = b ? b.subjectName : '';
  document.getElementById('cmRoom').value           = b ? (b.room    || '') : '';
  document.getElementById('cmSection').value        = b ? (b.section || '') : '';
  document.getElementById('cmType').value           = b ? (b.type    || 'Lecture') : 'Lecture';
  document.getElementById('cmRemove').style.display = (b && !isMakeUp) ? 'inline-flex' : 'none';

  // Disable all inputs for make-up class blocks
  ['cmSubjectCode','cmSubjectName','cmRoom','cmSection','cmType'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.disabled = isMakeUp;
  });  const saveBtn = document.getElementById('cmSave');
  if(saveBtn) saveBtn.style.display = isMakeUp ? 'none' : '';

  const modal = document.getElementById('cellModal');
  modal.dataset.day       = day;
  modal.dataset.startSlot = startSlot;
  modal.dataset.endSlot   = endSlot;

  showMo('cellModal');
  if(!isMakeUp) setTimeout(() => document.getElementById('cmSubjectCode').focus(), 80);
}

function saveCell(){
  // Don't allow saving if editing a make-up class block
  if(editingKey && blocks[editingKey] && blocks[editingKey].type === 'Make Up Class') return;

  const code    = document.getElementById('cmSubjectCode').value.trim();
  const name    = document.getElementById('cmSubjectName').value.trim();
  const section = document.getElementById('cmSection').value.trim();
  if(!code)   { toast('Subject code is required','error'); return; }
  if(!name)   { toast('Subject name is required','error'); return; }
  if(!section){ toast('Section is required','error'); return; }

  const modal     = document.getElementById('cellModal');
  const day       = modal.dataset.day;
  const startSlot = parseInt(modal.dataset.startSlot);
  const endSlot   = parseInt(modal.dataset.endSlot);
  const type      = document.getElementById('cmType').value;

  // Conflict check
  for(let s = startSlot; s < endSlot; s++){
    const conflict = Object.entries(blocks).find(([k, b]) =>
      k !== editingKey && b.day === day && b.startSlot <= s && s < b.endSlot
    );
    if(conflict){
      toast(`Conflict at ${slotLabel(s)} on ${day}. Clear that block first.`, 'error');
      return;
    }
  }

  if(editingKey) delete blocks[editingKey];

  const newKey = `${day}_${startSlot}`;
  blocks[newKey] = {
    day, startSlot, endSlot,
    subjectCode: code, subjectName: name,
    room: document.getElementById('cmRoom').value.trim(),
    section, type
  };

  hideMo('cellModal');
  renderBlocks();
  lsSave(); autoSave();
  toast('Block saved','success');
}

function removeCell(){
  if(!editingKey) return;
  // Make Up Class blocks are server-authoritative and cannot be deleted from the editor
  if(blocks[editingKey] && blocks[editingKey].type === 'Make Up Class'){
    toast('Make-up class blocks can only be removed through the request flow.','error');
    return;
  }
  delete blocks[editingKey];
  hideMo('cellModal');
  renderBlocks();
  lsSave(); autoSave();
  toast('Block removed','info');
}

/* ── Legend ── */
function renderLegend(){
  const tbody = document.getElementById('legendBody');
  if(!tbody) return;
  const all = Object.values(blocks);
  if(!all.length){
    tbody.innerHTML = '<tr><td colspan="3" style="padding:1.5rem;text-align:center;color:#94a3b8;font-size:.82rem">No subjects placed yet.</td></tr>';
    return;
  }
  const seen = {};
  all.forEach(b => { if(!seen[b.subjectCode]) seen[b.subjectCode] = b; });
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
function updateStats(){
  const all = Object.values(blocks);
  // duration in half-hour units → convert to hours
  const totalHalfHours = all.reduce((s,b) => s + (b.endSlot - b.startSlot), 0);
  document.getElementById('statBlocks').textContent   = all.length;
  document.getElementById('statHours').textContent    = (totalHalfHours / 2).toFixed(1).replace('.0','');
  document.getElementById('statSubjects').textContent = new Set(all.map(b => b.subjectCode)).size;
  document.getElementById('statRooms').textContent    = new Set(all.map(b => b.room).filter(Boolean)).size;
}

/* ── Export ── */
function openExportModal(){
  const y = new Date().getFullYear();
  document.getElementById('exportSchoolYear').value = `${y}-${y+1}`;
  showMo('exportModal');
}

async function exportWorkload(){
  const semester      = document.getElementById('exportSemester').value.trim();
  const schoolYear    = document.getElementById('exportSchoolYear').value.trim();
  const effectiveDate = document.getElementById('exportEffectiveDate').value.trim();
  
  if(!semester || !schoolYear){ toast('Semester and School Year are required','error'); return; }
  hideMo('exportModal');
  
  // Go directly to print without showing destination/format dialog
  toast('Preparing document for printing…','info');
  const html = buildExportHTML(semester, schoolYear, effectiveDate);
  const win = window.open('','_blank','width=1200,height=900');
  win.document.open(); 
  win.document.write(html); 
  win.document.close();
  setTimeout(() => {
    win.focus();
    win.print();
    win.close();
  }, 800);
}

async function exportWorkloadFormat(format, semester, schoolYear, effectiveDate){
  try {
    const all = Object.values(blocks);
    const rows = [];
    
    // Build schedule table data
    const exportSlots = SLOTS.filter(s => s % 2 === 0);
    rows.push(['Time'].concat(DAYS));
    
    exportSlots.forEach(slot => {
      const row = [slotLabel(slot)];
      DAYS.forEach(day => {
        const b = Object.values(blocks).find(b => b.day === day && b.startSlot === slot);
        if(b){
          row.push(b.subjectCode + ' - ' + b.subjectName + (b.room ? ' (' + b.room + ')' : ''));
        } else {
          row.push('');
        }
      });
      rows.push(row);
    });
    
    // Subject legend
    rows.push([]);
    rows.push(['Subject Type', 'Subject Code', 'Subject Name', 'Room']);
    const seen = {};
    all.forEach(b => { if(!seen[b.subjectCode]) seen[b.subjectCode] = b; });
    Object.values(seen).forEach(b => {
      rows.push([b.type, b.subjectCode, b.subjectName, b.room || '']);
    });
    
    const columns = ['Time'].concat(DAYS);
    const payload = {
      title: 'Class Plotting - ' + semester + ', SY ' + schoolYear,
      subtitle: 'Workload Schedule Export' + (effectiveDate ? ' - Effective: ' + effectiveDate : ''),
      columns: columns,
      rows: rows,
      meta: ['Semester: ' + semester, 'School Year: ' + schoolYear]
    };
    
    const res = await fetch('/export/' + format, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if(!res.ok){
      const txt = await res.text();
      throw new Error(txt || 'Export failed');
    }
    
    const dispo = res.headers.get('content-disposition') || '';
    const match = dispo.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'workload_schedule.' + format;
    
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
    
    toast('Workload exported successfully', 'success');
  } catch(e){
    toast('Export failed: ' + e.message, 'error');
  }
}

function showExportPreview(html, format){
  const win = window.open('','_blank','width=1200,height=900');
  win.document.open(); 
  win.document.write(html); 
  win.document.close();
  
  setTimeout(() => {
    win.focus();
    if(format === 'PDF'){
      toast('Use "Save as PDF" or "Print" in the print dialog','info');
    } else if(format === 'DOCX'){
      toast('Use "Print to file" or copy to Word','info');
    }
    win.print();
  }, 800);
}

function buildExportHTML(semester, schoolYear, effectiveDate){
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
      if(spanned) return; // covered by rowspan
      if(b){
        // rowspan = ceil(duration / 2) in hourly rows
        const rs = Math.ceil((b.endSlot - b.startSlot) / 2);
        trows += `<td rowspan="${rs}" class="dc" style="background:${typeColor(b.type)}">
          <div class="bi"><b>${esc(b.subjectCode)}</b>
          <span class="bi-time">${rangeLabel(b.startSlot, b.endSlot)}</span>
          <span class="bi-instr">${esc(instructorName)}</span>
          ${b.room    ? `<span class="bi-room">${esc(b.room)}</span>` : ''}
          ${b.section ? `<span class="bi-sect">${esc(b.section)}</span>` : ''}
          </div></td>`;
      } else {
        trows += '<td class="dc"></td>';
      }
    });
    trows += '</tr>';
  });

  const seen = {};
  Object.values(blocks).forEach(b => { if(!seen[b.subjectCode]) seen[b.subjectCode] = b; });
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
<table class="schedule-table"><thead><tr><th class="time-cell">Time</th>${DAYS.map(d=>`<th>${d}</th>`).join('')}</tr></thead><tbody>${trows}</tbody></table>
<div style="font-weight:700;font-size:8pt;margin-bottom:3pt">Subject Color Legend</div>
<table class="legend-table"><thead><tr><th style="width:70pt">Type</th><th style="width:120pt">Subject Code</th><th>Subject Name</th></tr></thead><tbody>${lrows}</tbody></table>
<div class="footer-section"><div class="footer-row"><div>Effective Date: ${effectiveDate ? esc(effectiveDate) : 'N/A'}</div><div>Page 1 of 1</div></div></div>
<div class="bottom-line"></div>
</body></html>`;
}

/* ── Helpers ── */
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showMo(id){ document.getElementById(id).classList.add('open'); }
function hideMo(id){ document.getElementById(id).classList.remove('open'); }
function toast(msg, type='info'){
  const wrap = document.getElementById('toastWrap');
  if(!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ── Wire ── */
function wire(){
  document.getElementById('cmSave').addEventListener('click', saveCell);
  document.getElementById('cmRemove').addEventListener('click', removeCell);
  document.getElementById('cmCancel').addEventListener('click', () => {
    // Re-enable inputs in case a make-up class modal was open
    ['cmSubjectCode','cmSubjectName','cmRoom','cmSection','cmType'].forEach(id => {
      const el = document.getElementById(id); if(el) el.disabled = false;
    });
    const saveBtn = document.getElementById('cmSave'); if(saveBtn) saveBtn.style.display = '';
    hideMo('cellModal');
  });
  document.getElementById('cmClose').addEventListener('click', () => {
    ['cmSubjectCode','cmSubjectName','cmRoom','cmSection','cmType'].forEach(id => {
      const el = document.getElementById(id); if(el) el.disabled = false;
    });
    const saveBtn = document.getElementById('cmSave'); if(saveBtn) saveBtn.style.display = '';
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
      document.getElementById('exportFormat').value = 'print';
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
  document.getElementById('exportClose').addEventListener('click',   () => hideMo('exportModal'));
  document.getElementById('exportCancel').addEventListener('click',  () => hideMo('exportModal'));
  document.getElementById('exportConfirm').addEventListener('click', exportWorkload);
  ['cellModal','clearModal','exportModal'].forEach(id => {
    document.getElementById(id).addEventListener('click', function(e){
      if(e.target===this){
        if(id === 'cellModal'){
          ['cmSubjectCode','cmSubjectName','cmRoom','cmSection','cmType'].forEach(fid => {
            const el = document.getElementById(fid); if(el) el.disabled = false;
          });
          const saveBtn = document.getElementById('cmSave'); if(saveBtn) saveBtn.style.display = '';
        }
        hideMo(id);
      }
    });
  });
}

/* ── Init ── */
// async function init(){
//   lsLoad();
//   try{
//     const r = await fetch('/instructor/workload/load');
//     const j = await r.json();
//     const subjectMap = {};
//     (j.subjects || []).forEach(s => {
//       if(s && s.code) subjectMap[s.code] = s.name || s.code;
//     });
//     // Merge server-side blocks into local blocks so approved make-up classes appear.
//     // Server blocks are stored in the compact format { subjectId, room, section, type, duration, color }.
//     // Convert them to the full client format before merging.
//     if(j && j.blocks && typeof j.blocks === 'object'){
//       Object.entries(j.blocks).forEach(([key, sb]) => {
//         // Parse key: "${day}_${startSlot}"
//         const under = key.indexOf('_');
//         if(under < 0) return;
//         const day       = key.slice(0, under);
//         const startSlot = parseInt(key.slice(under + 1));
//         const endSlot   = startSlot + (sb.duration || 1);
//         // Only merge if not already present locally (server is authoritative for make-up classes)
//         if(!blocks[key] || sb.type === 'Make Up Class'){
//           const subjectCode = sb.subjectId || '';
//           blocks[key] = {
//             day, startSlot, endSlot,
//             subjectCode: subjectCode,
//             subjectName: subjectMap[subjectCode] || sb.subjectName || subjectCode,
//             room:        sb.room    || '',
//             section:     sb.section || '',
//             type:        sb.type    || 'Lecture',
//             color:       sb.color   || typeColor(sb.type)
//           };
//         }
//       });
//       lsSave();
//     }
//   }catch(e){}
//   buildGrid();
//   wire();
// }
async function init(){
  lsLoad();
  try {
    const j = window.__WORKLOAD_DATA__ || { subjects: [], blocks: {} };
    const subjectMap = {};
    (j.subjects || []).forEach(s => {
      if (s && s.code) subjectMap[s.code] = s.name || s.code;
    });
    if (j.blocks && typeof j.blocks === 'object') {
      Object.entries(j.blocks).forEach(([key, sb]) => {
        const under     = key.indexOf('_');
        if (under < 0) return;
        const day       = key.slice(0, under);
        const startSlot = parseInt(key.slice(under + 1));
        const endSlot   = startSlot + (sb.duration || 1);
        if (!blocks[key] || sb.type === 'Make Up Class') {
          blocks[key] = {
            day, startSlot, endSlot,
            subjectCode: sb.subjectId || '',
            subjectName: subjectMap[sb.subjectId] || sb.subjectName || '',
            room:        sb.room    || '',
            section:     sb.section || '',
            type:        sb.type    || 'Lecture',
            color:       sb.color   || typeColor(sb.type),
          };
        }
      });
      lsSave();
    }
  } catch(e) {
    console.warn('[init] Failed to parse workload data', e);
  }
  buildGrid();
  wire();
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded', init);
} else { init(); }

})();

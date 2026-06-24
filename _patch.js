const fs = require('fs');

// ── Write workload.ejs ──
const workload = fs.readFileSync('views/pages/instructor/workload.ejs', 'utf8');

// Find the <script> tag start and replace everything from there to end
const scriptStart = workload.indexOf('\n<script>');
const beforeScript = workload.substring(0, scriptStart);

const newScript = `
<script>
// ── Constants ──
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const TIME_SLOTS = [
    '07:00-08:00','08:00-09:00','09:00-10:00','10:00-11:00',
    '11:00-12:00','12:00-01:00','01:00-02:00','02:00-03:00',
    '03:00-04:00','04:00-05:00','05:00-06:00','06:00-07:00'
];
const LUNCH = '12:00-01:00';
const COLORS = ['#e07b39','#7b6fc4','#e05c5c','#4a90d9','#4caf7d','#d4a017','#5b8dd9','#c45c8a'];

let subjects = [];
let blocks = {};
let dirty = false;

// ── Load from server ──
async function loadFromServer() {
    try {
        const res = await fetch('/instructor/workload/load');
        const data = await res.json();
        subjects = data.subjects || [];
        blocks   = data.blocks   || {};
    } catch(e) {
        subjects = [];
        blocks   = {};
    }
}

// ── Save to server ──
async function saveToServer() {
    const btn = document.getElementById('btnSave');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
        const res = await fetch('/instructor/workload/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subjects, blocks })
        });
        const data = await res.json();
        if (data.success) {
            dirty = false;
            updateDirtyIndicator();
            showToast('success', 'Saved', 'Timetable saved successfully.');
        } else {
            showToast('error', 'Error', data.error || 'Failed to save.');
        }
    } catch(e) {
        showToast('error', 'Error', 'Could not reach server.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = \`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save\`;
    }
}

function markDirty() { dirty = true; updateDirtyIndicator(); }
function updateDirtyIndicator() {
    const sub = document.querySelector('.page-subtitle');
    if (sub) sub.textContent = dirty
        ? 'Weekly class schedule timetable — unsaved changes'
        : 'Weekly class schedule timetable — click any cell to add or edit a class block';
}

// ── Render timetable ──
function renderTimetable() {
    const tbody = document.getElementById('timetableBody');
    tbody.innerHTML = '';
    TIME_SLOTS.forEach(time => {
        const tr = document.createElement('tr');
        const tc = document.createElement('td');
        tc.className = 'time-cell';
        tc.textContent = time;
        tr.appendChild(tc);
        DAYS.forEach(day => {
            const td = document.createElement('td');
            td.className = 'day-cell' + (time === LUNCH ? ' lunch-row' : '');
            const key = day + '_' + time;
            const block = blocks[key];
            if (block) {
                const subj = subjects.find(s => s.code === block.subjectCode);
                const ci = subj ? subj.color : 0;
                td.innerHTML = '<div class="subj-block color-' + ci + '" data-key="' + key + '">' +
                    '<span class="room-name">' + block.room + '</span>' +
                    '<button class="edit-btn" data-key="' + key + '">&#9998;</button></div>';
            } else {
                td.dataset.key = key;
            }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    tbody.querySelectorAll('td.day-cell:not(:has(.subj-block))').forEach(td => {
        td.addEventListener('click', () => openCellModal(td.dataset.key, false));
    });
    tbody.querySelectorAll('.subj-block').forEach(el => {
        el.addEventListener('click', function(e) {
            if (e.target.classList.contains('edit-btn')) return;
            openCellModal(this.dataset.key, true);
        });
    });
    tbody.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openCellModal(btn.dataset.key, true));
    });
}

// ── Render legend ──
function renderLegend() {
    const tbody = document.getElementById('legendBody');
    tbody.innerHTML = '';
    subjects.forEach((s, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td><span class="legend-color-swatch" style="background:' + COLORS[s.color] + '"></span><strong>' + s.code + '</strong></td>' +
            '<td>' + s.name + '</td>' +
            '<td style="text-align:center;"><button class="btn-modal cancel" style="padding:.2rem .6rem;font-size:.75rem;" data-idx="' + i + '">Edit</button></td>';
        tbody.appendChild(tr);
    });
    tbody.querySelectorAll('button[data-idx]').forEach(btn => {
        btn.addEventListener('click', () => openSubjectModal(parseInt(btn.dataset.idx)));
    });
}

// ── Cell modal ──
let activeCellKey = null;
function openCellModal(key, isEdit) {
    activeCellKey = key;
    document.getElementById('modalTitle').textContent = isEdit ? 'Edit Class' : 'Add Class';
    document.getElementById('modalDelete').style.display = isEdit ? '' : 'none';
    const sel = document.getElementById('modalSubject');
    if (!subjects.length) {
        sel.innerHTML = '<option value="">— Add a subject first —</option>';
    } else {
        sel.innerHTML = subjects.map(s => '<option value="' + s.code + '">' + s.code + ' — ' + s.name + '</option>').join('');
    }
    const existing = blocks[key];
    if (existing) { sel.value = existing.subjectCode; document.getElementById('modalRoom').value = existing.room; }
    else { document.getElementById('modalRoom').value = ''; }
    document.getElementById('cellModal').classList.add('open');
}
document.getElementById('modalCancel').addEventListener('click', () => document.getElementById('cellModal').classList.remove('open'));
document.getElementById('modalSave').addEventListener('click', () => {
    const subjectCode = document.getElementById('modalSubject').value;
    const room = document.getElementById('modalRoom').value.trim();
    if (!subjectCode || subjectCode === '') return;
    blocks[activeCellKey] = { subjectCode, room: room || '—' };
    document.getElementById('cellModal').classList.remove('open');
    markDirty(); renderTimetable();
});
document.getElementById('modalDelete').addEventListener('click', () => {
    delete blocks[activeCellKey];
    document.getElementById('cellModal').classList.remove('open');
    markDirty(); renderTimetable();
});

// ── Subject modal ──
let activeSubjIdx = null;
function openSubjectModal(idx) {
    activeSubjIdx = idx;
    const isEdit = idx !== null && idx >= 0;
    document.getElementById('subjectModalTitle').textContent = isEdit ? 'Edit Subject' : 'Add Subject';
    document.getElementById('subjDelete').style.display = isEdit ? '' : 'none';
    const s = isEdit ? subjects[idx] : { code: '', name: '', color: 0 };
    document.getElementById('subjCode').value  = s.code;
    document.getElementById('subjName').value  = s.name;
    document.getElementById('subjColor').value = s.color;
    document.getElementById('subjectModal').classList.add('open');
}
document.getElementById('btnAddSubject').addEventListener('click', () => openSubjectModal(null));
document.getElementById('subjCancel').addEventListener('click', () => document.getElementById('subjectModal').classList.remove('open'));
document.getElementById('subjSave').addEventListener('click', () => {
    const code  = document.getElementById('subjCode').value.trim();
    const name  = document.getElementById('subjName').value.trim();
    const color = parseInt(document.getElementById('subjColor').value);
    if (!code || !name) { showToast('error','Missing fields','Subject code and name are required.'); return; }
    if (activeSubjIdx !== null && activeSubjIdx >= 0) { subjects[activeSubjIdx] = { code, name, color }; }
    else { subjects.push({ code, name, color }); }
    document.getElementById('subjectModal').classList.remove('open');
    markDirty(); renderLegend(); renderTimetable();
});
document.getElementById('subjDelete').addEventListener('click', () => {
    const code = subjects[activeSubjIdx].code;
    subjects.splice(activeSubjIdx, 1);
    Object.keys(blocks).forEach(k => { if (blocks[k].subjectCode === code) delete blocks[k]; });
    document.getElementById('subjectModal').classList.remove('open');
    markDirty(); renderLegend(); renderTimetable();
});

// ── OCR Import ──
let ocrResult = null;
document.getElementById('btnImport').addEventListener('click', () => {
    document.getElementById('ocrModal').classList.add('open');
    document.getElementById('ocrPreviewImg').src = '';
    document.getElementById('ocrPreviewImg').style.display = 'none';
    document.getElementById('ocrPreviewSection').style.display = 'none';
    document.getElementById('ocrStatus').textContent = '';
    document.getElementById('ocrFileInput').value = '';
    ocrResult = null;
});
document.getElementById('ocrFileInput').addEventListener('change', function() {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById('ocrPreviewImg').src = e.target.result;
        document.getElementById('ocrPreviewImg').style.display = 'block';
    };
    reader.readAsDataURL(file);
});
document.getElementById('ocrCancel').addEventListener('click', () => document.getElementById('ocrModal').classList.remove('open'));
document.getElementById('ocrProcess').addEventListener('click', async () => {
    const file = document.getElementById('ocrFileInput').files[0];
    if (!file) { document.getElementById('ocrStatus').textContent = 'Please select an image first.'; return; }
    const status = document.getElementById('ocrStatus');
    const btn = document.getElementById('ocrProcess');
    status.textContent = 'Processing image... this may take a moment.';
    btn.disabled = true;
    document.getElementById('ocrApply').style.display = 'none';
    document.getElementById('ocrPreviewSection').style.display = 'none';
    const formData = new FormData();
    formData.append('schedule', file);
    try {
        const res = await fetch('/instructor/workload/ocr-import', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success && data.data) {
            ocrResult = data.data;
            status.textContent = 'Schedule detected! Review below and click Apply.';
            renderOcrPreview(data.data);
            document.getElementById('ocrPreviewSection').style.display = 'block';
            document.getElementById('ocrApply').style.display = '';
        } else {
            status.textContent = 'Could not read schedule from image. Try a clearer photo.';
        }
    } catch(e) {
        status.textContent = 'Server error. Please try again.';
    } finally {
        btn.disabled = false;
    }
});
document.getElementById('ocrApply').addEventListener('click', () => {
    if (!ocrResult) return;
    if (!confirm('This will replace your current timetable with the imported schedule. Continue?')) return;
    subjects = ocrResult.subjects || [];
    blocks   = ocrResult.blocks   || {};
    document.getElementById('ocrModal').classList.remove('open');
    markDirty(); renderLegend(); renderTimetable();
    showToast('success', 'Imported', 'Schedule imported from image.');
});
function renderOcrPreview(data) {
    const wrap = document.getElementById('ocrPreviewTable');
    if (!data.blocks || !Object.keys(data.blocks).length) {
        wrap.innerHTML = '<p style="color:var(--gray-500);font-size:.8125rem;">No class blocks detected.</p>';
        return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:.75rem;">' +
        '<thead><tr style="background:var(--gray-50);">' +
        '<td style="padding:.3rem .5rem;font-weight:700;">Day</td>' +
        '<td style="padding:.3rem .5rem;font-weight:700;">Time</td>' +
        '<td style="padding:.3rem .5rem;font-weight:700;">Subject</td>' +
        '<td style="padding:.3rem .5rem;font-weight:700;">Room</td></tr></thead><tbody>';
    Object.entries(data.blocks).forEach(([key, b]) => {
        const [day, time] = key.split('_');
        html += '<tr><td style="padding:.25rem .5rem;border-top:1px solid var(--gray-200);">' + day + '</td>' +
            '<td style="padding:.25rem .5rem;border-top:1px solid var(--gray-200);">' + time + '</td>' +
            '<td style="padding:.25rem .5rem;border-top:1px solid var(--gray-200);">' + b.subjectCode + '</td>' +
            '<td style="padding:.25rem .5rem;border-top:1px solid var(--gray-200);">' + b.room + '</td></tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
}

// ── Toolbar ──
document.getElementById('btnSave').addEventListener('click', saveToServer);
document.getElementById('btnPrint').addEventListener('click', () => window.print());

// ── Toast ──
function showToast(type, title, message) {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = '<div class="toast-content"><p class="toast-title">' + title + '</p><p class="toast-message">' + message + '</p></div>';
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3500);
}

// ── Init ──
loadFromServer().then(() => { renderTimetable(); renderLegend(); });
</script>
`;

const newContent = beforeScript + newScript;
fs.writeFileSync('views/pages/instructor/workload.ejs', newContent, 'utf8');
console.log('workload.ejs written, size:', newContent.length);

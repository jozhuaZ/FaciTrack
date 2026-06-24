document.addEventListener('DOMContentLoaded', function () {

  /* ── Decline modal ── */
  const declineModal   = document.getElementById('declineModal');
  const declineNameEl  = document.getElementById('declineStudentName');
  const declineReason  = document.getElementById('declineReason');
  let pendingDeclineId = null, pendingDeclineName = null;

  function openDeclineModal(id, name) {
    pendingDeclineId   = id;
    pendingDeclineName = name;
    declineNameEl.textContent = name;
    declineReason.value = '';
    declineModal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closeDeclineModal() {
    declineModal.classList.remove('show');
    document.body.style.overflow = '';
    pendingDeclineId = pendingDeclineName = null;
  }

  document.getElementById('closeModal')?.addEventListener('click', closeDeclineModal);
  document.getElementById('cancelDecline')?.addEventListener('click', closeDeclineModal);
  declineModal?.addEventListener('click', e => { if (e.target === declineModal) closeDeclineModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && declineModal?.classList.contains('show')) closeDeclineModal(); });

  document.getElementById('confirmDecline')?.addEventListener('click', () => {
    const reason = declineReason.value.trim();
    if (!reason) { showToast('error', 'Required', 'Please provide a reason.'); return; }

    fetch(`/instructor/consultations/${pendingDeclineId}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    })
      .then(r => r.json())
      .then(() => {
        const name = pendingDeclineName;
        closeDeclineModal();
        showToast('success', 'Declined', `${name} has been notified.`);
        removeAppointmentRow(name);
      })
      .catch(() => showToast('error', 'Error', 'Could not decline. Try again.'));
  });

  /* ── Approve buttons ── */
  document.querySelectorAll('.btn-icon-action.approve').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const id   = this.dataset.id;
      const name = this.dataset.student;
      fetch(`/instructor/consultations/${id}/approve`, { method: 'POST' })
        .then(r => r.json())
        .then(() => {
          showToast('success', 'Approved', `${name}'s appointment confirmed.`);
          removeAppointmentRow(name);
        })
        .catch(() => showToast('error', 'Error', 'Could not approve. Try again.'));
    });
  });

  /* ── Decline buttons ── */
  document.querySelectorAll('.btn-icon-action.decline').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      openDeclineModal(this.dataset.id, this.dataset.student);
    });
  });

  function removeAppointmentRow(name) {
    setTimeout(() => {
      document.querySelectorAll('.appointment-row').forEach(row => {
        const nameEl = row.querySelector('.apt-row-name');
        if (nameEl && nameEl.textContent.trim() === name) {
          row.style.transition = 'opacity .3s, transform .3s';
          row.style.opacity = '0';
          row.style.transform = 'translateX(-16px)';
          setTimeout(() => row.remove(), 320);
        }
      });
    }, 400);
  }

  /* ── Workload snapshot ── */
  loadWorkloadSnapshot();

  async function loadWorkloadSnapshot() {
    const container = document.getElementById('workloadSnapshot');
    const wmsBlocks   = document.getElementById('wmsBlocks');
    const wmsHours    = document.getElementById('wmsHours');
    const wmsSubjects = document.getElementById('wmsSubjects');
    if (!container) return;

    try {
      const r = await fetch('/instructor/workload/load');
      const d = await r.json();
      const subjects = Array.isArray(d.subjects) ? d.subjects : [];
      const blocks   = d.blocks && typeof d.blocks === 'object' ? d.blocks : {};

      const blockList  = Object.values(blocks).filter(b => !b.isSpan);
      const totalBlocks = blockList.length;
      const totalHours  = blockList.reduce((sum, b) => sum + (b.duration || 1), 0);
      const usedIds     = [...new Set(blockList.map(b => b.subjectId))];
      const usedSubjects = subjects.filter(s => usedIds.includes(s.id));

      if (wmsBlocks)   wmsBlocks.textContent   = totalBlocks;
      if (wmsHours)    wmsHours.textContent     = totalHours + 'h';
      if (wmsSubjects) wmsSubjects.textContent  = usedSubjects.length;

      if (!usedSubjects.length) {
        container.innerHTML = `<div class="wl-empty">No workload set yet. <a href="/instructor/workload">Build your timetable →</a></div>`;
        return;
      }

      container.innerHTML = `<div class="wl-subject-list">${
        usedSubjects.slice(0, 5).map(s => `
          <div class="wl-subject-row">
            <span class="wl-subject-dot" style="background:${s.color || '#3b82f6'}"></span>
            <span class="wl-subject-code">${esc(s.code)}</span>
            <span class="wl-subject-name">${esc(s.name)}</span>
          </div>`).join('')
      }${usedSubjects.length > 5 ? `<div class="wl-empty" style="padding:.5rem 0">+${usedSubjects.length - 5} more subjects</div>` : ''}</div>`;

    } catch (e) {
      container.innerHTML = `<div class="wl-empty">Could not load workload. <a href="/instructor/workload">Open timetable →</a></div>`;
    }
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Toast ── */
  function showToast(type, title, message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = type === 'success'
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    el.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-content"><p class="toast-title">${title}</p><p class="toast-message">${message}</p></div>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(100%)';
      setTimeout(() => el.remove(), 320);
    }, 4500);
  }

});

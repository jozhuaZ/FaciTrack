/**
 * instructor-dashboard.js
 * Handles dashboard-specific search functionality only.
 * Approve/decline, status selector, unavailability modal, auto-refresh,
 * and filter tabs are all handled inline in dashboard.ejs.
 */
document.addEventListener('DOMContentLoaded', function () {

  /* ── Appointment search in the pending list ── */
  initializeAppointmentSearch();

  function initializeAppointmentSearch() {
    const searchInput = document.getElementById('appointmentSearch');
    if (!searchInput) return;

    searchInput.addEventListener('input', function () {
      const query = this.value.toLowerCase().trim();
      document.querySelectorAll('#pendingList .apt-item').forEach(function (item) {
        const student = (item.dataset.student || '').toLowerCase();
        const topic   = (item.dataset.topic   || '').toLowerCase();
        item.style.display = (!query || student.includes(query) || topic.includes(query)) ? '' : 'none';
      });
    });
  }

});

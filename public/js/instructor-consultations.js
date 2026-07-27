/* ═══════════════════════════════════════════════════════════════
   INSTRUCTOR CONSULTATIONS PAGE - All Handlers
   Manages appointments, modals, pagination, and actions
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function() {
    
    // ── Pagination ──
    const ITEMS_PER_PAGE = 5;
    let currentPage = 1;
    let currentFilter = 'all';
    let consultSearch = '';

    function getVisibleCards() {
        return Array.from(document.querySelectorAll('.consultation-card')).filter(c => {
            const matchStatus = currentFilter === 'all' || c.dataset.status === currentFilter;
            const matchSearch = !consultSearch ||
                (c.dataset.student || '').toLowerCase().includes(consultSearch) ||
                (c.dataset.topic   || '').toLowerCase().includes(consultSearch);
            return matchStatus && matchSearch;
        });
    }

    function renderPage() {
        const cards = getVisibleCards();
        const total = cards.length;
        const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
        currentPage = Math.min(currentPage, totalPages);
        const start = (currentPage - 1) * ITEMS_PER_PAGE;
        const end = start + ITEMS_PER_PAGE;

        // Show/hide all cards
        document.querySelectorAll('.consultation-card').forEach(c => c.style.display = 'none');
        cards.forEach((c, i) => { c.style.display = (i >= start && i < end) ? 'flex' : 'none'; });

        // Pagination info
        const paginationInfo = document.getElementById('paginationInfo');
        if (paginationInfo) {
            const showing = Math.min(end, total) - start;
            paginationInfo.textContent =
                total === 0 ? 'No consultations found' :
                `Showing ${start + 1}–${Math.min(end, total)} of ${total}`;
        }

        // Pagination controls
        const ctrl = document.getElementById('paginationControls');
        if (ctrl) {
            ctrl.innerHTML = '';
            if (totalPages <= 1) return;

            const prevBtn = document.createElement('button');
            prevBtn.className = 'pg-btn pg-arrow';
            prevBtn.innerHTML = '&#8592;';
            prevBtn.disabled = currentPage === 1;
            prevBtn.addEventListener('click', () => { currentPage--; renderPage(); });
            ctrl.appendChild(prevBtn);

            // Page number buttons (show up to 5)
            const range = [];
            let s = Math.max(1, currentPage - 2);
            let e = Math.min(totalPages, s + 4);
            s = Math.max(1, e - 4);
            for (let i = s; i <= e; i++) range.push(i);

            range.forEach(p => {
                const btn = document.createElement('button');
                btn.className = 'pg-btn' + (p === currentPage ? ' active' : '');
                btn.textContent = p;
                btn.addEventListener('click', () => { currentPage = p; renderPage(); });
                ctrl.appendChild(btn);
            });

            const nextBtn = document.createElement('button');
            nextBtn.className = 'pg-btn pg-arrow';
            nextBtn.innerHTML = '&#8594;';
            nextBtn.disabled = currentPage === totalPages;
            nextBtn.addEventListener('click', () => { currentPage++; renderPage(); });
            ctrl.appendChild(nextBtn);
        }
    }

    // ── Search and filter ──
    const searchInput = document.getElementById('consultSearch');
    const statusFilter = document.getElementById('consultStatusFilter');

    if (searchInput) {
        searchInput.addEventListener('input', function() {
            consultSearch = this.value.toLowerCase().trim();
            currentPage = 1;
            renderPage();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', function() {
            currentFilter = this.value;
            currentPage = 1;
            renderPage();
        });
    }

    // ── View Details Modal ──
    let currentEditCard = null;
    const viewModal = document.getElementById('viewModal');
    
    document.querySelectorAll('.btn-view-details').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const card = this.closest('.consultation-card');
            if (!card) return;
            
            currentEditCard = card;
            const name = card.dataset.student;
            document.getElementById('viewStudentName').textContent = name;
            document.getElementById('viewStudentId').textContent = card.dataset.studentid;
            document.getElementById('viewDate').textContent = card.dataset.date;
            document.getElementById('viewTime').textContent = card.dataset.time;
            document.getElementById('viewDuration').textContent = card.dataset.duration;
            document.getElementById('viewTopic').textContent = card.dataset.topic;
            document.getElementById('viewRequested').textContent = card.dataset.requested;
            
            const status = card.dataset.status;
            const badge = document.getElementById('viewStatusBadge');
            if (badge) {
                badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                badge.className = 'consult-status-badge ' + status;
            }
            
            if (viewModal) {
                viewModal.classList.add('show');
                document.body.style.overflow = 'hidden';
            }
        });
    });

    // Close view modal
    const closeViewModal = document.getElementById('closeViewModal');
    const cancelView = document.getElementById('cancelView');
    
    if (closeViewModal) {
        closeViewModal.addEventListener('click', () => {
            if (viewModal) {
                viewModal.classList.remove('show');
                document.body.style.overflow = '';
            }
        });
    }
    
    if (cancelView) {
        cancelView.addEventListener('click', () => {
            if (viewModal) {
                viewModal.classList.remove('show');
                document.body.style.overflow = '';
            }
        });
    }
    
    if (viewModal) {
        viewModal.addEventListener('click', (e) => {
            if (e.target === viewModal) {
                viewModal.classList.remove('show');
                document.body.style.overflow = '';
            }
        });
    }

    // ── Approve Buttons ──
    document.querySelectorAll('.btn-approve-full').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const id = this.dataset.id;
            const name = this.dataset.student;
            
            fetch(`/instructor/consultations/${id}/approve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            })
            .then(r => r.json())
            .then(() => {
                showToast(`${name}'s appointment approved successfully`, 'success');
                // Update card status
                const card = document.querySelector(`.consultation-card[data-id="${id}"]`);
                if (card) {
                    card.dataset.status = 'confirmed';
                    const badge = card.querySelector('.consult-status-badge');
                    if (badge) {
                        badge.textContent = 'Confirmed';
                        badge.className = 'consult-status-badge confirmed';
                    }
                    const actions = card.querySelector('.consult-card-actions');
                    if (actions) {
                        actions.innerHTML = `
                            <button class="btn-view-consult btn-view-details" data-index="${card.dataset.index}">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                View Details
                            </button>
                        `;
                        // Re-attach view details handler
                        const newViewBtn = actions.querySelector('.btn-view-details');
                        if (newViewBtn) {
                            newViewBtn.addEventListener('click', function(e) {
                                e.stopPropagation();
                                // Trigger view modal open
                                this.click();
                            });
                        }
                    }
                }
                // Refresh calendar if visible
                if (typeof renderCalendar === 'function') {
                    renderCalendar();
                }
            })
            .catch(err => {
                console.error('Approve error:', err);
                showToast('Could not approve appointment. Try again.', 'error');
            });
        });
    });

    // ── Decline Modal ──
    const declineModal = document.getElementById('declineModal');
    const declineNameEl = document.getElementById('declineStudentName');
    const declineReason = document.getElementById('declineReason');
    let pendingDeclineId = null;
    let pendingDeclineName = null;

    function openDeclineModal(id, name) {
        pendingDeclineId = id;
        pendingDeclineName = name;
        if (declineNameEl) declineNameEl.textContent = name;
        if (declineReason) declineReason.value = '';
        if (declineModal) {
            declineModal.classList.add('show');
            document.body.style.overflow = 'hidden';
        }
    }

    function closeDeclineModal() {
        if (declineModal) {
            declineModal.classList.remove('show');
            document.body.style.overflow = '';
        }
        pendingDeclineId = null;
        pendingDeclineName = null;
    }

    document.querySelectorAll('.btn-decline-full').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            openDeclineModal(this.dataset.id, this.dataset.student);
        });
    });

    const closeDeclineModalBtn = document.getElementById('closeDeclineModal');
    const cancelDecline = document.getElementById('cancelDecline');
    const confirmDecline = document.getElementById('confirmDecline');

    if (closeDeclineModalBtn) {
        closeDeclineModalBtn.addEventListener('click', closeDeclineModal);
    }

    if (cancelDecline) {
        cancelDecline.addEventListener('click', closeDeclineModal);
    }

    if (confirmDecline) {
        confirmDecline.addEventListener('click', () => {
            const reason = declineReason ? declineReason.value.trim() : '';
            if (!reason) {
                showToast('Please provide a reason for declining', 'error');
                return;
            }

            fetch(`/instructor/consultations/${pendingDeclineId}/decline`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason })
            })
            .then(r => r.json())
            .then(() => {
                const name = pendingDeclineName;
                closeDeclineModal();
                showToast(`${name} has been notified`, 'success');
                
                // Update card status
                const card = document.querySelector(`.consultation-card[data-id="${pendingDeclineId}"]`);
                if (card) {
                    card.dataset.status = 'declined';
                    const badge = card.querySelector('.consult-status-badge');
                    if (badge) {
                        badge.textContent = 'Declined';
                        badge.className = 'consult-status-badge declined';
                    }
                    const actions = card.querySelector('.consult-card-actions');
                    if (actions) {
                        actions.innerHTML = `
                            <button class="btn-view-consult btn-view-details" data-index="${card.dataset.index}">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                View Details
                            </button>
                        `;
                    }
                }
                
                // Refresh calendar if visible
                if (typeof renderCalendar === 'function') {
                    renderCalendar();
                }
            })
            .catch(err => {
                console.error('Decline error:', err);
                showToast('Could not decline. Try again.', 'error');
            });
        });
    }

    if (declineModal) {
        declineModal.addEventListener('click', (e) => {
            if (e.target === declineModal) {
                closeDeclineModal();
            }
        });
    }

    // ── Toast Notifications ──
    function showToast(message, type = 'success') {
        const container = document.getElementById('toastContainer');
        if (!container) {
            console.log('Toast:', message);
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success'
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';

        toast.innerHTML = `
            <div class="toast-icon">${icon}</div>
            <div class="toast-content">
                <p class="toast-message">${message}</p>
            </div>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.4s ease';
            setTimeout(() => toast.remove(), 400);
        }, 3000);
    }

    // Make showToast globally accessible
    window.showToast = showToast;

    // ── Initialize pagination on page load ──
    renderPage();

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (viewModal && viewModal.classList.contains('show')) {
                viewModal.classList.remove('show');
                document.body.style.overflow = '';
            }
            if (declineModal && declineModal.classList.contains('show')) {
                closeDeclineModal();
            }
        }
    });
});

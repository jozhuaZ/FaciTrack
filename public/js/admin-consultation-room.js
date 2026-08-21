// Admin Consultation Room Management Script

let currentFilters = {
    date: null,
    programCode: null
};

let slotsCache = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    initializeFilters();
    loadAllProgramSlots();
    initializeModals();
    initializeRefresh();
});

function initializeFilters() {
    const dateFilter = document.getElementById('dateFilter');
    const programFilter = document.getElementById('programFilter');
    const applyFilterBtn = document.getElementById('applyFilterBtn');
    const clearFilterBtn = document.getElementById('clearFilterBtn');

    // Set default date to today
    if (dateFilter) {
        currentFilters.date = dateFilter.value;
    }

    applyFilterBtn.addEventListener('click', () => {
        currentFilters.date = dateFilter.value || null;
        currentFilters.programCode = programFilter.value || null;
        loadAllProgramSlots();
    });

    clearFilterBtn.addEventListener('click', () => {
        dateFilter.value = new Date().toISOString().split('T')[0];
        programFilter.value = '';
        currentFilters.date = dateFilter.value;
        currentFilters.programCode = null;
        loadAllProgramSlots();
    });
}

async function loadAllProgramSlots() {
    const programCards = document.querySelectorAll('.program-table-card');

    for (const card of programCards) {
        const programCode = card.dataset.program;

        // Skip if filtering by specific program and this isn't it
        if (currentFilters.programCode && currentFilters.programCode !== programCode) {
            card.style.display = 'none';
            continue;
        }

        card.style.display = 'block';
        await loadProgramSlots(programCode, card);
    }
}

async function loadProgramSlots(programCode, cardElement) {
    const container = cardElement.querySelector('.consultation-slots-container');
    const tableCountSpan = cardElement.querySelector('.table-count');

    // Show loading state
    container.innerHTML = `
        <div class="loading-state">
            <div class="spinner"></div>
            <p>Loading consultation slots...</p>
        </div>
    `;

    try {
        const params = new URLSearchParams({
            programCode: programCode
        });

        if (currentFilters.date) {
            params.append('date', currentFilters.date);
        }

        const response = await fetch(`/admin/consultation-room/slots?${params.toString()}`);
        const result = await response.json();

        if (result.success) {
            slotsCache[programCode] = result.data;
            renderSlots(programCode, result.data, container);

            // Update table count
            const bookedSlots = result.data.filter(slot => slot.appointment).length;
            if (tableCountSpan) {
                tableCountSpan.textContent = bookedSlots;
            }
        } else {
            container.innerHTML = `
                <div class="loading-state">
                    <p style="color: #ef4444;">Failed to load slots: ${result.error}</p>
                </div>
            `;
        }
    } catch (error) {
        console.error('Error loading program slots:', error);
        container.innerHTML = `
            <div class="loading-state">
                <p style="color: #ef4444;">Network error. Please try again.</p>
            </div>
        `;
    }
}

function renderSlots(programCode, slots, container) {
    if (slots.length === 0) {
        container.innerHTML = `
            <div class="loading-state">
                <p>No consultation slots available for the selected date.</p>
            </div>
        `;
        return;
    }

    const slotsHTML = slots.map(slot => {
        let slotClass = 'consultation-slot';
        let statusIndicatorClass = 'status-indicator available';
        let statusText = 'Available';

        if (slot.appointment) {
            slotClass += ' booked';
            statusIndicatorClass = 'status-indicator booked';
            statusText = 'Booked';
        } else if (slot.isReserved) {
            slotClass += ' occupied';
            statusIndicatorClass = 'status-indicator occupied';
            statusText = 'Occupied (2-min timer)';
        } else if (slot.slotStatus === 'closed') {
            slotClass += ' unavailable';
            statusIndicatorClass = 'status-indicator unavailable';
            statusText = 'Unavailable';
        }

        const roomInfo = slot.room 
            ? `<span class="room-badge">
                   <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/></svg>
                   ${slot.room.roomNumber}
               </span>`
            : '';

        const modeInfo = slot.appointment
            ? `<span class="mode-badge ${slot.appointment.mode.toLowerCase().replace(' ', '-')}">${slot.appointment.mode}</span>`
            : '';

        return `
            <div class="${slotClass}" data-slot-id="${slot.slotId}" onclick="showSlotDetails(${slot.slotId})">
                <div class="slot-info">
                    <div class="slot-time">${slot.date} · ${slot.timeStart} - ${slot.timeEnd}</div>
                    <div class="slot-instructor">Instructor: ${slot.instructor.fullName} (${slot.instructor.position})</div>
                </div>
                <div class="slot-meta">
                    ${roomInfo}
                    ${modeInfo}
                    <div class="slot-status">
                        <span class="${statusIndicatorClass}"></span>
                        <span>${statusText}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = slotsHTML;
}

async function showSlotDetails(slotId) {
    // Find slot in cache
    let slot = null;
    for (const programCode in slotsCache) {
        const found = slotsCache[programCode].find(s => s.slotId === slotId);
        if (found) {
            slot = found;
            break;
        }
    }

    if (!slot) {
        alert('Slot not found');
        return;
    }

    const modal = document.getElementById('slotDetailsModal');
    const content = document.getElementById('slotDetailsContent');

    let detailsHTML = `
        <div class="detail-section">
            <h4 class="detail-section-title">Time & Date</h4>
            <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${slot.date}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${slot.timeStart} - ${slot.timeEnd}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status:</span>
                <span class="detail-value">${slot.slotStatus}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Instructor Information</h4>
            <div class="detail-row">
                <span class="detail-label">Name:</span>
                <span class="detail-value">${slot.instructor.fullName}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Position:</span>
                <span class="detail-value">${slot.instructor.position}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Department:</span>
                <span class="detail-value">${slot.instructor.department}</span>
            </div>
        </div>
    `;

    if (slot.appointment) {
        detailsHTML += `
            <div class="detail-section">
                <h4 class="detail-section-title">Appointment Details</h4>
                <div class="detail-row">
                    <span class="detail-label">Student:</span>
                    <span class="detail-value">${slot.appointment.student.firstName} ${slot.appointment.student.lastName}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Mode:</span>
                    <span class="detail-value">${slot.appointment.mode}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Topic:</span>
                    <span class="detail-value">${slot.appointment.topic || 'N/A'}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Status:</span>
                    <span class="detail-value">${slot.appointment.status}</span>
                </div>
            </div>
        `;
    }

    if (slot.room) {
        detailsHTML += `
            <div class="detail-section">
                <h4 class="detail-section-title">Room Information</h4>
                <div class="detail-row">
                    <span class="detail-label">Room Number:</span>
                    <span class="detail-value">${slot.room.roomNumber}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Capacity:</span>
                    <span class="detail-value">${slot.room.capacity} tables</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Current Bookings:</span>
                    <span class="detail-value">${slot.room.currentBookings} / ${slot.room.capacity}</span>
                </div>
            </div>
        `;
    }

    if (slot.isReserved && slot.reservationExpires) {
        detailsHTML += `
            <div class="detail-section">
                <h4 class="detail-section-title">Reservation</h4>
                <div class="detail-row">
                    <span class="detail-label">Reserved until:</span>
                    <span class="detail-value">${new Date(slot.reservationExpires).toLocaleString()}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label" style="color: #f59e0b;">⚠️ Occupied Status:</span>
                    <span class="detail-value" style="color: #f59e0b;">Student is filling out form</span>
                </div>
            </div>
        `;
    }

    content.innerHTML = detailsHTML;
    modal.classList.add('active');
}

function initializeModals() {
    const modal = document.getElementById('slotDetailsModal');
    const closeBtn = document.getElementById('closeSlotModal');

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });
}

function initializeRefresh() {
    const refreshBtn = document.getElementById('refreshAllBtn');
    
    refreshBtn.addEventListener('click', () => {
        loadAllProgramSlots();
    });

    // Auto-refresh every 30 seconds
    setInterval(() => {
        loadAllProgramSlots();
    }, 30000);
}

// Export for use in modal
window.showSlotDetails = showSlotDetails;

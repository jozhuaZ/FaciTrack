// Admin Consultation Logs Script

let currentPage = 0;
let currentLimit = 50;
let currentFilters = {
    programCode: null,
    status: null,
    instructorId: null,
    dateFrom: null,
    dateTo: null
};

let logsCache = [];
let totalLogs = 0;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    initializeFilters();
    initializeModals();
    initializePagination();
    initializeExport();
    loadStats();
});

function initializeFilters() {
    const programFilter = document.getElementById('programFilterLogs');
    const statusFilter = document.getElementById('statusFilterLogs');
    const instructorFilter = document.getElementById('instructorFilterLogs');
    const dateFromFilter = document.getElementById('dateFromFilter');
    const dateToFilter = document.getElementById('dateToFilter');
    const applyBtn = document.getElementById('applyLogsFilterBtn');
    const clearBtn = document.getElementById('clearLogsFilterBtn');

    applyBtn.addEventListener('click', () => {
        currentFilters = {
            programCode: programFilter.value || null,
            status: statusFilter.value || null,
            instructorId: instructorFilter.value || null,
            dateFrom: dateFromFilter.value || null,
            dateTo: dateToFilter.value || null
        };
        currentPage = 0;
        loadLogs();
        loadStats();
    });

    clearBtn.addEventListener('click', () => {
        programFilter.value = '';
        statusFilter.value = '';
        instructorFilter.value = '';
        dateFromFilter.value = '';
        dateToFilter.value = '';
        currentFilters = {
            programCode: null,
            status: null,
            instructorId: null,
            dateFrom: null,
            dateTo: null
        };
        currentPage = 0;
        loadLogs();
        loadStats();
    });
}

async function loadLogs() {
    const tbody = document.getElementById('logsTableBody');
    const resultCount = document.getElementById('resultCount');

    // Show loading
    tbody.innerHTML = `
        <tr>
            <td colspan="10" style="text-align: center; padding: 2rem;">
                <div class="spinner" style="margin: 0 auto;"></div>
                <p style="margin-top: 1rem; color: #6b7280;">Loading logs...</p>
            </td>
        </tr>
    `;

    try {
        const params = new URLSearchParams({
            limit: currentLimit,
            offset: currentPage * currentLimit
        });

        if (currentFilters.programCode) params.append('programCode', currentFilters.programCode);
        if (currentFilters.status) params.append('status', currentFilters.status);
        if (currentFilters.instructorId) params.append('instructorId', currentFilters.instructorId);
        if (currentFilters.dateFrom) params.append('dateFrom', currentFilters.dateFrom);
        if (currentFilters.dateTo) params.append('dateTo', currentFilters.dateTo);

        const response = await fetch(`/admin/consultation-logs/data?${params.toString()}`);
        const result = await response.json();

        if (result.success) {
            logsCache = result.data;
            totalLogs = result.pagination.total;
            renderLogs(result.data);
            updatePagination(result.pagination);

            const showing = Math.min((currentPage * currentLimit) + result.data.length, totalLogs);
            resultCount.textContent = `Showing ${showing} of ${totalLogs}`;
        } else {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" class="no-data">Failed to load logs: ${result.error}</td>
                </tr>
            `;
        }
    } catch (error) {
        console.error('Error loading logs:', error);
        tbody.innerHTML = `
            <tr>
                <td colspan="10" class="no-data">Network error. Please try again.</td>
            </tr>
        `;
    }
}

function renderLogs(logs) {
    const tbody = document.getElementById('logsTableBody');

    if (logs.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" class="no-data">No consultation logs found</td>
            </tr>
        `;
        return;
    }

    const logsHTML = logs.map(log => {
        const dateObj = new Date(log.date);
        const formattedDate = dateObj.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
        });

        return `
            <tr>
                <td><span class="log-id">#${log.appointmentId}</span></td>
                <td>
                    <div class="instructor-cell">
                        <strong>${log.instructor.fullName}</strong>
                        <span class="text-muted">${log.instructor.position}</span>
                    </div>
                </td>
                <td>${log.student.fullName}</td>
                <td>${log.course || 'N/A'}</td>
                <td>${formattedDate}</td>
                <td>${log.timeStart} - ${log.timeEnd}</td>
                <td>
                    <span class="mode-badge ${log.mode.toLowerCase().replace(' ', '-')}">
                        ${log.mode}
                    </span>
                </td>
                <td>${log.room}</td>
                <td>
                    <span class="status-badge ${log.status}">
                        ${log.status.charAt(0).toUpperCase() + log.status.slice(1)}
                    </span>
                </td>
                <td>
                    <button class="btn-action view" onclick="showLogDetails(${log.appointmentId})">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = logsHTML;
}

function showLogDetails(appointmentId) {
    const log = logsCache.find(l => l.appointmentId === appointmentId);

    if (!log) {
        alert('Log not found');
        return;
    }

    const modal = document.getElementById('logDetailsModal');
    const content = document.getElementById('logDetailsContent');

    const dateObj = new Date(log.date);
    const formattedDate = dateObj.toLocaleDateString('en-US', { 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
    });

    const createdDate = new Date(log.createdAt);
    const formattedCreatedAt = createdDate.toLocaleString('en-US');

    const detailsHTML = `
        <div class="detail-section">
            <h4 class="detail-section-title">Appointment Information</h4>
            <div class="detail-row">
                <span class="detail-label">Appointment ID:</span>
                <span class="detail-value">#${log.appointmentId}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Status:</span>
                <span class="detail-value">
                    <span class="status-badge ${log.status}">${log.status.charAt(0).toUpperCase() + log.status.slice(1)}</span>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Created:</span>
                <span class="detail-value">${formattedCreatedAt}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Schedule</h4>
            <div class="detail-row">
                <span class="detail-label">Date:</span>
                <span class="detail-value">${formattedDate}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Time:</span>
                <span class="detail-value">${log.timeStart} - ${log.timeEnd}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Mode:</span>
                <span class="detail-value">
                    <span class="mode-badge ${log.mode.toLowerCase().replace(' ', '-')}">${log.mode}</span>
                </span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Room/Location:</span>
                <span class="detail-value">${log.room}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Instructor</h4>
            <div class="detail-row">
                <span class="detail-label">Name:</span>
                <span class="detail-value">${log.instructor.fullName}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Position:</span>
                <span class="detail-value">${log.instructor.position}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Student</h4>
            <div class="detail-row">
                <span class="detail-label">Name:</span>
                <span class="detail-value">${log.student.fullName}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Student ID:</span>
                <span class="detail-value">${log.student.publicId}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Course Details</h4>
            <div class="detail-row">
                <span class="detail-label">Course:</span>
                <span class="detail-value">${log.course || 'N/A'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Section:</span>
                <span class="detail-value">${log.section || 'N/A'}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Topic:</span>
                <span class="detail-value">${log.topic || 'N/A'}</span>
            </div>
        </div>

        <div class="detail-section">
            <h4 class="detail-section-title">Department & Program</h4>
            <div class="detail-row">
                <span class="detail-label">Department:</span>
                <span class="detail-value">${log.department}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">Program:</span>
                <span class="detail-value">${log.programCode}</span>
            </div>
        </div>
    `;

    content.innerHTML = detailsHTML;
    modal.classList.add('active');
}

async function loadStats() {
    try {
        const params = new URLSearchParams();

        if (currentFilters.programCode) params.append('programCode', currentFilters.programCode);
        if (currentFilters.dateFrom) params.append('dateFrom', currentFilters.dateFrom);
        if (currentFilters.dateTo) params.append('dateTo', currentFilters.dateTo);

        const response = await fetch(`/admin/consultation-room/stats?${params.toString()}`);
        const result = await response.json();

        if (result.success) {
            const stats = result.data.consultationStats;

            document.getElementById('totalConsultations').textContent = stats.total_consultations || 0;
            document.getElementById('completedCount').textContent = stats.completed_count || 0;
            document.getElementById('faceToFaceCount').textContent = stats.face_to_face_count || 0;
            document.getElementById('onlineCount').textContent = stats.online_count || 0;
        }
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

function initializeModals() {
    const modal = document.getElementById('logDetailsModal');
    const closeBtn = document.getElementById('closeLogModal');

    closeBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
        }
    });
}

function initializePagination() {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');

    prevBtn.addEventListener('click', () => {
        if (currentPage > 0) {
            currentPage--;
            loadLogs();
        }
    });

    nextBtn.addEventListener('click', () => {
        if ((currentPage + 1) * currentLimit < totalLogs) {
            currentPage++;
            loadLogs();
        }
    });

    // Load initial data
    loadLogs();
}

function updatePagination(pagination) {
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    const pageInfo = document.getElementById('pageInfo');

    prevBtn.disabled = currentPage === 0;
    nextBtn.disabled = !pagination.hasMore;

    const totalPages = Math.ceil(pagination.total / currentLimit);
    pageInfo.textContent = `Page ${currentPage + 1} of ${totalPages}`;
}

function initializeExport() {
    const exportBtn = document.getElementById('exportLogsBtn');

    exportBtn.addEventListener('click', () => {
        exportToCSV();
    });
}

function exportToCSV() {
    if (logsCache.length === 0) {
        alert('No data to export');
        return;
    }

    // Create CSV content
    const headers = ['ID', 'Instructor', 'Position', 'Student', 'Course', 'Section', 'Date', 'Time Start', 'Time End', 'Mode', 'Room', 'Status', 'Topic', 'Department', 'Program'];
    const rows = logsCache.map(log => [
        log.appointmentId,
        log.instructor.fullName,
        log.instructor.position,
        log.student.fullName,
        log.course || '',
        log.section || '',
        log.date,
        log.timeStart,
        log.timeEnd,
        log.mode,
        log.room,
        log.status,
        log.topic || '',
        log.department,
        log.programCode
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    // Download CSV
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `consultation-logs-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Export for use in onclick handlers
window.showLogDetails = showLogDetails;

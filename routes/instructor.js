const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const WorkloadController = require('../controllers/WorkloadController');
const WorkloadImportController = require('../controllers/WorkloadImportController');
const InstructorController = require('../controllers/InstructorController');
const NotificationController = require('../controllers/NotificationController');
const MakeupController = require('../controllers/MakeupController');
const CalendarController = require('../controllers/CalendarController');
const CalendarFeedController = require('../controllers/CalendarFeedController');
const InstructorEventController = require('../controllers/InstructorEventController');
const GoogleCalendarController = require('../controllers/GoogleCalendarController');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Document uploads for make-up class requests ──
// Never under public/, and served only through the authenticated
// /makeup/document/:docId route — these are signed absence documents.
// services/file-store.js decides where the bytes land.

// A supporting document is always a PDF; the polling sheet may also be a
// spreadsheet. Browsers sometimes send octet-stream for .xlsx, so the
// extension is the fallback check.
const DOC_TYPES = {
    documents: { mimes: ['application/pdf'], exts: ['.pdf'], label: 'PDF' },
    polling: {
        mimes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
        ],
        exts: ['.pdf', '.xlsx', '.xls'],
        label: 'PDF or spreadsheet',
    },
};

const makeupUpload = multer({
    // Held in memory, then written by services/file-store.js — which knows
    // whether this host has a disk worth writing to. Writing here instead
    // would put the file somewhere a serverless host discards before the
    // request that saves the row has even finished.
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 6 },
    fileFilter: (req, file, cb) => {
        const rule = DOC_TYPES[file.fieldname];
        if (!rule) return cb(new Error('Unexpected upload.'));
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (rule.mimes.includes(file.mimetype) || rule.exts.includes(ext)) return cb(null, true);
        cb(new Error(`${file.originalname} is not a ${rule.label} file.`));
    }
});

/** Turn multer's own errors into a flash instead of a stack trace. */
function acceptDocuments(req, res, next) {
    makeupUpload.fields([
        { name: 'documents', maxCount: 5 },
        { name: 'polling', maxCount: 1 },
    ])(req, res, err => {
        if (!err) return next();
        req.session.flash = { type: 'error', message: err.message || 'Invalid file. Please attach a PDF.' };
        res.redirect(req.params.id
            ? `/instructor/makeup/request/${req.params.id}/edit`
            : '/instructor/makeup/request');
    });
}

// Simple UUID v4 generator (no external dependency)
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}


// ── Slot utilities ──
function timeToSlot(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 2 + (m >= 30 ? 1 : 0);
}

function slotToLabel(slot) {
    const totalMins = slot * 30;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// ── Shared notifications list (module-level, persists for server session) ──
const notificationsList = [];
let notifIdCounter = 1;

function formatRelativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) return 'Just now';
    const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    const diffDays = Math.round(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

function createInstructorNotification({ type, title, message, read = false, createdAt = new Date().toISOString(), category = 'general' }) {
    return {
        id: notifIdCounter++,
        type,
        category,
        title,
        message,
        read,
        createdAt,
        time: formatRelativeTime(createdAt)
    };
}

function addInstructorNotification(payload) {
    const entry = createInstructorNotification(payload);
    notificationsList.unshift(entry);
    return entry;
}

function seedSampleNotifications() {
    if (notificationsList.length > 0) return;
    notificationsList.push(
        addInstructorNotification({
            type: 'new-request',
            title: 'New appointment request',
            message: 'Juan Dela Cruz requested a consultation for today at 2:00 PM.',
            category: 'appointment',
            read: false
        }),
        addInstructorNotification({
            type: 'cancellation',
            title: 'Appointment cancelled',
            message: 'Maria Garcia cancelled her appointment for March 25.',
            category: 'appointment',
            read: false
        }),
        addInstructorNotification({
            type: 'reminder',
            title: 'Upcoming appointment reminder',
            message: 'Carlos Mendoza is due for a consultation at 3:30 PM.',
            category: 'reminder',
            read: true
        })
    );
}

seedSampleNotifications();


// ── Schedule parser: extract blocks from OCR raw text ──
function parseScheduleText(rawText) {
    const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const dayAbbr = { MON:'Monday', TUE:'Tuesday', WED:'Wednesday', THU:'Thursday', FRI:'Friday',
                      MONDAY:'Monday', TUESDAY:'Tuesday', WEDNESDAY:'Wednesday', THURSDAY:'Thursday', FRIDAY:'Friday' };
    const timeSlots = [
        '07:00-08:00','08:00-09:00','09:00-10:00','10:00-11:00',
        '11:00-12:00','12:00-01:00','01:00-02:00','02:00-03:00',
        '03:00-04:00','04:00-05:00','05:00-06:00','06:00-07:00'
    ];

    const subjects = {};
    const blocks = {};
    const lines = rawText.split(/\n/).map(l => l.trim()).filter(Boolean);
    const colorMap = ['#e07b39','#7b6fc4','#e05c5c','#4a90d9','#4caf7d','#d4a017','#5b8dd9','#c45c8a'];
    let colorIdx = 0;

    // Try to find subject codes (e.g. ITEC 321, ISA 321)
    const subjectCodeRe = /\b([A-Z]{2,6}\s*\d{3,4}[A-Z]?)\b/g;
    // Try to find room names
    const roomRe = /\b(Room\s*\d+|MAC\s*Lab|ERP\s*Lab|Lab\s*\d*|[A-Z]+\s*Lab)\b/gi;
    // Try to find time patterns like 08:00-09:00 or 8:00-9:00
    const timeRe = /\b(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\b/g;

    // Detect column headers (days) and their approximate positions
    let detectedDays = [];
    lines.forEach(line => {
        const upper = line.toUpperCase();
        days.forEach(d => { if (upper.includes(d.toUpperCase()) && !detectedDays.includes(d)) detectedDays.push(d); });
    });
    if (!detectedDays.length) detectedDays = days;

    // Extract subject codes found in text
    const allCodes = [];
    rawText.replace(subjectCodeRe, (m, code) => { const c = code.replace(/\s+/,' ').trim(); if (!allCodes.includes(c)) allCodes.push(c); });

    // Build subject list
    allCodes.forEach(code => {
        if (!subjects[code]) {
            subjects[code] = { code, name: code, color: colorIdx % 8 };
            colorIdx++;
        }
    });

    // Try to extract rows: time | day blocks
    // Look for lines that start with a time pattern
    let currentTime = null;
    lines.forEach(line => {
        const timeMatch = line.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
        if (timeMatch) {
            // Normalize to slot format
            const h1 = timeMatch[1].padStart(5,'0'), h2 = timeMatch[2].padStart(5,'0');
            const slot = h1 + '-' + h2;
            if (timeSlots.includes(slot)) currentTime = slot;
        }

        if (currentTime) {
            // Look for subject codes and rooms in this line
            const codes = [];
            let m;
            const re = new RegExp(subjectCodeRe.source, 'g');
            while ((m = re.exec(line)) !== null) codes.push(m[1].replace(/\s+/,' ').trim());
            const rooms = line.match(roomRe) || [];

            // Try to associate with a day based on position in line
            // Simple heuristic: assign to first unoccupied day that appears in the line
            detectedDays.forEach((day, di) => {
                if (codes[di] || rooms[di]) {
                    const key = day + '_' + currentTime;
                    if (!blocks[key] && (codes[di] || codes[0])) {
                        blocks[key] = {
                            subjectCode: codes[di] || codes[0],
                            room: rooms[di] || rooms[0] || '—'
                        };
                    }
                }
            });
        }
    });

    return {
        subjects: Object.values(subjects),
        blocks
    };
}

router.use((req, res, next) => {
    console.log(`[Instructor Router] ${req.method} ${req.originalUrl}`);
    next();
});

// Lazy-load student router to avoid circular dependency
function getStudentRouter() {
    return require('./student');
}

// ── In-memory schedule store (persists for the server session) ──
// Key: instructor id (1 = Dr. Maria Santos for this prototype)
const scheduleStore = {
    1: [
        // Sample consultation slots for demonstration
        { day: 'Monday',    timeStart: '9:00 AM',  timeEnd: '10:00 AM',  status: 'open',   maxCapacity: 3, bookedCount: 1 },
        { day: 'Monday',    timeStart: '2:00 PM',  timeEnd: '3:30 PM',   status: 'open',   maxCapacity: 2, bookedCount: 2 },
        { day: 'Tuesday',   timeStart: '10:00 AM', timeEnd: '11:00 AM',  status: 'open',   maxCapacity: 3, bookedCount: 0 },
        { day: 'Wednesday', timeStart: '1:00 PM',  timeEnd: '2:30 PM',   status: 'open',   maxCapacity: 2, bookedCount: 1 },
        { day: 'Wednesday', timeStart: '3:00 PM',  timeEnd: '4:00 PM',   status: 'closed', maxCapacity: 3, bookedCount: 3 },
        { day: 'Friday',    timeStart: '9:30 AM',  timeEnd: '10:30 AM',  status: 'open',   maxCapacity: 4, bookedCount: 0 }
    ]
};

function getSchedule(instructorId) {
    return scheduleStore[instructorId] || [];
}

// PROTOTYPE MODE: Disabled role check to allow free navigation
// router.use(requireRole('instructor'));

// Instructor Dashboard
router.get('/dashboard', InstructorController.renderDashboardPage);

// Faculty sets their own availability status
router.patch('/availability-status', InstructorController.updateAvailabilityStatus);

// Helper: shared data
function getSharedData() {
    const instructor = {
        id: 1,
        name: 'Dr. Maria Santos',
        email: 'maria.santos@cspc.edu.ph',
        position: 'Professor',
        department: 'College of Computer Studies',
        specialization: 'Software Engineering',
        officeRoom: 'CCS Building, Room 201',
        bleStatus: 'in-room',
        bleLastDetected: '2 minutes ago',
        statusOverride: false,
        profilePhoto: null
    };

    // Pull real bookings from student refStore for instructor ID 1
    const sr = getStudentRouter();
    let appointments = [];
    if (sr.refStore) {
        appointments = Object.values(sr.refStore)
            .filter(r => r.facultyId === 1)
            .map(r => ({
                id:          r.refNumber,
                studentName: r.studentName,
                studentId:   r.studentId,
                date:        r.date || r.day || '—',
                time:        r.slot || '—',
                duration:    '—',
                topic:       r.topic,
                status:      r.status,
                isToday:     false,
                requestedAt: r.requestedAt ? new Date(r.requestedAt).toLocaleString() : '—',
                declineReason: r.declineReason || ''
            }));
    }

    // Seed sample appointments if none exist yet (prototype fallback)
    if (!appointments.length) {
        function relDate(offset) {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            return d.toISOString().split('T')[0];
        }
        appointments = [
            { id: 'SAMPLE-1', studentName: 'Juan Dela Cruz',  studentId: '2021-00123', date: relDate(0),  time: '2:00 PM',  duration: '30 min', topic: 'Thesis consultation',        status: 'pending',   isToday: true,  requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-2', studentName: 'Ana Reyes',        studentId: '2021-00456', date: relDate(0),  time: '3:30 PM',  duration: '45 min', topic: 'Project proposal review',    status: 'confirmed', isToday: true,  requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-3', studentName: 'Carlos Mendoza',   studentId: '2021-00789', date: relDate(-1), time: '10:00 AM', duration: '30 min', topic: 'Grade inquiry',              status: 'confirmed', isToday: false, requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-4', studentName: 'Maria Garcia',     studentId: '2021-00321', date: relDate(-2), time: '1:00 PM',  duration: '30 min', topic: 'Academic advising',          status: 'declined',  isToday: false, requestedAt: '—', declineReason: 'Schedule conflict' },
            { id: 'SAMPLE-5', studentName: 'Pedro Lim',        studentId: '2022-00111', date: relDate(1),  time: '9:00 AM',  duration: '30 min', topic: 'Research methodology',       status: 'pending',   isToday: false, requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-6', studentName: 'Rosa Fernandez',   studentId: '2022-00222', date: relDate(-3), time: '11:00 AM', duration: '45 min', topic: 'Capstone project feedback',  status: 'confirmed', isToday: false, requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-7', studentName: 'Luis Torres',      studentId: '2021-00555', date: relDate(-4), time: '2:00 PM',  duration: '30 min', topic: 'Grade reconsideration',      status: 'confirmed', isToday: false, requestedAt: '—', declineReason: '' },
            { id: 'SAMPLE-8', studentName: 'Kristine Uy',      studentId: '2022-00333', date: relDate(2),  time: '1:00 PM',  duration: '30 min', topic: 'AI project consultation',    status: 'pending',   isToday: false, requestedAt: '—', declineReason: '' }
        ];
    }


    // Pull live schedule from store — format for the schedule page
    const consultationSlots = getSchedule(1).map(s => ({
        day:         s.day,
        date:        '',
        time:        `${s.timeStart} - ${s.timeEnd}`,
        timeStart:   s.timeStart,
        timeEnd:     s.timeEnd,
        status:      s.status,
        bookedCount: s.bookedCount,
        maxCapacity: s.maxCapacity
    }));

    const presenceLogs = [
        { timestamp: '2026-03-17 09:15 AM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { timestamp: '2026-03-17 11:30 AM', status: 'exited',  location: 'CCS Building, Room 201', duration: '2h 15m' },
        { timestamp: '2026-03-17 01:00 PM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { timestamp: '2026-03-16 09:00 AM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { timestamp: '2026-03-16 12:00 PM', status: 'exited',  location: 'CCS Building, Room 201', duration: '3h 0m' }
    ];

    const workloadStats = {
        thisWeek:  {
            hoursLogged: appointments.filter(a => a.status === 'confirmed').length * 0.75,
            consultationsCompleted: appointments.filter(a => a.status === 'confirmed').length,
            averageDuration: '45 min',
            pendingRequests: appointments.filter(a => a.status === 'pending').length
        },
        thisMonth: {
            hoursLogged: appointments.filter(a => a.status === 'confirmed').length * 1.5,
            consultationsCompleted: appointments.filter(a => a.status === 'confirmed').length,
            averageDuration: '42 min',
            pendingRequests: appointments.filter(a => a.status === 'pending').length
        },
        trends: (function() {
            const days = ['Mon','Tue','Wed','Thu','Fri'];
            const today = new Date().getDay(); // 0=Sun,1=Mon,...
            // Count real appointments per weekday from this week
            const counts = [0,0,0,0,0];
            appointments.forEach(function(a) {
                const d = new Date(a.date);
                const dow = d.getDay();
                if (dow >= 1 && dow <= 5) counts[dow - 1]++;
            });
            // If all zero (no real data), use sample values
            const hasData = counts.some(c => c > 0);
            const sample = [3, 2, 4, 1, 3];
            return days.map((day, i) => ({
                day,
                consultations: hasData ? counts[i] : sample[i],
                hours: hasData ? counts[i] * 0.75 : sample[i] * 0.75
            }));
        })()
    };

    const notifications = notificationsList.slice();
    const workloadLogs = (workloadStats.trends || []).map(t => ({
        day: t.day,
        timeRange: '08:00 AM - 10:00 AM',
        subjectCode: 'ITEC 321',
        subjectName: 'Software Engineering',
        room: 'Room 201',
        type: 'Regular',
        duration: 4
    }));

    return { instructor, appointments, consultationSlots, presenceLogs, workloadStats, notifications, workloadLogs };
}

// Appointments
router.get('/appointments', InstructorController.renderAppointmentsPage);
// Both bulk routes stay above ':id' so the literal path is not read as an id
router.post('/appointments/approve-all', InstructorController.approveAllAppointments);
router.post('/appointments/complete-all', InstructorController.completeAllAppointments);
router.post('/appointments/:id/approve', InstructorController.approveAppointment);
router.post('/appointments/:id/decline', InstructorController.declineAppointment);
router.post('/appointments/:id/complete', InstructorController.completeAppointment);
router.patch('/appointments/:id/mode', InstructorController.updateAppointmentMode);

// Personal meeting room used for online consultations
router.patch('/meeting-link', InstructorController.updateDefaultMeetingLink);

// Google Calendar connection — lets online consultations get a real scheduled
// Meet instead of reusing the static personal room link. The callback sits
// behind the instructor guard like everything else here; the instructor is
// already signed in when Google sends them back.
router.get('/google/connect', GoogleCalendarController.connect);
router.get('/google/callback', GoogleCalendarController.callback);
router.delete('/google', GoogleCalendarController.disconnect);

// reschedule appointment routes
router.get('/appointments/reschedule-options', InstructorController.getRescheduleOptions);
router.post('/appointments/:id/reschedule', InstructorController.rescheduleAppointment);

// API endpoint for calendar data - schedules
router.get('/schedule/data', (req, res) => {
    const slots = getSchedule(1);
    res.json({ slots: slots });
});

// Schedule page
router.get('/consultation-schedule', InstructorController.renderConsultationPage);

// Slot management
router.post('/schedule/save',       InstructorController.saveSlotBlock);
router.delete('/schedule/:slotId',  InstructorController.deleteSlot);

// Unavailability for consultation slots
router.get('/unavailability/list',         InstructorController.getUnavailability);
router.get('/unavailability/check/:date',  InstructorController.checkUnavailability);
router.post('/unavailability/set',         InstructorController.setUnavailability);
router.post('/unavailability/cancel-affected', InstructorController.cancelAffectedAppointments);
router.delete('/unavailability/range',     InstructorController.removeUnavailabilityRange);
router.delete('/unavailability/:date',     InstructorController.removeUnavailability);

// workload
router.get('/workload', WorkloadController.renderPage);
router.post('/workload/save', WorkloadController.save);

// Read a CSPC workload form (.docx or .pdf) and return a preview. The instructor
// confirms it in the browser; the page's existing save path does the writing.
router.post('/workload/import', upload.single('workload'), WorkloadImportController.preview);
// Workload — Load timetable
// router.get('/workload/load', (req, res) => {
//     const data = getTimetable(1); // instructor ID 1 for prototype
//     res.json(data);
// });

// Workload — Save timetable
// router.post('/workload/save', (req, res) => {
//     const { subjects, blocks } = req.body;
//     if (!Array.isArray(subjects) || typeof blocks !== 'object') {
//         return res.status(400).json({ error: 'Invalid data' });
//     }
//     // Validate subjects
//     for (const s of subjects) {
//         if (!s.code || !s.code.trim() || !s.name || !s.name.trim()) {
//             return res.status(400).json({ error: 'Subject code and name are required.' });
//         }
//     }
//     // Preserve any existing make-up class blocks (added by dean approval) that the
//     // client may not have in its local state yet.
//     const existing = timetableStore[1] ? timetableStore[1].blocks || {} : {};
//     const mergedBlocks = Object.assign({}, blocks);
//     for (const [key, block] of Object.entries(existing)) {
//         if (block.type === 'Make Up Class' && !mergedBlocks[key]) {
//             mergedBlocks[key] = block;
//         }
//     }
//     timetableStore[1] = { subjects, blocks: mergedBlocks };
//     console.log('[Workload] Saved for instructor 1:', subjects.length, 'subjects,', Object.keys(mergedBlocks).length, 'blocks');
//     res.json({ success: true });
// });

// Workload — OCR Import
router.post('/workload/ocr-import', upload.single('schedule'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No image uploaded.' });
    const mime = req.file.mimetype;
    if (!['image/jpeg','image/png','image/webp'].includes(mime)) {
        return res.status(400).json({ success: false, error: 'Invalid file type. Use JPEG, PNG, or WEBP.' });
    }
    try {
        // tesseract.js downloads eng.traineddata on first use and caches it in
        // the working directory by default — which is why eng.traineddata sits
        // in the project root. That directory is read-only on a serverless
        // host, so the download fails and OCR reports a processing error. The
        // system temp directory is writable on both.
        // Loaded here, not at startup: only this OCR path uses it.
        const { createWorker } = require('tesseract.js');
        const worker = await createWorker('eng', 1, { cachePath: os.tmpdir() });
        const { data: { text } } = await worker.recognize(req.file.buffer);
        await worker.terminate();
        console.log('[OCR] Raw text length:', text.length);
        const parsed = parseScheduleText(text);
        if (!Object.keys(parsed.blocks).length && !parsed.subjects.length) {
            return res.json({ success: false, error: 'Could not detect a schedule in this image. Try a clearer, well-lit photo.' });
        }
        res.json({ success: true, data: parsed, rawText: text });
    } catch (err) {
        console.error('[OCR] Error:', err);
        res.status(500).json({ success: false, error: 'OCR processing failed. Please try again.' });
    }
});

router.get('/reports', InstructorController.renderReportsPage);


// Settings
router.get('/settings', InstructorController.renderSettingsPage);
router.patch('/profile',              InstructorController.updateOwnProfile);
router.patch('/password',             InstructorController.changePassword);
router.patch('/settings/notifications', InstructorController.updateNotificationPrefs);
router.patch('/settings/schedule',      InstructorController.updateScheduleSettings);

// Presence Logs (redirects to dashboard for now — presence data is shown in the Activity Feed)
router.get('/presence', (req, res) => {
    res.redirect('/instructor/dashboard');
});

// Consultations — Approve
router.post('/consultations/:id/approve', (req, res) => {
    const refNumber = req.params.id;
    const sr = getStudentRouter();
    const booking = sr.refStore && sr.refStore[refNumber];
    if (booking) {
        booking.status = 'confirmed';
        sr.confirmSlot(booking.facultyId, booking.day, booking.slot);
        console.log(`[Instructor] Approved booking ${refNumber}`);
        // Send approval email
        if (sr.sendApprovalEmail) {
            sr.sendApprovalEmail({
                studentEmail: booking.studentEmail,
                studentName:  booking.studentName,
                refNumber,
                facultyName:  booking.facultyName,
                slot:         booking.slot,
                date:         booking.date
            });
        }
    } else {
        console.log(`[Instructor] Approved appointment ID: ${refNumber}`);
    }
    res.json({ success: true, message: 'Appointment approved.' });
});

// Consultations — Decline
router.post('/consultations/:id/decline', (req, res) => {
    const refNumber = req.params.id;
    const { reason } = req.body;
    const sr = getStudentRouter();
    const booking = sr.refStore && sr.refStore[refNumber];
    if (booking) {
        booking.status = 'declined';
        booking.declineReason = reason || '';
        sr.releaseSlot(booking.facultyId, booking.day, booking.slot);
        console.log(`[Instructor] Declined booking ${refNumber}, reason: ${reason}`);
        // Send decline email
        if (sr.sendDeclineEmail) {
            sr.sendDeclineEmail({
                studentEmail: booking.studentEmail,
                studentName:  booking.studentName,
                refNumber,
                facultyName:  booking.facultyName,
                reason:       reason || ''
            });
        }
    } else {
        console.log(`[Instructor] Declined appointment ID: ${refNumber}, reason: ${reason}`);
    }
    res.json({ success: true, message: 'Appointment declined.' });
});

// ── Make-Up Class Request routes ──
// Persistence, conflict checking and notifications live in MakeupController.
// Specific paths are declared before the /:id ones so they are not swallowed.
// ── The instructor's own calendar, read through the Google API ──
// Connecting and disconnecting live on /google above; these manage the
// preferences and the pull. There is no longer a subscribe-by-URL route:
// pasting a secret iCal address was replaced by the Google connection, which
// is both simpler to set up and hours fresher.
router.get('/calendar/connections',        CalendarController.listConnections);
router.patch('/calendar/connections/:id',  CalendarController.updateConnection);
router.delete('/calendar/connections/:id', CalendarController.removeConnection);
router.post('/calendar/sync',              CalendarController.sync);
router.post('/calendar/sync/:id',          CalendarController.sync);
router.get('/calendar/events',             CalendarController.listEvents);
router.get('/calendar/pending',            CalendarController.listPending);
router.post('/calendar/decide',            CalendarController.decide);

// Outbound: the URL Google/Apple subscribe to. The feed itself is public and
// token-authenticated; these two are the logged-in half.
// ── The instructor's own events and tasks on the calendar ──
// 'conflicts' sits above ':id' so the literal path is not read as an id.
router.get('/events',                InstructorEventController.list);
router.post('/events/conflicts',     InstructorEventController.conflicts);
router.post('/events',               InstructorEventController.create);
router.patch('/events/:id',          InstructorEventController.update);
router.delete('/events/:id',         InstructorEventController.remove);

router.get('/calendar/feed-link',    CalendarFeedController.getMine);
router.post('/calendar/feed-link',   CalendarFeedController.rotate);

router.get('/makeup/requests',            MakeupController.renderRequestList);
router.get('/makeup/request',             MakeupController.renderRequestForm);
router.post('/makeup/request',            acceptDocuments, MakeupController.submitRequest);
router.get('/makeup/request/:id/edit',    MakeupController.renderRequestForm);
router.post('/makeup/request/:id',        acceptDocuments, MakeupController.submitRequest);
router.post('/makeup/check-conflicts',    MakeupController.checkConflicts);
router.post('/makeup/suggest-slots',      MakeupController.suggestSlots);
router.get('/makeup/document/:docId',     MakeupController.downloadDocument);
router.post('/makeup/:id/withdraw',       MakeupController.withdrawRequest);

// ── Unavailability Store ──
// key: 'YYYY-MM-DD' → { date, reason, blockedAt, cancelledRefs: [] }
const unavailabilityStore = {};

router.notificationsList    = notificationsList;
router.getScheduleStore     = () => scheduleStore;
router.unavailabilityStore  = unavailabilityStore;

module.exports = router;

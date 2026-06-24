const express = require('express');
const router = express.Router();
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const WorkloadController = require('../controllers/WorkloadController');
const { authenticateUser, createSession, getRoleRedirect, revokeSession } = require('../services/auth');
const { requireRole, setSessionCookie, clearSessionCookie } = require('../middleware/auth');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── PDF upload middleware for make-up class requests ──
const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Only PDF files are allowed.'));
    }
});

// Simple UUID v4 generator (no external dependency)
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Per-instructor timetable store (in-memory for prototype) ──
const timetableStore = {}; // key: instructorId → { subjects, blocks }

// ── Make-Up Class Request store (in-memory for prototype) ──
const requestStore = {}; // key: request UUID → MakeUpRequest

// ── Flash store for cross-redirect messages ──
const flashStore = { message: null, type: null };

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

// ── Room availability checker (scans all instructors) ──
function checkRoomAvailability(day, reqStart, reqEnd, roomName) {
    for (const [instrId, data] of Object.entries(timetableStore)) {
        const blocks = (data && data.blocks) ? data.blocks : {};
        for (const [key, block] of Object.entries(blocks)) {
            const parts = key.split('_');
            const blockDay = parts[0];
            const blockStartSlot = parseInt(parts[1]);
            if (blockDay !== day) continue;
            if (!block.room || block.room.toLowerCase() !== roomName.toLowerCase()) continue;
            const blockEndSlot = blockStartSlot + (block.duration || 1);
            if (reqStart < blockEndSlot && reqEnd > blockStartSlot) {
                return {
                    conflictingInstructor: instrId,
                    conflictingBlock: block,
                    timeRange: `${slotToLabel(blockStartSlot)} – ${slotToLabel(blockEndSlot)}`
                };
            }
        }
    }
    return null;
}

// ── Instructor availability checker ──
function checkInstructorAvailability(instructorId, day, reqStart, reqEnd) {
    const data = timetableStore[instructorId];
    const blocks = (data && data.blocks) ? data.blocks : {};
    for (const [key, block] of Object.entries(blocks)) {
        const parts = key.split('_');
        const blockDay = parts[0];
        const blockStartSlot = parseInt(parts[1]);
        if (blockDay !== day) continue;
        const blockEndSlot = blockStartSlot + (block.duration || 1);
        if (reqStart < blockEndSlot && reqEnd > blockStartSlot) {
            return {
                conflictingBlock: block,
                timeRange: `${slotToLabel(blockStartSlot)} – ${slotToLabel(blockEndSlot)}`
            };
        }
    }
    return null;
}

// ── Shared notifications list (module-level, persists for server session) ──
const notificationsList = [
    { id: 1, type: 'new-request',  message: 'New consultation request from Juan Dela Cruz',           time: '1 hour ago',  read: false },
    { id: 2, type: 'cancellation', message: 'Maria Garcia cancelled appointment for March 25',         time: '2 hours ago', read: false },
    { id: 3, type: 'reminder',     message: 'Upcoming consultation with Carlos Mendoza at 3:30 PM',   time: '3 hours ago', read: true  },
    { id: 4, type: 'alert',        message: 'Presence not detected during scheduled hours yesterday',  time: '1 day ago',   read: true  }
];
let notifIdCounter = 5;

function makeDemoPdf(title) {
    // Minimal valid PDF that displays a message
    const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>
stream
BT /F1 18 Tf 72 720 Td (Make-Up Class Request) Tj 0 -30 Td /F1 12 Tf (${title}) Tj 0 -20 Td (This is a demo document for prototype purposes.) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
446
%%EOF`;
    return Buffer.from(content);
}

function seedDemoMakeupRequests() {
    if (Object.keys(requestStore).length > 0) return;

    const now = Date.now();
    const demo = [
        {
            id: uuidv4(),
            instructorId: 1,
            instructorName: 'Dr. Maria Santos',
            subjectCode: 'ITEC 321',
            subjectName: 'Software Engineering',
            section: 'BSIT 3A',
            day: 'Saturday',
            startSlot: timeToSlot('09:00'),
            endSlot: timeToSlot('11:00'),
            deliveryMode: 'in-campus',
            room: 'Room 201',
            document: {
                buffer: Buffer.from('Demo PDF placeholder'),
                originalname: 'makeup-request-it321.pdf',
                mimetype: 'application/pdf'
            },
            submittedAt: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
            status: 'pending',
            approvedBy: '',
            declineReason: ''
        },
        {
            id: uuidv4(),
            instructorId: 1,
            instructorName: 'Dr. Maria Santos',
            subjectCode: 'ITEC 215',
            subjectName: 'Database Systems',
            section: 'BSIT 2B',
            day: 'Friday',
            startSlot: timeToSlot('13:00'),
            endSlot: timeToSlot('15:00'),
            deliveryMode: 'online',
            room: '',
            document: {
                buffer: Buffer.from('Demo PDF placeholder'),
                originalname: 'makeup-request-it215.pdf',
                mimetype: 'application/pdf'
            },
            submittedAt: new Date(now - 1000 * 60 * 60 * 72).toISOString(),
            status: 'approved',
            approvedBy: 'Dr. Lourdes Reyes',
            deanStatement: 'This make-up class is hereby approved. The instructor is authorized to conduct the session as scheduled. Please coordinate with the registrar for proper documentation.',
            declineReason: ''
        },
        {
            id: uuidv4(),
            instructorId: 1,
            instructorName: 'Dr. Maria Santos',
            subjectCode: 'ITEC 101',
            subjectName: 'Introduction to Computing',
            section: 'BSIT 1A',
            day: 'Thursday',
            startSlot: timeToSlot('10:00'),
            endSlot: timeToSlot('11:00'),
            deliveryMode: 'in-campus',
            room: 'Room 105',
            document: {
                buffer: Buffer.from('Demo PDF placeholder'),
                originalname: 'makeup-request-it101.pdf',
                mimetype: 'application/pdf'
            },
            submittedAt: new Date(now - 1000 * 60 * 60 * 120).toISOString(),
            status: 'declined',
            approvedBy: '',
            declineReason: 'Requested room is reserved for accreditation activities.'
        }
    ];

    demo.forEach((item) => {
        requestStore[item.id] = item;
    });
}

seedDemoMakeupRequests();

function getTimetable(instructorId) {
    return timetableStore[instructorId] || { subjects: [], blocks: {} };
}

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

// Save schedule POST — called from the schedule page via fetch
router.post('/schedule/save', (req, res) => {
    const { slots } = req.body;
    if (!Array.isArray(slots)) return res.status(400).json({ error: 'Invalid data' });
    // Validate: each must have day/timeStart/timeEnd/maxCapacity
    const cleaned = slots.map(s => ({
        day:         String(s.day || '').trim(),
        timeStart:   String(s.timeStart || '').trim(),
        timeEnd:     String(s.timeEnd || '').trim(),
        maxCapacity: Math.max(1, parseInt(s.maxCapacity) || 3),
        bookedCount: parseInt(s.bookedCount) || 0,
        status:      ['open','full','closed'].includes(s.status) ? s.status : 'open'
    })).filter(s => s.day && s.timeStart && s.timeEnd);
    scheduleStore[1] = cleaned;
    console.log('[Schedule] Saved:', JSON.stringify(cleaned));
    res.json({ success: true, slots: cleaned });
});

// Instructor Login page
router.get('/login', (req, res) => {
    res.render('pages/instructor/login', { 
        title: 'FaciTrack - Instructor Login',
        error: null 
    });
});

// Instructor Login POST handler
router.post('/login', (req, res) => {
    const { email } = req.body;
    
    // Input validation
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
        return res.render('pages/instructor/login', { 
            title: 'FaciTrack - Instructor Login',
            error: 'Please enter your email address.' 
        });
    }
    
    // PROTOTYPE MODE: Accept any email without password verification
    const { readData } = require('../services/data-store');
    const db = readData();
    const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === email.trim().toLowerCase());
    
    if (user && user.role === 'instructor') {
        const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '' });
        setSessionCookie(res, session.token);
        res.redirect(getRoleRedirect(user.role));
    } else {
        res.render('pages/instructor/login', { 
            title: 'FaciTrack - Instructor Login',
            error: 'Instructor user not found.'
        });
    }
});

router.post('/logout', (req, res) => {
    if (req.authToken) revokeSession(req.authToken);
    clearSessionCookie(res);
    return res.redirect('/');
});
router.get('/logout', (req, res) => {
    if (req.authToken) revokeSession(req.authToken);
    clearSessionCookie(res);
    return res.redirect('/');
});

// PROTOTYPE MODE: Disabled role check to allow free navigation
// router.use(requireRole('instructor'));

// Instructor Dashboard
router.get('/dashboard', (req, res) => {
    const data = getSharedData();
    res.render('pages/instructor/dashboard', {
        title: 'FaciTrack - Instructor Dashboard',
        ...data
    });
});

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

// Consultations
// Supports query parameters: ?status=pending|confirmed|declined&page=N
router.get('/consultations', (req, res) => {
    const data = getSharedData();
    const { status } = req.query;

    let filteredAppointments = data.appointments;
    if (status) {
        filteredAppointments = filteredAppointments.filter(a => a.status === status);
    }

    res.render('pages/instructor/consultations', {
        title: 'FaciTrack - Consultations',
        ...data,
        appointments: filteredAppointments,
        filterStatus: status || '',
        pendingCount: data.appointments.filter(a => a.status === 'pending').length
    });
});

// Schedule
router.get('/schedule', (req, res) => {
    const data = getSharedData();
    res.render('pages/instructor/schedule', {
        title: 'FaciTrack - Schedule',
        ...data,
        pendingCount: data.appointments.filter(a => a.status === 'pending').length
    });
});

router.get('/workload', WorkloadController.renderPage);
router.post('/workload/save', WorkloadController.save);
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
        const worker = await createWorker('eng');
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

// Workload page
// router.get('/workload', (req, res) => {
//     const data = getSharedData();
//     res.render('pages/instructor/workload', {
//         title: 'FaciTrack - Workload',
//         ...data,
//         pendingCount: data.appointments.filter(a => a.status === 'pending').length
//     });
// });

// Reports
router.get('/reports', (req, res) => {
    const data = getSharedData();
    const timetable = getTimetable(1);

    // Build workload log rows from timetable blocks
    // Each block: key = "Day_slotIndex", value = { subjectCode, subjectName, room, duration, type }
    const DAYS_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const workloadLogs = [];
    const { subjects, blocks } = timetable;
    const subjectMap = {};
    (subjects || []).forEach(s => { subjectMap[s.code] = s.name || s.code; });

    Object.entries(blocks || {}).forEach(([key, block]) => {
        const parts = key.split('_');
        const day = parts[0];
        const slotIdx = parseInt(parts[1], 10);
        const timeLabel = slotToLabel(slotIdx);
        const endLabel  = slotToLabel(slotIdx + (block.duration || 1));
        workloadLogs.push({
            day,
            dayOrder: DAYS_ORDER.indexOf(day),
            slotIdx,
            timeRange: `${timeLabel} – ${endLabel}`,
            subjectCode: block.subjectCode || '—',
            subjectName: subjectMap[block.subjectCode] || block.subjectName || block.subjectCode || '—',
            room: block.room || '—',
            type: block.type || 'Regular',
            duration: block.duration || 1
        });
    });

    // Sort by day order then slot
    workloadLogs.sort((a, b) => a.dayOrder - b.dayOrder || a.slotIdx - b.slotIdx);

    res.render('pages/instructor/reports', {
        title: 'FaciTrack - Reports',
        ...data,
        workloadLogs,
        pendingCount: data.appointments.filter(a => a.status === 'pending').length
    });
});

// Settings
router.get('/settings', (req, res) => {
    const data = getSharedData();
    res.render('pages/instructor/settings', {
        title: 'FaciTrack - Settings',
        ...data,
        pendingCount: data.appointments.filter(a => a.status === 'pending').length
    });
});

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

// GET: View submitted PDF document (instructor's own requests)
router.get('/makeup/:id/document', (req, res) => {
    const request = requestStore[req.params.id];
    if (!request) return res.status(404).send('Request not found.');
    if (!request.document || !request.document.buffer) return res.status(404).send('No document attached.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${request.document.originalname || 'document.pdf'}"`);
    res.send(request.document.buffer);
});

// GET: Subject code lookup (AJAX)
router.get('/makeup/subject-lookup', (req, res) => {
    const code = String(req.query.code || '').trim().toLowerCase();
    const subjects = (timetableStore[1] && timetableStore[1].subjects) || [];
    const match = subjects.find(s => s.code && s.code.toLowerCase() === code);
    res.json({ subjectName: match ? match.name : null });
});

// ── Helper: Get available rooms (simulated database) ──
function getAvailableRooms() {
    return ['Room 101', 'Room 102', 'Room 201', 'Room 202', 'Room 301', 'Room 302', 'Lab A', 'Lab B', 'Online Session'];
}

// ── Helper: Get all instructor workload ──
function getAllInstructorWorkload() {
    const workload = {};
    for (const [instrId, data] of Object.entries(timetableStore)) {
        workload[instrId] = data ? data.blocks || {} : {};
    }
    return workload;
}

// ── Helper: Check if slot is available for room ──
function isRoomAvailableForSlot(room, day, startSlot, endSlot) {
    const allWorkload = getAllInstructorWorkload();
    for (const [instrId, blocks] of Object.entries(allWorkload)) {
        for (const [key, block] of Object.entries(blocks)) {
            const parts = key.split('_');
            const blockDay = parts[0];
            if (blockDay !== day) continue;
            if (!block.room || block.room.toLowerCase() !== room.toLowerCase()) continue;
            const blockStartSlot = parseInt(parts[1]);
            const blockEndSlot = blockStartSlot + (block.duration || 1);
            if (startSlot < blockEndSlot && endSlot > blockStartSlot) {
                return false; // Conflict
            }
        }
    }
    return true; // Available
}

// ── Helper: Find available time slots for a given day ──
function getAvailableTimeSlotsForDay(instructorId, day, durationSlots) {
    const data = timetableStore[instructorId];
    const blocks = (data && data.blocks) ? data.blocks : {};
    const occupiedSlots = new Set();

    // Mark all occupied slots for this day
    for (const [key, block] of Object.entries(blocks)) {
        const parts = key.split('_');
        const blockDay = parts[0];
        if (blockDay !== day) continue;
        const blockStartSlot = parseInt(parts[1]);
        const blockEndSlot = blockStartSlot + (block.duration || 1);
        for (let s = blockStartSlot; s < blockEndSlot; s++) {
            occupiedSlots.add(s);
        }
    }

    // Find available time windows (during business hours: 7 AM to 6 PM = slots 14-36)
    const availableSlots = [];
    for (let slot = 14; slot <= 36 - durationSlots; slot++) {
        let isAvailable = true;
        for (let s = slot; s < slot + durationSlots; s++) {
            if (occupiedSlots.has(s)) {
                isAvailable = false;
                break;
            }
        }
        if (isAvailable) {
            availableSlots.push(slot);
        }
    }

    return availableSlots;
}

// POST: Generate available schedule options
router.post('/makeup/generate-schedule', (req, res) => {
    const { subjectCode, classType, deliveryMode, section } = req.body;
    const instructorId = 1; // Current instructor
    const durationHours = classType === 'Laboratory' ? 3 : 2;
    const durationSlots = durationHours * 2; // Each slot = 30 min

    if (!subjectCode || !classType || !deliveryMode) {
        return res.json({ success: false, error: 'Missing required fields' });
    }

    // Generate options for next 10 business days
    const today = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const options = [];
    let currentDate = new Date(today);
    currentDate.setDate(currentDate.getDate() + 1); // Start from tomorrow

    const weekdayNames = { 'Monday': 'Monday', 'Tuesday': 'Tuesday', 'Wednesday': 'Wednesday', 'Thursday': 'Thursday', 'Friday': 'Friday' };
    const weekdayOrder = { 'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 'Friday': 5 };

    while (options.length < 5 && currentDate < new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)) {
        const dow = currentDate.getDay();
        const dayName = dayNames[dow];

        // Only consider weekdays
        if (weekdayNames[dayName]) {
            const availableSlots = getAvailableTimeSlotsForDay(instructorId, dayName, durationSlots);

            // Try to find a good room-time combination
            for (const slot of availableSlots) {
                const startSlot = slot;
                const endSlot = slot + durationSlots;
                const rooms = getAvailableRooms();

                // Find first available room for this time slot
                for (const room of rooms) {
                    if (isRoomAvailableForSlot(room, dayName, startSlot, endSlot)) {
                        const startTime = slotToLabel(startSlot);
                        const endTime = slotToLabel(endSlot);

                        options.push({
                            date: currentDate.toISOString().split('T')[0],
                            day: dayName,
                            startTime,
                            endTime,
                            room,
                            startSlot,
                            endSlot,
                            duration: durationHours
                        });

                        break; // Move to next time slot after finding a room
                    }
                }

                if (options.length >= 5) break;
            }
        }

        currentDate.setDate(currentDate.getDate() + 1);
    }

    if (options.length === 0) {
        return res.json({ success: false, error: 'Unable to generate schedule options. Please try again later.' });
    }

    // Store for validation later
    req.session = req.session || {};
    req.session.lastGeneratedOptions = options;

    res.json({ success: true, options });
});

// GET: Submission form
router.get('/makeup/request', (req, res) => {
    const data = getSharedData();
    const flash = flashStore.message ? { message: flashStore.message, type: flashStore.type } : null;
    flashStore.message = null; flashStore.type = null;
    res.render('pages/instructor/makeup-request', {
        title: 'FaciTrack - Make-Up Class Request',
        ...data,
        pendingCount: data.appointments.filter(a => a.status === 'pending').length,
        flash,
        formError: null,
        formValues: {}
    });
});

// POST: Submit request (multipart/form-data with PDF)
router.post('/makeup/request', (req, res, next) => {
    pdfUpload.single('document')(req, res, (uploadErr) => {
        const data = getSharedData();
        const pendingCount = data.appointments.filter(a => a.status === 'pending').length;

        const subjectCode  = String(req.body.subjectCode  || '').trim();
        const subjectName  = String(req.body.subjectName  || '').trim() || subjectCode;
        const section      = String(req.body.section      || '').trim();
        const day          = String(req.body.day          || '').trim();
        const date         = String(req.body.date         || '').trim();
        const classType    = String(req.body.classType    || '').trim();
        const startTime    = String(req.body.startTime    || '').trim();
        const endTime      = String(req.body.endTime      || '').trim();
        const deliveryMode = 'in-campus'; // System-generated for makeup classes
        const room         = String(req.body.room         || '').trim();

        const validDays  = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
        const validModes = ['in-campus','online'];

        const formValues = { subjectCode, subjectName, section, day, startTime, endTime, deliveryMode, room };

        // PDF upload error (wrong file type)
        if (uploadErr) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: uploadErr.message || 'Invalid file. Please attach a PDF.',
                formValues
            });
        }

        // Field validation
        if (!subjectCode || !section || !day || !date || !startTime || !endTime || !classType) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: 'All required fields must be filled in.',
                formValues
            });
        }
        if (!req.file) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: 'A supporting PDF document is required.',
                formValues
            });
        }
        if (!validDays.includes(day)) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: 'Please select a valid day.',
                formValues
            });
        }
        if (deliveryMode === 'in-campus' && !room) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: 'Room is required for in-campus make-up classes.',
                formValues
            });
        }

        const startSlot = timeToSlot(startTime);
        const endSlot   = timeToSlot(endTime);
        if (endSlot <= startSlot) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: 'End time must be after start time.',
                formValues
            });
        }

        // Room availability check (in-campus only)
        if (deliveryMode === 'in-campus') {
            const roomConflict = checkRoomAvailability(day, startSlot, endSlot, room);
            if (roomConflict) {
                return res.render('pages/instructor/makeup-request', {
                    title: 'FaciTrack - Make-Up Class Request',
                    ...data, pendingCount, flash: null,
                    formError: `Room conflict: "${room}" is already occupied on ${day} from ${roomConflict.timeRange}.`,
                    formValues
                });
            }
        }

        // Instructor availability check
        const instrConflict = checkInstructorAvailability(1, day, startSlot, endSlot);
        if (instrConflict) {
            return res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                ...data, pendingCount, flash: null,
                formError: `Schedule conflict: you already have a class on ${day} from ${instrConflict.timeRange}.`,
                formValues
            });
        }

        // Create request record
        const id = uuidv4();
        requestStore[id] = {
            id,
            instructorId:   1,
            instructorName: 'Dr. Maria Santos',
            subjectCode,
            subjectName,
            section,
            date,
            day,
            classType,
            startSlot,
            endSlot,
            startTime,
            endTime,
            deliveryMode,
            room,
            document: {
                buffer:       req.file.buffer,
                originalname: req.file.originalname,
                mimetype:     req.file.mimetype
            },
            submittedAt:   new Date().toISOString(),
            status:        'pending',
            approvedBy:    '',
            declineReason: ''
        };

        // Add notification
        notificationsList.unshift({
            id:      notifIdCounter++,
            type:    'makeup',
            message: `Make-up class request submitted for ${subjectCode} on ${day} (${slotToLabel(startSlot)} – ${slotToLabel(endSlot)})`,
            time:    'Just now',
            read:    false
        });

        flashStore.message = `Your make-up class request for ${subjectCode} has been submitted for dean review.`;
        flashStore.type    = 'success';
        res.redirect('/instructor/makeup/requests');
    });
});

// GET: Instructor's own request list
router.get('/makeup/requests', (req, res) => {
    const data = getSharedData();
    const flash = flashStore.message ? { message: flashStore.message, type: flashStore.type } : null;
    flashStore.message = null; flashStore.type = null;

    const myRequests = Object.values(requestStore)
        .filter(r => r.instructorId === 1)
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.render('pages/instructor/makeup-requests', {
        title: 'FaciTrack - My Make-Up Requests',
        ...data,
        pendingCount: data.appointments.filter(a => a.status === 'pending').length,
        flash,
        myRequests,
        slotToLabel
    });
});

router.requestStore       = requestStore;
router.timetableStore     = timetableStore;
router.notificationsList  = notificationsList;
router.slotToLabel        = slotToLabel;
router.getScheduleStore   = () => scheduleStore;

module.exports = router;

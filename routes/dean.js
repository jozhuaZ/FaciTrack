const express = require('express');
const router = express.Router();
const { authenticateUser, createSession, getRoleRedirect, revokeSession } = require('../services/auth');
const { requireRole, setSessionCookie, clearSessionCookie } = require('../middleware/auth');

// Import shared stores from instructor router
const instructorRouter = require('./instructor');

// Router-level middleware: log all dean route requests
router.use((req, res, next) => {
    console.log(`[Dean Router] ${req.method} ${req.originalUrl}`);
    next();
});

// Dean Login page
router.get('/login', (req, res) => {
    res.render('pages/dean/login', { 
        title: 'FaciTrack - Dean Login',
        error: null 
    });
});

// Dean Login POST handler
router.post('/login', (req, res) => {
    const { email } = req.body;
    
    // Input validation
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
        return res.render('pages/dean/login', { 
            title: 'FaciTrack - Dean Login',
            error: 'Please enter your email address.' 
        });
    }
    
    // PROTOTYPE MODE: Accept any email without password verification
    const { readData } = require('../services/data-store');
    const db = readData();
    const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === email.trim().toLowerCase());
    
    if (user && user.role === 'dean') {
        const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '' });
        setSessionCookie(res, session.token);
        res.redirect(getRoleRedirect(user.role));
    } else {
        res.render('pages/dean/login', { 
            title: 'FaciTrack - Dean Login',
            error: 'Dean user not found.' 
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
// router.use(requireRole('dean'));

// Shared simulated data
function getSharedData() {
    const dean = {
        name: 'Dr. Lourdes Reyes',
        email: 'dean@cspc.edu.ph',
        position: 'Dean',
        department: 'College of Computer Studies'
    };

    const faculty = [
        {
            id: 1,
            name: 'Dr. Maria Santos',
            position: 'Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 201',
            bleStatus: 'in-room',
            bleLastDetected: '2 minutes ago',
            hoursThisMonth: 48,
            consultationsThisMonth: 32,
            avgDuration: '42 min'
        },
        {
            id: 2,
            name: 'Prof. Jose Dela Cruz',
            position: 'Associate Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 105',
            bleStatus: 'out-of-room',
            bleLastDetected: '1 hour ago',
            hoursThisMonth: 36,
            consultationsThisMonth: 24,
            avgDuration: '38 min'
        },
        {
            id: 3,
            name: 'Dr. Ana Villanueva',
            position: 'Assistant Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 203',
            bleStatus: 'in-room',
            bleLastDetected: '5 minutes ago',
            hoursThisMonth: 42,
            consultationsThisMonth: 28,
            avgDuration: '45 min'
        },
        {
            id: 4,
            name: 'Prof. Carlos Bautista',
            position: 'Instructor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 102',
            bleStatus: 'out-of-room',
            bleLastDetected: '3 hours ago',
            hoursThisMonth: 30,
            consultationsThisMonth: 18,
            avgDuration: '35 min'
        },
        {
            id: 5,
            name: 'Dr. Ramon Aquino',
            position: 'Associate Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 204',
            bleStatus: 'in-room',
            bleLastDetected: '10 minutes ago',
            hoursThisMonth: 40,
            consultationsThisMonth: 22,
            avgDuration: '40 min'
        },
        {
            id: 6,
            name: 'Prof. Liza Navarro',
            position: 'Instructor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 106',
            bleStatus: 'in-room',
            bleLastDetected: '8 minutes ago',
            hoursThisMonth: 28,
            consultationsThisMonth: 15,
            avgDuration: '33 min'
        },
        {
            id: 7,
            name: 'Dr. Eduardo Flores',
            position: 'Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 202',
            bleStatus: 'in-room',
            bleLastDetected: '3 minutes ago',
            hoursThisMonth: 44,
            consultationsThisMonth: 30,
            avgDuration: '44 min'
        },
        {
            id: 8,
            name: 'Prof. Grace Mendoza',
            position: 'Assistant Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 107',
            bleStatus: 'out-of-room',
            bleLastDetected: '2 hours ago',
            hoursThisMonth: 32,
            consultationsThisMonth: 20,
            avgDuration: '36 min'
        },
        {
            id: 9,
            name: 'Dr. Benjamin Reyes',
            position: 'Associate Professor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 205',
            bleStatus: 'in-room',
            bleLastDetected: '15 minutes ago',
            hoursThisMonth: 38,
            consultationsThisMonth: 25,
            avgDuration: '39 min'
        },
        {
            id: 10,
            name: 'Prof. Maricel Castro',
            position: 'Instructor',
            department: 'College of Computer Studies',
            officeRoom: 'CCS Building, Room 103',
            bleStatus: 'out-of-room',
            bleLastDetected: '4 hours ago',
            hoursThisMonth: 26,
            consultationsThisMonth: 14,
            avgDuration: '32 min'
        }
    ];

    // Generate dates relative to today so period filters (This Week / This Month) work
    function relDate(offsetDays) {
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        return d.toISOString().split('T')[0]; // YYYY-MM-DD for reliable Date parsing
    }
    const allAppointments = [
        { id: 1,  studentName: 'Juan Dela Cruz',    studentId: '2021-00123', instructorName: 'Dr. Maria Santos',     date: relDate(0),  time: '2:00 PM',  duration: '30 minutes', topic: 'Thesis consultation regarding system architecture', status: 'pending',   isToday: true  },
        { id: 2,  studentName: 'Ana Reyes',          studentId: '2021-00456', instructorName: 'Dr. Maria Santos',     date: relDate(1),  time: '10:00 AM', duration: '30 minutes', topic: 'Grade inquiry for Midterm exam',                    status: 'pending',   isToday: false },
        { id: 3,  studentName: 'Carlos Mendoza',     studentId: '2021-00789', instructorName: 'Dr. Maria Santos',     date: relDate(0),  time: '3:30 PM',  duration: '45 minutes', topic: 'Project proposal review',                           status: 'confirmed', isToday: true  },
        { id: 4,  studentName: 'Maria Garcia',       studentId: '2021-00321', instructorName: 'Prof. Jose Dela Cruz', date: relDate(-2), time: '1:00 PM',  duration: '30 minutes', topic: 'Academic advising',                                 status: 'declined',  isToday: false },
        { id: 5,  studentName: 'Pedro Lim',          studentId: '2022-00111', instructorName: 'Dr. Ana Villanueva',   date: relDate(0),  time: '9:00 AM',  duration: '30 minutes', topic: 'Research methodology guidance',                     status: 'confirmed', isToday: true  },
        { id: 6,  studentName: 'Rosa Fernandez',     studentId: '2022-00222', instructorName: 'Prof. Carlos Bautista',date: relDate(1),  time: '11:00 AM', duration: '45 minutes', topic: 'Capstone project feedback',                         status: 'pending',   isToday: false },
        { id: 7,  studentName: 'Luis Torres',        studentId: '2021-00555', instructorName: 'Dr. Ana Villanueva',   date: relDate(-1), time: '2:00 PM',  duration: '30 minutes', topic: 'Grade reconsideration request',                     status: 'confirmed', isToday: false },
        { id: 8,  studentName: 'Kristine Uy',        studentId: '2022-00333', instructorName: 'Dr. Ramon Aquino',     date: relDate(0),  time: '1:00 PM',  duration: '30 minutes', topic: 'AI project consultation',                           status: 'confirmed', isToday: true  },
        { id: 9,  studentName: 'Mark Villanueva',    studentId: '2022-00444', instructorName: 'Prof. Liza Navarro',   date: relDate(2),  time: '2:00 PM',  duration: '45 minutes', topic: 'Web app debugging session',                         status: 'pending',   isToday: false },
        { id: 10, studentName: 'Sheila Ramos',       studentId: '2021-00666', instructorName: 'Dr. Eduardo Flores',   date: relDate(0),  time: '3:00 PM',  duration: '30 minutes', topic: 'Network security thesis review',                    status: 'confirmed', isToday: true  },
        { id: 11, studentName: 'Jerome Pascual',     studentId: '2022-00555', instructorName: 'Prof. Grace Mendoza',  date: relDate(3),  time: '10:00 AM', duration: '30 minutes', topic: 'Mobile app UI feedback',                            status: 'pending',   isToday: false },
        { id: 12, studentName: 'Diane Soriano',      studentId: '2021-00777', instructorName: 'Dr. Benjamin Reyes',   date: relDate(0),  time: '11:00 AM', duration: '45 minutes', topic: 'Data science capstone guidance',                    status: 'confirmed', isToday: true  },
        { id: 13, studentName: 'Ryan Ocampo',        studentId: '2022-00666', instructorName: 'Prof. Maricel Castro', date: relDate(1),  time: '1:00 PM',  duration: '30 minutes', topic: 'System design review',                              status: 'pending',   isToday: false }
    ];

    const presenceLogs = [
        { facultyName: 'Dr. Maria Santos', timestamp: '2026-03-17 09:15 AM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { facultyName: 'Dr. Maria Santos', timestamp: '2026-03-17 11:30 AM', status: 'exited', location: 'CCS Building, Room 201', duration: '2h 15m' },
        { facultyName: 'Dr. Ana Villanueva', timestamp: '2026-03-17 08:45 AM', status: 'entered', location: 'CCS Building, Room 203', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', timestamp: '2026-03-17 09:00 AM', status: 'entered', location: 'CCS Building, Room 105', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', timestamp: '2026-03-17 10:00 AM', status: 'exited', location: 'CCS Building, Room 105', duration: '1h 0m' },
        { facultyName: 'Dr. Maria Santos', timestamp: '2026-03-17 01:00 PM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { facultyName: 'Prof. Carlos Bautista', timestamp: '2026-03-17 07:30 AM', status: 'entered', location: 'CCS Building, Room 102', duration: null },
        { facultyName: 'Prof. Carlos Bautista', timestamp: '2026-03-17 10:30 AM', status: 'exited', location: 'CCS Building, Room 102', duration: '3h 0m' },
        { facultyName: 'Dr. Ramon Aquino', timestamp: '2026-03-17 08:00 AM', status: 'entered', location: 'CCS Building, Room 204', duration: null },
        { facultyName: 'Dr. Ramon Aquino', timestamp: '2026-03-17 11:00 AM', status: 'exited', location: 'CCS Building, Room 204', duration: '3h 0m' },
        { facultyName: 'Prof. Liza Navarro', timestamp: '2026-03-17 09:30 AM', status: 'entered', location: 'CCS Building, Room 106', duration: null },
        { facultyName: 'Dr. Eduardo Flores', timestamp: '2026-03-17 08:30 AM', status: 'entered', location: 'CCS Building, Room 202', duration: null },
        { facultyName: 'Prof. Grace Mendoza', timestamp: '2026-03-17 07:45 AM', status: 'entered', location: 'CCS Building, Room 107', duration: null },
        { facultyName: 'Prof. Grace Mendoza', timestamp: '2026-03-17 09:45 AM', status: 'exited', location: 'CCS Building, Room 107', duration: '2h 0m' },
        { facultyName: 'Dr. Benjamin Reyes', timestamp: '2026-03-17 10:00 AM', status: 'entered', location: 'CCS Building, Room 205', duration: null },
        { facultyName: 'Prof. Maricel Castro', timestamp: '2026-03-17 07:00 AM', status: 'entered', location: 'CCS Building, Room 103', duration: null },
        { facultyName: 'Prof. Maricel Castro', timestamp: '2026-03-17 11:00 AM', status: 'exited', location: 'CCS Building, Room 103', duration: '4h 0m' }
    ];

    const recentActivity = presenceLogs.slice(0, 6);

    const notifications = [
        { id: 1, type: 'makeup',       message: 'Dr. Maria Santos submitted a make-up class request for Software Engineering.',  time: '1 hour ago',  read: false },
        { id: 2, type: 'makeup',       message: 'Prof. Jose Dela Cruz submitted a make-up class request for Database Systems.',   time: '3 hours ago', read: false },
        { id: 3, type: 'presence',     message: 'Dr. Ana Villanueva has not been detected in Room 203 during scheduled hours.',   time: '5 hours ago', read: false },
        { id: 4, type: 'appointment',  message: 'Juan Dela Cruz booked a consultation with Dr. Maria Santos for today at 2:00 PM.', time: 'Yesterday',  read: true  },
        { id: 5, type: 'presence',     message: 'Prof. Carlos Bautista entered Room 102 at 7:30 AM.',                             time: 'Yesterday',   read: true  },
        { id: 6, type: 'appointment',  message: 'Ana Reyes cancelled her appointment with Dr. Maria Santos.',                     time: '2 days ago',  read: true  }
    ];

    return { dean, faculty, allAppointments, presenceLogs, recentActivity, notifications };
}

// Helper to get pending makeup count for sidebar badge
function getPendingMakeupCount() {
    const requestStore = instructorRouter.requestStore || {};
    return Object.values(requestStore).filter(r => r.status === 'pending').length;
}

// Dean Dashboard
router.get('/dashboard', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/dashboard', {
        title: 'FaciTrack - Dean Dashboard',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// Faculty list with real-time BLE status
// Supports query parameters: ?bleStatus=in-room|out-of-room
router.get('/faculty', (req, res) => {
    const data = getSharedData();
    const { bleStatus } = req.query;

    let filteredFaculty = data.faculty;
    if (bleStatus) {
        filteredFaculty = filteredFaculty.filter(f => f.bleStatus === bleStatus);
    }

    res.render('pages/dean/faculty', {
        title: 'FaciTrack - Faculty',
        ...data,
        faculty: filteredFaculty,
        filterBleStatus: bleStatus || '',
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// Add instructor (POST) — prototype: returns success JSON
router.post('/faculty', (req, res) => {
    const { name, position, officeRoom } = req.body;
    if (!name || !position || !officeRoom) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }
    // In a real app this would persist to DB; prototype just acknowledges
    res.json({ success: true, message: `${name} added to faculty list.` });
});

// Delete instructor (POST with _method override or direct DELETE)
router.post('/faculty/:id/delete', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid ID.' });
    // In a real app this would remove from DB; prototype just acknowledges
    res.json({ success: true, message: `Instructor #${id} removed.` });
});

// Monitoring — redirects to Faculty (merged page)
router.get('/monitoring', (_req, res) => {
    res.redirect('/dean/faculty');
});

// Workload reports per faculty
router.get('/reports', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/reports', {
        title: 'FaciTrack - Reports',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// Presence Logs
router.get('/presence', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/presence', {
        title: 'FaciTrack - Presence Logs',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// Settings
router.get('/settings', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/settings', {
        title: 'FaciTrack - Settings',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// ── Make-Up Class Request routes (Dean) ──

// GET: Dean's review queue
router.get('/makeup/requests', (req, res) => {
    const data = getSharedData();
    const requestStore = instructorRouter.requestStore || {};
    const allRequests  = Object.values(requestStore).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const pending   = allRequests.filter(r => r.status === 'pending');
    const approved  = allRequests.filter(r => r.status === 'approved');
    const declined  = allRequests.filter(r => r.status === 'declined');
    const slotToLabel = instructorRouter.slotToLabel || (s => String(s));

    res.render('pages/dean/makeup-requests', {
        title: 'FaciTrack - Make-Up Requests',
        ...data,
        pending, approved, declined,
        pendingMakeupCount: pending.length,
        slotToLabel
    });
});

// GET: Stream PDF document for a request
router.get('/makeup/:id/document', (req, res) => {
    const requestStore = instructorRouter.requestStore || {};
    const request = requestStore[req.params.id];
    if (!request) return res.status(404).send('Request not found.');
    if (!request.document || !request.document.buffer) return res.status(404).send('No document attached.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${request.document.originalname || 'document.pdf'}"`);
    res.send(request.document.buffer);
});

// POST: Approve a request
router.post('/makeup/:id/approve', (req, res) => {
    const requestStore   = instructorRouter.requestStore   || {};
    const timetableStore = instructorRouter.timetableStore || {};
    const notifList      = instructorRouter.notificationsList || [];
    const slotToLabel    = instructorRouter.slotToLabel || (s => String(s));

    const request = requestStore[req.params.id];
    if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ success: false, error: 'Request already actioned.' });

    const confirmed = req.body.confirmed === true || req.body.confirmed === 'true';
    if (!confirmed) return res.status(400).json({ success: false, error: 'Approval must be confirmed with signature.' });

    request.status     = 'approved';
    request.approvedBy = 'Dr. Lourdes Reyes';
    request.deanStatement = String(req.body.statement || '').trim();

    // Write MakeUpClass block to timetableStore
    if (!timetableStore[request.instructorId]) {
        timetableStore[request.instructorId] = { subjects: [], blocks: {} };
    }
    const blockKey = `${request.day}_${request.startSlot}`;
    timetableStore[request.instructorId].blocks[blockKey] = {
        subjectId:   request.subjectCode || request.subjectName,
        subjectName: request.subjectName || request.subjectCode,
        room:        request.deliveryMode === 'online' ? 'Online' : request.room,
        section:     request.section,
        type:        'Make Up Class',
        duration:    request.endSlot - request.startSlot,
        color:       '#10b981'
    };

    // Notify instructor
    notifList.unshift({
        id:      Date.now(),
        type:    'makeup',
        message: `Your make-up class request for ${request.subjectCode} on ${request.day} (${slotToLabel(request.startSlot)} – ${slotToLabel(request.endSlot)}) was approved.`,
        time:    'Just now',
        read:    false
    });

    res.json({ success: true, updatedRequest: request });
});

// POST: Decline a request
router.post('/makeup/:id/decline', (req, res) => {
    const requestStore = instructorRouter.requestStore || {};
    const notifList    = instructorRouter.notificationsList || [];
    const slotToLabel  = instructorRouter.slotToLabel || (s => String(s));

    const request = requestStore[req.params.id];
    if (!request) return res.status(404).json({ success: false, error: 'Request not found.' });
    if (request.status !== 'pending') return res.status(400).json({ success: false, error: 'Request already actioned.' });

    const declineReason = String(req.body.reason || '').trim();
    if (!declineReason) return res.status(400).json({ success: false, error: 'Decline reason is required.' });

    request.status        = 'declined';
    request.declineReason = declineReason;

    // Notify instructor
    notifList.unshift({
        id:      Date.now(),
        type:    'makeup',
        message: `Your make-up class request for ${request.subjectCode} on ${request.day} (${slotToLabel(request.startSlot)} – ${slotToLabel(request.endSlot)}) was declined. Reason: ${declineReason}`,
        time:    'Just now',
        read:    false
    });

    res.json({ success: true, updatedRequest: request });
});

module.exports = router;


// 3D Building Viewer
router.get('/building', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/building', {
        title: 'FaciTrack - 3D Building Viewer',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

// Rooms page
router.get('/rooms', (req, res) => {
    const data = getSharedData();
    res.render('pages/dean/rooms', {
        title: 'FaciTrack - Room Management',
        ...data,
        pendingMakeupCount: getPendingMakeupCount()
    });
});

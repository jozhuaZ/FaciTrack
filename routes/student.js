const express = require('express');
const router = express.Router();
const { requireRole, setSessionCookie } = require('../middleware/auth');
const { createSession, getRoleRedirect, authenticateUser } = require('../services/auth');
const instructorRouter = require('./instructor');
const emailService = require('../services/email');

router.use((req, res, next) => {
    console.log(`[Student Router] ${req.method} ${req.originalUrl}`);
    next();
});

// ── Student Login (Public Routes) ──
// router.get('/login', (req, res) => {
//     const errorMessages = {
//         'oauth_not_configured': 'Google Sign-In is not configured. Please use email/password login.',
//         'authentication_failed': 'Authentication failed. Please try again.',
//         'missing_code': 'Authentication code missing. Please try again.',
//         'not_a_student_account': 'This account is not registered as a student.',
//         'account_inactive': 'Your account is inactive. Please contact support.'
//     };

//     const errorParam = req.query.error;
//     const errorMessage = errorParam ? errorMessages[errorParam] || 'An error occurred. Please try again.' : null;

//     res.render('pages/index', {
//         title: 'FaciTrack - Student Login',
//         error: errorMessage
//     });
// });

router.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.render('pages/student/login', {
            title: 'FaciTrack - Student Login',
            error: 'Please enter your email and password.'
        });
    }

    // Authenticate student
    const user = authenticateUser(email, password);

    if (!user || user.role !== 'student') {
        return res.render('pages/student/login', {
            title: 'FaciTrack - Student Login',
            error: 'Invalid email or password.'
        });
    }

    // Validate CSPC student email
    if (!email.endsWith('@my.cspc.edu.ph')) {
        return res.render('pages/student/login', {
            title: 'FaciTrack - Student Login',
            error: 'Please use your CSPC student email (@my.cspc.edu.ph).'
        });
    }

    // Create session
    const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '' });
    setSessionCookie(res, session.token);
    res.redirect(getRoleRedirect(user.role));
});

// Protect all other student routes - require student role
router.use(requireRole('student'));

// ── Faculty list ──
const facultyList = [
    {
        id: 1, name: 'Dr. Maria Santos', department: 'College of Computer Studies',
        position: 'Professor', specialization: 'Software Engineering',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 2:00 PM', email: 'msantos@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 201', consultationSlots: []
    },
    {
        id: 2, name: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies',
        position: 'Associate Professor', specialization: 'Database Systems',
        bleStatus: 'out', manualStatus: null,
        nextAvailable: 'Tomorrow, 10:00 AM', email: 'jdelacruz@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 105',
        consultationSlots: [
            { day: 'Tuesday',  time: '9:00 AM – 10:00 AM', status: 'open', maxCapacity: 3 },
            { day: 'Thursday', time: '1:00 PM – 2:00 PM',  status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 3, name: 'Dr. Ana Villanueva', department: 'College of Computer Studies',
        position: 'Assistant Professor', specialization: 'Information Systems',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 9:00 AM', email: 'avillanueva@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 203',
        consultationSlots: [
            { day: 'Monday',    time: '9:00 AM – 10:00 AM', status: 'open', maxCapacity: 3 },
            { day: 'Wednesday', time: '1:00 PM – 2:00 PM',  status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 4, name: 'Prof. Carlos Bautista', department: 'College of Computer Studies',
        position: 'Instructor', specialization: 'Computer Networks',
        bleStatus: 'out', manualStatus: 'in-travel',
        nextAvailable: 'Tomorrow, 9:00 AM', email: 'cbautista@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 102',
        consultationSlots: [
            { day: 'Tuesday',  time: '2:00 PM – 3:00 PM',  status: 'open', maxCapacity: 3 },
            { day: 'Thursday', time: '9:00 AM – 10:00 AM', status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 5, name: 'Dr. Ramon Aquino', department: 'College of Computer Studies',
        position: 'Associate Professor', specialization: 'Artificial Intelligence',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 3:00 PM', email: 'raquino@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 204',
        consultationSlots: [
            { day: 'Monday',   time: '1:00 PM – 2:00 PM',   status: 'open', maxCapacity: 3 },
            { day: 'Thursday', time: '10:00 AM – 11:00 AM', status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 6, name: 'Prof. Liza Navarro', department: 'College of Computer Studies',
        position: 'Instructor', specialization: 'Web Development',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 4:00 PM', email: 'lnavarro@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 106',
        consultationSlots: [
            { day: 'Wednesday', time: '2:00 PM – 3:00 PM',   status: 'full', maxCapacity: 3 },
            { day: 'Friday',    time: '10:00 AM – 11:00 AM', status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 7, name: 'Dr. Eduardo Flores', department: 'College of Computer Studies',
        position: 'Professor', specialization: 'Cybersecurity',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 1:00 PM', email: 'eflores@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 202',
        consultationSlots: [
            { day: 'Tuesday',  time: '1:00 PM – 2:00 PM', status: 'open', maxCapacity: 3 },
            { day: 'Thursday', time: '2:00 PM – 3:00 PM', status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 8, name: 'Prof. Grace Mendoza', department: 'College of Computer Studies',
        position: 'Assistant Professor', specialization: 'Mobile Application Development',
        bleStatus: 'out', manualStatus: 'in-leave',
        nextAvailable: 'Tomorrow, 10:00 AM', email: 'gmendoza@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 107',
        consultationSlots: [
            { day: 'Monday', time: '10:00 AM – 11:00 AM', status: 'open', maxCapacity: 3 },
            { day: 'Friday', time: '2:00 PM – 3:00 PM',   status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 9, name: 'Dr. Benjamin Reyes', department: 'College of Computer Studies',
        position: 'Associate Professor', specialization: 'Data Science',
        bleStatus: 'in', manualStatus: null,
        nextAvailable: 'Today, 11:00 AM', email: 'breyes@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 205',
        consultationSlots: [
            { day: 'Tuesday',   time: '10:00 AM – 11:00 AM', status: 'open', maxCapacity: 3 },
            { day: 'Wednesday', time: '3:00 PM – 4:00 PM',   status: 'open', maxCapacity: 3 }
        ]
    },
    {
        id: 10, name: 'Prof. Maricel Castro', department: 'College of Computer Studies',
        position: 'Instructor', specialization: 'Systems Analysis and Design',
        bleStatus: 'out', manualStatus: null,
        nextAvailable: 'Tomorrow, 1:00 PM', email: 'mcastro@cspc.edu.ph',
        officeRoom: 'CCS Building, Room 103',
        consultationSlots: [
            { day: 'Monday',   time: '3:00 PM – 4:00 PM', status: 'open', maxCapacity: 3 },
            { day: 'Thursday', time: '1:00 PM – 2:00 PM', status: 'full', maxCapacity: 3 }
        ]
    }
];

const departments = [
    { value: 'College of Computer Studies',        label: 'College of Computer Studies (CCS)' },
    { value: 'College of Teacher Education',       label: 'College of Teacher Education (CTE)' },
    { value: 'College of Engineering',             label: 'College of Engineering (COE)' },
    { value: 'College of Agriculture',             label: 'College of Agriculture (CA)' },
    { value: 'College of Business Administration', label: 'College of Business Administration (CBA)' },
    { value: 'College of Arts and Sciences',       label: 'College of Arts and Sciences (CAS)' },
];

// ── Reference number store ──
const refStore = {};

// ── Slot booking tracker ──
// key: `${facultyId}_${day}_${slotTime}` → { refNumber, studentEmail, status, reservedAt }
const slotBookings = {};

// ── Slot reservation hold store (5-min hold before form submit) ──
// key: reservationToken → { facultyId, day, slotTime, expiresAt }
const slotReservations = {};
const RESERVATION_MS = 5 * 60 * 1000; // 5 minutes

function slotKey(facultyId, day, slotTime) {
    return `${facultyId}_${day}_${slotTime.trim()}`;
}

// Check if a slot is taken (pending or confirmed booking — permanent)
function isSlotTaken(facultyId, day, slotTime) {
    const entry = slotBookings[slotKey(facultyId, day, slotTime)];
    return entry && (entry.status === 'pending' || entry.status === 'confirmed');
}

// Check if a slot is under a 5-min reservation hold
function isSlotReserved(facultyId, day, slotTime) {
    const key = slotKey(facultyId, day, slotTime);
    const now = Date.now();
    // Clean expired reservations first
    Object.keys(slotReservations).forEach(token => {
        if (slotReservations[token].expiresAt < now) {
            delete slotReservations[token];
        }
    });
    return Object.values(slotReservations).some(r =>
        r.facultyId === facultyId &&
        r.day === day &&
        r.slotTime.trim() === slotTime.trim() &&
        r.expiresAt > now
    );
}

// Reserve a slot for 5 minutes (returns token)
function reserveSlot(facultyId, day, slotTime) {
    const token = `RSV-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    slotReservations[token] = {
        facultyId, day, slotTime: slotTime.trim(),
        expiresAt: Date.now() + RESERVATION_MS
    };
    return token;
}

// Release a reservation by token
function releaseReservation(token) {
    delete slotReservations[token];
}

// Lock a slot permanently (on booking submit)
function lockSlot(facultyId, day, slotTime, refNumber, studentEmail) {
    slotBookings[slotKey(facultyId, day, slotTime)] = { refNumber, studentEmail, status: 'pending' };
}

// Release a slot (on decline or cancellation)
function releaseSlot(facultyId, day, slotTime) {
    delete slotBookings[slotKey(facultyId, day, slotTime)];
}

// Confirm a slot
function confirmSlot(facultyId, day, slotTime) {
    const entry = slotBookings[slotKey(facultyId, day, slotTime)];
    if (entry) entry.status = 'confirmed';
}

// Get all taken/reserved slots for a faculty (for the profile page)
function getTakenSlots(facultyId) {
    const taken = {};
    const now = Date.now();
    const prefix = `${facultyId}_`;

    // Permanent bookings
    Object.entries(slotBookings).forEach(([key, val]) => {
        if (!key.startsWith(prefix)) return;
        if (val.status !== 'pending' && val.status !== 'confirmed') return;
        const rest = key.slice(prefix.length);
        const underscoreIdx = rest.indexOf('_');
        if (underscoreIdx === -1) return;
        const day = rest.slice(0, underscoreIdx);
        const slotTime = rest.slice(underscoreIdx + 1);
        if (!taken[day]) taken[day] = [];
        if (!taken[day].includes(slotTime)) taken[day].push(slotTime);
    });

    // Active reservations (5-min holds)
    Object.values(slotReservations).forEach(r => {
        if (r.facultyId !== facultyId) return;
        if (r.expiresAt < now) return;
        if (!taken[r.day]) taken[r.day] = [];
        if (!taken[r.day].includes(r.slotTime)) taken[r.day].push(r.slotTime);
    });

    return taken;
}

function generateRefNumber() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return 'FT-' + code;
}

// ── 2-week calendar window helpers ──
// Returns { windowStart: Date, windowEnd: Date }
// windowStart = Sunday of current week
// windowEnd   = Saturday of next week
function getTwoWeekWindow() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = today.getDay(); // 0=Sun
    const windowStart = new Date(today);
    windowStart.setDate(today.getDate() - dayOfWeek); // back to Sunday
    const windowEnd = new Date(windowStart);
    windowEnd.setDate(windowStart.getDate() + 13); // +13 = next Saturday
    return { windowStart, windowEnd };
}

// Check if a given Date falls within the 2-week window and is not in the past
function isDateInWindow(date) {
    const { windowStart, windowEnd } = getTwoWeekWindow();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d >= today && d >= windowStart && d <= windowEnd;
}

// ── Auto-reschedule logic ──
// Finds the next available slot for a faculty after a given date
function findNextAvailableSlot(faculty, afterDate) {
    const slots = faculty.consultationSlots.filter(s => s.status === 'open');
    if (!slots.length) return null;

    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Search up to 60 days ahead
    for (let offset = 1; offset <= 60; offset++) {
        const candidate = new Date(afterDate);
        candidate.setDate(afterDate.getDate() + offset);
        candidate.setHours(0, 0, 0, 0);
        if (candidate < today) continue;

        const dayName = dayNames[candidate.getDay()];
        const matchingSlots = slots.filter(s => s.day === dayName);

        for (const slot of matchingSlots) {
            // Chop into sub-slots and find a free one
            const subSlots = chopSlotServer(slot);
            for (const subSlot of subSlots) {
                if (!isSlotTaken(faculty.id, dayName, subSlot) && !isSlotReserved(faculty.id, dayName, subSlot)) {
                    return {
                        date: candidate,
                        day: dayName,
                        slot: subSlot,
                        dateStr: `${dayName}, ${candidate.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}`
                    };
                }
            }
        }
    }
    return null;
}

// Server-side slot chopper (mirrors client-side chopSlot)
function parseTimeServer(str) {
    const parts = str.trim().split(' ');
    const [h, m] = parts[0].split(':').map(Number);
    const period = parts[1];
    let hours = h;
    if (period === 'PM' && h !== 12) hours += 12;
    if (period === 'AM' && h === 12) hours = 0;
    return hours * 60 + m;
}
function formatTimeServer(mins) {
    let h = Math.floor(mins / 60), m = mins % 60;
    const p = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m.toString().padStart(2, '0')} ${p}`;
}
function chopSlotServer(slotObj) {
    const parts = slotObj.time.split('–').map(s => s.trim());
    if (parts.length < 2) return [slotObj.time];
    const startMins = parseTimeServer(parts[0]);
    const endMins   = parseTimeServer(parts[1]);
    const cap = slotObj.maxCapacity || 3;
    const slotMins = Math.floor((endMins - startMins) / cap);
    const result = [];
    for (let i = 0; i < cap; i++) {
        const s = startMins + i * slotMins;
        const e = s + slotMins;
        result.push(`${formatTimeServer(s)} – ${formatTimeServer(e)}`);
    }
    return result;
}

// Get faculty — ID 1 pulls live schedule from instructor store
function getFaculty(id) {
    const f = facultyList.find(f => f.id === id);
    if (!f) return null;
    if (id === 1) {
        const store = instructorRouter.getScheduleStore();
        const liveSlots = (store[1] || []).map(s => ({
            day: s.day, time: `${s.timeStart} – ${s.timeEnd}`,
            timeStart: s.timeStart, timeEnd: s.timeEnd,
            status: s.status, maxCapacity: s.maxCapacity
        }));
        return { ...f, consultationSlots: liveSlots, nextAvailable: computeNextAvailable(liveSlots) };
    }
    return { ...f, nextAvailable: computeNextAvailable(f.consultationSlots) };
}

// Compute the next available slot label from a faculty's consultation slots.
// Skips slots whose time has already passed today, and skips fully-booked slots.
function computeNextAvailable(slots) {
    if (!slots || !slots.length) return 'No schedule set';

    const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const now = new Date();
    const todayIdx = now.getDay(); // 0=Sun
    const nowMins  = now.getHours() * 60 + now.getMinutes();

    // Parse "9:00 AM" → minutes since midnight
    function parseMins(str) {
        if (!str) return 0;
        const parts = str.trim().split(' ');
        const [h, m] = parts[0].split(':').map(Number);
        const period = parts[1] || 'AM';
        let hours = h;
        if (period === 'PM' && h !== 12) hours += 12;
        if (period === 'AM' && h === 12) hours = 0;
        return hours * 60 + (m || 0);
    }

    // Get start time of a slot (handles "9:00 AM – 10:00 AM" or timeStart field)
    function getSlotStartMins(slot) {
        if (slot.timeStart) return parseMins(slot.timeStart);
        const parts = (slot.time || '').split('–');
        return parseMins(parts[0].trim());
    }

    // Only consider open slots
    const openSlots = slots.filter(s => s.status === 'open');
    if (!openSlots.length) return 'No open slots';

    // Search up to 7 days ahead (current week + next week)
    for (let offset = 0; offset < 7; offset++) {
        const checkIdx = (todayIdx + offset) % 7;
        const dayName  = DAY_NAMES[checkIdx];
        const isToday  = offset === 0;

        const daySlots = openSlots.filter(s => s.day === dayName);
        if (!daySlots.length) continue;

        for (const slot of daySlots) {
            const startMins = getSlotStartMins(slot);
            // If today, skip slots that have already started or passed
            if (isToday && startMins <= nowMins) continue;

            // Format the label
            const startLabel = slot.timeStart || (slot.time || '').split('–')[0].trim();
            if (isToday) return `Today, ${startLabel}`;
            if (offset === 1) return `Tomorrow, ${startLabel}`;
            return `${dayName}, ${startLabel}`;
        }
    }

    return 'Check schedule';
}

// Derive display status for student-facing views (In / Out only)
function getDisplayStatus(faculty) {
    if (faculty.manualStatus === 'in-travel' || faculty.manualStatus === 'in-leave') return 'out';
    return faculty.bleStatus === 'in' ? 'in' : 'out';
}

// ── Routes ──

router.get('/dashboard', (req, res) => {
    const { search, dept } = req.query;
    let filtered = facultyList.map(f => getFaculty(f.id));
    if (dept)   filtered = filtered.filter(f => f.department === dept);
    if (search) {
        const kw = search.toLowerCase();
        filtered = filtered.filter(f =>
            f.name.toLowerCase().includes(kw) || f.specialization.toLowerCase().includes(kw)
        );
    }
    res.render('pages/student/dashboard', {
        title: 'FaciTrack - Faculty Directory',
        facultyList: filtered,
        searchQuery: search || '', activeDept: dept || '', departments
    });
});

router.get('/faculty/:id', (req, res) => {
    const faculty = getFaculty(parseInt(req.params.id));
    if (!faculty) return res.redirect('/student/dashboard');
    const takenSlots = getTakenSlots(faculty.id);
    const { windowStart, windowEnd } = getTwoWeekWindow();
    res.render('pages/student/profile', {
        title: `FaciTrack - ${faculty.name}`,
        faculty,
        takenSlots,
        windowStart: windowStart.toISOString(),
        windowEnd:   windowEnd.toISOString()
    });
});

// ── Slot reservation endpoint (called when student clicks a slot) ──
router.post('/slot/reserve', (req, res) => {
    const { facultyId, day, slotTime } = req.body;
    const fid = parseInt(facultyId);
    if (!fid || !day || !slotTime) return res.status(400).json({ error: 'Missing parameters.' });

    if (isSlotTaken(fid, day, slotTime)) {
        return res.json({ available: false, reason: 'taken' });
    }
    if (isSlotReserved(fid, day, slotTime)) {
        return res.json({ available: false, reason: 'reserved' });
    }

    const token = reserveSlot(fid, day, slotTime);
    res.json({ available: true, token, expiresIn: RESERVATION_MS });
});

// ── Release reservation (called on back/cancel) ──
router.post('/slot/release', (req, res) => {
    const { token } = req.body;
    if (token) releaseReservation(token);
    res.json({ success: true });
});

router.get('/faculty/:id/book', (req, res) => {
    const faculty = getFaculty(parseInt(req.params.id));
    if (!faculty) return res.redirect('/student/dashboard');
    const hasOpen = faculty.consultationSlots.some(s => s.status === 'open');
    if (!hasOpen) return res.redirect(`/student/faculty/${faculty.id}`);
    
    // Get logged-in student info
    const student = req.currentUser;
    
    res.render('pages/student/book', {
        title: `FaciTrack - Book Appointment with ${faculty.name}`,
        faculty,
        student,
        selectedSlot: req.query.slot || null,
        selectedDate: req.query.date || null,
        reservationToken: req.query.token || null
    });
});

router.post('/faculty/:id/book', (req, res) => {
    const faculty = getFaculty(parseInt(req.params.id));
    if (!faculty) return res.redirect('/student/dashboard');

    const { selectedSlot, consultTopic, consultNotes, selectedDate, reservationToken } = req.body;
    
    // Get logged-in student info
    const student = req.currentUser;
    const studentName = student.name;
    const studentId = student.studentNo || student.id.toString();
    const studentEmail = student.email;

    const renderError = (msg) => res.render('pages/student/book', {
        title: `FaciTrack - Book Appointment with ${faculty.name}`,
        faculty, student, error: msg,
        selectedSlot, selectedDate, reservationToken
    });

    if (!selectedSlot) return renderError('Please select a consultation slot.');
    if (!consultTopic || !consultTopic.trim()) return renderError('Please describe your consultation topic.');

    const sanitizedTopic = consultTopic.trim().substring(0, 500);
    const sanitizedNotes = (consultNotes || '').trim().substring(0, 1000);
    const normalizedEmail = studentEmail.toLowerCase().trim();

    const dayFromSlot = selectedDate ? selectedDate.split(',')[0].trim() : '';

    // Check if slot is taken by a permanent booking
    if (isSlotTaken(faculty.id, dayFromSlot, selectedSlot)) {
        // Release their reservation token since slot is gone
        if (reservationToken) releaseReservation(reservationToken);
        return renderError('This slot has already been booked. Please go back and select a different slot.');
    }

    // Validate reservation token — if expired, redirect back with session expired message
    if (reservationToken) {
        const reservation = slotReservations[reservationToken];
        if (!reservation || reservation.expiresAt < Date.now()) {
            releaseReservation(reservationToken);
            return res.redirect(
                `/student/faculty/${faculty.id}?expired=1&slot=${encodeURIComponent(selectedSlot)}&date=${encodeURIComponent(selectedDate || '')}`
            );
        }
        // Release the reservation — we're converting it to a permanent booking
        releaseReservation(reservationToken);
    }

    // Check duplicate booking by same student with same instructor
    const existingBooking = Object.values(refStore).find(r =>
        r.facultyId === faculty.id &&
        r.studentEmail === normalizedEmail &&
        (r.status === 'pending' || r.status === 'confirmed')
    );
    if (existingBooking) {
        return renderError(`You already have an active booking with ${faculty.name} (Ref: ${existingBooking.refNumber}). Please wait for the instructor to respond before booking again.`);
    }

    // Generate reference number and lock the slot permanently
    const refNumber = generateRefNumber();
    lockSlot(faculty.id, dayFromSlot, selectedSlot, refNumber, normalizedEmail);

    refStore[refNumber] = {
        refNumber, facultyId: faculty.id, facultyName: faculty.name,
        studentName: studentName, studentId: studentId, studentEmail: normalizedEmail,
        slot: selectedSlot, day: dayFromSlot, date: selectedDate || '', topic: sanitizedTopic,
        notes: sanitizedNotes, status: 'pending', requestedAt: new Date().toISOString()
    };

    console.log(`[Booking] Ref: ${refNumber} | ${studentName} booked with ${faculty.name}`);

    // Send booking confirmation email (backend-ready)
    emailService.sendBookingConfirmation({
        studentEmail: normalizedEmail,
        studentName: studentName,
        refNumber,
        facultyName: faculty.name,
        slot: selectedSlot,
        date: selectedDate || '',
        topic: sanitizedTopic
    });

    const backHref = `/student/faculty/${faculty.id}/book?` + new URLSearchParams({
        slot:          selectedSlot,
        date:          selectedDate || ''
    }).toString();

    res.render('pages/student/booking-confirm', {
        title: 'FaciTrack - Booking Confirmed',
        email: normalizedEmail,
        refNumber,
        backHref,
        bookingData: {
            facultyName: faculty.name,
            topic:       sanitizedTopic,
            slot:        selectedSlot,
            date:        selectedDate || ''
        }
    });
});

router.get('/appointments', (req, res) => {
    // Get logged-in student's appointments
    const student = req.currentUser;
    const studentEmail = student.email.toLowerCase();
    
    // Filter appointments for this student
    const myAppointments = Object.values(refStore).filter(apt => 
        apt.studentEmail === studentEmail
    );
    
    res.render('pages/student/appointments', { 
        title: 'FaciTrack - My Appointments',
        appointments: myAppointments,
        student
    });
});

router.get('/availability', (req, res) => {
    res.render('pages/student/availability', {
        title: 'FaciTrack - Faculty Availability', facultyList
    });
});

// Validate reference number
router.get('/ref/validate', (req, res) => {
    const ref   = (req.query.ref   || '').toUpperCase().trim();
    const email = (req.query.email || '').toLowerCase().trim();

    if (!refStore[ref]) {
        return res.json({ valid: false });
    }

    const apt = refStore[ref];

    // Validate email matches the booking
    if (email && apt.studentEmail && apt.studentEmail.toLowerCase() !== email) {
        return res.json({ valid: false, reason: 'email_mismatch' });
    }

    const faculty = getFaculty(apt.facultyId);
    return res.json({
        valid: true,
        appointment: {
            ...apt,
            facultyDept: faculty ? faculty.department : ''
        }
    });
});

// ── Auto-reschedule endpoint (called by instructor/admin when marking unavailable) ──
router.post('/reschedule/:refNumber', (req, res) => {
    const ref = req.params.refNumber.toUpperCase();
    const booking = refStore[ref];
    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    const faculty = getFaculty(booking.facultyId);
    if (!faculty) return res.status(404).json({ error: 'Faculty not found.' });

    const originalDate = new Date(booking.requestedAt);
    const next = findNextAvailableSlot(faculty, new Date());
    if (!next) return res.status(409).json({ error: 'No available slots found for rescheduling.' });

    const originalSlot = booking.slot;
    const originalDateStr = booking.date;

    // Release old slot, lock new one
    releaseSlot(booking.facultyId, booking.day, booking.slot);
    lockSlot(booking.facultyId, next.day, next.slot, ref, booking.studentEmail);

    // Update booking
    booking.slot = next.slot;
    booking.day  = next.day;
    booking.date = next.dateStr;
    booking.rescheduledFrom = { date: originalDateStr, slot: originalSlot };

    // Send reschedule email
    emailService.sendRescheduleNotification({
        studentEmail: booking.studentEmail,
        studentName:  booking.studentName,
        refNumber:    ref,
        facultyName:  faculty.name,
        originalDate: originalDateStr,
        originalSlot,
        newDate: next.dateStr,
        newSlot: next.slot
    });

    console.log(`[Reschedule] ${ref} moved from ${originalDateStr} ${originalSlot} → ${next.dateStr} ${next.slot}`);
    res.json({ success: true, newDate: next.dateStr, newSlot: next.slot });
});

module.exports = router;
module.exports.releaseSlot        = releaseSlot;
module.exports.confirmSlot        = confirmSlot;
module.exports.slotBookings       = slotBookings;
module.exports.refStore           = refStore;
module.exports.getDisplayStatus   = getDisplayStatus;
module.exports.facultyList        = facultyList;
module.exports.sendApprovalEmail  = emailService.sendApprovalNotification;
module.exports.sendDeclineEmail   = emailService.sendDeclineNotification;

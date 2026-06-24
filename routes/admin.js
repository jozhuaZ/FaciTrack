const express = require('express');
const router = express.Router();
const AdminController = require('../controllers/AdminController');
const { authenticateUser, createSession, getRoleRedirect, revokeSession, createOTP, verifyOTP } = require('../services/auth');
const { requireRole, setSessionCookie, clearSessionCookie } = require('../middleware/auth');

// Router-level middleware: log all admin route requests
router.use((req, res, next) => {
    console.log(`[Admin Router] ${req.method} ${req.originalUrl}`);
    next();
});

// Admin Login
router.get('/login', (req, res) => {
    res.render('pages/admin/login', { 
        title: 'FaciTrack - Administrator Login', 
        error: null,
        step: 'login',
        email: '',
        otpToken: '',
        otpError: null
    });
});

router.post('/login', (req, res) => {
    const { email, password } = req.body;
    
    // Input validation
    if (!email || typeof email !== 'string' || email.trim().length === 0) {
        return res.render('pages/admin/login', { 
            title: 'FaciTrack - Administrator Login', 
            error: 'Please enter your email address.',
            step: 'login',
            email: '',
            otpToken: '',
            otpError: null
        });
    }

    if (!password || typeof password !== 'string' || password.trim().length === 0) {
        return res.render('pages/admin/login', { 
            title: 'FaciTrack - Administrator Login', 
            error: 'Please enter your password.',
            step: 'login',
            email: email,
            otpToken: '',
            otpError: null
        });
    }
    
    // Authenticate user
    const user = authenticateUser(email, password);
    
    if (!user || user.role !== 'admin') {
        return res.render('pages/admin/login', { 
            title: 'FaciTrack - Administrator Login', 
            error: 'Invalid email or password.',
            step: 'login',
            email: email,
            otpToken: '',
            otpError: null
        });
    }

    // Generate OTP and send to email
    const { otpToken, expiresAt } = createOTP(email);

    // Show OTP verification page
    res.render('pages/admin/login', {
        title: 'FaciTrack - Verify Your Identity',
        error: null,
        step: 'otp',
        email: email,
        otpToken: otpToken,
        otpError: null
    });
});

// OTP Verification
router.post('/login/verify-otp', (req, res) => {
    const { email, otpToken, otp } = req.body;

    if (!otpToken || !otp) {
        return res.render('pages/admin/login', {
            title: 'FaciTrack - Verify Your Identity',
            error: null,
            step: 'otp',
            email: email,
            otpToken: otpToken,
            otpError: 'Please enter the verification code.'
        });
    }

    // Verify OTP
    const result = verifyOTP(otpToken, otp.trim());

    if (!result.success) {
        return res.render('pages/admin/login', {
            title: 'FaciTrack - Verify Your Identity',
            error: null,
            step: 'otp',
            email: email,
            otpToken: otpToken,
            otpError: result.error
        });
    }

    // OTP verified - get user and create session
    const { readData } = require('../services/data-store');
    const db = readData();
    const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === result.email);

    if (!user || user.role !== 'admin') {
        return res.render('pages/admin/login', {
            title: 'FaciTrack - Administrator Login',
            error: 'Admin user not found.',
            step: 'login',
            email: '',
            otpToken: '',
            otpError: null
        });
    }

    // Create session and redirect
    const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '' });
    setSessionCookie(res, session.token);
    res.redirect(getRoleRedirect(user.role));
});

// Resend OTP
router.post('/login/resend-otp', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.json({ success: false, error: 'Email is required.' });
    }

    // Verify user exists
    const { readData } = require('../services/data-store');
    const db = readData();
    const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === email.toLowerCase());

    if (!user || user.role !== 'admin') {
        return res.json({ success: false, error: 'User not found.' });
    }

    // Generate new OTP
    const { otpToken } = createOTP(email);

    res.json({ success: true, otpToken });
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
// router.use(requireRole('admin'));

// Admin manages CCS department only
const CCS_DEPT = 'College of Computer Studies';

function getSharedData() {
    // Admin scope: CCS department only
    const admin = {
        name: 'System Admin',
        role: 'Administrator',
        email: 'admin@cspc.edu.ph',
        department: 'College of Computer Studies'
    };

    // CCS faculty only — Admin manages ONE department
    const faculty = [
        { id: 1,  name: 'Dr. Maria Santos',     position: 'Professor',           department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 201', bleStatus: 'in-room',     bleLastDetected: '2 minutes ago',  hoursThisMonth: 48, consultationsThisMonth: 32, avgDuration: '42 min', pilotDept: true },
        { id: 2,  name: 'Prof. Jose Dela Cruz',  position: 'Associate Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 105', bleStatus: 'out-of-room', bleLastDetected: '1 hour ago',     hoursThisMonth: 36, consultationsThisMonth: 24, avgDuration: '38 min', pilotDept: true },
        { id: 3,  name: 'Dr. Ana Villanueva',    position: 'Assistant Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 203', bleStatus: 'in-room',     bleLastDetected: '5 minutes ago',  hoursThisMonth: 42, consultationsThisMonth: 28, avgDuration: '45 min', pilotDept: true },
        { id: 4,  name: 'Prof. Carlos Bautista', position: 'Instructor',          department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 102', bleStatus: 'out-of-room', bleLastDetected: '3 hours ago',    hoursThisMonth: 30, consultationsThisMonth: 18, avgDuration: '35 min', pilotDept: true },
        { id: 5,  name: 'Dr. Ramon Aquino',      position: 'Associate Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 204', bleStatus: 'in-room',     bleLastDetected: '10 minutes ago', hoursThisMonth: 40, consultationsThisMonth: 22, avgDuration: '40 min', pilotDept: true },
        { id: 6,  name: 'Prof. Liza Navarro',    position: 'Instructor',          department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 106', bleStatus: 'in-room',     bleLastDetected: '8 minutes ago',  hoursThisMonth: 28, consultationsThisMonth: 15, avgDuration: '33 min', pilotDept: true },
        { id: 7,  name: 'Dr. Eduardo Flores',    position: 'Professor',           department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 202', bleStatus: 'in-room',     bleLastDetected: '3 minutes ago',  hoursThisMonth: 44, consultationsThisMonth: 30, avgDuration: '44 min', pilotDept: true },
        { id: 8,  name: 'Prof. Grace Mendoza',   position: 'Assistant Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 107', bleStatus: 'out-of-room', bleLastDetected: '2 hours ago',    hoursThisMonth: 32, consultationsThisMonth: 20, avgDuration: '36 min', pilotDept: true },
        { id: 9,  name: 'Dr. Benjamin Reyes',    position: 'Associate Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 205', bleStatus: 'in-room',     bleLastDetected: '15 minutes ago', hoursThisMonth: 38, consultationsThisMonth: 25, avgDuration: '39 min', pilotDept: true },
        { id: 10, name: 'Prof. Maricel Castro',  position: 'Instructor',          department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 103', bleStatus: 'out-of-room', bleLastDetected: '4 hours ago',    hoursThisMonth: 26, consultationsThisMonth: 14, avgDuration: '32 min', pilotDept: true },
    ];

    // CCS appointments only
    const allAppointments = [
        { id: 1,  studentName: 'Juan Dela Cruz',   studentId: '2021-00123', instructorName: 'Dr. Maria Santos',     department: 'College of Computer Studies', date: 'March 24, 2026', time: '2:00 PM',  duration: '30 minutes', topic: 'Thesis consultation regarding system architecture', status: 'pending' },
        { id: 2,  studentName: 'Ana Reyes',         studentId: '2021-00456', instructorName: 'Dr. Maria Santos',     department: 'College of Computer Studies', date: 'March 25, 2026', time: '10:00 AM', duration: '30 minutes', topic: 'Grade inquiry for Midterm exam', status: 'pending' },
        { id: 3,  studentName: 'Carlos Mendoza',    studentId: '2021-00789', instructorName: 'Dr. Maria Santos',     department: 'College of Computer Studies', date: 'March 24, 2026', time: '3:30 PM',  duration: '45 minutes', topic: 'Project proposal review', status: 'confirmed' },
        { id: 4,  studentName: 'Maria Garcia',      studentId: '2021-00321', instructorName: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies', date: 'March 22, 2026', time: '1:00 PM',  duration: '30 minutes', topic: 'Academic advising', status: 'declined' },
        { id: 5,  studentName: 'Pedro Lim',         studentId: '2022-00111', instructorName: 'Dr. Ana Villanueva',   department: 'College of Computer Studies', date: 'March 24, 2026', time: '9:00 AM',  duration: '30 minutes', topic: 'Research methodology guidance', status: 'confirmed' },
        { id: 6,  studentName: 'Rosa Fernandez',    studentId: '2022-00222', instructorName: 'Prof. Carlos Bautista',department: 'College of Computer Studies', date: 'March 25, 2026', time: '11:00 AM', duration: '45 minutes', topic: 'Capstone project feedback', status: 'pending' },
        { id: 7,  studentName: 'Luis Torres',       studentId: '2021-00555', instructorName: 'Dr. Ana Villanueva',   department: 'College of Computer Studies', date: 'March 23, 2026', time: '2:00 PM',  duration: '30 minutes', topic: 'Grade reconsideration request', status: 'confirmed' },
        { id: 8,  studentName: 'Kristine Uy',       studentId: '2022-00333', instructorName: 'Dr. Ramon Aquino',     department: 'College of Computer Studies', date: 'March 24, 2026', time: '1:00 PM',  duration: '30 minutes', topic: 'AI project consultation', status: 'confirmed' },
        { id: 9,  studentName: 'Mark Villanueva',   studentId: '2022-00444', instructorName: 'Prof. Liza Navarro',   department: 'College of Computer Studies', date: 'March 25, 2026', time: '2:00 PM',  duration: '45 minutes', topic: 'Web app debugging session', status: 'pending' },
        { id: 10, studentName: 'Sheila Ramos',      studentId: '2021-00666', instructorName: 'Dr. Eduardo Flores',   department: 'College of Computer Studies', date: 'March 24, 2026', time: '3:00 PM',  duration: '30 minutes', topic: 'Network security thesis review', status: 'confirmed' },
    ];

    const presenceLogs = [
        { facultyName: 'Dr. Maria Santos',     department: 'College of Computer Studies', timestamp: '2026-03-17 09:15 AM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { facultyName: 'Dr. Maria Santos',     department: 'College of Computer Studies', timestamp: '2026-03-17 11:30 AM', status: 'exited',  location: 'CCS Building, Room 201', duration: '2h 15m' },
        { facultyName: 'Dr. Ana Villanueva',   department: 'College of Computer Studies', timestamp: '2026-03-17 08:45 AM', status: 'entered', location: 'CCS Building, Room 203', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies', timestamp: '2026-03-17 09:00 AM', status: 'entered', location: 'CCS Building, Room 105', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies', timestamp: '2026-03-17 10:00 AM', status: 'exited',  location: 'CCS Building, Room 105', duration: '1h 0m' },
        { facultyName: 'Dr. Maria Santos',     department: 'College of Computer Studies', timestamp: '2026-03-17 01:00 PM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { facultyName: 'Prof. Carlos Bautista',department: 'College of Computer Studies', timestamp: '2026-03-17 07:30 AM', status: 'entered', location: 'CCS Building, Room 102', duration: null },
        { facultyName: 'Prof. Carlos Bautista',department: 'College of Computer Studies', timestamp: '2026-03-17 10:30 AM', status: 'exited',  location: 'CCS Building, Room 102', duration: '3h 0m' },
        { facultyName: 'Dr. Ramon Aquino',     department: 'College of Computer Studies', timestamp: '2026-03-17 08:00 AM', status: 'entered', location: 'CCS Building, Room 204', duration: null },
        { facultyName: 'Dr. Ramon Aquino',     department: 'College of Computer Studies', timestamp: '2026-03-17 11:00 AM', status: 'exited',  location: 'CCS Building, Room 204', duration: '3h 0m' },
        { facultyName: 'Prof. Liza Navarro',   department: 'College of Computer Studies', timestamp: '2026-03-17 09:30 AM', status: 'entered', location: 'CCS Building, Room 106', duration: null },
        { facultyName: 'Dr. Eduardo Flores',   department: 'College of Computer Studies', timestamp: '2026-03-17 08:30 AM', status: 'entered', location: 'CCS Building, Room 202', duration: null },
        { facultyName: 'Prof. Grace Mendoza',  department: 'College of Computer Studies', timestamp: '2026-03-17 07:45 AM', status: 'entered', location: 'CCS Building, Room 107', duration: null },
        { facultyName: 'Prof. Grace Mendoza',  department: 'College of Computer Studies', timestamp: '2026-03-17 09:45 AM', status: 'exited',  location: 'CCS Building, Room 107', duration: '2h 0m' },
        { facultyName: 'Dr. Benjamin Reyes',   department: 'College of Computer Studies', timestamp: '2026-03-17 10:00 AM', status: 'entered', location: 'CCS Building, Room 205', duration: null },
        { facultyName: 'Prof. Maricel Castro', department: 'College of Computer Studies', timestamp: '2026-03-17 07:00 AM', status: 'entered', location: 'CCS Building, Room 103', duration: null },
        { facultyName: 'Prof. Maricel Castro', department: 'College of Computer Studies', timestamp: '2026-03-17 11:00 AM', status: 'exited',  location: 'CCS Building, Room 103', duration: '4h 0m' }
    ];

    // CCS users only: 10 instructors + 1 dean = 11 total
    const users = [
        { id: 1,  name: 'Dr. Maria Santos',     email: 'msantos@cspc.edu.ph',     role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 08:45 AM' },
        { id: 2,  name: 'Prof. Jose Dela Cruz',  email: 'jdelacruz@cspc.edu.ph',   role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 09:00 AM' },
        { id: 3,  name: 'Dr. Ana Villanueva',    email: 'avillanueva@cspc.edu.ph', role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 08:30 AM' },
        { id: 4,  name: 'Prof. Carlos Bautista', email: 'cbautista@cspc.edu.ph',   role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Part-time',   lastLogin: 'Mar 16, 2026 04:00 PM' },
        { id: 5,  name: 'Dr. Ramon Aquino',      email: 'raquino@cspc.edu.ph',     role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 07:55 AM' },
        { id: 6,  name: 'Prof. Liza Navarro',    email: 'lnavarro@cspc.edu.ph',    role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Contractual', lastLogin: 'Mar 17, 2026 09:25 AM' },
        { id: 7,  name: 'Dr. Eduardo Flores',    email: 'eflores@cspc.edu.ph',     role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 08:20 AM' },
        { id: 8,  name: 'Prof. Grace Mendoza',   email: 'gmendoza@cspc.edu.ph',    role: 'Instructor', department: 'College of Computer Studies', status: 'inactive', employmentType: 'Part-time',   lastLogin: 'Mar 15, 2026 02:00 PM' },
        { id: 9,  name: 'Dr. Benjamin Reyes',    email: 'breyes@cspc.edu.ph',      role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 09:50 AM' },
        { id: 10, name: 'Prof. Maricel Castro',  email: 'mcastro@cspc.edu.ph',     role: 'Instructor', department: 'College of Computer Studies', status: 'active',   employmentType: 'Contractual', lastLogin: 'Mar 16, 2026 05:30 PM' },
        { id: 11, name: 'Dr. Lourdes Reyes',     email: 'dean.ccs@cspc.edu.ph',    role: 'Dean',       department: 'College of Computer Studies', status: 'active',   employmentType: 'Regular',     lastLogin: 'Mar 17, 2026 07:30 AM' },
    ];

    const logs = [
        { user: 'Dr. Maria Santos', role: 'Instructor', action: 'Logged into the system', type: 'login', ip: '192.168.1.101', timestamp: 'Mar 17, 2026 08:45 AM', isToday: true },
        { user: 'Dr. Lourdes Reyes', role: 'Dean', action: 'Logged into the system', type: 'login', ip: '192.168.1.50', timestamp: 'Mar 17, 2026 07:30 AM', isToday: true },
        { user: 'System Administrator', role: 'Admin', action: 'Updated system settings', type: 'update', ip: '192.168.1.10', timestamp: 'Mar 17, 2026 06:15 AM', isToday: true },
        { user: 'Prof. Jose Dela Cruz', role: 'Instructor', action: 'Logged into the system', type: 'login', ip: '192.168.1.102', timestamp: 'Mar 17, 2026 09:00 AM', isToday: true },
        { user: 'Dr. Ana Villanueva', role: 'Instructor', action: 'Updated consultation schedule', type: 'update', ip: '192.168.1.103', timestamp: 'Mar 17, 2026 08:35 AM', isToday: true },
        { user: 'System Administrator', role: 'Admin', action: 'Created new user account: Prof. Maricel Castro', type: 'create', ip: '192.168.1.10', timestamp: 'Mar 16, 2026 03:00 PM', isToday: false },
        { user: 'Dr. Ramon Aquino', role: 'Instructor', action: 'Logged into the system', type: 'login', ip: '192.168.1.105', timestamp: 'Mar 17, 2026 07:55 AM', isToday: true },
        { user: 'Prof. Grace Mendoza', role: 'Instructor', action: 'Logged out of the system', type: 'logout', ip: '192.168.1.108', timestamp: 'Mar 15, 2026 02:00 PM', isToday: false },
        { user: 'System Administrator', role: 'Admin', action: 'Deactivated account: Prof. Grace Mendoza', type: 'update', ip: '192.168.1.10', timestamp: 'Mar 15, 2026 02:05 PM', isToday: false },
        { user: 'Dr. Eduardo Flores', role: 'Instructor', action: 'Logged into the system', type: 'login', ip: '192.168.1.107', timestamp: 'Mar 17, 2026 08:20 AM', isToday: true }
    ];

    const settings = [
        { label: 'System Name', value: 'FaciTrack' },
        { label: 'Institution', value: 'Camarines Sur Polytechnic Colleges' },
        { label: 'Pilot Department', value: 'College of Computer Studies' },
        { label: 'Deployment Scope',                value: 'CCS Department (Pilot)' },
        { label: 'Academic Year', value: '2025–2026' },
        { label: 'BLE Scan Interval (seconds)', value: '30' },
        { label: 'BLE Signal Threshold (RSSI)', value: '-75 dBm' },
        { label: 'Presence Timeout (minutes)', value: '10' },
        { label: 'Auto-Refresh Interval (seconds)', value: '30' },
        { label: 'Max Appointment Duration (minutes)', value: '60' },
        { label: 'Appointment Booking Window (days)', value: '7' }
    ];

    const toggles = [
        { label: 'BLE Real-Time Monitoring', description: 'Enable live faculty presence detection via BLE beacons.', enabled: true },
        { label: 'Public Display Screen', description: 'Show faculty availability on the public monitor outside the faculty lounge.', enabled: true },
        { label: 'Student Appointment Booking', description: 'Allow students to book consultation appointments online.', enabled: true },
        { label: 'Email Notifications', description: 'Send email alerts for appointment confirmations and reminders.', enabled: false },
        { label: 'Audit Logging', description: 'Record all user actions and system events for security review.', enabled: true }
    ];

    return { admin, users, logs, settings, toggles, faculty, allAppointments, presenceLogs, departments: ['College of Computer Studies'], deptData: DEPT_DATA, roomData: ROOM_DATA };
}

// Department master data
// CCS Department data only — Admin manages one department
const DEPT_DATA = [
    { name: 'College of Computer Studies', shortName: 'CCS', building: 'CCS Building', dean: 'Dr. Lourdes Reyes', facultyCount: 10, roomCount: 8, bleDeployed: true, status: 'active' },
];

// CCS Rooms only — Admin manages one department
const ROOM_DATA = [
    { roomNumber: 'Room 201',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Dr. Maria Santos',     bleScanner: true, status: 'active' },
    { roomNumber: 'Room 105',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Prof. Jose Dela Cruz',  bleScanner: true, status: 'active' },
    { roomNumber: 'Room 203',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Dr. Ana Villanueva',    bleScanner: true, status: 'active' },
    { roomNumber: 'Room 102',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Prof. Carlos Bautista', bleScanner: true, status: 'active' },
    { roomNumber: 'Room 204',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Dr. Ramon Aquino',      bleScanner: true, status: 'active' },
    { roomNumber: 'Room 106',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Prof. Liza Navarro',    bleScanner: true, status: 'active' },
    { roomNumber: 'Room 202',      building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Office',  assignedFaculty: 'Dr. Eduardo Flores',    bleScanner: true, status: 'active' },
    { roomNumber: 'Faculty Lounge',building: 'CCS Building', department: 'College of Computer Studies', type: 'Faculty Lounge', assignedFaculty: 'Unassigned',            bleScanner: true, status: 'active' },
];

router.get('/dashboard', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/dashboard', { title: 'FaciTrack - Admin Dashboard', ...data });
});

//     const data = getSharedData();
//     const { role } = req.query;

//     // Data is already CCS-only from getSharedData — just filter by role if requested
//     let filteredUsers = data.users;
//     if (role) {
//         filteredUsers = filteredUsers.filter(u => u.role.toLowerCase() === role.toLowerCase());
//     }

//     res.render('pages/admin/users', {
//         title: 'FaciTrack - Faculty Management',
//         ...data,
//         users: filteredUsers,
//         filterRole: role || ''
//     });
// });
router.get('/users', AdminController.renderPage);
router.post('/users', AdminController.createUser);
router.put('/users/:publicId',  AdminController.updateUser);

router.get('/logs', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/logs', { title: 'FaciTrack - Audit Logs', ...data });
});

router.get('/settings', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/settings', { title: 'FaciTrack - System Settings', ...data });
});

router.get('/reports', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/reports', { title: 'FaciTrack - Reports', ...data });
});

router.get('/monitoring', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/monitoring', { title: 'FaciTrack - Monitoring Logs', ...data });
});

router.get('/appointments', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/appointments', { title: 'FaciTrack - Appointments', ...data });
});

router.get('/departments', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/departments', {
        title: 'FaciTrack - Departments',
        ...data
    });
});

router.get('/rooms', (req, res) => {
    const data = getSharedData();
    res.render('pages/admin/rooms', {
        title: 'FaciTrack - Rooms',
        ...data
    });
});

module.exports = router;

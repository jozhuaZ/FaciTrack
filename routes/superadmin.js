const express = require('express');
const router = express.Router();
const { authenticateUser, createSession, getRoleRedirect, revokeSession } = require('../services/auth');
const { requireRole, setSessionCookie, clearSessionCookie } = require('../middleware/auth');

router.use((req, res, next) => {
    console.log(`[SuperAdmin Router] ${req.method} ${req.originalUrl}`);
    next();
});

// Reuse admin shared data (same institution-wide data) — reserved for future use

const DEPARTMENTS = [
    'College of Computer Studies',
    'College of Engineering',
    'College of Education',
    'College of Business Administration',
    'College of Arts and Sciences',
    'College of Industrial Technology'
];

let DEPT_DATA = [
    { name: 'College of Computer Studies',        shortName: 'CCS',  building: 'CCS Building',   dean: 'Dr. Lourdes Reyes',      facultyCount: 10, roomCount: 8,  bleDeployed: true,  status: 'active' },
    { name: 'College of Engineering',             shortName: 'COE',  building: 'COE Building',   dean: 'Dr. Renato Villafuerte', facultyCount: 3,  roomCount: 5,  bleDeployed: false, status: 'active' },
    { name: 'College of Education',               shortName: 'COEd', building: 'COEd Building',  dean: 'Dr. Pilar Gonzales',     facultyCount: 2,  roomCount: 4,  bleDeployed: false, status: 'active' },
    { name: 'College of Business Administration', shortName: 'CBA',  building: 'CBA Building',   dean: 'Dr. Rosario Medina',     facultyCount: 2,  roomCount: 4,  bleDeployed: false, status: 'active' },
    { name: 'College of Arts and Sciences',       shortName: 'CAS',  building: 'CAS Building',   dean: 'Dr. Herminia Santos',    facultyCount: 2,  roomCount: 4,  bleDeployed: false, status: 'active' },
    { name: 'College of Industrial Technology',   shortName: 'CIT',  building: 'CIT Building',   dean: 'Dr. Teresita Lim',       facultyCount: 1,  roomCount: 3,  bleDeployed: false, status: 'active' },
];

let nextDeptId = DEPT_DATA.length + 1;
DEPT_DATA = DEPT_DATA.map((dept, index) => ({ id: index + 1, ...dept }));

function normalizeDepartmentStatus(dept) {
    const isCCS = dept.shortName === 'CCS' || dept.name === 'College of Computer Studies';
    const bleDeployed = isCCS ? Boolean(dept.bleDeployed) : false;
    return {
        ...dept,
        bleDeployed,
        bleStatusLabel: bleDeployed ? 'Active' : 'Not Deployed'
    };
}

// Super Admin login
router.get('/login', (req, res) => {
    res.render('pages/superadmin/login', { title: 'FaciTrack - Super Admin', error: null });
});

router.post('/login', (req, res) => {
    const { email } = req.body;
    if (!email || email.trim().length === 0) {
        return res.render('pages/superadmin/login', { title: 'FaciTrack - Super Admin', error: 'Please enter your email address.' });
    }
    
    // PROTOTYPE MODE: Accept any email without password verification
    const { readData } = require('../services/data-store');
    const db = readData();
    const user = (db.users || []).find((u) => String(u.email || '').toLowerCase() === email.trim().toLowerCase());
    
    if (user && user.role === 'superadmin') {
        const session = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] || '' });
        setSessionCookie(res, session.token);
        res.redirect(getRoleRedirect(user.role));
    } else {
        res.render('pages/superadmin/login', { title: 'FaciTrack - Super Admin', error: 'Super Admin user not found.' });
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
// router.use(requireRole('superadmin'));

// Shared data for super admin (institution-wide)
function getSharedData() {
    // Build institution-wide data for super admin view
    const faculty = [
        { id: 1,  name: 'Dr. Maria Santos',     position: 'Professor',           department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 201', bleStatus: 'in-room',      bleLastDetected: '2 min ago',  hoursThisMonth: 48, consultationsThisMonth: 32, avgDuration: '42 min', pilotDept: true },
        { id: 2,  name: 'Prof. Jose Dela Cruz',  position: 'Associate Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 105', bleStatus: 'out-of-room',  bleLastDetected: '1 hr ago',   hoursThisMonth: 36, consultationsThisMonth: 24, avgDuration: '38 min', pilotDept: true },
        { id: 3,  name: 'Dr. Ana Villanueva',    position: 'Assistant Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 203', bleStatus: 'in-room',      bleLastDetected: '5 min ago',  hoursThisMonth: 42, consultationsThisMonth: 28, avgDuration: '45 min', pilotDept: true },
        { id: 4,  name: 'Prof. Carlos Bautista', position: 'Instructor',          department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 102', bleStatus: 'out-of-room',  bleLastDetected: '3 hrs ago',  hoursThisMonth: 30, consultationsThisMonth: 18, avgDuration: '35 min', pilotDept: true },
        { id: 5,  name: 'Dr. Ramon Aquino',      position: 'Associate Professor', department: 'College of Computer Studies', officeRoom: 'CCS Building, Room 204', bleStatus: 'in-room',      bleLastDetected: '10 min ago', hoursThisMonth: 40, consultationsThisMonth: 22, avgDuration: '40 min', pilotDept: true },
        { id: 11, name: 'Engr. Roberto Tan',     position: 'Professor',           department: 'College of Engineering',      officeRoom: 'COE Building, Room 101', bleStatus: 'not-deployed', bleLastDetected: 'N/A',        hoursThisMonth: 44, consultationsThisMonth: 27, avgDuration: '40 min', pilotDept: false },
        { id: 14, name: 'Dr. Celia Morales',     position: 'Professor',           department: 'College of Education',        officeRoom: 'COEd Building, Room 201',bleStatus: 'not-deployed', bleLastDetected: 'N/A',        hoursThisMonth: 42, consultationsThisMonth: 29, avgDuration: '43 min', pilotDept: false },
        { id: 16, name: 'Dr. Felix Domingo',     position: 'Associate Professor', department: 'College of Business Administration', officeRoom: 'CBA Building, Room 101', bleStatus: 'not-deployed', bleLastDetected: 'N/A', hoursThisMonth: 36, consultationsThisMonth: 22, avgDuration: '38 min', pilotDept: false },
        { id: 18, name: 'Dr. Alma Ramos',        position: 'Professor',           department: 'College of Arts and Sciences',officeRoom: 'CAS Building, Room 301', bleStatus: 'not-deployed', bleLastDetected: 'N/A',        hoursThisMonth: 40, consultationsThisMonth: 24, avgDuration: '41 min', pilotDept: false },
        { id: 20, name: 'Engr. Manny Soriano',   position: 'Instructor',          department: 'College of Industrial Technology', officeRoom: 'CIT Building, Room 101', bleStatus: 'not-deployed', bleLastDetected: 'N/A', hoursThisMonth: 26, consultationsThisMonth: 13, avgDuration: '31 min', pilotDept: false },
    ];

    const allAppointments = [
        { id: 1,  studentName: 'Juan Dela Cruz',   instructorName: 'Dr. Maria Santos',   department: 'College of Computer Studies',        date: 'May 3, 2026',  time: '2:00 PM',  duration: '30 min', topic: 'Thesis consultation', status: 'pending' },
        { id: 2,  studentName: 'Ana Reyes',         instructorName: 'Dr. Maria Santos',   department: 'College of Computer Studies',        date: 'May 4, 2026',  time: '10:00 AM', duration: '30 min', topic: 'Grade inquiry', status: 'confirmed' },
        { id: 3,  studentName: 'Pedro Lim',         instructorName: 'Dr. Ana Villanueva', department: 'College of Computer Studies',        date: 'May 3, 2026',  time: '9:00 AM',  duration: '30 min', topic: 'Research guidance', status: 'confirmed' },
        { id: 4,  studentName: 'Jerome Pascual',    instructorName: 'Engr. Roberto Tan',  department: 'College of Engineering',             date: 'May 4, 2026',  time: '10:00 AM', duration: '30 min', topic: 'Structural analysis', status: 'pending' },
        { id: 5,  studentName: 'Ryan Ocampo',       instructorName: 'Dr. Celia Morales',  department: 'College of Education',               date: 'May 4, 2026',  time: '1:00 PM',  duration: '30 min', topic: 'Lesson plan review', status: 'pending' },
        { id: 6,  studentName: 'Marco Dela Torre',  instructorName: 'Dr. Felix Domingo',  department: 'College of Business Administration', date: 'May 3, 2026',  time: '2:30 PM',  duration: '30 min', topic: 'Business plan', status: 'confirmed' },
        { id: 7,  studentName: 'Sofia Navarro',     instructorName: 'Dr. Alma Ramos',     department: 'College of Arts and Sciences',       date: 'May 4, 2026',  time: '3:00 PM',  duration: '45 min', topic: 'Research paper', status: 'pending' },
        { id: 8,  studentName: 'Renz Aquino',       instructorName: 'Engr. Manny Soriano',department: 'College of Industrial Technology',   date: 'May 5, 2026',  time: '10:30 AM', duration: '30 min', topic: 'Welding project', status: 'confirmed' },
    ];

    const presenceLogs = [
        { facultyName: 'Dr. Maria Santos',     department: 'College of Computer Studies', timestamp: '2026-05-03 09:15 AM', status: 'entered', location: 'CCS Building, Room 201', duration: null },
        { facultyName: 'Dr. Maria Santos',     department: 'College of Computer Studies', timestamp: '2026-05-03 11:30 AM', status: 'exited',  location: 'CCS Building, Room 201', duration: '2h 15m' },
        { facultyName: 'Dr. Ana Villanueva',   department: 'College of Computer Studies', timestamp: '2026-05-03 08:45 AM', status: 'entered', location: 'CCS Building, Room 203', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies', timestamp: '2026-05-03 09:00 AM', status: 'entered', location: 'CCS Building, Room 105', duration: null },
        { facultyName: 'Prof. Jose Dela Cruz', department: 'College of Computer Studies', timestamp: '2026-05-03 10:00 AM', status: 'exited',  location: 'CCS Building, Room 105', duration: '1h 0m' },
        { facultyName: 'Dr. Ramon Aquino',     department: 'College of Computer Studies', timestamp: '2026-05-03 08:00 AM', status: 'entered', location: 'CCS Building, Room 204', duration: null },
        { facultyName: 'Dr. Ramon Aquino',     department: 'College of Computer Studies', timestamp: '2026-05-03 11:00 AM', status: 'exited',  location: 'CCS Building, Room 204', duration: '3h 0m' },
    ];

    const users = [
        { id: 101, name: 'Mr. Paulo Navarro',     email: 'admin.ccs@cspc.edu.ph',  role: 'Admin',      department: 'College of Computer Studies',        status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:10 AM' },
        { id: 102, name: 'Engr. Lorna Vitug',     email: 'admin.coe@cspc.edu.ph',  role: 'Admin',      department: 'College of Engineering',             status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:15 AM' },
        { id: 103, name: 'Ms. Janine Relova',     email: 'admin.coed@cspc.edu.ph', role: 'Admin',      department: 'College of Education',               status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:05 AM' },
        { id: 104, name: 'Mr. Joel Cabrera',      email: 'admin.cba@cspc.edu.ph',  role: 'Admin',      department: 'College of Business Administration', status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:18 AM' },
        { id: 105, name: 'Ms. Irene Salvacion',   email: 'admin.cas@cspc.edu.ph',  role: 'Admin',      department: 'College of Arts and Sciences',       status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:12 AM' },
        { id: 106, name: 'Mr. Noel Manalo',       email: 'admin.cit@cspc.edu.ph',  role: 'Admin',      department: 'College of Industrial Technology',   status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:09 AM' },
        { id: 1,  name: 'Dr. Maria Santos',     email: 'msantos@cspc.edu.ph',    role: 'Instructor', department: 'College of Computer Studies',        status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:45 AM' },
        { id: 2,  name: 'Prof. Jose Dela Cruz',  email: 'jdelacruz@cspc.edu.ph',  role: 'Instructor', department: 'College of Computer Studies',        status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 09:00 AM' },
        { id: 3,  name: 'Dr. Ana Villanueva',    email: 'avillanueva@cspc.edu.ph', role: 'Instructor', department: 'College of Computer Studies',       status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:30 AM' },
        { id: 4,  name: 'Prof. Carlos Bautista', email: 'cbautista@cspc.edu.ph',  role: 'Instructor', department: 'College of Computer Studies',        status: 'active',   employmentType: 'Part-time', lastLogin: 'May 2, 2026 04:00 PM' },
        { id: 5,  name: 'Dr. Lourdes Reyes',     email: 'dean.ccs@cspc.edu.ph',   role: 'Dean',       department: 'College of Computer Studies',        status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:30 AM' },
        { id: 6,  name: 'Engr. Roberto Tan',     email: 'rtan@cspc.edu.ph',       role: 'Instructor', department: 'College of Engineering',             status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:10 AM' },
        { id: 7,  name: 'Dr. Renato Villafuerte',email: 'dean.coe@cspc.edu.ph',   role: 'Dean',       department: 'College of Engineering',             status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:45 AM' },
        { id: 8,  name: 'Dr. Celia Morales',     email: 'cmorales@cspc.edu.ph',   role: 'Instructor', department: 'College of Education',               status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 09:05 AM' },
        { id: 9,  name: 'Dr. Pilar Gonzales',    email: 'dean.coed@cspc.edu.ph',  role: 'Dean',       department: 'College of Education',               status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:20 AM' },
        { id: 10, name: 'Dr. Felix Domingo',     email: 'fdomingo@cspc.edu.ph',   role: 'Instructor', department: 'College of Business Administration', status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:40 AM' },
        { id: 11, name: 'Dr. Rosario Medina',    email: 'dean.cba@cspc.edu.ph',   role: 'Dean',       department: 'College of Business Administration', status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:55 AM' },
        { id: 12, name: 'Dr. Alma Ramos',        email: 'aramos@cspc.edu.ph',     role: 'Instructor', department: 'College of Arts and Sciences',       status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 09:15 AM' },
        { id: 13, name: 'Dr. Herminia Santos',   email: 'dean.cas@cspc.edu.ph',   role: 'Dean',       department: 'College of Arts and Sciences',       status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:00 AM' },
        { id: 14, name: 'Engr. Manny Soriano',   email: 'msoriano@cspc.edu.ph',   role: 'Instructor', department: 'College of Industrial Technology',   status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 08:30 AM' },
        { id: 15, name: 'Dr. Teresita Lim',      email: 'dean.cit@cspc.edu.ph',   role: 'Dean',       department: 'College of Industrial Technology',   status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 07:35 AM' },
        { id: 16, name: 'System Administrator',  email: 'admin@cspc.edu.ph',      role: 'Super Admin',department: 'Office of the Super Administrator',   status: 'active',   employmentType: 'Regular',   lastLogin: 'May 3, 2026 06:00 AM' },
    ];

    const logs = [
        { user: 'System Administrator', role: 'Admin',      action: 'Updated system settings',                    type: 'update', ip: '192.168.1.10',  timestamp: 'May 3, 2026 06:15 AM', isToday: true },
        { user: 'Dr. Lourdes Reyes',    role: 'Dean',       action: 'Logged into the system',                     type: 'login',  ip: '192.168.1.50',  timestamp: 'May 3, 2026 07:30 AM', isToday: true },
        { user: 'Dr. Maria Santos',     role: 'Instructor', action: 'Logged into the system',                     type: 'login',  ip: '192.168.1.101', timestamp: 'May 3, 2026 08:45 AM', isToday: true },
        { user: 'Prof. Jose Dela Cruz', role: 'Instructor', action: 'Updated consultation schedule',              type: 'update', ip: '192.168.1.102', timestamp: 'May 3, 2026 09:00 AM', isToday: true },
        { user: 'System Administrator', role: 'Admin',      action: 'Created new user: Prof. Carlos Bautista',    type: 'create', ip: '192.168.1.10',  timestamp: 'May 2, 2026 03:00 PM', isToday: false },
        { user: 'Dr. Ana Villanueva',   role: 'Instructor', action: 'Logged into the system',                     type: 'login',  ip: '192.168.1.103', timestamp: 'May 3, 2026 08:30 AM', isToday: true },
        { user: 'System Administrator', role: 'Admin',      action: 'Deactivated account: Prof. Grace Mendoza',   type: 'update', ip: '192.168.1.10',  timestamp: 'May 1, 2026 02:05 PM', isToday: false },
        { user: 'Dr. Ramon Aquino',     role: 'Instructor', action: 'Logged into the system',                     type: 'login',  ip: '192.168.1.105', timestamp: 'May 3, 2026 07:55 AM', isToday: true },
    ];

    const settings = [
        { label: 'System Name',                      value: 'FaciTrack' },
        { label: 'Institution',                      value: 'Camarines Sur Polytechnic Colleges' },
        { label: 'Pilot Department',                 value: 'College of Computer Studies' },
        { label: 'Deployment Scope',                 value: 'Institution-wide (Super Admin view)' },
        { label: 'BLE Scan Interval (seconds)',      value: '30' },
        { label: 'BLE Signal Threshold (RSSI)',      value: '-75 dBm' },
        { label: 'Presence Timeout (minutes)',       value: '10' },
        { label: 'Auto-Refresh Interval (seconds)',  value: '30' },
        { label: 'Max Appointment Duration (min)',   value: '60' },
        { label: 'Booking Window (days)',            value: '7' },
    ];

    const toggles = [
        { label: 'BLE Real-Time Monitoring',       description: 'Enable live faculty presence detection via BLE beacons.',                    enabled: true },
        { label: 'Public Display Screen',          description: 'Show faculty availability on the public monitor.',                           enabled: true },
        { label: 'Student Appointment Booking',    description: 'Allow students to book consultation appointments online.',                   enabled: true },
        { label: 'Email Notifications',            description: 'Send email alerts for appointment confirmations and reminders.',             enabled: false },
        { label: 'Audit Logging',                  description: 'Record all user actions and system events for security review.',             enabled: true },
        { label: 'Multi-Department BLE Rollout',   description: 'Enable BLE deployment for non-pilot departments (requires hardware setup).', enabled: false },
    ];

    const normalizedDeptData = DEPT_DATA.map(normalizeDepartmentStatus);
    return { faculty, allAppointments, presenceLogs, users, logs, settings, toggles, deptData: normalizedDeptData, departments: normalizedDeptData.map(d => d.name) };
}

// Routes
router.get('/dashboard',   (req, res) => { const d=getSharedData(); res.render('pages/superadmin/dashboard',   { title: 'FaciTrack - Super Admin', ...d }); });
router.get('/departments', (req, res) => { const d=getSharedData(); res.render('pages/superadmin/departments', { title: 'FaciTrack - Departments',  ...d }); });
router.get('/users',       (req, res) => { const d=getSharedData(); res.render('pages/superadmin/users',       { title: 'FaciTrack - All Users',    ...d }); });
router.get('/monitoring',  (req, res) => { const d=getSharedData(); res.render('pages/superadmin/monitoring',  { title: 'FaciTrack - Monitoring',   ...d }); });
router.get('/reports',     (req, res) => { const d=getSharedData(); res.render('pages/superadmin/reports',     { title: 'FaciTrack - Reports',      ...d }); });
router.get('/logs',        (req, res) => { const d=getSharedData(); res.render('pages/superadmin/logs',        { title: 'FaciTrack - Audit Logs',   ...d }); });
router.get('/settings',    (req, res) => { const d=getSharedData(); res.render('pages/superadmin/settings',    { title: 'FaciTrack - Settings',     ...d }); });

router.post('/departments', (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required.' });

    const shortName = (req.body.shortName || '').trim();
    const building = (req.body.building || '').trim();
    const dean = (req.body.dean || '').trim();
    const status = (req.body.status || 'active').trim();

    const duplicate = DEPT_DATA.some(d => d.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return res.status(409).json({ error: 'Department already exists.' });

    const created = normalizeDepartmentStatus({
        id: nextDeptId++,
        name,
        shortName: shortName || name.split(' ').map(w => w[0]).join('').slice(0, 4).toUpperCase(),
        building: building || 'TBD',
        dean: dean || 'TBD',
        facultyCount: Number(req.body.facultyCount) || 0,
        roomCount: Number(req.body.roomCount) || 0,
        bleDeployed: req.body.bleDeployed === true || req.body.bleDeployed === 'true',
        status: status === 'inactive' ? 'inactive' : 'active'
    });

    DEPT_DATA.push(created);
    return res.status(201).json({ department: created });
});

router.patch('/departments/:id', (req, res) => {
    const departmentId = Number(req.params.id);
    const targetIndex = DEPT_DATA.findIndex(d => d.id === departmentId);
    if (targetIndex === -1) return res.status(404).json({ error: 'Department not found.' });

    const current = DEPT_DATA[targetIndex];
    const next = {
        ...current,
        name: (req.body.name || current.name).trim(),
        shortName: (req.body.shortName || current.shortName).trim(),
        building: (req.body.building || current.building).trim(),
        dean: (req.body.dean || current.dean).trim(),
        status: ((req.body.status || current.status).trim() === 'inactive') ? 'inactive' : 'active',
        bleDeployed: req.body.bleDeployed === undefined ? current.bleDeployed : (req.body.bleDeployed === true || req.body.bleDeployed === 'true')
    };

    DEPT_DATA[targetIndex] = normalizeDepartmentStatus(next);
    return res.json({ department: DEPT_DATA[targetIndex] });
});

router.delete('/departments/:id', (req, res) => {
    const departmentId = Number(req.params.id);
    const targetIndex = DEPT_DATA.findIndex(d => d.id === departmentId);
    if (targetIndex === -1) return res.status(404).json({ error: 'Department not found.' });

    const [removed] = DEPT_DATA.splice(targetIndex, 1);
    return res.json({ deletedId: departmentId, department: removed });
});

module.exports = router;

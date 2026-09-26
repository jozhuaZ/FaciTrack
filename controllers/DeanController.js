const DeanModel = require('../models/DeanModel');
const MakeupRequestModel = require('../models/MakeupRequestModel');
const NotificationModel = require('../models/NotificationModel');
const InstructorSettingsModel = require('../models/InstructorSettingsModel');
const { timeAgo, to12Hour, formatFullDate } = require('../utils/timeFormat');
const appSettings = require('../services/app-settings');

/**
 * The Dean module's read side.
 *
 * The views were written against a hardcoded faculty list, so this layer's job
 * is to hand them the same field names filled from the database. The one shape
 * change is presence: `bleStatus` now has a third value, 'unknown', for the
 * faculty the BLE module has never reported on — which today is all of them.
 */

// users.availability_status → what the monitoring board calls it
// Shared with the dean's reports and the lounge board — see utils/availability.js.
const { AVAILABILITY_LABELS } = require('../utils/availability');

function toDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** First and last day of the month containing `ref`. */
function monthWindow(ref = new Date()) {
    const since = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const until = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
    return { since: toDateKey(since), until: toDateKey(until) };
}

/** A DATE column arrives as a Date from mysql2; the views want 'YYYY-MM-DD'. */
function dateKey(value) {
    if (!value) return null;
    return value instanceof Date ? toDateKey(value) : String(value).slice(0, 10);
}

/**
 * Presence, told honestly.
 *
 * No row in `faculty_presence` is not the same as "out of room" — it means no
 * scanner has ever reported on this person. Collapsing the two would have the
 * dashboard confidently announce that every instructor is absent.
 */
function presenceOf(row) {
    if (row.is_present === null || row.is_present === undefined) {
        return { bleStatus: 'unknown', bleLastDetected: null };
    }
    return {
        bleStatus: row.is_present ? 'in-room' : 'out-of-room',
        bleLastDetected: timeAgo(row.presence_updated_at),
    };
}

function facultyRow(row) {
    const minutes = Number(row.minutes) || 0;
    const consultations = Number(row.consultations) || 0;

    return {
        id: row.id,
        name: row.name,
        position: row.position || 'Faculty',
        department: row.department || '',
        status: row.status,
        // Selected by the query all along, but dropped here — so the monitoring
        // board had nothing to render and fell back to a silhouette for everyone.
        photo: row.profile_picture || null,
        officeRoom: row.office_room_number
            ? [row.office_building, row.office_room_number].filter(Boolean).join(', ')
            : 'No office assigned',
        // Where BLE last saw them. Null until the scanners are installed; the
        // Rooms view groups on the id, so a room rename cannot break the match.
        detectedRoomId: row.detected_room_id || null,
        detectedRoom: row.detected_room_number || null,
        detectedRoomType: row.detected_room_type || null,
        baseRoomId: row.base_room_id || null,
        availability: row.availability_status || null,
        availabilityLabel: AVAILABILITY_LABELS[row.availability_status] || 'Not set',
        hoursThisMonth: Math.round(minutes / 60),
        consultationsThisMonth: consultations,
        avgDuration: consultations ? `${Math.round(minutes / consultations)} min` : null,
        ...presenceOf(row),
    };
}

/**
 * One make-up request flattened for a table row. A request carries several
 * sessions, so the subjects and rooms are collapsed into summary strings and
 * the earliest session date is what the row sorts and filters by.
 */
function makeupRow(row) {
    const sessions = row.sessions || [];
    const unique = values => [...new Set(values.filter(Boolean))];

    const subjects = unique(sessions.map(s => s.subject_code));
    const sections = unique(sessions.map(s => s.section_name));
    const rooms = unique(sessions.map(s => s.room_number || (s.delivery_mode === 'online' ? 'Online' : null)));
    const dates = sessions.map(s => dateKey(s.class_date)).filter(Boolean).sort();

    return {
        id: row.id,
        instructorName: `${row.first_name} ${row.last_name}`,
        position: row.position || 'Faculty',
        subject: subjects.join(', ') || '—',
        subjectName: unique(sessions.map(s => s.subject_name)).join(', '),
        section: sections.join(', ') || '—',
        sessionCount: sessions.length,
        sessionDates: dates,
        firstDate: dates[0] || null,
        timeLabel: sessions.length ? sessions[0].timeLabel : '',
        rooms: rooms.join(', ') || '—',
        deliveryMode: unique(sessions.map(s => s.delivery_mode)).join(', '),
        documentCount: (row.documents || []).length,
        hasPolling: Boolean(row.pollingDocument),
        status: row.status,
        reason: row.reason || '',
        decidedBy: row.decided_by_first ? `${row.decided_by_first} ${row.decided_by_last}` : null,
        decidedAt: row.decided_at ? dateKey(row.decided_at) : null,
        submittedAt: dateKey(row.submitted_at),
    };
}

/**
 * A booking request nobody has answered.
 *
 * waitingHours is kept alongside the human label so the table can sort and
 * filter on it — "3 days" does not order correctly as text.
 */
function unansweredRow(row) {
    const hours = Number(row.waiting_hours) || 0;
    return {
        id: row.id,
        instructorName: row.instructor_name,
        studentName: row.student_name,
        studentNumber: row.student_number || '—',
        topic: row.topic || '—',
        mode: row.mode,
        date: dateKey(row.consultation_date),
        dateLabel: formatFullDate(row.consultation_date),
        timeLabel: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
        requestedAt: row.created_at ? timeAgo(row.created_at) : '—',
        waitingHours: hours,
        waitingLabel: hours < 24
            ? `${hours}h`
            : `${Math.floor(hours / 24)}d ${hours % 24}h`,
        // Past the escalation threshold — the row the dean is meant to notice.
        stale: Boolean(Number(row.is_stale)),
    };
}

function presenceRow(row) {
    return {
        id: row.id,
        facultyName: row.facultyName,
        // 'moved' is an arrival as far as a reader is concerned — they walked
        // into this room; which room they left is the previous row's business.
        status: row.event === 'exited' ? 'exited' : 'entered',
        location: row.room_number
            ? [row.building, row.room_number].filter(Boolean).join(', ')
            : 'Unknown location',
        timestamp: row.occurred_at,
        relative: timeAgo(row.occurred_at),
        duration: formatDuration(row.minutes_in_room),
        scannerId: row.scanner_id || null,
    };
}

/** "1h 20m" — only an exit closes a visit, so entries have no length yet. */
function formatDuration(minutes) {
    if (minutes === null || minutes === undefined) return null;
    const total = Number(minutes);
    if (!Number.isFinite(total) || total < 0) return null;
    if (total < 60) return total + 'm';
    return Math.floor(total / 60) + 'h ' + (total % 60) + 'm';
}

/**
 * Everything a dean page is built from: the faculty roster, their presence,
 * and the department's make-up requests. Loading them together keeps the
 * sidebar badge, the stat cards and the tables consistent with one another,
 * which separate per-page queries would not guarantee.
 *
 * The make-up queue is fetched once and serves both the sidebar count and the
 * reports table, rather than being queried twice for the same rows.
 */
async function loadDepartment(deanPublicId) {
    const { since, until } = monthWindow();

    const staleHours = await appSettings.get('pending_escalate_hours');

    const [dean, facultyRows, presenceRows, makeupRows, notifications, unansweredRows] = await Promise.all([
        DeanModel.getDean(deanPublicId),
        DeanModel.getFaculty(deanPublicId, { since, until }),
        DeanModel.getPresenceHistory(deanPublicId),
        MakeupRequestModel.getByDepartment(deanPublicId).catch(err => {
            console.error('[Dean] Could not load make-up requests:', err.message);
            return [];
        }),
        NotificationModel.getForUser(deanPublicId).catch(() => []),
        DeanModel.getUnansweredRequests(deanPublicId, { staleHours }).catch(err => {
            console.error('[Dean] Could not load unanswered requests:', err.message);
            return [];
        }),
    ]);

    const faculty = facultyRows.map(facultyRow);
    const presenceLogs = presenceRows.map(presenceRow);
    const makeupRequests = makeupRows.map(makeupRow);
    const unansweredRequests = unansweredRows.map(unansweredRow);

    return {
        dean: {
            name: dean?.name || 'Dean',
            firstName: dean?.first_name || '',
            middleName: dean?.middle_name || '',
            lastName: dean?.last_name || '',
            email: dean?.email || '',
            position: dean?.position || 'Dean',
            department: dean?.department || 'No department assigned',
            profilePhoto: dean?.profile_picture || null,
        },
        faculty,
        presenceLogs,
        recentActivity: presenceLogs.slice(0, 6),
        makeupRequests,
        pendingMakeupCount: makeupRequests.filter(r => r.status === 'pending').length,
        unansweredRequests,
        // Only the overdue ones drive the alert. Every pending request would
        // count a booking made ten minutes ago, which no instructor has had a
        // chance to answer yet — an alarm nobody could ever clear.
        unansweredStaleCount: unansweredRequests.filter(r => r.stale).length,
        unansweredStaleHours: staleHours,
        notifications,
        // True while no scanner has ever reported, so the pages can explain
        // themselves instead of showing convincing-looking zeroes.
        presenceUnavailable: faculty.every(f => f.bleStatus === 'unknown'),
    };
}

const DeanController = {

    async renderDashboard(req, res) {
        try {
            res.render('pages/dean/dashboard', {
                title: 'FaciTrack - Dashboard',
                ...(await loadDepartment(req.session.userId)),
            });
        } catch (err) {
            console.error('[DeanController.renderDashboard]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderFaculty(req, res) {
        try {
            const [data, rooms] = await Promise.all([
                loadDepartment(req.session.userId),
                DeanModel.getRooms(req.session.userId).catch(() => []),
            ]);
            const { bleStatus } = req.query;

            res.render('pages/dean/faculty', {
                title: 'FaciTrack - Faculty',
                ...data,
                faculty: bleStatus
                    ? data.faculty.filter(f => f.bleStatus === bleStatus)
                    : data.faculty,
                filterBleStatus: bleStatus || '',
                rooms,
            });
        } catch (err) {
            console.error('[DeanController.renderFaculty]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderPresence(req, res) {
        try {
            res.render('pages/dean/presence', {
                title: 'FaciTrack - Presence Logs',
                ...(await loadDepartment(req.session.userId)),
            });
        } catch (err) {
            console.error('[DeanController.renderPresence]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * The presence feed as JSON, for pages refreshing themselves after a
     * realtime nudge. Same shaping as the rendered page, so the two can never
     * disagree about what a row means.
     */
    async getPresenceFeedJson(req, res) {
        try {
            const rows = await DeanModel.getPresenceHistory(req.session.userId, { limit: 200 });
            res.json({ success: true, logs: rows.map(presenceRow) });
        } catch (err) {
            console.error('[DeanController.getPresenceFeedJson]', err);
            res.status(500).json({ success: false, error: 'Could not load presence.' });
        }
    },

    /**
     * Just the table rows, rendered from the same partial the page uses, so a
     * row that arrives live is identical to one written at page load.
     */
    async getPresenceRows(req, res) {
        try {
            const rows = await DeanModel.getPresenceHistory(req.session.userId, { limit: 200 });
            res.render('partials/presence-rows', { presenceLogs: rows.map(presenceRow) });
        } catch (err) {
            console.error('[DeanController.getPresenceRows]', err);
            // The one place that must NOT reach the error page: this returns
            // table rows for a live refresh, so an error document here would
            // be spliced into a <tbody>. Answer with nothing and leave the
            // rows already on screen alone.
            res.status(500).send('');
        }
    },

    async renderReports(req, res) {
        try {
            res.render('pages/dean/reports', {
                title: 'FaciTrack - Reports',
                ...(await loadDepartment(req.session.userId)),
            });
        } catch (err) {
            console.error('[DeanController.renderReports]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderSettings(req, res) {
        try {
            const [data, prefs] = await Promise.all([
                loadDepartment(req.session.userId),
                InstructorSettingsModel.getByPublicId(req.session.userId),
            ]);
            res.render('pages/dean/settings', {
                title: 'FaciTrack - Settings',
                ...data,
                prefs,
            });
        } catch (err) {
            console.error('[DeanController.renderSettings]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * The 3D viewer still draws a synthetic building; only the chrome around it
     * is real for now. Rooms are passed through so the scene can be pointed at
     * them without another round trip once the model is wired up.
     */
    async renderBuilding(req, res) {
        try {
            const [data, rooms] = await Promise.all([
                loadDepartment(req.session.userId),
                DeanModel.getRooms(req.session.userId).catch(() => []),
            ]);
            res.render('pages/dean/building', {
                title: 'FaciTrack - 3D Building Viewer',
                ...data,
                rooms,
            });
        } catch (err) {
            console.error('[DeanController.renderBuilding]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },
};

module.exports = DeanController;
module.exports.loadDepartment = loadDepartment;

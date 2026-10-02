const pool = require('../configs/db');

/**
 * Class Attendance: how long each instructor was actually detected in the room
 * their workload assigns, during each class meeting. For the Dean's reports.
 *
 * Reporting only. Nothing here reads or changes appointments or availability —
 * BLE presence and appointment status never influence each other.
 *
 * A "meeting" is one occurrence of a class:
 *   - every week a workload block falls on its day, from the day the workload
 *     was imported (the workload keeps no semester start) up to today, except
 *     days the instructor marked unavailable;
 *   - plus each session of an approved make-up request, in its own room and time.
 *
 * For each meeting, from the presence history:
 *   presentMinutes   time inside the class window spent in the assigned room
 *   firstIn / lastOut when the instructor was first and last detected there
 *   monitoredMinutes time inside the window the room's scanner was online
 * and a status:
 *   no-room      the workload has no room for this class, so nothing to check
 *   no-signal    the room's scanner was offline the whole class
 *   present      in the room at least 75% of the class
 *   partial      in the room some of the class
 *   absent       not detected in the room at all while the scanner watched
 *   in-progress  the class has started and not finished yet
 *
 * All times are Manila wall-clock strings ('YYYY-MM-DD HH:MM:SS'), the same
 * clock the database and the Node process run on (see app.js).
 */

const PRESENT_SHARE = 0.75;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = n => String(n).padStart(2, '0');
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(key, days) {
    const d = new Date(key + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return dateKey(d);
}
/** Half-hour slot index → 'HH:MM:SS' (slot 14 = 07:00). */
function slotTime(slot) {
    const m = Number(slot) * 30;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`;
}
/** 'YYYY-MM-DD HH:MM:SS' (or a date + time) → epoch ms on the process clock. */
function ms(value) { return new Date(String(value).replace(' ', 'T')).getTime(); }
function stamp(t) {
    const d = new Date(t);
    return `${dateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function to12(t) {
    const d = new Date(t);
    const h = d.getHours();
    return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Total length of the parts of `intervals` that fall inside [start, end), overlaps merged. */
function coveredMs(intervals, start, end) {
    const parts = intervals
        .map(i => [Math.max(i.start, start), Math.min(i.end, end)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    let total = 0;
    let curA = null;
    let curB = null;
    for (const [a, b] of parts) {
        if (curB === null || a > curB) {
            if (curB !== null) total += curB - curA;
            curA = a; curB = b;
        } else if (b > curB) {
            curB = b;
        }
    }
    if (curB !== null) total += curB - curA;
    return total;
}

const ClassAttendanceModel = {

    /**
     * Every class meeting for the dean's department between `from` and today
     * (inclusive), newest first, with its measured attendance.
     */
    async getForDean(deanPublicId, { from } = {}) {
        const [[dean]] = await pool.execute(
            'SELECT department_id FROM users WHERE public_id = ?', [deanPublicId]
        );
        if (!dean) return [];

        const now = Date.now();
        const today = dateKey(new Date(now));
        const fromKey = from || addDays(today, -60);

        const [instructors] = await pool.execute(
            `SELECT id, CONCAT(first_name, ' ', last_name) AS name
               FROM users
              WHERE role = 'Instructor' AND department_id <=> ?`,
            [dean.department_id]
        );
        if (!instructors.length) return [];
        const ids = instructors.map(i => i.id);
        const nameOf = new Map(instructors.map(i => [i.id, i.name]));

        const [blocks] = await pool.query(
            `SELECT wb.id, wb.instructor_id, wb.day_of_week, wb.start_slot, wb.end_slot,
                    wb.section_name, wb.class_type, wb.room_id, DATE(wb.created_at) AS imported_on,
                    ws.subject_code, ws.subject_name, r.room_number
               FROM workload_blocks wb
               LEFT JOIN workload_subjects ws ON ws.id = wb.subject_id
               LEFT JOIN rooms r ON r.id = wb.room_id
              WHERE wb.instructor_id IN (?)`,
            [ids]
        );

        const [makeups] = await pool.query(
            `SELECT s.id, mr.instructor_id, DATE_FORMAT(s.class_date, '%Y-%m-%d') AS class_date,
                    s.start_slot, s.end_slot, s.section_name, s.class_type, s.room_id,
                    s.subject_code, s.subject_name, r.room_number
               FROM makeup_requests mr
               JOIN makeup_request_schedules s ON s.request_id = mr.id
               LEFT JOIN rooms r ON r.id = s.room_id
              WHERE mr.instructor_id IN (?) AND mr.status = 'approved'
                AND s.class_date BETWEEN ? AND ?`,
            [ids, fromKey, today]
        );

        const [blockedRows] = await pool.query(
            `SELECT instructor_id, DATE_FORMAT(unavail_date, '%Y-%m-%d') AS d
               FROM instructor_unavailability
              WHERE instructor_id IN (?) AND unavail_date BETWEEN ? AND ?`,
            [ids, fromKey, today]
        );
        const blocked = new Set(blockedRows.map(b => b.instructor_id + '|' + b.d));

        // ── Meetings ──
        const meetings = [];
        const dayIndex = name => DAY_NAMES.indexOf(name);
        for (const b of blocks) {
            const want = dayIndex(b.day_of_week);
            if (want < 0) continue;
            const imported = typeof b.imported_on === 'string' ? b.imported_on.slice(0, 10) : dateKey(new Date(b.imported_on));
            let d = fromKey > imported ? fromKey : imported;
            // Walk to the first matching weekday, then step a week at a time
            while (new Date(d + 'T00:00:00').getDay() !== want) d = addDays(d, 1);
            for (; d <= today; d = addDays(d, 7)) {
                if (blocked.has(b.instructor_id + '|' + d)) continue;
                meetings.push({
                    kind: 'class', sourceId: b.id, instructorId: b.instructor_id, date: d,
                    startSlot: b.start_slot, endSlot: b.end_slot, roomId: b.room_id,
                    room: b.room_number || null, subjectCode: b.subject_code || '—',
                    subjectName: b.subject_name || '', section: b.section_name || '',
                    classType: b.class_type || '',
                });
            }
        }
        for (const m of makeups) {
            meetings.push({
                kind: 'makeup', sourceId: m.id, instructorId: m.instructor_id, date: m.class_date,
                startSlot: m.start_slot, endSlot: m.end_slot, roomId: m.room_id,
                room: m.room_number || null, subjectCode: m.subject_code || '—',
                subjectName: m.subject_name || '', section: m.section_name || '',
                classType: m.class_type || '',
            });
        }
        if (!meetings.length) return [];

        // ── Presence intervals per instructor, from the entered/moved/exited log ──
        // A day of margin either side catches someone who walked in the evening before.
        const [events] = await pool.query(
            `SELECT instructor_id, room_id, event, DATE_FORMAT(occurred_at, '%Y-%m-%d %H:%i:%s') AS t
               FROM presence_logs
              WHERE instructor_id IN (?) AND occurred_at BETWEEN ? AND ?
              ORDER BY instructor_id, occurred_at, id`,
            [ids, addDays(fromKey, -1) + ' 00:00:00', addDays(today, 1) + ' 00:00:00']
        );
        const [live] = await pool.query(
            'SELECT instructor_id, room_id, is_present, signal_lost FROM faculty_presence WHERE instructor_id IN (?)',
            [ids]
        );
        const stillIn = new Map(live.filter(r => r.is_present && !r.signal_lost).map(r => [r.instructor_id, r.room_id]));

        const intervalsBy = new Map();   // instructorId → [{room, start, end}]
        let open = null;
        let openFor = null;
        const close = at => {
            if (open) {
                if (!intervalsBy.has(openFor)) intervalsBy.set(openFor, []);
                intervalsBy.get(openFor).push({ room: open.room, start: open.start, end: at });
            }
            open = null;
        };
        for (const e of events) {
            if (e.instructor_id !== openFor) {
                // The previous instructor's last interval: still open only if
                // they are still in that room now
                if (open) close(stillIn.get(openFor) === open.room ? now : open.start);
                openFor = e.instructor_id;
            }
            const t = ms(e.t);
            if (e.event === 'exited') { if (open) close(t); continue; }
            if (open) close(t);                 // entered/moved ends any earlier stay
            open = { room: e.room_id, start: t };
        }
        if (open) close(stillIn.get(openFor) === open.room ? now : open.start);

        // ── When each room's scanner was online ──
        const roomIds = [...new Set(meetings.map(m => m.roomId).filter(Boolean))];
        let runsBy = new Map();
        let trackingSince = null;
        if (roomIds.length) {
            const [runs] = await pool.query(
                `SELECT room_id, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS a,
                        DATE_FORMAT(last_seen_at, '%Y-%m-%d %H:%i:%s') AS b
                   FROM scanner_online_runs
                  WHERE room_id IN (?) AND last_seen_at >= ? AND started_at <= ?`,
                [roomIds, fromKey + ' 00:00:00', addDays(today, 1) + ' 00:00:00']
            );
            for (const r of runs) {
                if (!runsBy.has(r.room_id)) runsBy.set(r.room_id, []);
                // A report covers the few seconds after it too
                runsBy.get(r.room_id).push({ start: ms(r.a), end: ms(r.b) + 15000 });
            }
            const [[first]] = await pool.query('SELECT MIN(started_at) AS s FROM scanner_online_runs');
            trackingSince = first && first.s ? ms(first.s) : null;
        }

        // ── Measure each meeting ──
        const rows = [];
        for (const m of meetings) {
            const start = ms(`${m.date}T${slotTime(m.startSlot)}`);
            const end = ms(`${m.date}T${slotTime(m.endSlot)}`);
            if (start > now) continue;                    // not started yet
            const inProgress = end > now;
            const until = Math.min(end, now);
            const scheduledMin = Math.round((end - start) / 60000);

            let status;
            let presentMin = null;
            let monitoredMin = null;
            let firstIn = null;
            let lastOut = null;

            if (!m.roomId) {
                status = 'no-room';
            } else {
                const stays = (intervalsBy.get(m.instructorId) || [])
                    .filter(i => i.room === m.roomId && i.end > start && i.start < until);
                presentMin = Math.round(coveredMs(stays, start, until) / 60000);
                if (stays.length) {
                    firstIn = Math.max(start, Math.min(...stays.map(s => s.start)));
                    lastOut = Math.min(until, Math.max(...stays.map(s => s.end)));
                }

                // Before scanner history existed, "offline" cannot be told
                // apart from "absent", so the signal is not judged at all.
                const judged = trackingSince !== null && until > trackingSince;
                monitoredMin = judged
                    ? Math.round(coveredMs(runsBy.get(m.roomId) || [], start, until) / 60000)
                    : null;

                if (judged && monitoredMin === 0 && presentMin === 0) status = 'no-signal';
                else if (inProgress) status = 'in-progress';
                else if (presentMin === 0) status = 'absent';
                else if (presentMin >= scheduledMin * PRESENT_SHARE) status = 'present';
                else status = 'partial';
            }

            const lateMin = firstIn !== null ? Math.max(0, Math.round((firstIn - start) / 60000)) : null;
            rows.push({
                id: `${m.kind}-${m.sourceId}-${m.date}`,
                kind: m.kind,
                instructorName: nameOf.get(m.instructorId) || '—',
                date: m.date,
                dateLabel: new Date(m.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
                timeLabel: `${to12(start)} – ${to12(end)}`,
                startsAt: stamp(start),
                subjectCode: m.subjectCode,
                subjectName: m.subjectName,
                section: m.section,
                classType: m.classType,
                room: m.room || 'No room assigned',
                scheduledMin,
                presentMin,
                monitoredMin,
                percent: presentMin !== null && scheduledMin ? Math.round(presentMin / scheduledMin * 100) : null,
                firstIn: firstIn !== null ? to12(firstIn) : null,
                lastOut: lastOut !== null ? to12(lastOut) : null,
                lateMin,
                status,
            });
        }

        rows.sort((a, b) => (a.startsAt < b.startsAt ? 1 : a.startsAt > b.startsAt ? -1 : 0));
        return rows;
    },
};

module.exports = ClassAttendanceModel;
module.exports.coveredMs = coveredMs;

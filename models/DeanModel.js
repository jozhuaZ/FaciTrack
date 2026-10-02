const pool = require('../configs/db');

/**
 * Everything the Dean module reads, scoped to the dean's own department.
 *
 * Every query joins the dean back through `users.public_id` rather than
 * trusting a department id carried in the session, so a stale session can
 * never widen what a dean is allowed to see.
 *
 * Presence is deliberately a LEFT JOIN onto `faculty_presence`: that table is
 * written by the BLE module, which is not built yet. Today every faculty row
 * comes back with no presence and the pages say so; the moment the scanners
 * start writing, the same queries return real values with no change needed
 * here or in the views.
 *
 * The dean's scope is faculty, their presence, and make-up class requests.
 * Individual student consultations are not read here — the only thing this
 * module takes from the appointments table is each instructor's own workload
 * total, which is a fact about the instructor rather than about any booking.
 */

// Which appointment statuses count as consultation work actually delivered
const DELIVERED_STATUSES = "'confirmed', 'completed'";

const DeanModel = {

    /** The dean's own record, for the sidebar and report headers. */
    async getDean(deanPublicId) {
        const [rows] = await pool.execute(
            `SELECT u.id AS internal_id,
                    u.public_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS name,
                    u.first_name, u.middle_name, u.last_name, u.email,
                    u.position, u.profile_picture,
                    u.department_id,
                    d.full_name  AS department,
                    d.short_name AS department_short,
                    d.building   AS department_building
               FROM users u
               LEFT JOIN departments d ON u.department_id = d.id
              WHERE u.public_id = ?`,
            [deanPublicId]
        );
        return rows[0] || null;
    },

    /**
     * Every instructor in the dean's department, with their base office, their
     * self-reported availability, and their presence row if one exists.
     *
     * Consultation totals cover the given window and count only work that
     * actually happened or is committed to happen.
     */
    async getFaculty(deanPublicId, { since, until } = {}) {
        const [rows] = await pool.execute(
            `SELECT u.public_id            AS id,
                    CONCAT(u.first_name, ' ', u.last_name) AS name,
                    u.position,
                    u.status,
                    u.availability_status,
                    u.profile_picture,
                    u.base_room_id,
                    d.full_name            AS department,
                    office.room_number     AS office_room_number,
                    office.room_type       AS office_room_type,
                    officeDept.building    AS office_building,
                    fp.is_present,
                    fp.signal_lost,
                    fp.last_updated        AS presence_updated_at,
                    fp.room_id             AS detected_room_id,
                    detected.room_number   AS detected_room_number,
                    detected.room_type     AS detected_room_type,
                    stats.consultations,
                    stats.minutes
               FROM users u
               JOIN users dean ON dean.public_id = ?
               LEFT JOIN departments d          ON u.department_id      = d.id
               LEFT JOIN rooms office           ON u.base_room_id       = office.id
               LEFT JOIN departments officeDept ON office.department_id = officeDept.id
               LEFT JOIN faculty_presence fp    ON fp.instructor_id     = u.id
               LEFT JOIN rooms detected         ON fp.room_id           = detected.id
               LEFT JOIN (
                    SELECT a.instructor_id,
                           COUNT(*) AS consultations,
                           SUM(TIME_TO_SEC(TIMEDIFF(ch.end_time, ch.start_time)) / 60) AS minutes
                      FROM appointments a
                      JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
                     WHERE a.status IN (${DELIVERED_STATUSES})
                       AND ch.consultation_date BETWEEN ? AND ?
                     GROUP BY a.instructor_id
               ) stats ON stats.instructor_id = u.id
              WHERE u.role = 'Instructor'
                AND u.department_id <=> dean.department_id
              ORDER BY u.last_name ASC, u.first_name ASC`,
            [deanPublicId, since, until]
        );
        return rows;
    },

    /**
     * Booking requests in this dean's department that no instructor has
     * answered yet.
     *
     * Scoped the same way getFaculty() is — through the dean's own
     * department_id — so a dean only ever sees their own faculty.
     *
     * Only consultations still in the future are counted. A request for a slot
     * that has already passed is a different problem: nobody can approve it
     * now, and listing it as "waiting" would imply an action that no longer
     * exists.
     *
     * @param {number} staleHours  a request counts as unanswered after this long
     */
    async getUnansweredRequests(deanPublicId, { staleHours = 48 } = {}) {
        const [rows] = await pool.execute(
            `SELECT a.id,
                    a.created_at,
                    a.topic,
                    a.mode,
                    TIMESTAMPDIFF(HOUR, a.created_at, NOW())      AS waiting_hours,
                    TIMESTAMPDIFF(HOUR, a.created_at, NOW()) >= ? AS is_stale,
                    ch.consultation_date,
                    ch.start_time,
                    ch.end_time,
                    CONCAT(i.first_name, ' ', i.last_name) AS instructor_name,
                    CONCAT(s.first_name, ' ', s.last_name) AS student_name,
                    a.student_number
               FROM appointments a
               JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
               JOIN users i ON a.instructor_id = i.id
               JOIN users s ON a.student_id    = s.id
               JOIN users dean ON dean.public_id = ?
              WHERE a.status = 'pending'
                AND i.department_id <=> dean.department_id
                AND TIMESTAMP(ch.consultation_date, ch.start_time) > NOW()
              ORDER BY a.created_at ASC`,
            [staleHours, deanPublicId]
        );
        return rows;
    },

    /**
     * The presence feed for the Presence Logs page.
     *
     * `faculty_presence` holds one row per instructor and is updated in place,
     * so each row is that instructor's latest detection rather than a history.
     * Until the BLE module ships this returns nothing at all, which is what the
     * page's empty state is for.
     */
    /**
     * Every entry and exit in the dean's department, newest first.
     *
     * This reads presence_logs — the append-only history — rather than
     * faculty_presence, which only ever holds one row per instructor and so
     * could never answer "where has this person been today". A completed visit
     * also carries its length, worked out from the entry it closes.
     */
    async getPresenceHistory(deanPublicId, { limit = 200 } = {}) {
        const [rows] = await pool.query(
            `SELECT pl.id,
                    CONCAT(u.first_name, ' ', u.last_name) AS facultyName,
                    pl.event,
                    pl.occurred_at,
                    pl.scanner_id,
                    r.room_number,
                    rd.building,
                    -- An exit closes the most recent entry for the same person;
                    -- the gap between them is how long they were in the room.
                    CASE WHEN pl.event = 'exited' THEN TIMESTAMPDIFF(
                        MINUTE,
                        (SELECT MAX(prev.occurred_at)
                           FROM presence_logs prev
                          WHERE prev.instructor_id = pl.instructor_id
                            AND prev.occurred_at < pl.occurred_at
                            AND prev.event IN ('entered', 'moved')),
                        pl.occurred_at
                    ) END AS minutes_in_room
               FROM presence_logs pl
               JOIN users u    ON pl.instructor_id = u.id
               JOIN users dean ON dean.public_id = ?
               LEFT JOIN rooms r        ON pl.room_id       = r.id
               LEFT JOIN departments rd ON r.department_id  = rd.id
              WHERE u.department_id <=> dean.department_id
              ORDER BY pl.occurred_at DESC, pl.id DESC
              LIMIT ?`,
            [deanPublicId, Number(limit)]
        );
        return rows;
    },

    async getPresenceFeed(deanPublicId, { limit = 200 } = {}) {
        const [rows] = await pool.query(
            `SELECT CONCAT(u.first_name, ' ', u.last_name) AS facultyName,
                    fp.is_present,
                    fp.signal_lost,
                    fp.detected_at,
                    fp.last_updated,
                    r.room_number,
                    rd.building
               FROM faculty_presence fp
               JOIN users u ON fp.instructor_id = u.id
               JOIN users dean ON dean.public_id = ?
               LEFT JOIN rooms r        ON fp.room_id      = r.id
               LEFT JOIN departments rd ON r.department_id = rd.id
              WHERE u.department_id <=> dean.department_id
              ORDER BY fp.last_updated DESC
              LIMIT ?`,
            [deanPublicId, Number(limit)]
        );
        return rows;
    },

    /**
     * Rooms in the dean's department, for the 3D building viewer and any room
     * listing.
     */
    async getRooms(deanPublicId) {
        const [rows] = await pool.execute(
            `SELECT r.id,
                    r.room_number,
                    r.floor_number,
                    r.room_type,
                    r.capacity,
                    r.status,
                    r.is_ble_scanner_installed,
                    r.model_x,
                    r.model_y,
                    r.model_z,
                    CONCAT(f.first_name, ' ', f.last_name) AS assigned_faculty_name
               FROM rooms r
               JOIN users dean ON dean.public_id = ?
               LEFT JOIN users f ON r.assigned_faculty = f.id
              WHERE r.department_id <=> dean.department_id
              ORDER BY r.room_number ASC`,
            [deanPublicId]
        );
        return rows;
    },
};

module.exports = DeanModel;

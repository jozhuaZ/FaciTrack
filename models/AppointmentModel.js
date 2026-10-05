const pool = require('../configs/db');
const { SLOT_HOLDING_SQL } = require('../services/scheduling');
const NotificationModel = require('../models/NotificationModel');
const AuditLogModel = require('../models/AuditLogModel');
const { notifyUser } = require('../services/notify');
const { provisionMeetingLink, releaseMeetingLink } = require('../services/meeting');
const { to12Hour, formatFullDate } = require('../utils/timeFormat');

async function assignConsultationRoom(conn, departmentId, consultationDate, timeStart, timeEnd) {
    const [rooms] = await conn.execute(
        `SELECT * FROM rooms
         WHERE department_id = ? AND room_type = 'Consultation Room' AND status = 'Active'
         ORDER BY id`,
        [departmentId]
    );

    for (const room of rooms) {
        // Lock this room row — serializes concurrent booking attempts against it
        await conn.execute('SELECT id FROM rooms WHERE id = ? FOR UPDATE', [room.id]);

        const [[{ count }]] = await conn.execute(
            `SELECT COUNT(*) AS count
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             WHERE a.room_id = ?
               AND a.status IN ('pending','confirmed')
               AND ch.consultation_date = ?
               AND ch.start_time < ?
               AND ch.end_time   > ?`,
            [room.id, consultationDate, timeEnd, timeStart]
        );

        if (count < room.capacity) return room.id;
    }
    return null; // every consultation room is full for this time slot
}

async function freeSlotIfNotClosed(conn, consultationHourId) {
    await conn.execute(
        `UPDATE consultation_hours SET status = 'Available', is_booked = 0
         WHERE id = ? AND status != 'closed'`,
        [consultationHourId]
    );
}

/**
 * Retry a transaction InnoDB aborted for a deadlock — same reasoning as
 * MakeupRequestModel's copy: createAppointment and assignConsultationRoom
 * lock rows (consultation_hours, rooms) that concurrent bookings share, and a
 * deadlock's loser rolled back cleanly, so simply replaying the whole
 * transaction is what MySQL's own error text is telling the caller to do.
 */
async function withDeadlockRetry(fn, retries = 2) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (err.code !== 'ER_LOCK_DEADLOCK' || attempt >= retries) throw err;
        }
    }
}

const AppointmentModel = {
    async getCount() {
        const [[{ count }]] = await pool.execute('SELECT COUNT(*) AS count FROM appointments');

        return count;
    },

    async getStudentCount(studentId) {
        const [[{ count }]] = await pool.execute('SELECT COUNT(*) AS count FROM appointments WHERE student_id = ?', [studentId]);

        return count;
    },

    async getConsultationHourId(appointmentId) {
        try {
            const [rows] = await pool.execute(
                'SELECT consultation_hour_id as slot_id FROM appointments WHERE id = ?',
                [appointmentId]
            );

            if (rows.length === 0) {
                return null;
            }

            return rows[0].slot_id;
        } catch (error) {
            console.error('Error fetching consultation hour ID:', error);
            throw error;
        }
    },

    // userId could be studentId or instructorId
    /**
     * Appointments for the outbound ICS feed.
     *
     * One query for both audiences — the caller says which side of the booking
     * it is publishing for, and both names come back either way so the event
     * can be titled from the other party. Windowed rather than unbounded: a
     * calendar subscription only needs the recent past and the near future,
     * and a feed that grows forever eventually times out on fetch.
     *
     * @param {number} internalUserId  users.id
     * @param {'instructor'|'student'} audience
     */
    async getAppointmentsForFeed(internalUserId, audience, { pastDays = 90, futureDays = 180 } = {}) {
        const column = audience === 'instructor' ? 'ap.instructor_id' : 'ap.student_id';

        const [rows] = await pool.execute(
            `SELECT ap.id, ap.status, ap.mode, ap.topic, ap.notes, ap.created_at,
                    ap.section_group_name, ap.course_subject, ap.student_number,
                    ap.meeting_link,
                    ch.consultation_date, ch.start_time, ch.end_time,
                    s.first_name AS student_first_name, s.last_name AS student_last_name,
                    i.first_name AS instructor_first_name, i.last_name AS instructor_last_name,
                    r.room_number,
                    d.building AS building_name
               FROM appointments ap
               JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
               JOIN users s ON ap.student_id    = s.id
               JOIN users i ON ap.instructor_id = i.id
               LEFT JOIN rooms r       ON ap.room_id = r.id
               LEFT JOIN departments d ON r.department_id = d.id
              WHERE ${column} = ?
                AND ch.consultation_date BETWEEN (CURDATE() - INTERVAL ? DAY)
                                             AND (CURDATE() + INTERVAL ? DAY)
              ORDER BY ch.consultation_date ASC, ch.start_time ASC`,
            [internalUserId, pastDays, futureDays]
        );
        return rows;
    },

    async getAppointmentsByUser(userId) {
        const query = `SELECT
                ap.id, ap.status, ap.mode, ap.topic, ap.section_group_name, ap.course_subject,
                ap.email, ap.notes, ap.created_at, ap.rescheduled_to_id, ap.rescheduled_from_id, ap.decline_reason,
                COALESCE(ap.meeting_link, u.default_meeting_link) AS meeting_link,
                ch.consultation_date, ch.day_of_the_week, ch.start_time, ch.end_time,
                u.public_id AS instructor_public_id,
                u.first_name, u.last_name, u.middle_name, u.position,
                u.profile_picture AS instructor_photo,
                r.room_number,
                d.building AS building_name, d.full_name AS department_name,
                rch.consultation_date AS rescheduled_date,
                rch.day_of_the_week AS rescheduled_day,
                rch.start_time AS rescheduled_start_time,
                rch.end_time AS rescheduled_end_time,
                fch.consultation_date AS rescheduled_from_date,
                fch.day_of_the_week AS rescheduled_from_day,
                fch.start_time AS rescheduled_from_start_time,
                fch.end_time AS rescheduled_from_end_time
            FROM appointments ap
            JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
            JOIN users u ON ap.instructor_id = u.id
            LEFT JOIN rooms r ON ap.room_id = r.id
            LEFT JOIN departments d ON r.department_id = d.id
            LEFT JOIN appointments rap ON ap.rescheduled_to_id = rap.id
            LEFT JOIN consultation_hours rch ON rap.consultation_hour_id = rch.id
            LEFT JOIN appointments fap ON ap.rescheduled_from_id = fap.id
            LEFT JOIN consultation_hours fch ON fap.consultation_hour_id = fch.id
            WHERE ap.student_id = ?
            ORDER BY
                FIELD(ap.status, 'pending', 'confirmed', 'rescheduled', 'declined', 'expired', 'completed', 'cancelled'),
                ch.consultation_date ASC,
                ch.start_time ASC`;
        const [rows] = await pool.execute(query, [userId]);
        return rows;
    },

    async createAppointment(args) {
        return withDeadlockRetry(() => this._createAppointment(args));
    },

    async _createAppointment({
        consultationHourId, studentPublicId, instructorId, studentNumber,
        sectionGroupName, courseSubject, email, topic, mode, notes,
        departmentId, consultationDate, timeStart, timeEnd,
    }) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[student]] = await conn.execute(
                'SELECT id, first_name, last_name, role FROM users WHERE public_id = ?', [studentPublicId]
            );
            if (!student) throw new Error('Student not found');

            // Re-check the slot hasn't already been booked by someone else.
            // Must use the same definition of "taken" as the booking calendar,
            // or a slot can be offered and then refused on submit.
            const [[slotCheck]] = await conn.execute(
                `SELECT a.id AS appointment_id, ch.start_time, ch.end_time
                 FROM consultation_hours ch
                 LEFT JOIN appointments a ON ch.id = a.consultation_hour_id
                                         AND a.status IN (${SLOT_HOLDING_SQL})
                 WHERE ch.id = ? FOR UPDATE`,
                [consultationHourId]
            );
            if (slotCheck && slotCheck.appointment_id) {
                await conn.rollback();
                return { success: false, reason: 'SLOT_ALREADY_BOOKED' };
            }

            let roomId = null;
            if (mode === 'Face-to-Face') {
                roomId = await assignConsultationRoom(conn, departmentId, consultationDate, timeStart, timeEnd);
                if (roomId === null) {
                    await conn.rollback();
                    return { success: false, reason: 'NO_ROOM_AVAILABLE' };
                }
            }

            // Online consultations inherit the instructor's personal meeting room
            let meetingLink = null;
            if (mode === 'Online') {
                const [[host]] = await conn.execute(
                    'SELECT default_meeting_link FROM users WHERE id = ?', [instructorId]
                );
                meetingLink = host?.default_meeting_link || null;
            }

            const [result] = await conn.execute(
                `INSERT INTO appointments
                    (consultation_hour_id, student_id, instructor_id, student_number, section_group_name,
                     course_subject, email, topic, mode, notes, status, room_id, meeting_link)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [
                    consultationHourId, student.id, instructorId, studentNumber, sectionGroupName,
                    courseSubject, email, topic, mode, notes || null, roomId, meetingLink,
                ]
            );

            // Reservation converts into a real appointment — release the hold
            await conn.execute(
                'DELETE FROM slot_reservations WHERE slot_id = ? AND student_id = ?',
                [consultationHourId, student.id]
            );

            await conn.commit();

            const studentName = `${student.first_name} ${student.last_name ?? ''}`.trim();

            // No Meet is created here. A request is not yet a meeting — the
            // instructor may decline it — and minting a calendar event at
            // booking put entries on their calendar for consultations that
            // never happened, then deleted them again on decline. The event is
            // created when the instructor approves, in approveAppointment.
            //
            // The instructor's standing room link, if they have one, is already
            // on the row from the transaction above, so an online request still
            // shows where it would be held.

            try {
                const timeLabel = `${to12Hour(slotCheck.start_time)} – ${to12Hour(slotCheck.end_time)}`;
                const dateLabel = formatFullDate(consultationDate);

                await notifyUser(
                    instructorId,
                    'new-request',
                    `${studentName ?? 'A student'} requested a consultation on ${dateLabel} at ${timeLabel}.`,
                    result.insertId,
                    {
                        pushTitle: 'New Consultation Request',
                        email: {
                            heading: 'New Consultation Request',
                            status: 'reminder',
                            message: `<strong>${studentName}</strong> has requested a consultation and is waiting for your response.`,
                            details: [
                                { label: 'Student', value: studentName },
                                { label: 'Date', value: dateLabel },
                                { label: 'Time', value: timeLabel },
                                { label: 'Topic', value: topic },
                                { label: 'Mode', value: mode },
                            ],
                        },
                    }
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (createAppointment):', notifErr);
            }

            return { success: true, appointmentId: result.insertId, roomId, meetingLink };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async getAppointmentDetails(appointmentId) {
        const [[row]] = await pool.execute(
            `SELECT
            ap.id, ap.status, ap.mode, ap.topic, ap.section_group_name, ap.course_subject,
            ap.email, ap.notes, ap.created_at,
            COALESCE(ap.meeting_link, u.default_meeting_link) AS meeting_link,
            ch.consultation_date, ch.day_of_the_week, ch.start_time, ch.end_time,
            u.first_name, u.last_name, u.middle_name, u.position,
            r.room_number,
            d.building AS building_name
         FROM appointments ap
         JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
         JOIN users u ON ap.instructor_id = u.id
         LEFT JOIN rooms r ON ap.room_id = r.id
         LEFT JOIN departments d ON r.department_id = d.id
         WHERE ap.id = ?`,
            [appointmentId]
        );
        return row || null;
    },

    async getAppointmentsByInstructor(instructorPublicId) {
        const [[instructor]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [instructorPublicId]
        );
        if (!instructor) return [];

        const query = `SELECT
                ap.id, ap.status, ap.mode, ap.topic, ap.section_group_name, ap.course_subject,
                ap.email, ap.notes, ap.created_at, ap.decline_reason,
                COALESCE(ap.meeting_link, host.default_meeting_link) AS meeting_link,
                ch.consultation_date, ch.day_of_the_week, ch.start_time, ch.end_time,
                s.first_name AS student_first_name, s.last_name AS student_last_name,
                ap.student_number,
                r.room_number,
                d.building AS building_name
            FROM appointments ap
            JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
            JOIN users s ON ap.student_id = s.id
            JOIN users host ON ap.instructor_id = host.id
            LEFT JOIN rooms r ON ap.room_id = r.id
            LEFT JOIN departments d ON r.department_id = d.id
            WHERE ap.instructor_id = ?
            ORDER BY
                FIELD(ap.status, 'pending', 'confirmed', 'rescheduled', 'declined', 'expired', 'completed', 'cancelled'),
                ch.consultation_date ASC,
                ch.start_time ASC`;

        const [rows] = await pool.execute(query, [instructor.id]);
        return rows;
    },

    /**
     * Everything the consultation log form prints, for one completed
     * consultation — and only to the two people it belongs to: the instructor
     * who held it or the student who booked it. Anyone else, or a consultation
     * not yet completed, gets null.
     *
     * @param {{ instructorPublicId?: string, studentPublicId?: string }} viewer
     */
    async getConsultationFormData(appointmentId, viewer = {}) {
        let owner;
        let ownerId;
        if (viewer.instructorPublicId) { owner = 'i.public_id'; ownerId = viewer.instructorPublicId; }
        else if (viewer.studentPublicId) { owner = 's.public_id'; ownerId = viewer.studentPublicId; }
        else return null;

        const [rows] = await pool.execute(
            `SELECT ap.id, ap.mode, ap.topic, ap.notes, ap.course_subject, ap.section_group_name,
                    ap.student_number, ap.completed_at,
                    COALESCE(ap.meeting_link, i.default_meeting_link) AS meeting_link,
                    ch.consultation_date, ch.start_time, ch.end_time,
                    s.first_name AS student_first_name, s.middle_name AS student_middle_name,
                    s.last_name AS student_last_name,
                    i.first_name AS instructor_first_name, i.middle_name AS instructor_middle_name,
                    i.last_name AS instructor_last_name,
                    r.room_number
               FROM appointments ap
               JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
               JOIN users s ON ap.student_id = s.id
               JOIN users i ON ap.instructor_id = i.id
               LEFT JOIN rooms r ON ap.room_id = r.id
              WHERE ap.id = ? AND ${owner} = ? AND ap.status = 'completed'`,
            [appointmentId, ownerId]
        );
        return rows[0] || null;
    },

    async cancelAppointment(appointmentId, studentPublicId) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[student]] = await conn.execute(
                'SELECT id, first_name, last_name, role FROM users WHERE public_id = ?', [studentPublicId]
            );
            if (!student) { await conn.rollback(); return { success: false, reason: 'STUDENT_NOT_FOUND' }; }

            const [[appointment]] = await conn.execute(
                `SELECT a.consultation_hour_id, a.instructor_id, ch.consultation_date, ch.start_time
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             WHERE a.id = ? AND a.student_id = ? AND a.status IN ('pending','confirmed')
             FOR UPDATE`,
                [appointmentId, student.id]
            );
            if (!appointment) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            await conn.execute(
                `UPDATE appointments SET status = 'cancelled' WHERE id = ?`,
                [appointmentId]
            );

            // Free the slot back up, but don't touch it if it was soft-closed
            await freeSlotIfNotClosed(conn, appointment.consultation_hour_id);

            await conn.commit();

            // The consultation is off — take the meeting off the instructor's
            // calendar too, or it sits there as a live Meet nobody will join.
            await releaseMeetingLink(appointmentId);

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);

                const studentName = `${student.first_name} ${student.last_name}`;

                await notifyUser(
                    appointment.instructor_id,
                    'cancellation',
                    `${studentName} cancelled their upcoming consultation on ${dateLabel} at ${timeLabel}.`,
                    appointmentId,
                    {
                        pushTitle: 'Appointment Cancelled',
                        email: {
                            heading: 'Appointment Cancelled',
                            status: 'cancelled',
                            message: `<strong>${studentName}</strong> cancelled their consultation. The slot is now open for other students.`,
                            details: [
                                { label: 'Student', value: studentName },
                                { label: 'Date', value: dateLabel },
                                { label: 'Time', value: timeLabel },
                            ],
                        },
                    }
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (cancelAppointment):', notifErr);
            }

            return { success: true };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async approveAppointment(appointmentId, instructorPublicId) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id, first_name, last_name, role FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            const [[appointment]] = await conn.execute(
                `SELECT a.student_id, a.mode, a.meeting_link, a.topic, a.email,
                    s.first_name AS student_first_name, s.last_name AS student_last_name,
                    r.room_number,
                    ch.consultation_date, ch.start_time, ch.end_time
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users s ON a.student_id = s.id
             LEFT JOIN rooms r ON a.room_id = r.id
             WHERE a.id = ? AND a.instructor_id = ? AND a.status = 'pending'
             FOR UPDATE`,
                [appointmentId, instructor.id]
            );
            if (!appointment) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            await conn.execute(
                `UPDATE appointments SET status = 'confirmed' WHERE id = ?`,
                [appointmentId]
            );

            await conn.commit();

            // Now it is a meeting, so now it gets one. Done after the commit
            // and never inside it: this is a network round-trip, and an
            // approval that rolled back because Google was slow would be a far
            // worse outcome than one that falls back to the standing link.
            let meetingLink = appointment.meeting_link;
            if (appointment.mode === 'Online') {
                const provisioned = await provisionMeetingLink({
                    appointmentId,
                    instructorId: instructor.id,
                    studentName: `${appointment.student_first_name ?? ''} ${appointment.student_last_name ?? ''}`.trim() || 'Student',
                    studentEmail: appointment.email,
                    topic: appointment.topic,
                    date: appointment.consultation_date,
                    startTime: appointment.start_time,
                    endTime: appointment.end_time,
                    fallbackLink: appointment.meeting_link,
                });
                meetingLink = provisioned.meetingLink;
            }

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);
                const instructorName = `${instructor.first_name} ${instructor.last_name}`;

                await notifyUser(
                    appointment.student_id,
                    'approved',
                    `${instructorName} confirmed your consultation request on ${dateLabel} at ${timeLabel}.`,
                    appointmentId,
                    {
                        pushTitle: 'Appointment Confirmed',
                        email: {
                            heading: 'Appointment Confirmed',
                            status: 'approved',
                            message: `${instructorName} has <strong>confirmed</strong> your consultation request.`,
                            details: [
                                { label: 'Instructor', value: instructorName },
                                { label: 'Date', value: dateLabel },
                                { label: 'Time', value: `${timeLabel} – ${to12Hour(appointment.end_time)}` },
                                { label: 'Mode', value: appointment.mode },
                                { label: 'Room', value: appointment.mode === 'Face-to-Face' ? appointment.room_number : null },
                                { label: 'Meeting link', value: appointment.mode === 'Online' ? meetingLink : null },
                            ],
                        },
                    }
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (approveAppointment):', notifErr);
            }

            return { success: true, meetingLink };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async declineAppointment(appointmentId, instructorPublicId, reason) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id, first_name, last_name, role FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            const [[appointment]] = await conn.execute(
                `SELECT a.consultation_hour_id, a.student_id, ch.consultation_date, ch.start_time
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             WHERE a.id = ? AND a.instructor_id = ? AND a.status = 'pending'
             FOR UPDATE`,
                [appointmentId, instructor.id]
            );
            if (!appointment) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            await conn.execute(
                `UPDATE appointments SET status = 'declined', decline_reason = ? WHERE id = ?`,
                [reason, appointmentId]
            );

            // Free the slot back up, but leave soft-closed slots alone
            await freeSlotIfNotClosed(conn, appointment.consultation_hour_id);

            await conn.commit();

            // Declined requests never happen, so the provisional Meet created
            // at booking time has to go with them.
            await releaseMeetingLink(appointmentId);

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);
                const instructorName = `${instructor.first_name} ${instructor.last_name}`;

                await notifyUser(
                    appointment.student_id,
                    'declined',
                    `${instructorName} declined your consultation request on ${dateLabel} at ${timeLabel}.`,
                    appointmentId,
                    {
                        pushTitle: 'Appointment Declined',
                        email: {
                            heading: 'Appointment Declined',
                            status: 'declined',
                            message: `${instructorName} was unable to accept your consultation request. You can book another slot at any time.`,
                            details: [
                                { label: 'Instructor', value: instructorName },
                                { label: 'Date', value: dateLabel },
                                { label: 'Time', value: timeLabel },
                                { label: 'Reason', value: reason },
                            ],
                        },
                    }
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (declineAppointment):', notifErr);
            }

            return { success: true };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Move an appointment to a new slot. The instructor may also switch the
     * consultation mode at the same time — a venue that worked at the old time
     * often does not at the new one.
     */
    async rescheduleAppointment(appointmentId, newSlotId, instructorPublicId, reason, newMode) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id, first_name, last_name, department_id, role FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            const [[oldApt]] = await conn.execute(
                `SELECT a.*, ch.consultation_date AS old_date, ch.start_time AS old_start_time,
                    s.first_name AS student_first_name, s.last_name AS student_last_name
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users s ON a.student_id = s.id
             WHERE a.id = ? AND a.instructor_id = ? AND a.status IN ('pending','confirmed')
             FOR UPDATE`,
                [appointmentId, instructor.id]
            );
            if (!oldApt) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            const [[newSlot]] = await conn.execute(
                `SELECT ch.*,
                (SELECT id FROM appointments a
                 WHERE a.consultation_hour_id = ch.id
                   AND a.status IN (${SLOT_HOLDING_SQL})) AS active_appointment_id
             FROM consultation_hours ch
             WHERE ch.id = ? AND ch.instructor_id = ? FOR UPDATE`,
                [newSlotId, instructor.id]
            );
            if (!newSlot || newSlot.status === 'closed' || newSlot.active_appointment_id) {
                await conn.rollback();
                return { success: false, reason: 'SLOT_UNAVAILABLE' };
            }

            const mode = newMode || oldApt.mode;
            let roomId = null;
            let meetingLink = null;

            if (mode === 'Face-to-Face') {
                // The old room does not carry over — the new time may already be taken
                roomId = await assignConsultationRoom(
                    conn, oldApt.department_id_snapshot ?? instructor.department_id,
                    newSlot.consultation_date, newSlot.start_time, newSlot.end_time
                );
                if (roomId === null) {
                    await conn.rollback();
                    return { success: false, reason: 'NO_ROOM_AVAILABLE' };
                }
            } else {
                const [[host]] = await conn.execute(
                    `SELECT u.default_meeting_link, (ga.user_id IS NOT NULL) AS google_connected
                       FROM users u
                       LEFT JOIN google_accounts ga ON ga.user_id = u.id AND ga.last_error IS NULL
                      WHERE u.id = ?`,
                    [instructor.id]
                );
                meetingLink = oldApt.meeting_link || host?.default_meeting_link || null;
                // No link yet is fine when the calendar is connected — one is
                // minted for the new slot right after this commits.
                if (!meetingLink && !Number(host?.google_connected)) {
                    await conn.rollback();
                    return { success: false, reason: 'MEETING_LINK_REQUIRED' };
                }
            }

            const [insertResult] = await conn.execute(
                `INSERT INTO appointments
                (consultation_hour_id, student_id, instructor_id, student_number, section_group_name,
                 course_subject, email, topic, mode, notes, status, room_id, meeting_link, rescheduled_from_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newSlotId, oldApt.student_id, instructor.id, oldApt.student_number, oldApt.section_group_name,
                    oldApt.course_subject, oldApt.email, oldApt.topic, mode, oldApt.notes,
                    'confirmed', roomId, meetingLink, appointmentId,
                ]
            );
            const newAppointmentId = insertResult.insertId;

            await conn.execute(
                `UPDATE appointments SET status = 'rescheduled', rescheduled_to_id = ?, decline_reason = ?
             WHERE id = ?`,
                [newAppointmentId, reason || null, appointmentId]
            );

            await conn.execute(
                `UPDATE consultation_hours SET status = 'Available'
             WHERE id = ? AND status != 'closed'`,
                [oldApt.consultation_hour_id]
            );

            await conn.commit();

            // A scheduled Meet is pinned to a time, so moving the consultation
            // means retiring the old event and minting one for the new slot.
            // Only the link changes; if Google is unavailable the copied link
            // from the old appointment stays, which is still reachable.
            if (mode === 'Online') {
                await releaseMeetingLink(appointmentId);
                const provisioned = await provisionMeetingLink({
                    appointmentId: newAppointmentId,
                    instructorId: instructor.id,
                    studentName: `${oldApt.student_first_name ?? ''} ${oldApt.student_last_name ?? ''}`.trim() || 'Student',
                    studentEmail: oldApt.email,
                    topic: oldApt.topic,
                    date: newSlot.consultation_date,
                    startTime: newSlot.start_time,
                    endTime: newSlot.end_time,
                    fallbackLink: meetingLink,
                });
                meetingLink = provisioned.meetingLink;
            }

            try {
                const previousDateLabel = formatFullDate(oldApt.old_date);
                const previousTimeLabel = to12Hour(oldApt.old_start_time);
                const newDateLabel = formatFullDate(newSlot.consultation_date);
                const newTimeLabel = `${to12Hour(newSlot.start_time)} – ${to12Hour(newSlot.end_time)}`;

                const instructorName = `${instructor.first_name} ${instructor.last_name}`;

                await notifyUser(
                    oldApt.student_id,
                    'rescheduled',
                    `${instructorName} rescheduled your consultation of ${previousDateLabel} at ${previousTimeLabel} to ${newDateLabel}, ${newTimeLabel}.`,
                    newAppointmentId,
                    {
                        pushTitle: 'Appointment Rescheduled',
                        email: {
                            heading: 'Appointment Rescheduled',
                            status: 'rescheduled',
                            message: `${instructorName} has moved your consultation to a new date and time.`,
                            details: [
                                { label: 'Instructor', value: instructorName },
                                { label: 'Was', value: `${previousDateLabel} at ${previousTimeLabel}` },
                                { label: 'Now', value: `${newDateLabel}, ${newTimeLabel}` },
                            ],
                        },
                    }
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (rescheduleAppointment):', notifErr);
            }

            return { success: true, newAppointmentId };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async getAppointmentsNeedingReminder() {
        const [rows] = await pool.execute(
            `SELECT
            a.id, a.student_id, a.instructor_id, a.reminder_sent,
            ch.consultation_date, ch.start_time,
            u.first_name AS instructor_first_name, u.last_name AS instructor_last_name
         FROM appointments a
         JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         JOIN users u ON a.instructor_id = u.id
         WHERE a.status = 'confirmed'
           AND a.reminder_sent = 0
           AND TIMESTAMP(ch.consultation_date, ch.start_time)
               BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 MINUTE)`
        );
        return rows;
    },

    /**
     * Instructor overrides the consultation mode the student picked.
     * Online consultations carry a meeting link; face-to-face get a room instead.
     */
    async updateMode(appointmentId, instructorPublicId, mode, meetingLink) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[apt]] = await conn.execute(
                `SELECT a.id, a.mode, a.room_id, a.status, ch.consultation_date,
                        ch.start_time, ch.end_time, u.department_id
                 FROM appointments a
                 JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
                 JOIN users u ON a.instructor_id = u.id
                 WHERE a.id = ? AND u.public_id = ?
                   AND a.status IN ('pending','confirmed')
                 FOR UPDATE`,
                [appointmentId, instructorPublicId]
            );
            if (!apt) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            let roomId = apt.room_id;
            let link = meetingLink || null;

            if (mode === 'Face-to-Face') {
                // Needs a room; keep the existing one if it already has it
                if (!roomId) {
                    roomId = await assignConsultationRoom(
                        conn, apt.department_id, apt.consultation_date, apt.start_time, apt.end_time
                    );
                    if (roomId === null) { await conn.rollback(); return { success: false, reason: 'NO_ROOM_AVAILABLE' }; }
                }
                link = null;   // a physical consultation has no meeting link
            } else {
                if (!link) { await conn.rollback(); return { success: false, reason: 'MEETING_LINK_REQUIRED' }; }
                roomId = null; // free the room for someone else
            }

            await conn.execute(
                'UPDATE appointments SET mode = ?, room_id = ?, meeting_link = ? WHERE id = ?',
                [mode, roomId, link, appointmentId]
            );

            await conn.commit();
            return { success: true, mode, roomId, meetingLink: link };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Mark a consultation as completed. Only allowed once the slot has ended —
     * an instructor cannot close out a consultation that has not happened yet.
     */
    async completeAppointment(appointmentId, instructorPublicId) {
        const [[apt]] = await pool.execute(
            `SELECT a.id, a.status,
                    TIMESTAMP(ch.consultation_date, ch.end_time) AS ends_at,
                    TIMESTAMP(ch.consultation_date, ch.end_time) > NOW() AS not_yet
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users u ON a.instructor_id = u.id
             WHERE a.id = ? AND u.public_id = ?`,
            [appointmentId, instructorPublicId]
        );

        if (!apt) return { success: false, reason: 'NOT_FOUND' };
        if (apt.status === 'completed') return { success: false, reason: 'ALREADY_COMPLETED' };
        if (apt.status !== 'confirmed') return { success: false, reason: 'NOT_CONFIRMED' };
        if (apt.not_yet) return { success: false, reason: 'NOT_YET_ENDED', endsAt: apt.ends_at };

        await pool.execute(
            "UPDATE appointments SET status = 'completed', completed_at = NOW() WHERE id = ?",
            [appointmentId]
        );
        return { success: true };
    },

    /**
     * Confirmed consultations whose slot has ended but were never marked complete.
     * `nudgeEveryHours` throttles how often the same appointment is chased.
     */
    async getAppointmentsAwaitingCompletion(nudgeEveryHours = 24) {
        const [rows] = await pool.execute(
            `SELECT a.id, a.instructor_id, a.student_id,
                    ch.consultation_date, ch.start_time, ch.end_time,
                    s.first_name AS student_first_name, s.last_name AS student_last_name
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users s ON a.student_id = s.id
             WHERE a.status = 'confirmed'
               AND TIMESTAMP(ch.consultation_date, ch.end_time) < NOW()
               AND (a.completion_nudged_at IS NULL
                    OR a.completion_nudged_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
             ORDER BY ch.consultation_date, ch.start_time`,
            [nudgeEveryHours]
        );
        return rows;
    },

    /**
     * Attach a newly saved meeting link to the instructor's online consultations
     * that do not have one yet. Returns the rows so students can be notified.
     */
    async attachMeetingLinkToPending(instructorPublicId, link) {
        const [rows] = await pool.execute(
            `SELECT a.id, a.student_id
             FROM appointments a
             JOIN users u ON a.instructor_id = u.id
             WHERE u.public_id = ?
               AND a.mode = 'Online'
               AND a.status IN ('pending','confirmed')
               AND (a.meeting_link IS NULL OR a.meeting_link = '')`,
            [instructorPublicId]
        );
        if (!rows.length) return [];

        await pool.execute(
            `UPDATE appointments a
             JOIN users u ON a.instructor_id = u.id
             SET a.meeting_link = ?
             WHERE u.public_id = ?
               AND a.mode = 'Online'
               AND a.status IN ('pending','confirmed')
               AND (a.meeting_link IS NULL OR a.meeting_link = '')`,
            [link, instructorPublicId]
        );
        return rows;
    },

    /**
     * Upcoming online consultations with no meeting link, so the instructor
     * can be chased before the student is left without a way to join.
     */
    async getOnlineAppointmentsMissingLink(nudgeEveryHours = 24) {
        const [rows] = await pool.execute(
            `SELECT a.id, a.instructor_id, ch.consultation_date, ch.start_time,
                    s.first_name AS student_first_name, s.last_name AS student_last_name
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users s ON a.student_id = s.id
             WHERE a.mode = 'Online'
               -- Confirmed only. A pending request has no link because it has
               -- not been approved yet, and telling an instructor their
               -- consultation is missing a link when the answer is "approve it"
               -- would nag them about something that is not wrong.
               AND a.status = 'confirmed'
               AND (a.meeting_link IS NULL OR a.meeting_link = '')
               AND TIMESTAMP(ch.consultation_date, ch.start_time) > NOW()
               AND (a.completion_nudged_at IS NULL
                    OR a.completion_nudged_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
             ORDER BY ch.consultation_date, ch.start_time`,
            [nudgeEveryHours]
        );
        return rows;
    },

    async markCompletionNudged(appointmentId) {
        await pool.execute(
            'UPDATE appointments SET completion_nudged_at = NOW() WHERE id = ?',
            [appointmentId]
        );
    },

    /**
     * Requests still sitting at 'pending' while the consultation date is still
     * ahead — the student is waiting on an answer. Uses its own throttle column
     * so it cannot collide with the completion / missing-link nudges, which a
     * pending online appointment can also qualify for.
     */
    async getPendingAppointmentsAwaitingAction(nudgeEveryHours = 24) {
        const [rows] = await pool.execute(
            `SELECT a.id, a.instructor_id, a.student_id, a.created_at,
                    ch.consultation_date, ch.start_time,
                    s.first_name AS student_first_name, s.last_name AS student_last_name
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users s ON a.student_id = s.id
             WHERE a.status = 'pending'
               AND TIMESTAMP(ch.consultation_date, ch.start_time) > NOW()
               AND (a.pending_nudged_at IS NULL
                    OR a.pending_nudged_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
             ORDER BY ch.consultation_date, ch.start_time`,
            [nudgeEveryHours]
        );
        return rows;
    },

    /**
     * Requests whose consultation has been and gone while still pending.
     *
     * The end time, not the start: a consultation whose window has completely
     * passed could not have happened, whereas one that started ten minutes ago
     * still has most of its slot left and an instructor might legitimately
     * accept it. Judging it on the end is the version that is never wrong.
     *
     * Returns what was expired so the caller can tell the students waiting.
     */
    async expireUnansweredRequests() {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Locked for the same reason the presence sweep locks: this runs on
            // a timer, and an instructor pressing Approve at the same moment
            // must either win outright or find nothing left to expire.
            const [stale] = await conn.execute(
                `SELECT a.id, a.student_id, a.instructor_id, a.topic,
                        ch.consultation_date, ch.start_time, ch.end_time,
                        CONCAT(u.first_name, ' ', u.last_name) AS instructor_name
                   FROM appointments a
                   JOIN consultation_hours ch ON ch.id = a.consultation_hour_id
                   JOIN users u ON u.id = a.instructor_id
                  WHERE a.status = 'pending'
                    AND TIMESTAMP(ch.consultation_date, ch.end_time) < NOW()
                  FOR UPDATE`
            );

            if (!stale.length) {
                await conn.commit();
                return [];
            }

            await conn.query(
                "UPDATE appointments SET status = 'expired' WHERE id IN (?)",
                [stale.map(r => r.id)]
            );

            await conn.commit();
            return stale;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async markPendingNudged(appointmentId) {
        await pool.execute(
            'UPDATE appointments SET pending_nudged_at = NOW() WHERE id = ?',
            [appointmentId]
        );
    },

    async markReminderSent(appointmentId) {
        await pool.execute(
            `UPDATE appointments SET reminder_sent = 1 WHERE id = ?`,
            [appointmentId]
        );
    },
};

module.exports = AppointmentModel;
const pool = require('../configs/db');
const NotificationModel = require('../models/NotificationModel');
const AuditLogModel = require('../models/AuditLogModel');
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
    async getAppointmentsByUser(userId) {
        const query = `SELECT
                ap.id, ap.status, ap.mode, ap.topic, ap.section_group_name, ap.course_subject,
                ap.email, ap.notes, ap.created_at, ap.rescheduled_to_id, ap.rescheduled_from_id, ap.decline_reason,
                ch.consultation_date, ch.day_of_the_week, ch.start_time, ch.end_time,
                u.first_name, u.last_name, u.middle_name, u.position,
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
                FIELD(ap.status, 'pending', 'confirmed', 'rescheduled', 'declined', 'completed', 'cancelled'),
                ch.consultation_date ASC,
                ch.start_time ASC`;
        const [rows] = await pool.execute(query, [userId]);
        return rows;
    },

    async createAppointment({
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

            // Re-check the slot hasn't already been booked by someone else
            const [[slotCheck]] = await conn.execute(
                `SELECT a.id AS appointment_id, ch.start_time, ch.end_time
                 FROM consultation_hours ch
                 LEFT JOIN appointments a ON ch.id = a.consultation_hour_id AND a.status != 'cancelled'
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

            const [result] = await conn.execute(
                `INSERT INTO appointments
                    (consultation_hour_id, student_id, instructor_id, student_number, section_group_name,
                     course_subject, email, topic, mode, notes, status, room_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [
                    consultationHourId, student.id, instructorId, studentNumber, sectionGroupName,
                    courseSubject, email, topic, mode, notes || null, roomId,
                ]
            );

            // Reservation converts into a real appointment — release the hold
            await conn.execute(
                'DELETE FROM slot_reservations WHERE slot_id = ? AND student_id = ?',
                [consultationHourId, student.id]
            );

            await conn.commit();

            try {
                const studentName = `${student.first_name} ${student.last_name ?? ''}`;
                const timeLabel = `${to12Hour(slotCheck.start_time)} – ${to12Hour(slotCheck.end_time)}`;
                await NotificationModel.create(
                    instructorId,
                    'new-request',
                    `${studentName ?? 'A student'} requested a consultation on ${formatFullDate(consultationDate)} at ${timeLabel}.`,
                    result.insertId
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (createAppointment):', notifErr);
            }
            
            return { success: true, appointmentId: result.insertId, roomId };
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
                ch.consultation_date, ch.day_of_the_week, ch.start_time, ch.end_time,
                s.first_name AS student_first_name, s.last_name AS student_last_name,
                ap.student_number,
                r.room_number,
                d.building AS building_name
            FROM appointments ap
            JOIN consultation_hours ch ON ap.consultation_hour_id = ch.id
            JOIN users s ON ap.student_id = s.id
            LEFT JOIN rooms r ON ap.room_id = r.id
            LEFT JOIN departments d ON r.department_id = d.id
            WHERE ap.instructor_id = ?
            ORDER BY
                FIELD(ap.status, 'pending', 'confirmed', 'rescheduled', 'declined', 'completed', 'cancelled'),
                ch.consultation_date ASC,
                ch.start_time ASC`;

        const [rows] = await pool.execute(query, [instructor.id]);
        return rows;
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

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);

                await NotificationModel.create(
                    appointment.instructor_id,
                    'cancellation',
                    `${student.first_name} ${student.last_name} cancelled their upcoming consultation on ${dateLabel} at ${timeLabel}.`,
                    appointmentId
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
                `SELECT a.student_id, ch.consultation_date, ch.start_time
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
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

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);
                await NotificationModel.create(
                    appointment.student_id,
                    'approved',
                    `${instructor.first_name} ${instructor.last_name} confirmed your consultation request on ${dateLabel} at ${timeLabel}.`,
                    appointmentId
                );
            } catch (notifErr) {
                console.error('[Notification] Failed to create (approveAppointment):', notifErr);
            }

            return { success: true };
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

            try {
                const dateLabel = formatFullDate(appointment.consultation_date);
                const timeLabel = to12Hour(appointment.start_time);
                await NotificationModel.create(
                    appointment.student_id,
                    'declined',
                    `${instructor.first_name} ${instructor.last_name} declined your consultation request on ${dateLabel} at ${timeLabel}.`,
                    appointmentId
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

    async rescheduleAppointment(appointmentId, newSlotId, instructorPublicId, reason) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id, first_name, last_name, department_id, role FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            const [[oldApt]] = await conn.execute(
                `SELECT a.*, ch.consultation_date AS old_date, ch.start_time AS old_start_time
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             WHERE a.id = ? AND a.instructor_id = ? AND a.status IN ('pending','confirmed')
             FOR UPDATE`,
                [appointmentId, instructor.id]
            );
            if (!oldApt) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' }; }

            const [[newSlot]] = await conn.execute(
                `SELECT ch.*,
                (SELECT id FROM appointments a
                 WHERE a.consultation_hour_id = ch.id AND a.status IN ('pending','confirmed')) AS active_appointment_id
             FROM consultation_hours ch
             WHERE ch.id = ? AND ch.instructor_id = ? FOR UPDATE`,
                [newSlotId, instructor.id]
            );
            if (!newSlot || newSlot.status === 'closed' || newSlot.active_appointment_id) {
                await conn.rollback();
                return { success: false, reason: 'SLOT_UNAVAILABLE' };
            }

            let roomId = oldApt.room_id;
            if (oldApt.mode === 'Face-to-Face') {
                roomId = await assignConsultationRoom(
                    conn, oldApt.department_id_snapshot ?? instructor.department_id,
                    newSlot.consultation_date, newSlot.start_time, newSlot.end_time
                );
                if (roomId === null) {
                    await conn.rollback();
                    return { success: false, reason: 'NO_ROOM_AVAILABLE' };
                }
            }

            const [insertResult] = await conn.execute(
                `INSERT INTO appointments
                (consultation_hour_id, student_id, instructor_id, section_group_name,
                 course_subject, email, topic, mode, notes, status, room_id, rescheduled_from_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newSlotId, oldApt.student_id, instructor.id, oldApt.section_group_name,
                    oldApt.course_subject, oldApt.email, oldApt.topic, oldApt.mode, oldApt.notes,
                    'confirmed', roomId, appointmentId,
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

            try {
                const previousDateLabel = formatFullDate(oldApt.old_date);
                const previousTimeLabel = to12Hour(oldApt.old_start_time);
                const newDateLabel = formatFullDate(newSlot.consultation_date);
                const newTimeLabel = `${to12Hour(newSlot.start_time)} – ${to12Hour(newSlot.end_time)}`;

                await NotificationModel.create(
                    oldApt.student_id,
                    'rescheduled',
                    `${instructor.first_name} ${instructor.last_name} rescheduled your consultation of ${previousDateLabel} at ${previousTimeLabel} to ${newDateLabel}, ${newTimeLabel}.`,
                    newAppointmentId
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
};

module.exports = AppointmentModel;
const pool = require('../configs/db');
const UserModel = require('./UserModel');

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
                'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
            );
            if (!student) throw new Error('Student not found');

            // Re-check the slot hasn't already been booked by someone else
            const [[slotCheck]] = await conn.execute(
                `SELECT a.id AS appointment_id
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

    async cancelAppointment(appointmentId, studentPublicId) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[student]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
            );
            if (!student) { await conn.rollback(); return { success: false, reason: 'STUDENT_NOT_FOUND' }; }

            const [[appointment]] = await conn.execute(
                `SELECT consultation_hour_id FROM appointments
             WHERE id = ? AND student_id = ? AND status IN ('pending','confirmed')
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
            return { success: true };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    // AppointmentModel.js
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

    async approveAppointment(appointmentId, instructorPublicId) {
        const [[instructor]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [instructorPublicId]
        );
        if (!instructor) return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' };

        const [result] = await pool.execute(
            `UPDATE appointments SET status = 'confirmed'
         WHERE id = ? AND instructor_id = ? AND status = 'pending'`,
            [appointmentId, instructor.id]
        );

        if (result.affectedRows === 0) return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' };
        return { success: true };
    },

    async declineAppointment(appointmentId, instructorPublicId, reason) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            const [[appointment]] = await conn.execute(
                `SELECT consultation_hour_id FROM appointments
             WHERE id = ? AND instructor_id = ? AND status = 'pending'
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
            return { success: true };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },
};

module.exports = AppointmentModel;
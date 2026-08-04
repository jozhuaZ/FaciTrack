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

const AppointmentModel = {

    // userId could be studentId or instructorId
    async getAppointmentsByUser(userId) {
        const query = `SELECT
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
         WHERE ap.student_id = ?`

        const [rows] = await pool.execute(query, [userId]);

        return rows;
    },

    async createAppointment({
        consultationHourId, studentPublicId, instructorId, sectionGroupName,
        courseSubject, email, topic, mode, notes,
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
                    (consultation_hour_id, student_id, instructor_id, section_group_name,
                     course_subject, email, topic, mode, notes, status, room_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                [
                    consultationHourId, student.id, instructorId, sectionGroupName,
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
        const [[student]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
        );
        if (!student) return { success: false, reason: 'STUDENT_NOT_FOUND' };

        const [result] = await pool.execute(
            `UPDATE appointments SET status = 'cancelled'
         WHERE id = ? AND student_id = ? AND status IN ('pending','confirmed')`,
            [appointmentId, student.id]
        );

        if (result.affectedRows === 0) {
            return { success: false, reason: 'NOT_FOUND_OR_RESOLVED' };
        }
        return { success: true };
    },
};

module.exports = AppointmentModel;
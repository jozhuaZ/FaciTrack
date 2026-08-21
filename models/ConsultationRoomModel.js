const pool = require('../configs/db');
const { to12Hour, to24Hour } = require('../utils/timeFormat');

const ConsultationRoomModel = {
    /**
     * Get all program-based consultation tables (BSIT, BLIS, BSCS, BSIS)
     */
    async getProgramTables() {
        const [rows] = await pool.execute(
            `SELECT id, program_code, program_name, table_capacity, status
             FROM consultation_program_tables
             ORDER BY program_code`
        );
        return rows;
    },

    /**
     * Get consultation slots for a specific program with availability info
     * Includes room, instructor, and booking details
     */
    async getConsultationSlotsByProgram(programCode, date = null) {
        let query = `
            SELECT 
                cs.id AS slot_id,
                cs.consultation_date,
                cs.start_time,
                cs.end_time,
                cs.status AS slot_status,
                u.id AS instructor_id,
                u.first_name,
                u.last_name,
                u.position,
                d.full_name AS department_name,
                r.id AS room_id,
                r.room_number,
                r.capacity AS room_capacity,
                a.id AS appointment_id,
                a.status AS appointment_status,
                a.mode AS appointment_mode,
                a.topic,
                s.first_name AS student_first_name,
                s.last_name AS student_last_name,
                s.public_id AS student_public_id,
                sr.expires_at AS reservation_expires,
                (SELECT COUNT(*) 
                 FROM appointments a2 
                 WHERE a2.room_id = r.id 
                   AND a2.status IN ('pending', 'confirmed')
                   AND EXISTS (
                       SELECT 1 FROM consultation_hours ch2 
                       WHERE ch2.id = a2.consultation_hour_id 
                         AND ch2.consultation_date = cs.consultation_date
                         AND ch2.start_time < cs.end_time
                         AND ch2.end_time > cs.start_time
                   )
                ) AS current_room_bookings
            FROM consultation_hours cs
            INNER JOIN users u ON cs.instructor_id = u.id
            INNER JOIN departments d ON u.department_id = d.id
            LEFT JOIN appointments a ON cs.id = a.consultation_hour_id 
                AND a.status IN ('pending', 'confirmed')
            LEFT JOIN users s ON a.student_id = s.id
            LEFT JOIN rooms r ON a.room_id = r.id
            LEFT JOIN slot_reservations sr ON cs.id = sr.slot_id 
                AND sr.expires_at > NOW()
            WHERE d.program_code = ?
        `;

        const params = [programCode];

        if (date) {
            query += ` AND cs.consultation_date = ?`;
            params.push(date);
        }

        query += ` ORDER BY cs.consultation_date, cs.start_time, u.last_name`;

        const [rows] = await pool.execute(query, params);

        return rows.map(row => ({
            slotId: row.slot_id,
            date: row.consultation_date,
            timeStart: to12Hour(row.start_time),
            timeEnd: to12Hour(row.end_time),
            rawStartTime: row.start_time,
            rawEndTime: row.end_time,
            slotStatus: row.slot_status,
            instructor: {
                id: row.instructor_id,
                firstName: row.first_name,
                lastName: row.last_name,
                fullName: `${row.first_name} ${row.last_name}`,
                position: row.position,
                department: row.department_name
            },
            room: row.room_id ? {
                id: row.room_id,
                roomNumber: row.room_number,
                capacity: row.room_capacity,
                currentBookings: row.current_room_bookings
            } : null,
            appointment: row.appointment_id ? {
                id: row.appointment_id,
                status: row.appointment_status,
                mode: row.appointment_mode,
                topic: row.topic,
                student: {
                    firstName: row.student_first_name,
                    lastName: row.student_last_name,
                    publicId: row.student_public_id
                }
            } : null,
            isReserved: !!row.reservation_expires,
            reservationExpires: row.reservation_expires
        }));
    },

    /**
     * Get all consultation logs with filtering options
     */
    async getConsultationLogs({ 
        limit = 50, 
        offset = 0, 
        programCode = null, 
        status = null, 
        dateFrom = null, 
        dateTo = null,
        instructorId = null 
    } = {}) {
        let query = `
            SELECT 
                a.id AS appointment_id,
                a.status,
                a.mode,
                a.topic,
                a.course_subject,
                a.section_group_name,
                a.created_at,
                ch.consultation_date,
                ch.start_time,
                ch.end_time,
                u.first_name AS instructor_first_name,
                u.last_name AS instructor_last_name,
                u.position AS instructor_position,
                s.first_name AS student_first_name,
                s.last_name AS student_last_name,
                s.public_id AS student_public_id,
                r.room_number,
                d.full_name AS department_name,
                d.program_code
            FROM appointments a
            INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
            INNER JOIN users u ON a.instructor_id = u.id
            INNER JOIN users s ON a.student_id = s.id
            INNER JOIN departments d ON u.department_id = d.id
            LEFT JOIN rooms r ON a.room_id = r.id
            WHERE 1=1
        `;

        const params = [];

        if (programCode) {
            query += ` AND d.program_code = ?`;
            params.push(programCode);
        }

        if (status) {
            query += ` AND a.status = ?`;
            params.push(status);
        }

        if (dateFrom) {
            query += ` AND ch.consultation_date >= ?`;
            params.push(dateFrom);
        }

        if (dateTo) {
            query += ` AND ch.consultation_date <= ?`;
            params.push(dateTo);
        }

        if (instructorId) {
            query += ` AND a.instructor_id = ?`;
            params.push(instructorId);
        }

        query += ` ORDER BY ch.consultation_date DESC, ch.start_time DESC`;

        if (limit) {
            query += ` LIMIT ?`;
            params.push(Number(limit));
        }

        if (offset) {
            query += ` OFFSET ?`;
            params.push(Number(offset));
        }

        const [rows] = await pool.execute(query, params);

        return rows.map(row => ({
            appointmentId: row.appointment_id,
            status: row.status,
            mode: row.mode,
            topic: row.topic,
            course: row.course_subject,
            section: row.section_group_name,
            date: row.consultation_date,
            timeStart: to12Hour(row.start_time),
            timeEnd: to12Hour(row.end_time),
            createdAt: row.created_at,
            instructor: {
                firstName: row.instructor_first_name,
                lastName: row.instructor_last_name,
                fullName: `${row.instructor_first_name} ${row.instructor_last_name}`,
                position: row.instructor_position
            },
            student: {
                firstName: row.student_first_name,
                lastName: row.student_last_name,
                fullName: `${row.student_first_name} ${row.student_last_name}`,
                publicId: row.student_public_id
            },
            room: row.room_number || 'Online',
            department: row.department_name,
            programCode: row.program_code
        }));
    },

    /**
     * Get count of consultation logs for pagination
     */
    async getConsultationLogsCount({ 
        programCode = null, 
        status = null, 
        dateFrom = null, 
        dateTo = null,
        instructorId = null 
    } = {}) {
        let query = `
            SELECT COUNT(*) AS total
            FROM appointments a
            INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
            INNER JOIN users u ON a.instructor_id = u.id
            INNER JOIN departments d ON u.department_id = d.id
            WHERE 1=1
        `;

        const params = [];

        if (programCode) {
            query += ` AND d.program_code = ?`;
            params.push(programCode);
        }

        if (status) {
            query += ` AND a.status = ?`;
            params.push(status);
        }

        if (dateFrom) {
            query += ` AND ch.consultation_date >= ?`;
            params.push(dateFrom);
        }

        if (dateTo) {
            query += ` AND ch.consultation_date <= ?`;
            params.push(dateTo);
        }

        if (instructorId) {
            query += ` AND a.instructor_id = ?`;
            params.push(instructorId);
        }

        const [[result]] = await pool.execute(query, params);
        return result.total;
    },

    /**
     * Get available rooms for a specific time slot and program
     * Returns rooms that are not fully booked (< capacity)
     */
    async getAvailableRooms(programCode, consultationDate, startTime, endTime) {
        const [rows] = await pool.execute(
            `SELECT 
                r.id,
                r.room_number,
                r.capacity,
                r.room_type,
                r.status,
                d.full_name AS department_name,
                (SELECT COUNT(*) 
                 FROM appointments a
                 INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
                 WHERE a.room_id = r.id
                   AND a.status IN ('pending', 'confirmed')
                   AND a.mode = 'Face-to-Face'
                   AND ch.consultation_date = ?
                   AND ch.start_time < ?
                   AND ch.end_time > ?
                ) AS current_bookings
             FROM rooms r
             INNER JOIN departments d ON r.department_id = d.id
             WHERE d.program_code = ?
               AND r.room_type = 'Consultation Room'
               AND r.status = 'Active'
             HAVING current_bookings < r.capacity
             ORDER BY current_bookings ASC, r.room_number`,
            [consultationDate, endTime, startTime, programCode]
        );

        return rows.map(row => ({
            id: row.id,
            roomNumber: row.room_number,
            capacity: row.capacity,
            currentBookings: row.current_bookings,
            availableSlots: row.capacity - row.current_bookings,
            department: row.department_name
        }));
    },

    /**
     * Check if a time slot is available for booking based on room capacity
     * Returns true if Face-to-Face slots are available
     */
    async checkSlotAvailability(programCode, consultationDate, startTime, endTime) {
        const availableRooms = await this.getAvailableRooms(
            programCode, 
            consultationDate, 
            startTime, 
            endTime
        );

        return {
            hasAvailability: availableRooms.length > 0,
            availableRooms: availableRooms,
            faceToFaceAvailable: availableRooms.length > 0
        };
    },

    /**
     * Get statistics for the consultation room dashboard
     */
    async getConsultationStats(programCode = null, dateFrom = null, dateTo = null) {
        let query = `
            SELECT 
                COUNT(*) AS total_consultations,
                SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN a.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
                SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
                SUM(CASE WHEN a.status = 'declined' THEN 1 ELSE 0 END) AS declined_count,
                SUM(CASE WHEN a.mode = 'Face-to-Face' THEN 1 ELSE 0 END) AS face_to_face_count,
                SUM(CASE WHEN a.mode = 'Online' THEN 1 ELSE 0 END) AS online_count
            FROM appointments a
            INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
            INNER JOIN users u ON a.instructor_id = u.id
            INNER JOIN departments d ON u.department_id = d.id
            WHERE 1=1
        `;

        const params = [];

        if (programCode) {
            query += ` AND d.program_code = ?`;
            params.push(programCode);
        }

        if (dateFrom) {
            query += ` AND ch.consultation_date >= ?`;
            params.push(dateFrom);
        }

        if (dateTo) {
            query += ` AND ch.consultation_date <= ?`;
            params.push(dateTo);
        }

        const [[stats]] = await pool.execute(query, params);
        return stats;
    },

    /**
     * Get room utilization statistics
     */
    async getRoomUtilizationStats(dateFrom = null, dateTo = null) {
        let query = `
            SELECT 
                r.room_number,
                r.capacity,
                d.full_name AS department_name,
                d.program_code,
                COUNT(a.id) AS total_bookings,
                SUM(CASE WHEN a.status IN ('pending', 'confirmed') THEN 1 ELSE 0 END) AS active_bookings
            FROM rooms r
            INNER JOIN departments d ON r.department_id = d.id
            LEFT JOIN appointments a ON r.id = a.room_id
            LEFT JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
            WHERE r.room_type = 'Consultation Room'
              AND r.status = 'Active'
        `;

        const params = [];

        if (dateFrom) {
            query += ` AND ch.consultation_date >= ?`;
            params.push(dateFrom);
        }

        if (dateTo) {
            query += ` AND ch.consultation_date <= ?`;
            params.push(dateTo);
        }

        query += ` GROUP BY r.id, r.room_number, r.capacity, d.full_name, d.program_code
                   ORDER BY d.program_code, r.room_number`;

        const [rows] = await pool.execute(query, params);
        return rows;
    },

    /**
     * Update appointment status (for accept/decline from admin panel)
     */
    async updateAppointmentStatus(appointmentId, status, reason = null) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[appointment]] = await conn.execute(
                `SELECT a.*, ch.id AS consultation_hour_id
                 FROM appointments a
                 INNER JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
                 WHERE a.id = ?
                 FOR UPDATE`,
                [appointmentId]
            );

            if (!appointment) {
                await conn.rollback();
                return { success: false, reason: 'APPOINTMENT_NOT_FOUND' };
            }

            // Update appointment status
            if (status === 'declined') {
                await conn.execute(
                    `UPDATE appointments 
                     SET status = ?, decline_reason = ?
                     WHERE id = ?`,
                    [status, reason, appointmentId]
                );

                // Free the slot if declined
                await conn.execute(
                    `UPDATE consultation_hours 
                     SET status = 'Available'
                     WHERE id = ? AND status != 'closed'`,
                    [appointment.consultation_hour_id]
                );
            } else {
                await conn.execute(
                    `UPDATE appointments 
                     SET status = ?
                     WHERE id = ?`,
                    [status, appointmentId]
                );
            }

            await conn.commit();
            return { success: true };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }
};

module.exports = ConsultationRoomModel;

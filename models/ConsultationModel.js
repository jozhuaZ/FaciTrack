const pool = require('../configs/db');
const crypto = require('crypto');
const { to12Hour, to24Hour, toMins, fromMins } = require('../utils/timeFormat');

function generateSubSlots(timeStart, timeEnd, maxCapacity) {
    const start = toMins(timeStart);
    const end = toMins(timeEnd);
    const piece = Math.floor((end - start) / maxCapacity);
    const subs = [];

    for (let i = 0; i < maxCapacity; i++) {
        const subStart = start + i * piece;
        const subEnd = i === maxCapacity - 1 ? end : subStart + piece;
        subs.push({
            timeStart: fromMins(subStart),
            timeEnd: fromMins(subEnd),
        });
    }
    return subs;
}

function toDateKey(d) {
    const date = new Date(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function groupConsultationRows(rows) {
    const grouped = {};
    rows.forEach(row => {
        const dateStr = row.consultation_date;
        const key = `${dateStr}_${row.day_of_the_week}`;
        if (!grouped[key]) {
            grouped[key] = {
                date: dateStr,
                day: row.day_of_the_week,
                subSlots: [],
            };
        }
        grouped[key].subSlots.push({
            id: row.id,
            timeStart: to12Hour(row.start_time),
            timeEnd: to12Hour(row.end_time),
            status: row.status,
            isBooked: !!row.appointment_id,
        });
    });
    return Object.values(grouped);
}

const ConsultationModel = {

    async getSlotWithFaculty(slotId) {
        const [[row]] = await pool.execute(
            `SELECT
            ch.id, ch.day_of_the_week AS day, ch.consultation_date AS date,
            ch.start_time AS raw_start_time, ch.end_time AS raw_end_time,
            a.id AS appointment_id,
            u.id AS instructor_id, u.public_id AS faculty_id,
            u.first_name, u.last_name, u.middle_name,
            u.position, u.email, u.department_id,
            d.full_name AS department_name,
            iu.id AS unavail_id
         FROM consultation_hours ch
         JOIN users u ON ch.instructor_id = u.id
         LEFT JOIN departments d ON u.department_id = d.id
         LEFT JOIN appointments a ON ch.id = a.consultation_hour_id AND a.status IN ('pending','confirmed')
         LEFT JOIN instructor_unavailability iu ON iu.instructor_id = u.id AND iu.unavail_date = ch.consultation_date
         WHERE ch.id = ?`,
            [slotId]
        );
        if (!row) return null;

        return {
            id: row.id,
            day: row.day,
            date: row.date,
            timeStart: to12Hour(row.raw_start_time),
            timeEnd: to12Hour(row.raw_end_time),
            rawStartTime: row.raw_start_time,
            rawEndTime: row.raw_end_time,
            isBooked: !!row.appointment_id,
            isUnavailable: !!row.unavail_id,
            instructorId: row.instructor_id,
            departmentId: row.department_id,
            faculty: {
                id: row.faculty_id,
                first_name: row.first_name,
                last_name: row.last_name,
                middle_name: row.middle_name,
                position: row.position,
                department_name: row.department_name,
            },
        };
    },

    async getSlotsByInstructor(publicId) {
        const [rows] = await pool.execute(
            `SELECT ch.*
             FROM consultation_hours ch
             JOIN users u ON ch.instructor_id = u.id
             WHERE u.public_id = ?
             ORDER BY ch.consultation_date, ch.start_time`,
            [publicId]
        );

        return rows.map(r => ({
            ...r,
            timeStart: to12Hour(r.start_time),
            timeEnd: to12Hour(r.end_time),
            day: r.day_of_the_week,
            date: toDateKey(r.consultation_date),
        }));
    },

    async getSlotsByInstructorGrouped(publicId) {
        const [rows] = await pool.execute(
            `SELECT
                    cs.id,
                    cs.day_of_the_week,
                    cs.consultation_date,
                    cs.start_time,
                    cs.end_time,
                    cs.status,
                    cs.is_booked,
                    a.id AS appointment_id
                FROM consultation_hours cs
                LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status IN ('pending','confirmed')
                JOIN users u ON cs.instructor_id = u.id
                WHERE u.public_id = ?
                AND cs.status != 'closed'
                AND NOT EXISTS (
                    SELECT 1 FROM instructor_unavailability iu
                    WHERE iu.instructor_id = u.id
                        AND iu.unavail_date = cs.consultation_date
                )
                ORDER BY cs.consultation_date, cs.start_time`,
            [publicId]
        );

        return groupConsultationRows(rows);
    },

    async getBookableSlotsByInstructor(publicId) {
        const [rows] = await pool.execute(
            `SELECT
            cs.id, cs.day_of_the_week, cs.consultation_date,
            cs.start_time, cs.end_time, cs.status,
            a.id AS appointment_id
         FROM consultation_hours cs
         LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status IN ('pending','confirmed')
         JOIN users u ON cs.instructor_id = u.id
         WHERE u.public_id = ?
           AND cs.status != 'closed'
           AND cs.consultation_date >= CURDATE()
           AND a.id IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM instructor_unavailability iu
               WHERE iu.instructor_id = u.id AND iu.unavail_date = cs.consultation_date
           )
         ORDER BY cs.consultation_date, cs.start_time`,
            [publicId]
        );
        return groupConsultationRows(rows);
    },

    async saveSlotBlock(publicId, { date, day, timeStart, timeEnd, maxCapacity, repeatWeeks = 1 }) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[user]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [publicId]
            );
            if (!user) throw new Error('Instructor not found');

            const recurrenceId = repeatWeeks > 1 ? crypto.randomUUID() : null;
            const subSlots = generateSubSlots(timeStart, timeEnd, maxCapacity);
            let totalInserted = 0;

            for (let week = 0; week < repeatWeeks; week++) {
                const occurrenceDate = addDays(date, week * 7);

                // Delete existing available slots in this range on this occurrence's date
                await conn.execute(
                    `DELETE FROM consultation_hours
                 WHERE instructor_id = ?
                   AND consultation_date = ?
                   AND start_time >= ?
                   AND end_time <= ?
                   AND status = 'Available'`,
                    [user.id, occurrenceDate, to24Hour(timeStart), to24Hour(timeEnd)]
                );

                for (const sub of subSlots) {
                    await conn.execute(
                        `INSERT INTO consultation_hours
                        (instructor_id, day_of_the_week, consultation_date, start_time, end_time, status, recurrence_id)
                     VALUES (?, ?, ?, ?, ?, 'Available', ?)`,
                        [user.id, day, occurrenceDate, to24Hour(sub.timeStart), to24Hour(sub.timeEnd), recurrenceId]
                    );
                    totalInserted++;
                }
            }

            await conn.commit();
            return { count: totalInserted, recurrenceId };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    async deleteSlot(publicId, slotId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const [[history]] = await pool.execute(
            `SELECT
            SUM(status IN ('pending','confirmed')) AS activeCount,
            COUNT(*) AS totalCount
         FROM appointments
         WHERE consultation_hour_id = ?`,
            [slotId]
        );

        if (history.activeCount > 0) {
            return { success: false, reason: 'ACTIVE_APPOINTMENT' };
        }

        if (history.totalCount > 0) {
            // soft-close appointments with history
            const [result] = await pool.execute(
                `UPDATE consultation_hours SET status = 'closed'
             WHERE id = ? AND instructor_id = ?`,
                [slotId, user.id]
            );
            return { success: result.affectedRows > 0, softClosed: true };
        }

        // if appointment has no history then safe to hard delete
        const [result] = await pool.execute(
            `DELETE FROM consultation_hours WHERE id = ? AND instructor_id = ?`,
            [slotId, user.id]
        );
        return { success: result.affectedRows > 0, softClosed: false };
    },

    async getUnavailability(publicId) {
        const [rows] = await pool.execute(
            `SELECT iu.unavail_date AS date, iu.reason
             FROM instructor_unavailability iu
             JOIN users u ON iu.instructor_id = u.id
             WHERE u.public_id = ?
             ORDER BY iu.unavail_date`,
            [publicId]
        );
        return rows.map(r => ({
            date: toDateKey(r.date),
            reason: r.reason,
        }));
    },

    async setUnavailability(publicId, date, reason) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        await pool.execute(
            `INSERT INTO instructor_unavailability (instructor_id, unavail_date, reason)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
            [user.id, date, reason || null]
        );
    },

    async removeUnavailability(publicId, date) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        await pool.execute(
            'DELETE FROM instructor_unavailability WHERE instructor_id = ? AND unavail_date = ?',
            [user.id, date]
        );
    },

    async checkAppointmentsOnDate(publicId, date) {
        const [rows] = await pool.execute(
            `SELECT COUNT(*) AS count
         FROM appointments a
         JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         JOIN users u ON ch.instructor_id = u.id
         WHERE u.public_id = ?
           AND ch.consultation_date = ?
           AND a.status != 'cancelled'`,
            [publicId, date]
        );
        return rows[0].count;
    },

    async cancelAppointmentsOnDate(publicId, date, reason) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const [affected] = await pool.execute(
            `SELECT a.id, a.student_id
         FROM appointments a
         JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         WHERE ch.instructor_id = ?
           AND ch.consultation_date = ?
           AND a.status IN ('pending','confirmed')`,
            [user.id, date]
        );

        if (affected.length) {
            await pool.execute(
                `UPDATE appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             SET a.status = 'declined',
                 a.decline_reason = ?
             WHERE ch.instructor_id = ?
               AND ch.consultation_date = ?
               AND a.status IN ('pending','confirmed')`,
                [reason, user.id, date]
            );

            await pool.execute(
                `UPDATE consultation_hours
             SET status = 'Available'
             WHERE instructor_id = ?
               AND consultation_date = ?`,
                [user.id, date]
            );
        }

        return affected;
    },

};

module.exports = ConsultationModel;
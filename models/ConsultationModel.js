const pool = require('../configs/db');
const crypto = require('crypto');

// Convert "8:00 AM" → "08:00:00" for MySQL TIME
function to24Hour(str) {
    const parts = str.trim().split(' ');
    let [h, m] = parts[0].split(':').map(Number);
    const p = parts[1];
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function to12Hour(timeStr) {
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr);
    const m = mStr;
    const p = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${p}`;
}

function toMins(str) {
    const parts = str.trim().split(' ');
    let [h, m] = parts[0].split(':').map(Number);
    const p = parts[1];
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return h * 60 + m;
}

function fromMins(mins) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const p = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')} ${p}`;
}

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

const ConsultationModel = {
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
             LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status != 'cancelled'
             JOIN users u ON cs.instructor_id = u.id
             WHERE u.public_id = ?
             ORDER BY cs.consultation_date, cs.start_time`,
            [publicId]
        );

        const grouped = {};
        rows.forEach(row => {
            const dateStr = toDateKey(row.consultation_date);
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

    async deleteSlotBlock(publicId, slotId) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const [result] = await pool.execute(
            `DELETE FROM consultation_hours
             WHERE id = ?
               AND instructor_id = ?
               AND status = 'Available'`,
            [slotId, user.id]
        );
        return result.affectedRows;
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
             JOIN consultation_hours ch ON a.slot_id = ch.id
             JOIN users u ON ch.instructor_id = u.id
             WHERE u.public_id = ?
               AND ch.consultation_date = ?
               AND a.status != 'cancelled'`,
            [publicId, date]
        );
        return rows[0].count;
    },

    async cancelAppointmentsOnDate(publicId, date) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const [affected] = await pool.execute(
            `SELECT a.id, a.student_id
             FROM appointments a
             JOIN consultation_hours ch ON a.slot_id = ch.id
             WHERE ch.instructor_id = ?
               AND ch.consultation_date = ?
               AND a.status != 'cancelled'`,
            [user.id, date]
        );

        if (affected.length) {
            await pool.execute(
                `UPDATE appointments a
                 JOIN consultation_hours ch ON a.slot_id = ch.id
                 SET a.status = 'cancelled',
                     a.cancelled_by = 'instructor',
                     a.cancel_reason = 'Instructor marked this date as unavailable.'
                 WHERE ch.instructor_id = ?
                   AND ch.consultation_date = ?
                   AND a.status != 'cancelled'`,
                [user.id, date]
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
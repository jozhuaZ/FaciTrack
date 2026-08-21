const pool = require('../configs/db');
const RESERVATION_MS = 2 * 60 * 1000; // Changed from 5 to 2 minutes

const SlotReservation = {
    async reserveSlot(slotId, studentPublicId) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[student]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
            );
            if (!student) throw new Error('Student not found');

            const [[existing]] = await conn.execute(
                'SELECT * FROM slot_reservations WHERE slot_id = ? FOR UPDATE',
                [slotId]
            );

            const now = new Date();
            const expiresAt = new Date(now.getTime() + RESERVATION_MS);

            if (existing) {
                const stillActive = new Date(existing.expires_at) > now;
                if (stillActive && existing.student_id !== student.id) {
                    await conn.rollback();
                    return { success: false, reason: 'Slot is currently held by another student.' };
                }
                await conn.execute(
                    'UPDATE slot_reservations SET expires_at = ?, student_id = ? WHERE slot_id = ?',
                    [expiresAt, student.id, slotId]
                );
            } else {
                await conn.execute(
                    'INSERT INTO slot_reservations (slot_id, student_id, expires_at) VALUES (?, ?, ?)',
                    [slotId, student.id, expiresAt]
                );
            }

            await conn.commit();
            return { success: true, expiresAt };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    // Heartbeat — reset the 5-minute window on user activity
    async extendReservation(slotId, studentPublicId) {
        const [[student]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
        );
        if (!student) return { success: false };

        const expiresAt = new Date(Date.now() + RESERVATION_MS);
        const [result] = await pool.execute(
            `UPDATE slot_reservations
         SET expires_at = ?
         WHERE slot_id = ? AND student_id = ? AND expires_at > NOW()`,
            [expiresAt, slotId, student.id]
        );

        if (result.affectedRows === 0) return { success: false };
        return { success: true, expiresAt };
    },

    // Release explicitly (booking confirmed, or student navigates away)
    async releaseSlot(slotId, studentPublicId) {
        const [[student]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [studentPublicId]
        );
        if (!student) return;

        await pool.execute(
            'DELETE FROM slot_reservations WHERE slot_id = ? AND student_id = ?',
            [slotId, student.id]
        );
    },

    // Get all currently-active reservations for a set of slots (for rendering the schedule page)
    async getActiveReservationsForInstructor(instructorPublicId) {
        const [rows] = await pool.execute(
            `SELECT sr.slot_id, sr.student_id, sr.expires_at
             FROM slot_reservations sr
             JOIN consultation_hours ch ON sr.slot_id = ch.id
             JOIN users u ON ch.instructor_id = u.id
             WHERE u.public_id = ? AND sr.expires_at > NOW()`,
            [instructorPublicId]
        );
        return rows;
    },

    async deleteReservationBySlotId(slotId) {
        const [result] = await pool.execute(
            'DELETE FROM slot_reservations WHERE slot_id = ?',
            [slotId]
        );
        if (result.affectedRows === 0) return { success: false };
        return { success: true };
    }
};

module.exports = SlotReservation;
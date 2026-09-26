const pool = require('../configs/db');
const crypto = require('crypto');
const { to12Hour, to24Hour, toMins, fromMins, formatFullDate } = require('../utils/timeFormat');
const SlotReservation = require('./SlotReservationModel');
const NotificationModel = require('./NotificationModel');
const { bookingLeadTimeHours, SLOT_HOLDING_SQL, LIVE_APPOINTMENT_SQL } = require('../services/scheduling');
const { notBlockedByCalendarSql, blockedByCalendarSql } = require('../services/availability');

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
            // Lets a booked slot link straight to the booking it holds.
            // Null where the query did not select it.
            appointmentId: row.appointment_id ?? null,
            // 'pending' | 'confirmed' | undefined (no live appointment, or the
            // query didn't select it — student booking views don't need it)
            appointmentStatus: row.appointment_status,
            // Undefined unless the query asked for it (student booking views)
            roomAvailable: row.room_available === undefined ? undefined : !!Number(row.room_available),
            // Only getSlotsForStudentView() selects these; every other caller
            // filters these cases out in SQL instead, so they stay undefined.
            tooSoon: row.too_soon === undefined ? undefined : !!Number(row.too_soon),
            dateBlocked: row.date_blocked === undefined ? undefined : !!Number(row.date_blocked),
            statusBlocked: row.status_blocked === undefined ? undefined : !!Number(row.status_blocked),
            calendarBlocked: row.calendar_blocked === undefined ? undefined : !!Number(row.calendar_blocked),
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
            u.position, u.email, u.department_id, u.availability_status,
            u.default_meeting_link,
            (ga.user_id IS NOT NULL) AS google_connected,
            EXISTS (
                SELECT 1 FROM rooms r
                WHERE r.department_id = u.department_id
                  AND r.room_type = 'Consultation Room'
                  AND r.status = 'Active'
                  AND (
                      SELECT COUNT(*)
                      FROM appointments a2
                      JOIN consultation_hours ch2 ON a2.consultation_hour_id = ch2.id
                      WHERE a2.room_id = r.id
                        AND a2.status IN ('pending','confirmed')
                        AND ch2.consultation_date = ch.consultation_date
                        AND ch2.start_time < ch.end_time
                        AND ch2.end_time   > ch.start_time
                  ) < r.capacity
            ) AS room_available,
            d.full_name AS department_name,
            iu.id AS unavail_id
         FROM consultation_hours ch
         JOIN users u ON ch.instructor_id = u.id
         LEFT JOIN departments d ON u.department_id = d.id
         LEFT JOIN google_accounts ga ON ga.user_id = u.id AND ga.last_error IS NULL
         LEFT JOIN appointments a ON ch.id = a.consultation_hour_id AND a.status IN (${SLOT_HOLDING_SQL})
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
            roomAvailable: !!Number(row.room_available),
            faculty: {
                id: row.faculty_id,
                first_name: row.first_name,
                last_name: row.last_name,
                middle_name: row.middle_name,
                position: row.position,
                department_name: row.department_name,
                availability_status: row.availability_status,
                default_meeting_link: row.default_meeting_link,
                // Either venue works for an online consultation: a scheduled
                // Meet from the connected calendar, or the static room link.
                online_ready: Boolean(row.default_meeting_link || Number(row.google_connected)),
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
                    a.id AS appointment_id,
                    a.status AS appointment_status
                FROM consultation_hours cs
                LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status IN (${SLOT_HOLDING_SQL})
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
            a.id AS appointment_id,
            -- Mirrors assignConsultationRoom(): is any consultation room still
            -- under capacity for this window? Face-to-Face is impossible if not.
            EXISTS (
                SELECT 1 FROM rooms r
                WHERE r.department_id = u.department_id
                  AND r.room_type = 'Consultation Room'
                  AND r.status = 'Active'
                  AND (
                      SELECT COUNT(*)
                      FROM appointments a2
                      JOIN consultation_hours ch2 ON a2.consultation_hour_id = ch2.id
                      WHERE a2.room_id = r.id
                        AND a2.status IN ('pending','confirmed')
                        AND ch2.consultation_date = cs.consultation_date
                        AND ch2.start_time < cs.end_time
                        AND ch2.end_time   > cs.start_time
                  ) < r.capacity
            ) AS room_available
         FROM consultation_hours cs
         LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status IN (${SLOT_HOLDING_SQL})
         JOIN users u ON cs.instructor_id = u.id
         WHERE u.public_id = ?
           AND cs.status != 'closed'
           -- A non-available status is a 'right now' signal, so it only hides
           -- TODAY's slots. Multi-day absence is handled by instructor_unavailability.
           AND (u.availability_status IS NULL
                OR u.availability_status = 'available'
                OR cs.consultation_date > CURDATE())
           -- Same-day booking is allowed, but not within the lead-time window
           AND TIMESTAMP(cs.consultation_date, cs.start_time) >= DATE_ADD(NOW(), INTERVAL ? HOUR)
           AND NOT EXISTS (
               SELECT 1 FROM instructor_unavailability iu
               WHERE iu.instructor_id = u.id AND iu.unavail_date = cs.consultation_date
           )
           -- A blocking event on a synced calendar hides the slot too
           AND ${notBlockedByCalendarSql('u.id', 'cs.consultation_date', 'cs.start_time', 'cs.end_time')}
         ORDER BY cs.consultation_date, cs.start_time`,
            [publicId, await bookingLeadTimeHours()]
        );
        return groupConsultationRows(rows);
    },

    /**
     * Every slot an instructor has published, each carrying the reason it
     * cannot be booked rather than being dropped from the list.
     *
     * getBookableSlotsByInstructor() filters unbookable slots out in SQL, which
     * is right for "find me a free slot" but wrong for a profile page: the
     * student saw a schedule with unexplained holes next to greyed-out entries,
     * because half the reasons removed a slot and half greyed it. Here every
     * reason is a flag, so the page can show one consistent list.
     */
    async getSlotsForStudentView(publicId) {
        const [rows] = await pool.execute(
            `SELECT
            cs.id, cs.day_of_the_week, cs.consultation_date,
            cs.start_time, cs.end_time, cs.status,
            a.id AS appointment_id,
            EXISTS (
                SELECT 1 FROM rooms r
                WHERE r.department_id = u.department_id
                  AND r.room_type = 'Consultation Room'
                  AND r.status = 'Active'
                  AND (
                      SELECT COUNT(*)
                      FROM appointments a2
                      JOIN consultation_hours ch2 ON a2.consultation_hour_id = ch2.id
                      WHERE a2.room_id = r.id
                        AND a2.status IN (${LIVE_APPOINTMENT_SQL})
                        AND ch2.consultation_date = cs.consultation_date
                        AND ch2.start_time < cs.end_time
                        AND ch2.end_time   > cs.start_time
                  ) < r.capacity
            ) AS room_available,
            (TIMESTAMP(cs.consultation_date, cs.start_time)
                 < DATE_ADD(NOW(), INTERVAL ? HOUR))            AS too_soon,
            EXISTS (
                SELECT 1 FROM instructor_unavailability iu
                WHERE iu.instructor_id = u.id AND iu.unavail_date = cs.consultation_date
            )                                                    AS date_blocked,
            (u.availability_status IS NOT NULL
                 AND u.availability_status <> 'available'
                 AND cs.consultation_date = CURDATE())           AS status_blocked,
            ${blockedByCalendarSql('u.id', 'cs.consultation_date', 'cs.start_time', 'cs.end_time')}
                                                                 AS calendar_blocked
         FROM consultation_hours cs
         LEFT JOIN appointments a ON cs.id = a.consultation_hour_id AND a.status IN (${SLOT_HOLDING_SQL})
         JOIN users u ON cs.instructor_id = u.id
         WHERE u.public_id = ?
           AND cs.status <> 'closed'
         ORDER BY cs.consultation_date, cs.start_time`,
            [await bookingLeadTimeHours(), publicId]
        );
        return groupConsultationRows(rows);
    },

    /**
     * Is this slot covered by a blocking calendar event?
     * The list query filters these out, but a student may already be holding
     * the page when a sync lands, so the reservation path re-checks.
     */
    async isBlockedByCalendar(slotId) {
        // Uses the shared rule rather than its own copy. It previously carried
        // a hand-written duplicate that only knew about imported events, so an
        // instructor's own blocking event was invisible here even after the
        // shared rule learned about them.
        const [[row]] = await pool.execute(
            `SELECT ${blockedByCalendarSql(
                'cs.instructor_id', 'cs.consultation_date', 'cs.start_time', 'cs.end_time'
            )} AS blocked
             FROM consultation_hours cs WHERE cs.id = ?`,
            [slotId]
        );
        return Boolean(row && row.blocked);
    },

    /** Just the date of one slot — used to bound reschedules server-side. */
    async getSlotDate(slotId) {
        const [[row]] = await pool.execute(
            'SELECT consultation_date FROM consultation_hours WHERE id = ?', [slotId]
        );
        return row ? row.consultation_date : null;
    },

    /**
     * Save a block of slots, optionally repeating weekly.
     *
     * No two of an instructor's slots may overlap. The old version had no check
     * at all — it only cleared available slots lying entirely inside the new
     * range, so a 4:30–5:00 added next to an existing 4:00–5:00 went straight
     * in on top of it (and a booked slot inside the range was kept and
     * overlapped too). Any overlap with an open or booked slot is now refused.
     *
     * Repeating: if the date the instructor picked overlaps, nothing is saved —
     * that is the slot they are looking at. A later week that overlaps is
     * skipped and reported rather than sinking the whole series.
     *
     * Editing (replaceSlotId): the old slot comes out inside the same
     * transaction. The page used to delete it first and then save, so an edit
     * that failed lost the slot; now a refused edit rolls back and the original
     * is still there.
     *
     * @returns {{count, recurrenceId, skipped}} on success, or
     *          {{conflict: {date, start, end}}} / {{error: 'NOT_FOUND'|'ACTIVE_APPOINTMENT'}}
     */
    async saveSlotBlock(publicId, { date, day, timeStart, timeEnd, maxCapacity, repeatWeeks = 1, replaceSlotId = null }) {
        const conn = await pool.getConnection();
        // Undo everything this call did and hand back why.
        const refuse = async (result) => { await conn.rollback(); return result; };
        try {
            await conn.beginTransaction();

            const [[user]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [publicId]
            );
            if (!user) throw new Error('Instructor not found');

            if (replaceSlotId) {
                const [[old]] = await conn.execute(
                    'SELECT id FROM consultation_hours WHERE id = ? AND instructor_id = ? FOR UPDATE',
                    [replaceSlotId, user.id]
                );
                if (!old) return refuse({ error: 'NOT_FOUND' });

                const [[history]] = await conn.execute(
                    `SELECT SUM(status IN ('pending','confirmed')) AS active, COUNT(*) AS total
                       FROM appointments WHERE consultation_hour_id = ?`,
                    [replaceSlotId]
                );
                // Moving a slot out from under a student's live booking would
                // leave them booked for a time that no longer exists.
                if (Number(history.active) > 0) return refuse({ error: 'ACTIVE_APPOINTMENT' });

                // Same rule as deleteSlot: keep it (closed) if it has history.
                if (Number(history.total) > 0) {
                    await conn.execute("UPDATE consultation_hours SET status = 'closed' WHERE id = ?", [replaceSlotId]);
                } else {
                    await conn.execute('DELETE FROM consultation_hours WHERE id = ?', [replaceSlotId]);
                }
            }

            const start24 = to24Hour(timeStart);
            const end24 = to24Hour(timeEnd);
            const recurrenceId = repeatWeeks > 1 ? crypto.randomUUID() : null;
            const subSlots = generateSubSlots(timeStart, timeEnd, maxCapacity);
            let totalInserted = 0;
            const skipped = [];

            for (let week = 0; week < repeatWeeks; week++) {
                const occurrenceDate = addDays(date, week * 7);

                // Two ranges overlap when each starts before the other ends.
                // Touching ends (4:00–5:00 then 5:00–5:30) is not an overlap.
                const [clash] = await conn.execute(
                    `SELECT start_time, end_time FROM consultation_hours
                      WHERE instructor_id = ?
                        AND consultation_date = ?
                        AND LOWER(status) <> 'closed'
                        AND start_time < ?
                        AND end_time > ?
                      ORDER BY start_time
                      LIMIT 1`,
                    [user.id, occurrenceDate, end24, start24]
                );
                if (clash.length) {
                    if (week === 0) {
                        return refuse({
                            conflict: { date: occurrenceDate, start: clash[0].start_time, end: clash[0].end_time },
                        });
                    }
                    skipped.push(occurrenceDate);
                    continue;
                }

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
            return { count: totalInserted, recurrenceId, skipped };
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
        return this.setUnavailabilityRange(publicId, date, date, reason);
    },

    /**
     * Block a whole day, or every day in an inclusive range.
     * Unavailability is always full-day — the table stores one row per date.
     */
    async setUnavailabilityRange(publicId, startDate, endDate, reason) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const dates = [];
        for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
            dates.push(d);
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const date of dates) {
                await conn.execute(
                    `INSERT INTO instructor_unavailability (instructor_id, unavail_date, reason)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
                    [user.id, date, reason || null]
                );
            }
            await conn.commit();
            return dates;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Appointments that would be disrupted by blocking this range.
     * Returns enough detail for the instructor to reschedule or cancel each one.
     */
    async getAffectedAppointments(publicId, startDate, endDate) {
        const [rows] = await pool.execute(
            `SELECT
                a.id, a.status, a.topic, a.mode,
                ch.consultation_date, ch.start_time, ch.end_time,
                s.first_name AS student_first_name,
                s.last_name  AS student_last_name,
                a.student_number, a.section_group_name, a.course_subject
             FROM appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             JOIN users u ON ch.instructor_id = u.id
             JOIN users s ON a.student_id = s.id
             WHERE u.public_id = ?
               AND ch.consultation_date BETWEEN ? AND ?
               AND a.status IN (${LIVE_APPOINTMENT_SQL})
             ORDER BY ch.consultation_date, ch.start_time`,
            [publicId, startDate, endDate]
        );

        return rows.map(r => ({
            id: r.id,
            status: r.status,
            topic: r.topic,
            mode: r.mode,
            date: toDateKey(r.consultation_date),
            timeStart: to12Hour(r.start_time),
            timeEnd: to12Hour(r.end_time),
            studentName: `${r.student_first_name} ${r.student_last_name}`,
            studentNumber: r.student_number,
            sectionGroup: r.section_group_name,
            courseSubject: r.course_subject,
        }));
    },

    async removeUnavailability(publicId, date, endDate = null) {
        const [[user]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        await pool.execute(
            `DELETE FROM instructor_unavailability
             WHERE instructor_id = ? AND unavail_date BETWEEN ? AND ?`,
            [user.id, date, endDate || date]
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
           AND a.status IN (${LIVE_APPOINTMENT_SQL})`,
            [publicId, date]
        );
        return rows[0].count;
    },

    async cancelAppointmentsOnDate(publicId, date, reason) {
        return this.cancelAppointmentsInRange(publicId, date, date, reason);
    },

    /**
     * Cancel every live appointment in a blocked range and notify each student.
     * Freed slots go back to 'Available' so they can be reused once unblocked.
     */
    async cancelAppointmentsInRange(publicId, startDate, endDate, reason) {
        const [[user]] = await pool.execute(
            'SELECT id, first_name, last_name FROM users WHERE public_id = ?', [publicId]
        );
        if (!user) throw new Error('Instructor not found');

        const [affected] = await pool.execute(
            `SELECT a.id, a.student_id, ch.consultation_date, ch.start_time
         FROM appointments a
         JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
         WHERE ch.instructor_id = ?
           AND ch.consultation_date BETWEEN ? AND ?
           AND a.status IN (${LIVE_APPOINTMENT_SQL})`,
            [user.id, startDate, endDate]
        );

        if (affected.length) {
            await pool.execute(
                `UPDATE appointments a
             JOIN consultation_hours ch ON a.consultation_hour_id = ch.id
             SET a.status = 'declined',
                 a.decline_reason = ?
             WHERE ch.instructor_id = ?
               AND ch.consultation_date BETWEEN ? AND ?
               AND a.status IN (${LIVE_APPOINTMENT_SQL})`,
                [reason, user.id, startDate, endDate]
            );

            await pool.execute(
                `UPDATE consultation_hours
             SET status = 'Available'
             WHERE instructor_id = ?
               AND consultation_date BETWEEN ? AND ?`,
                [user.id, startDate, endDate]
            );

            // The UI promises students are told — actually tell them
            const instructorName = `${user.first_name} ${user.last_name}`;
            for (const apt of affected) {
                const dateLabel = formatFullDate(apt.consultation_date);
                await NotificationModel.create(
                    apt.student_id,
                    'unavailability',
                    `${instructorName} is unavailable on ${dateLabel}. Your consultation was cancelled${reason ? ` (${reason})` : ''}. Please book a new slot.`,
                    apt.id
                );
            }
        }

        return affected;
    },

    async updateStatusById(slotId, status = 'Available') {
        const [affected] = await pool.execute(
            'UPDATE consultation_hours SET status = ? WHERE id = ?',
            [status, slotId]
        );

        if (status === 'Available') {
            await SlotReservation.deleteReservationBySlotId(slotId);
        }

        return affected;
    }

};

module.exports = ConsultationModel;
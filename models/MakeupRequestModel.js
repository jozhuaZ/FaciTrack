const crypto = require('crypto');
const pool = require('../configs/db');
const { calendarBusyIntervals } = require('../services/availability');

/**
 * Make-up class requests.
 *
 * One request carries several proposed sessions, several documents, and
 * receives a single dean decision. Approved sessions stay in
 * makeup_request_schedules — workload_blocks is a recurring weekly grid, so a
 * dated one-off written there would repeat every week and collide with the
 * class it replaces.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Which room types a class of each type may be held in.
 * A lecture can borrow a laboratory, but a laboratory class needs the
 * equipment, so it cannot fall back to a plain lecture room. An online class
 * has no room at all.
 */
const ROOM_TYPES_FOR_CLASS = {
    Lecture: ['Lecture', 'Laboratory'],
    Laboratory: ['Laboratory'],
    Online: [],
};

const CLASS_TYPES = Object.keys(ROOM_TYPES_FOR_CLASS);

/** Free-text class types come from the timetable, so normalise before matching. */
function normalizeClassType(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text.startsWith('lab')) return 'Laboratory';
    if (text.startsWith('online') || text.startsWith('virtual')) return 'Online';
    return 'Lecture';
}

/** 'HH:MM' → half-hour slot index, matching workload_blocks. */
function timeToSlot(timeStr) {
    const [h, m] = String(timeStr).split(':').map(Number);
    return h * 2 + (m >= 30 ? 1 : 0);
}

function slotToTime(slot) {
    const total = slot * 30;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function slotToLabel(slot) {
    const total = slot * 30;
    const h = Math.floor(total / 60);
    const m = total % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function dayOfWeek(dateKey) {
    return DAYS[new Date(dateKey + 'T00:00:00').getDay()];
}

function toDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Half-open interval overlap, the rule used everywhere in this module. */
function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && aEnd > bStart;
}

/**
 * Retry a transaction that InnoDB aborted for a deadlock.
 *
 * create() and update() each insert several rows that share foreign keys
 * (room_id, instructor_id) with whatever else is committing at the same
 * moment — two instructors submitting sessions in opposite room order is
 * enough to deadlock. That is what MySQL's own error text is telling the
 * caller to do ("try restarting transaction"): the loser rolled back cleanly
 * and holds no locks, so simply running the whole transaction again is safe.
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

const MakeupRequestModel = {
    timeToSlot,
    slotToTime,
    slotToLabel,
    dayOfWeek,
    normalizeClassType,
    ROOM_TYPES_FOR_CLASS,
    CLASS_TYPES,

    /** Is this room allowed to host that kind of class? */
    roomTypeAllowed(classType, roomType) {
        return ROOM_TYPES_FOR_CLASS[normalizeClassType(classType)].includes(roomType);
    },

    /**
     * Everything that would clash with one proposed session.
     * Runs on a caller-supplied connection so it can share the submit
     * transaction and see a consistent picture.
     */
    async findConflicts(conn, instructorInternalId, session, { ignoreRequestId = null } = {}) {
        const { classDate, startSlot, endSlot, roomId, deliveryMode } = session;
        const classType = normalizeClassType(session.classType);
        const day = dayOfWeek(classDate);
        const conflicts = [];

        // 0. The room has to suit the class before anything else matters
        if (deliveryMode === 'in-campus' && roomId) {
            const [[room]] = await conn.execute(
                'SELECT room_number, room_type, status FROM rooms WHERE id = ?', [roomId]
            );
            if (!room) {
                conflicts.push({ kind: 'room-missing', message: 'That room no longer exists.' });
            } else if (room.status !== 'Active') {
                conflicts.push({ kind: 'room-inactive', message: `${room.room_number} is not in service.` });
            } else if (!ROOM_TYPES_FOR_CLASS[classType].includes(room.room_type)) {
                conflicts.push({
                    kind: 'room-type',
                    message: `${room.room_number} is a ${room.room_type.toLowerCase()} room, ` +
                             `which cannot host a ${classType.toLowerCase()} class.`,
                });
            }
        }

        // 1. The instructor's own recurring class on that weekday
        const [ownBlocks] = await conn.execute(
            `SELECT ws.subject_code, wb.section_name, wb.start_slot, wb.end_slot
               FROM workload_blocks wb
               JOIN workload_subjects ws ON wb.subject_id = ws.id
              WHERE wb.instructor_id = ?
                AND wb.day_of_week = ?
                AND wb.start_slot < ? AND wb.end_slot > ?`,
            [instructorInternalId, day, endSlot, startSlot]
        );
        ownBlocks.forEach(b => conflicts.push({
            kind: 'own-class',
            message: `You teach ${b.subject_code} (${b.section_name || 'no section'}) every ${day}, ` +
                     `${slotToLabel(b.start_slot)} – ${slotToLabel(b.end_slot)}.`,
        }));

        if (deliveryMode === 'in-campus' && roomId) {
            // 2. Somebody else's recurring class already holds that room.
            //    The instructor's own blocks are skipped — #1 already said so.
            const [roomBlocks] = await conn.execute(
                `SELECT ws.subject_code, wb.start_slot, wb.end_slot,
                        u.first_name, u.last_name, r.room_number
                   FROM workload_blocks wb
                   JOIN workload_subjects ws ON wb.subject_id = ws.id
                   JOIN users u ON wb.instructor_id = u.id
                   JOIN rooms r ON wb.room_id = r.id
                  WHERE wb.room_id = ?
                    AND wb.instructor_id <> ?
                    AND wb.day_of_week = ?
                    AND wb.start_slot < ? AND wb.end_slot > ?`,
                [roomId, instructorInternalId, day, endSlot, startSlot]
            );
            roomBlocks.forEach(b => conflicts.push({
                kind: 'room-class',
                message: `${b.room_number} is taken every ${day} ` +
                         `${slotToLabel(b.start_slot)} – ${slotToLabel(b.end_slot)} ` +
                         `by ${b.first_name} ${b.last_name} (${b.subject_code}).`,
            }));
        }

        // 3. An already-approved make-up on that exact date — same room, or the
        //    instructor double-booking themselves
        const [approved] = await conn.execute(
            `SELECT s.subject_code, s.start_slot, s.end_slot, s.room_id,
                    r.room_number, mr.instructor_id
               FROM makeup_request_schedules s
               JOIN makeup_requests mr ON s.request_id = mr.id
               LEFT JOIN rooms r ON s.room_id = r.id
              WHERE mr.status = 'approved'
                AND s.class_date = ?
                AND s.start_slot < ? AND s.end_slot > ?
                AND (mr.instructor_id = ? OR (s.room_id IS NOT NULL AND s.room_id = ?))
                AND (? IS NULL OR mr.id <> ?)`,
            [classDate, endSlot, startSlot, instructorInternalId, roomId || 0,
             ignoreRequestId, ignoreRequestId]
        );
        approved.forEach(a => {
            const mine = String(a.instructor_id) === String(instructorInternalId);
            conflicts.push({
                kind: 'approved-makeup',
                message: mine
                    ? `You already have an approved make-up class for ${a.subject_code} then.`
                    : `${a.room_number} is already booked by an approved make-up class then.`,
            });
        });

        // 4. The instructor's consultation hours and live appointments that day
        const [slots] = await conn.execute(
            `SELECT ch.start_time, ch.end_time,
                    (SELECT COUNT(*) FROM appointments a
                      WHERE a.consultation_hour_id = ch.id
                        AND a.status IN ('pending','confirmed')) AS booked
               FROM consultation_hours ch
              WHERE ch.instructor_id = ?
                AND ch.consultation_date = ?
                AND ch.status <> 'closed'`,
            [instructorInternalId, classDate]
        );
        slots.forEach(s => {
            const sStart = timeToSlot(s.start_time);
            const sEnd = timeToSlot(s.end_time);
            if (overlaps(sStart, sEnd, startSlot, endSlot)) {
                conflicts.push({
                    kind: s.booked ? 'appointment' : 'consultation',
                    message: s.booked
                        ? `You have a booked consultation at ${slotToLabel(sStart)} – ${slotToLabel(sEnd)} that day.`
                        : `Your consultation hours cover ${slotToLabel(sStart)} – ${slotToLabel(sEnd)} that day.`,
                });
            }
        });

        // 5. A day the instructor has already marked unavailable
        const [[blocked]] = await conn.execute(
            `SELECT reason FROM instructor_unavailability
              WHERE instructor_id = ? AND unavail_date = ?`,
            [instructorInternalId, classDate]
        );
        if (blocked) {
            conflicts.push({
                kind: 'unavailable',
                message: `You marked ${classDate} unavailable` +
                         (blocked.reason ? ` (${blocked.reason}).` : '.'),
            });
        }

        // 6. A blocking event on a calendar the instructor synced
        const [external] = await conn.execute(
            `SELECT summary, start_slot, end_slot, all_day
               FROM external_events
              WHERE user_id = ? AND blocks = 1 AND event_date = ?
                AND (all_day = 1 OR (start_slot < ? AND end_slot > ?))`,
            [instructorInternalId, classDate, endSlot, startSlot]
        );
        external.forEach(e => conflicts.push({
            kind: 'calendar',
            message: e.all_day
                ? `Your calendar has ${e.summary || 'an all-day event'} on ${classDate}.`
                : `Your calendar has ${e.summary || 'an event'} at ` +
                  `${slotToLabel(e.start_slot)} – ${slotToLabel(e.end_slot)} that day.`,
        }));

        return conflicts;
    },

    // ── Slot generation ────────────────────────────────────────────────────

    /**
     * Find the earliest workable slot for each class being made up.
     *
     * Everything the scan needs is loaded once for the whole window and then
     * matched in memory — a query per candidate slot would mean thousands of
     * round trips. Placements are remembered as they are made, so two sessions
     * in one batch never land on top of each other.
     *
     * @param {string} instructorPublicId
     * @param {Array}  wanted  [{ key, classType, durationSlots, preferredRoomId,
     *                            preferredStartSlot, deliveryMode }]
     * @param {object} opts    { minDate, maxDate, dayStartSlot, dayEndSlot,
     *                           skipDays, ignoreRequestId, occupied }
     */
    async suggestSlots(instructorPublicId, wanted, opts = {}) {
        const {
            minDate, maxDate,
            dayStartSlot = 14,          // 07:00
            dayEndSlot = 42,            // 21:00
            skipDays = ['Sunday'],
            ignoreRequestId = null,
            occupied = [],
        } = opts;

        const [[instructor]] = await pool.execute(
            'SELECT id FROM users WHERE public_id = ?', [instructorPublicId]
        );
        if (!instructor) return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' };

        const busy = await loadBusyWindow(instructor.id, minDate, maxDate, ignoreRequestId);
        const rooms = await loadBookableRooms();

        // Slots the form already holds but has not saved — re-rolling one
        // session must not land on top of its siblings.
        occupied.forEach(o => reserve(busy, {
            date: o.classDate,
            start: o.startSlot,
            end: o.endSlot,
            room: o.roomId ? { id: o.roomId } : null,
        }, !o.roomId));

        const results = [];
        for (const item of wanted) {
            const classType = normalizeClassType(item.classType);
            const online = classType === 'Online' || item.deliveryMode === 'online';
            const duration = Math.max(1, parseInt(item.durationSlots, 10) || 2);
            const allowedTypes = ROOM_TYPES_FOR_CLASS[classType];

            // Rooms that suit this class, the usual one first — students and the
            // instructor both already know where it is.
            const suitable = online ? [] : rooms.filter(r => allowedTypes.includes(r.room_type));
            const candidates = suitable
                .filter(r => r.status === 'Active')
                .sort((a, b) => (String(b.id) === String(item.preferredRoomId) ? 1 : 0) -
                                (String(a.id) === String(item.preferredRoomId) ? 1 : 0));

            if (!online && !candidates.length) {
                results.push({
                    key: item.key,
                    found: false,
                    message: noRoomMessage(classType, allowedTypes, suitable),
                });
                continue;
            }

            const placed = findEarliest({
                busy, candidates, duration, online,
                minDate, maxDate, dayStartSlot, dayEndSlot, skipDays,
                preferredStartSlot: parseInt(item.preferredStartSlot, 10),
            });

            if (!placed) {
                results.push({
                    key: item.key,
                    found: false,
                    message: `Nothing free on or before ${maxDate}. ` +
                             `Try a shorter session, or hold it online.`,
                });
                continue;
            }

            reserve(busy, placed, online);
            results.push({
                key: item.key,
                found: true,
                classDate: placed.date,
                dayOfWeek: dayOfWeek(placed.date),
                startSlot: placed.start,
                endSlot: placed.end,
                startTime: slotToTime(placed.start),
                endTime: slotToTime(placed.end),
                deliveryMode: online ? 'online' : 'in-campus',
                classType,
                roomId: online ? null : placed.room.id,
                roomNumber: online ? null : placed.room.room_number,
                timeLabel: `${slotToLabel(placed.start)} – ${slotToLabel(placed.end)}`,
            });
        }

        return { success: true, results };
    },

    // ── Writes ─────────────────────────────────────────────────────────────

    /**
     * Create a request, its sessions and its documents in one transaction.
     * Conflicts are re-checked inside it, so two submissions racing for the
     * same room cannot both win.
     */
    async create(instructorPublicId, payload) {
        return withDeadlockRetry(() => this._create(instructorPublicId, payload));
    },

    async _create(instructorPublicId, { reason, documents = [], sessions }) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[instructor]] = await conn.execute(
                'SELECT id, department_id FROM users WHERE public_id = ?', [instructorPublicId]
            );
            if (!instructor) { await conn.rollback(); return { success: false, reason: 'INSTRUCTOR_NOT_FOUND' }; }

            for (const session of sessions) {
                const conflicts = await this.findConflicts(conn, instructor.id, session);
                if (conflicts.length) {
                    await conn.rollback();
                    return { success: false, reason: 'CONFLICT', conflicts, session };
                }
            }

            const id = crypto.randomUUID();
            await conn.execute(
                `INSERT INTO makeup_requests (id, instructor_id, department_id, reason)
                 VALUES (?, ?, ?, ?)`,
                [id, instructor.id, instructor.department_id, reason || null]
            );

            for (const s of sessions) await insertSession(conn, id, s);
            for (const d of documents) await insertDocument(conn, id, d);

            await conn.commit();
            return { success: true, id };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Replace a pending request's sessions and details, re-running the checks.
     * Documents are additive: new uploads append, and only the ids listed in
     * `removeDocumentIds` go away.
     */
    async update(requestId, instructorPublicId, payload) {
        return withDeadlockRetry(() => this._update(requestId, instructorPublicId, payload));
    },

    async _update(requestId, instructorPublicId, { reason, sessions, documents = [], removeDocumentIds = [] }) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[row]] = await conn.execute(
                `SELECT mr.id, mr.status, mr.instructor_id
                   FROM makeup_requests mr
                   JOIN users u ON mr.instructor_id = u.id
                  WHERE mr.id = ? AND u.public_id = ? FOR UPDATE`,
                [requestId, instructorPublicId]
            );
            if (!row) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND' }; }
            if (row.status !== 'pending') { await conn.rollback(); return { success: false, reason: 'NOT_PENDING' }; }

            for (const session of sessions) {
                const conflicts = await this.findConflicts(conn, row.instructor_id, session,
                    { ignoreRequestId: requestId });
                if (conflicts.length) {
                    await conn.rollback();
                    return { success: false, reason: 'CONFLICT', conflicts, session };
                }
            }

            // Files are only unlinked once the write commits, so collect the paths
            let removedPaths = [];
            if (removeDocumentIds.length) {
                const [gone] = await conn.query(
                    `SELECT id, file_path FROM makeup_request_documents
                      WHERE request_id = ? AND id IN (?)`,
                    [requestId, removeDocumentIds]
                );
                if (gone.length) {
                    removedPaths = gone.map(g => g.file_path);
                    await conn.query(
                        'DELETE FROM makeup_request_documents WHERE request_id = ? AND id IN (?)',
                        [requestId, gone.map(g => g.id)]
                    );
                }
            }

            for (const d of documents) await insertDocument(conn, requestId, d);

            // A request without its paperwork is not reviewable
            const [[left]] = await conn.execute(
                `SELECT COUNT(*) AS n FROM makeup_request_documents
                  WHERE request_id = ? AND kind = 'support'`,
                [requestId]
            );
            if (!left.n) { await conn.rollback(); return { success: false, reason: 'NO_DOCUMENT' }; }

            await conn.execute(
                'UPDATE makeup_requests SET reason = ? WHERE id = ?', [reason || null, requestId]
            );
            await conn.execute('DELETE FROM makeup_request_schedules WHERE request_id = ?', [requestId]);
            for (const s of sessions) await insertSession(conn, requestId, s);

            await conn.commit();
            return { success: true, removedPaths };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /** Instructor pulls a pending request back out of the dean's queue. */
    async withdraw(requestId, instructorPublicId) {
        const [result] = await pool.execute(
            `UPDATE makeup_requests mr
               JOIN users u ON mr.instructor_id = u.id
                SET mr.status = 'withdrawn'
              WHERE mr.id = ? AND u.public_id = ? AND mr.status = 'pending'`,
            [requestId, instructorPublicId]
        );
        return result.affectedRows > 0;
    },

    /**
     * Dean decision. Approving re-checks both the paperwork and the conflicts:
     * the schedule may have moved on since the request was filed.
     */
    async decide(requestId, deanPublicId, { approve, statement, declineReason }) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [[dean]] = await conn.execute(
                'SELECT id, department_id FROM users WHERE public_id = ?', [deanPublicId]
            );
            if (!dean) { await conn.rollback(); return { success: false, reason: 'DEAN_NOT_FOUND' }; }

            const [[row]] = await conn.execute(
                `SELECT id, status, instructor_id, department_id
                   FROM makeup_requests WHERE id = ? FOR UPDATE`,
                [requestId]
            );
            if (!row) { await conn.rollback(); return { success: false, reason: 'NOT_FOUND' }; }
            if (row.status !== 'pending') { await conn.rollback(); return { success: false, reason: 'ALREADY_DECIDED' }; }
            if (String(row.department_id) !== String(dean.department_id)) {
                await conn.rollback();
                return { success: false, reason: 'OTHER_DEPARTMENT' };
            }

            if (approve) {
                const [[docs]] = await conn.execute(
                    `SELECT COUNT(*) AS n FROM makeup_request_documents
                      WHERE request_id = ? AND kind = 'support'`,
                    [requestId]
                );
                if (!docs.n) { await conn.rollback(); return { success: false, reason: 'NO_DOCUMENT' }; }

                const [sessions] = await conn.execute(
                    `SELECT class_date AS classDate, start_slot AS startSlot, end_slot AS endSlot,
                            room_id AS roomId, delivery_mode AS deliveryMode, class_type AS classType
                       FROM makeup_request_schedules WHERE request_id = ?`,
                    [requestId]
                );
                for (const session of sessions) {
                    const conflicts = await this.findConflicts(conn, row.instructor_id, session,
                        { ignoreRequestId: requestId });
                    if (conflicts.length) {
                        await conn.rollback();
                        return { success: false, reason: 'CONFLICT', conflicts, session };
                    }
                }
            }

            await conn.execute(
                `UPDATE makeup_requests
                    SET status = ?, decided_by = ?, decided_at = NOW(),
                        dean_statement = ?, decline_reason = ?
                  WHERE id = ?`,
                [approve ? 'approved' : 'declined', dean.id,
                 approve ? (statement || null) : null,
                 approve ? null : (declineReason || null),
                 requestId]
            );

            await conn.commit();
            return { success: true, instructorInternalId: row.instructor_id };
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    // ── Reads ──────────────────────────────────────────────────────────────

    async getById(requestId) {
        const [[row]] = await pool.execute(
            `SELECT mr.*, u.public_id AS instructor_public_id,
                    u.first_name, u.last_name, d.short_name AS department,
                    dc.first_name AS decided_by_first, dc.last_name AS decided_by_last
               FROM makeup_requests mr
               JOIN users u ON mr.instructor_id = u.id
               LEFT JOIN departments d ON mr.department_id = d.id
               LEFT JOIN users dc ON mr.decided_by = dc.id
              WHERE mr.id = ?`,
            [requestId]
        );
        if (!row) return null;
        const [attached] = await this.attachSessions([row]);
        return attached;
    },

    /** One document plus enough of its request to authorise the download. */
    async getDocument(documentId) {
        const [[row]] = await pool.execute(
            `SELECT d.*, mr.department_id, u.public_id AS instructor_public_id
               FROM makeup_request_documents d
               JOIN makeup_requests mr ON d.request_id = mr.id
               JOIN users u ON mr.instructor_id = u.id
              WHERE d.id = ?`,
            [documentId]
        );
        return row || null;
    },

    async getByInstructor(instructorPublicId) {
        const [rows] = await pool.execute(
            `SELECT mr.*, dc.first_name AS decided_by_first, dc.last_name AS decided_by_last
               FROM makeup_requests mr
               JOIN users u ON mr.instructor_id = u.id
               LEFT JOIN users dc ON mr.decided_by = dc.id
              WHERE u.public_id = ?
              ORDER BY mr.submitted_at DESC, mr.id DESC`,
            [instructorPublicId]
        );
        return this.attachSessions(rows);
    },

    /**
     * The dean's queue: their own department only, oldest first.
     * The id tiebreak keeps the order stable when two requests share a
     * timestamp — approving in bulk hands out contested rooms in this order.
     */
    async getByDepartment(deanPublicId, { status = null } = {}) {
        const [rows] = await pool.execute(
            `SELECT mr.*, u.first_name, u.last_name, u.position,
                    dc.first_name AS decided_by_first, dc.last_name AS decided_by_last
               FROM makeup_requests mr
               JOIN users u ON mr.instructor_id = u.id
               JOIN users dean ON dean.public_id = ?
               LEFT JOIN users dc ON mr.decided_by = dc.id
              WHERE mr.department_id <=> dean.department_id
                AND mr.status <> 'withdrawn'
                AND (? IS NULL OR mr.status = ?)
              ORDER BY mr.submitted_at ASC, mr.id ASC`,
            [deanPublicId, status, status]
        );
        return this.attachSessions(rows);
    },

    /** Two extra queries for all sessions and documents, not two per request. */
    async attachSessions(requests) {
        if (!requests.length) return [];
        const ids = requests.map(r => r.id);

        const [sessions] = await pool.query(
            `SELECT s.*, r.room_number, r.room_type
               FROM makeup_request_schedules s
               LEFT JOIN rooms r ON s.room_id = r.id
              WHERE s.request_id IN (?)
              ORDER BY s.class_date, s.start_slot`,
            [ids]
        );
        const [docs] = await pool.query(
            `SELECT id, request_id, kind, original_name, mime_type, size_bytes
               FROM makeup_request_documents
              WHERE request_id IN (?)
              ORDER BY kind, uploaded_at, id`,
            [ids]
        );

        const sessionsByRequest = {};
        sessions.forEach(row => {
            (sessionsByRequest[row.request_id] = sessionsByRequest[row.request_id] || []).push(decorate(row));
        });
        const docsByRequest = {};
        docs.forEach(row => {
            (docsByRequest[row.request_id] = docsByRequest[row.request_id] || []).push(row);
        });

        return requests.map(r => {
            const mine = docsByRequest[r.id] || [];
            return Object.assign(r, {
                sessions: sessionsByRequest[r.id] || [],
                documents: mine,
                supportDocuments: mine.filter(d => d.kind === 'support'),
                pollingDocument: mine.find(d => d.kind === 'polling') || null,
            });
        });
    },

    /** Every file path a request owns, for cleaning up after a delete. */
    async getDocumentPaths(requestId) {
        const [rows] = await pool.execute(
            'SELECT file_path FROM makeup_request_documents WHERE request_id = ?', [requestId]
        );
        return rows.map(r => r.file_path);
    },

    /** Approved one-off sessions in a date range, for merging into calendars. */
    async getApprovedBetween(instructorPublicId, startDate, endDate) {
        const [rows] = await pool.execute(
            `SELECT s.*, r.room_number
               FROM makeup_request_schedules s
               JOIN makeup_requests mr ON s.request_id = mr.id
               JOIN users u ON mr.instructor_id = u.id
               LEFT JOIN rooms r ON s.room_id = r.id
              WHERE u.public_id = ?
                AND mr.status = 'approved'
                AND s.class_date BETWEEN ? AND ?
              ORDER BY s.class_date, s.start_slot`,
            [instructorPublicId, startDate, endDate]
        );
        return rows.map(decorate);
    },
};

// ── Generation helpers ─────────────────────────────────────────────────────

/**
 * Everything in the window that could block a suggestion, keyed for lookup:
 *   instructorByDay['Monday']       → their recurring classes
 *   instructorByDate['2026-09-01']  → make-ups, consultations, appointments
 *   roomByDay['7|Monday']           → recurring classes held in that room
 *   roomByDate['7|2026-09-01']      → approved make-ups in that room
 *   offDates                        → days the instructor marked unavailable
 */
async function loadBusyWindow(instructorId, minDate, maxDate, ignoreRequestId) {
    const busy = {
        instructorByDay: {}, instructorByDate: {},
        roomByDay: {}, roomByDate: {}, offDates: new Set(),
    };
    const push = (bucket, key, interval) => {
        (bucket[key] = bucket[key] || []).push(interval);
    };

    // Every roomed class in the college, plus this instructor's roomless ones
    const [blocks] = await pool.execute(
        `SELECT instructor_id, room_id, day_of_week, start_slot, end_slot
           FROM workload_blocks
          WHERE instructor_id = ? OR room_id IS NOT NULL`,
        [instructorId]
    );
    blocks.forEach(b => {
        const interval = [b.start_slot, b.end_slot];
        if (String(b.instructor_id) === String(instructorId)) {
            push(busy.instructorByDay, b.day_of_week, interval);
        }
        if (b.room_id) push(busy.roomByDay, `${b.room_id}|${b.day_of_week}`, interval);
    });

    const [makeups] = await pool.execute(
        `SELECT s.class_date, s.start_slot, s.end_slot, s.room_id, mr.instructor_id
           FROM makeup_request_schedules s
           JOIN makeup_requests mr ON s.request_id = mr.id
          WHERE mr.status = 'approved'
            AND s.class_date BETWEEN ? AND ?
            AND (? IS NULL OR mr.id <> ?)`,
        [minDate, maxDate, ignoreRequestId, ignoreRequestId]
    );
    makeups.forEach(m => {
        const date = toDateKey(new Date(m.class_date));
        const interval = [m.start_slot, m.end_slot];
        if (String(m.instructor_id) === String(instructorId)) {
            push(busy.instructorByDate, date, interval);
        }
        if (m.room_id) push(busy.roomByDate, `${m.room_id}|${date}`, interval);
    });

    const [hours] = await pool.execute(
        `SELECT consultation_date, start_time, end_time
           FROM consultation_hours
          WHERE instructor_id = ? AND status <> 'closed'
            AND consultation_date BETWEEN ? AND ?`,
        [instructorId, minDate, maxDate]
    );
    hours.forEach(h => push(busy.instructorByDate, toDateKey(new Date(h.consultation_date)),
        [timeToSlot(h.start_time), timeToSlot(h.end_time)]));

    const [off] = await pool.execute(
        `SELECT unavail_date FROM instructor_unavailability
          WHERE instructor_id = ? AND unavail_date BETWEEN ? AND ?`,
        [instructorId, minDate, maxDate]
    );
    off.forEach(o => busy.offDates.add(toDateKey(new Date(o.unavail_date))));

    // Events from a synced calendar the instructor chose to block with.
    // An all-day blocking event takes the day out entirely.
    const external = await calendarBusyIntervals(instructorId, minDate, maxDate);
    external.forEach(e => {
        if (e.startSlot === 0 && e.endSlot === 48) busy.offDates.add(e.date);
        else push(busy.instructorByDate, e.date, [e.startSlot, e.endSlot]);
    });

    return busy;
}

/**
 * Only teaching rooms can host a class; offices and lounges cannot.
 * Out-of-service rooms come back too, so a failed search can say whether the
 * room simply does not exist or is sitting there marked Inactive.
 */
async function loadBookableRooms() {
    const [rows] = await pool.execute(
        `SELECT id, room_number, room_type, status FROM rooms
          WHERE room_type IN ('Lecture', 'Laboratory')
          ORDER BY room_type, room_number`
    );
    return rows;
}

/**
 * Why nothing could be booked. "No room available" on its own sends people
 * hunting through their timetable when the real answer is that the one
 * laboratory on record is switched off in admin.
 */
function noRoomMessage(classType, allowedTypes, suitable) {
    const kind = allowedTypes.join(' or ').toLowerCase() + ' room';

    if (!suitable.length) {
        return `There is no ${kind} on record, so this ${classType.toLowerCase()} class ` +
               `cannot be held on campus. Ask your admin to add one, or hold it online.`;
    }

    const names = suitable.map(r => r.room_number).join(', ');
    return `Every ${kind} is out of service (${names}), so there is nowhere to hold this ` +
           `${classType.toLowerCase()} class. Ask your admin to reactivate one, or hold it online.`;
}

function isFree(list, start, end) {
    return !(list || []).some(([s, e]) => overlaps(s, e, start, end));
}

/**
 * Walk the window for the first slot that works. Two passes: the class's usual
 * start time first, so the make-up lands at the hour students already expect,
 * then anything at all that fits.
 */
function findEarliest(ctx) {
    if (Number.isFinite(ctx.preferredStartSlot)) {
        const atUsualTime = scan(ctx, slot => slot === ctx.preferredStartSlot);
        if (atUsualTime) return atUsualTime;
    }
    return scan(ctx, () => true);
}

function scan(ctx, slotAllowed) {
    const { busy, candidates, duration, online,
            minDate, maxDate, dayStartSlot, dayEndSlot, skipDays } = ctx;

    const cursor = new Date(minDate + 'T00:00:00');
    const last = new Date(maxDate + 'T00:00:00');

    while (cursor <= last) {
        const date = toDateKey(cursor);
        const day = dayOfWeek(date);

        if (!skipDays.includes(day) && !busy.offDates.has(date)) {
            for (let start = dayStartSlot; start + duration <= dayEndSlot; start++) {
                if (!slotAllowed(start)) continue;
                const end = start + duration;

                if (!isFree(busy.instructorByDay[day], start, end)) continue;
                if (!isFree(busy.instructorByDate[date], start, end)) continue;
                if (online) return { date, start, end, room: null };

                for (const room of candidates) {
                    if (!isFree(busy.roomByDay[`${room.id}|${day}`], start, end)) continue;
                    if (!isFree(busy.roomByDate[`${room.id}|${date}`], start, end)) continue;
                    return { date, start, end, room };
                }
            }
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    return null;
}

/** Remember a placement so the next suggestion in the batch avoids it. */
function reserve(busy, placed, online) {
    const interval = [placed.start, placed.end];
    (busy.instructorByDate[placed.date] = busy.instructorByDate[placed.date] || []).push(interval);
    if (!online && placed.room) {
        const key = `${placed.room.id}|${placed.date}`;
        (busy.roomByDate[key] = busy.roomByDate[key] || []).push(interval);
    }
}

// ── Write helpers ──────────────────────────────────────────────────────────

/** Shared INSERT so create() and update() cannot drift apart. */
function insertSession(conn, requestId, s) {
    return conn.execute(
        `INSERT INTO makeup_request_schedules
             (request_id, workload_block_id, subject_code, subject_name, section_name,
              class_type, delivery_mode, class_date, day_of_week, start_slot, end_slot, room_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [requestId, s.workloadBlockId || null, s.subjectCode, s.subjectName, s.sectionName,
         s.classType || null, s.deliveryMode, s.classDate, dayOfWeek(s.classDate),
         s.startSlot, s.endSlot, s.deliveryMode === 'online' ? null : (s.roomId || null)]
    );
}

function insertDocument(conn, requestId, d) {
    return conn.execute(
        `INSERT INTO makeup_request_documents
             (id, request_id, kind, file_path, original_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), requestId, d.kind || 'support', d.path,
         d.originalName, d.mimeType || 'application/octet-stream', d.size || 0]
    );
}

/** Add the display fields every view needs, so no view recomputes them. */
function decorate(row) {
    return Object.assign(row, {
        startLabel: slotToLabel(row.start_slot),
        endLabel: slotToLabel(row.end_slot),
        timeLabel: `${slotToLabel(row.start_slot)} – ${slotToLabel(row.end_slot)}`,
    });
}

module.exports = MakeupRequestModel;

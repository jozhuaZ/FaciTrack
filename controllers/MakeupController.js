
const path = require('path');
const crypto = require('crypto');

const pool = require('../configs/db');
const fileStore = require('../services/file-store');

const MakeupRequestModel = require('../models/MakeupRequestModel');
const { expireUndecidedMakeups } = require('../jobs/reminder');
const WorkloadModel = require('../models/WorkloadModel');
const RoomModel = require('../models/RoomModel');
const UserModel = require('../models/UserModel');
const AppointmentModel = require('../models/AppointmentModel');
const NotificationModel = require('../models/NotificationModel');
const AuditLogModel = require('../models/AuditLogModel');
const { notifyUser } = require('../services/notify');
const { buildInstructorUser } = require('../utils/sessionUser');

// How far ahead a make-up may be scheduled, and the hours a generated slot may
// fall in. Read per request so a change in System Settings takes effect without
// a restart; .env still supplies the default.
const appSettings = require('../services/app-settings');

async function makeupWindow() {
    const [weeks, dayStart, dayEnd] = await Promise.all([
        appSettings.get('makeup_max_weeks_ahead'),
        appSettings.get('makeup_day_start'),
        appSettings.get('makeup_day_end'),
    ]);
    return {
        weeks,
        dayStartSlot: MakeupRequestModel.timeToSlot(dayStart),
        dayEndSlot: MakeupRequestModel.timeToSlot(dayEnd),
    };
}

const DELIVERY_MODES = ['in-campus', 'online'];

function toDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tomorrow through the configured number of weeks out. */
async function bookingWindow() {
    const { weeks } = await makeupWindow();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const min = new Date(today);
    min.setDate(today.getDate() + 1);
    const max = new Date(today);
    max.setDate(today.getDate() + weeks * 7);
    const { dayStartSlot, dayEndSlot } = await makeupWindow();
    return { minDate: toDateKey(min), maxDate: toDateKey(max), weeks, dayStartSlot, dayEndSlot };
}

/** Delete an upload we are no longer keeping; never let it break the response. */
function discard(fileKey) {
    if (!fileKey) return;
    // A legacy row holds an absolute path, which is not a key this store will
    // accept. Those few files are left for manual cleanup rather than logged
    // as a failure on every edit.
    if (path.isAbsolute(fileKey)) return;
    fileStore.remove(fileKey).catch(err => {
        console.error('[Makeup] Could not remove upload:', err.message);
    });
}

function discardAll(documents) {
    (documents || []).forEach(d => discard(d.path));
}

/**
 * The uploads on this request, flattened into what the model stores.
 *
 * multer holds them in memory (see routes/instructor.js) and they are written
 * here, because only services/file-store.js knows whether this host has a disk
 * worth writing to.
 *
 * Writing before the request is known to be valid can leave a stored file with
 * no row pointing at it, which is why every failure path below calls
 * discardAll() — the same cleanup the on-disk version already needed.
 *
 * `path` still names the field so the model and discardAll() are unchanged;
 * what it holds is now a storage key rather than a filesystem path.
 */
async function collectUploads(req) {
    const files = req.files || {};
    const take = (list, kind) => (list || []).map(async (f) => {
        const key = `makeup/${crypto.randomUUID()}${path.extname(f.originalname || '.pdf')}`;
        await fileStore.put({
            key,
            buffer: f.buffer,
            mimeType: f.mimetype,
            originalName: f.originalname,
            kind: 'makeup',
        });
        return { kind, path: key, originalName: f.originalname, mimeType: f.mimetype, size: f.size };
    });

    return Promise.all([...take(files.documents, 'support'), ...take(files.polling, 'polling')]);
}

/**
 * Parse the posted sessions into the shape the model wants.
 * Returns { sessions } or { error } — never throws on bad input.
 */
function parseSessions(body, window) {
    const raw = body.sessions;
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!list.length) return { error: 'Add at least one make-up session.' };

    const sessions = [];
    for (const entry of list) {
        const item = typeof entry === 'string' ? safeParse(entry) : entry;
        if (!item) return { error: 'One of the sessions could not be read. Please try again.' };

        const subjectCode = String(item.subjectCode || '').trim();
        const sectionName = String(item.sectionName || '').trim();
        const classDate = String(item.classDate || '').trim();
        const startTime = String(item.startTime || '').trim();
        const endTime = String(item.endTime || '').trim();
        const classType = MakeupRequestModel.normalizeClassType(item.classType);

        // An online class has nowhere else to go, whatever the mode field says
        let deliveryMode = DELIVERY_MODES.includes(item.deliveryMode) ? item.deliveryMode : 'in-campus';
        if (classType === 'Online') deliveryMode = 'online';

        if (!subjectCode || !sectionName) return { error: 'Every session needs a subject and section.' };
        if (!classDate || !startTime || !endTime) return { error: 'Every session needs a date, start and end time.' };
        if (classDate < window.minDate) return { error: `Make-up classes must be scheduled from ${window.minDate} onwards.` };
        if (classDate > window.maxDate) return { error: `Make-up classes must be within ${window.weeks} weeks (on or before ${window.maxDate}).` };

        const startSlot = MakeupRequestModel.timeToSlot(startTime);
        const endSlot = MakeupRequestModel.timeToSlot(endTime);
        if (!Number.isFinite(startSlot) || !Number.isFinite(endSlot) || endSlot <= startSlot) {
            return { error: 'Each session must end after it starts.' };
        }

        const roomId = deliveryMode === 'online' ? null : parseInt(item.roomId, 10) || null;
        if (deliveryMode === 'in-campus' && !roomId) {
            return { error: 'In-campus sessions need a room.' };
        }

        sessions.push({
            workloadBlockId: parseInt(item.workloadBlockId, 10) || null,
            subjectCode,
            subjectName: String(item.subjectName || '').trim() || subjectCode,
            sectionName,
            classType,
            deliveryMode, classDate, startSlot, endSlot, roomId,
        });
    }
    return { sessions };
}

function safeParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
}

/** Two sessions in the same request must not overlap each other either. */
function findSelfOverlap(sessions) {
    for (let i = 0; i < sessions.length; i++) {
        for (let j = i + 1; j < sessions.length; j++) {
            const a = sessions[i], b = sessions[j];
            if (a.classDate !== b.classDate) continue;
            if (a.startSlot < b.endSlot && a.endSlot > b.startSlot) {
                return `Two of your sessions overlap on ${a.classDate}.`;
            }
        }
    }
    return null;
}

function conflictMessage(result) {
    const dateLabel = result.session ? result.session.classDate : 'that slot';
    return `Cannot book ${dateLabel}: ` + result.conflicts.map(c => c.message).join(' ');
}

const MakeupController = {
    /** Instructor's own requests. */
    async renderRequestList(req, res) {
        try {
            // Close off anything the dean never decided in time before showing the
            // list, so it is right even where no timer runs (serverless, no pinger).
            await expireUndecidedMakeups().catch(err =>
                console.error('[Makeup] Expiry sweep failed:', err.message));
            const instructor = buildInstructorUser(req.session);
            const requests = await MakeupRequestModel.getByInstructor(req.session.userId);
            const appts = await AppointmentModel.getAppointmentsByInstructor(req.session.userId);

            const flash = req.session.flash || null;
            delete req.session.flash;

            res.render('pages/instructor/makeup-requests', {
                title: 'FaciTrack - Make-Up Class Requests',
                instructor,
                pendingCount: appts.filter(a => a.status === 'pending').length,
                notifications: await NotificationModel.getForUser(req.session.userId),
                requests,
                counts: {
                    all: requests.length,
                    pending: requests.filter(r => r.status === 'pending').length,
                    approved: requests.filter(r => r.status === 'approved').length,
                    declined: requests.filter(r => r.status === 'declined').length,
                    withdrawn: requests.filter(r => r.status === 'withdrawn').length,
                    expired: requests.filter(r => r.status === 'expired').length,
                },
                flash,
            });
        } catch (err) {
            console.error('[MakeupController.renderRequestList]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /** The submission form, optionally pre-loaded with a request being edited. */
    async renderRequestForm(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);
            const appts = await AppointmentModel.getAppointmentsByInstructor(req.session.userId);

            // The real timetable is the list of classes that can be made up
            const blocks = await WorkloadModel.getBlocksByInstructor(req.session.userId);
            const missedClasses = blocks.map(b => ({
                id: b.id,
                subjectCode: b.subject_code,
                subjectName: b.subject_name,
                sectionName: b.section_name || '',
                classType: MakeupRequestModel.normalizeClassType(b.class_type),
                day: b.day_of_week,
                roomId: b.room_id,
                roomNumber: b.room_number || '',
                startSlot: b.start_slot,
                endSlot: b.end_slot,
                timeLabel: `${MakeupRequestModel.slotToLabel(b.start_slot)} – ${MakeupRequestModel.slotToLabel(b.end_slot)}`,
            }));

            // Only teaching rooms can host a class, so offices and lounges never
            // reach the form. getRooms joins departments and users, hence the
            // qualified column names.
            const allRooms = await RoomModel.getRooms({
                fields: 'r.id, r.room_number, r.room_type',
                filters: { status: 'Active' },
                orderBy: 'room_number',
            });
            const bookable = new Set(
                Object.values(MakeupRequestModel.ROOM_TYPES_FOR_CLASS).flat()
            );
            const rooms = allRooms.filter(r => bookable.has(r.room_type));

            let editing = null;
            if (req.params.id) {
                editing = await MakeupRequestModel.getById(req.params.id);
                if (!editing || editing.instructor_public_id !== req.session.userId) {
                    return res.status(404).render('pages/404', { title: 'Not found' });
                }
                if (editing.status !== 'pending') {
                    req.session.flash = { type: 'error', message: 'Only a pending request can be edited.' };
                    return res.redirect('/instructor/makeup/requests');
                }
            }

            const flash = req.session.flash || null;
            delete req.session.flash;

            res.render('pages/instructor/makeup-request', {
                title: 'FaciTrack - Make-Up Class Request',
                instructor,
                pendingCount: appts.filter(a => a.status === 'pending').length,
                notifications: await NotificationModel.getForUser(req.session.userId),
                missedClasses,
                rooms,
                roomTypesForClass: MakeupRequestModel.ROOM_TYPES_FOR_CLASS,
                window: await bookingWindow(),
                editing,
                flash,
            });
        } catch (err) {
            console.error('[MakeupController.renderRequestForm]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * Suggest a slot for each class being made up.
     * The form calls this instead of making the instructor hunt for a free
     * room and hour themselves — the point of the feature.
     */
    async suggestSlots(req, res) {
        try {
            const raw = Array.isArray(req.body.items) ? req.body.items : [];
            if (!raw.length) {
                return res.status(422).json({ success: false, error: 'Nothing to schedule.' });
            }

            const window = await bookingWindow();
            const wanted = raw.map((item, index) => ({
                key: String(item.key || index),
                classType: item.classType,
                deliveryMode: item.deliveryMode,
                durationSlots: parseInt(item.durationSlots, 10) || 2,
                preferredRoomId: item.preferredRoomId || null,
                preferredStartSlot: item.preferredStartSlot,
            }));

            // Slots the form is already holding, so a re-roll avoids its siblings
            const occupied = (Array.isArray(req.body.occupied) ? req.body.occupied : [])
                .map(o => ({
                    classDate: String(o.classDate || '').slice(0, 10),
                    startSlot: parseInt(o.startSlot, 10),
                    endSlot: parseInt(o.endSlot, 10),
                    roomId: parseInt(o.roomId, 10) || null,
                }))
                .filter(o => o.classDate && Number.isFinite(o.startSlot) && Number.isFinite(o.endSlot));

            const result = await MakeupRequestModel.suggestSlots(req.session.userId, wanted, {
                minDate: window.minDate,
                maxDate: window.maxDate,
                dayStartSlot: window.dayStartSlot,
                dayEndSlot: window.dayEndSlot,
                ignoreRequestId: req.body.editingRequestId || null,
                occupied,
            });

            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Your account could not be found.' });
            }
            res.json({ success: true, results: result.results, window });
        } catch (err) {
            console.error('[MakeupController.suggestSlots]', err);
            res.status(500).json({ success: false, error: 'Could not generate a schedule.' });
        }
    },

    /** Create a request, or replace a pending one when `id` is present. */
    async submitRequest(req, res) {
        const isEdit = Boolean(req.params.id);
        const uploads = await collectUploads(req);
        try {
            const window = await bookingWindow();
            const support = uploads.filter(d => d.kind === 'support');

            if (!isEdit && !support.length) {
                discardAll(uploads);
                return fail(req, res, 'At least one supporting PDF is required.');
            }

            const parsed = parseSessions(req.body, window);
            if (parsed.error) {
                discardAll(uploads);
                return fail(req, res, parsed.error);
            }
            const overlap = findSelfOverlap(parsed.sessions);
            if (overlap) {
                discardAll(uploads);
                return fail(req, res, overlap);
            }

            const payload = {
                reason: String(req.body.reason || '').trim(),
                sessions: parsed.sessions,
                documents: uploads,
            };

            let result;
            if (isEdit) {
                payload.removeDocumentIds = await removalList(req, uploads);
                result = await MakeupRequestModel.update(req.params.id, req.session.userId, payload);
            } else {
                result = await MakeupRequestModel.create(req.session.userId, payload);
            }

            if (!result.success) {
                discardAll(uploads);
                const messages = {
                    NOT_FOUND: 'That request no longer exists.',
                    NOT_PENDING: 'Only a pending request can be edited.',
                    NO_DOCUMENT: 'A request needs at least one supporting PDF.',
                    INSTRUCTOR_NOT_FOUND: 'Your account could not be found.',
                };
                return fail(req, res, result.reason === 'CONFLICT'
                    ? conflictMessage(result)
                    : (messages[result.reason] || 'Could not save the request.'));
            }

            // Replaced files are only safe to delete once the write committed
            (result.removedPaths || []).forEach(discard);

            const requestId = isEdit ? req.params.id : result.id;
            await MakeupController.notifyDean(req, requestId, isEdit ? 'updated' : 'submitted');

            try {
                const me = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(me.internal_id, me.role,
                    isEdit ? 'Updated make-up request' : 'Submitted make-up request', 'makeup');
            } catch (err) {
                console.error('[AuditLog] Failed to log make-up request:', err);
            }

            req.session.flash = {
                type: 'success',
                message: isEdit
                    ? 'Your make-up request was updated and the dean has been notified.'
                    : `Your make-up request (${parsed.sessions.length} session(s)) was sent for dean review.`,
            };
            res.redirect('/instructor/makeup/requests');
        } catch (err) {
            console.error('[MakeupController.submitRequest]', err);
            discardAll(uploads);
            fail(req, res, 'Something went wrong while saving the request.');
        }
    },

    async withdrawRequest(req, res) {
        try {
            const ok = await MakeupRequestModel.withdraw(req.params.id, req.session.userId);
            if (!ok) {
                return res.status(409).json({ success: false, error: 'Only a pending request can be withdrawn.' });
            }

            await MakeupController.notifyDean(req, req.params.id, 'withdrawn');

            try {
                const me = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(me.internal_id, me.role, 'Withdrew make-up request', 'makeup');
            } catch (err) {
                console.error('[AuditLog] Failed to log withdrawal:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[MakeupController.withdrawRequest]', err);
            res.status(500).json({ success: false, error: 'Failed to withdraw the request.' });
        }
    },

    /** Tell the department's dean that the queue changed. */
    async notifyDean(req, requestId, verb) {
        try {
            const me = await UserModel.getUserByPublicId(req.session.userId);
            if (!me || !me.department_id) return;

            const deans = await UserModel.getUsers({
                role: 'Dean',
                fields: 'id, department_id',
            });
            const target = (deans || []).filter(d => String(d.department_id) === String(me.department_id));

            const message = `${me.first_name} ${me.last_name} ${verb} a make-up class request.`;
            for (const dean of target) {
                await notifyUser(dean.id, 'makeup', message, null, {
                    pushTitle: 'Make-up class request',
                });
            }
        } catch (err) {
            // A notification must never sink a request that already saved
            console.error('[Makeup] Could not notify the dean:', err.message);
        }
    },

    /** Stream one attachment. Never served from public/ — this route is the gate. */
    async downloadDocument(req, res) {
        try {
            const doc = await MakeupRequestModel.getDocument(req.params.docId);
            if (!doc) return res.status(404).send('Document not found.');

            const isOwner = doc.instructor_public_id === req.session.userId;
            const isDean = req.session.role === 'Dean';
            if (!isOwner && !isDean) return res.status(403).send('Not authorised.');

            if (isDean && !isOwner) {
                const dean = await UserModel.getUserByPublicId(req.session.userId);
                if (String(dean.department_id) !== String(doc.department_id)) {
                    return res.status(403).send('Not authorised.');
                }
            }

            // Rows written before uploads moved into the file store hold an
            // absolute path rather than a key; on a host that still has the
            // file, serving it beats telling an instructor their document is
            // gone. Nothing new is written in that shape.
            const file = path.isAbsolute(doc.file_path || '')
                ? await fileStore.getLegacyPath(doc.file_path)
                : await fileStore.get(doc.file_path);

            if (!file) {
                return res.status(404).send('That document is no longer available.');
            }

            // A spreadsheet has no inline viewer, so let the browser download it
            const inline = doc.mime_type === 'application/pdf';
            res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
            res.setHeader('Content-Disposition',
                `${inline ? 'inline' : 'attachment'}; filename="${path.basename(doc.original_name || 'document')}"`);
            res.setHeader('Content-Length', file.buffer.length);
            res.end(file.buffer);
        } catch (err) {
            console.error('[MakeupController.downloadDocument]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * Check one proposed session without saving anything. The form calls this
     * as the instructor picks a date, time and room.
     */
    async checkConflicts(req, res) {
        const conn = await pool.getConnection();
        try {
            const window = await bookingWindow();
            const parsed = parseSessions({ sessions: [req.body] }, window);
            if (parsed.error) return res.json({ success: true, conflicts: [], note: parsed.error });

            const [[me]] = await conn.execute(
                'SELECT id FROM users WHERE public_id = ?', [req.session.userId]
            );
            if (!me) return res.status(404).json({ success: false, error: 'Account not found.' });

            const conflicts = await MakeupRequestModel.findConflicts(
                conn, me.id, parsed.sessions[0],
                { ignoreRequestId: req.body.editingRequestId || null }
            );
            res.json({ success: true, conflicts });
        } catch (err) {
            console.error('[MakeupController.checkConflicts]', err);
            res.status(500).json({ success: false, error: 'Could not check availability.' });
        } finally {
            conn.release();
        }
    },

    // ── Dean side ──────────────────────────────────────────────────────────

    async renderDeanQueue(req, res) {
        try {
            // Close off anything the dean never decided in time before showing the
            // list, so it is right even where no timer runs (serverless, no pinger).
            await expireUndecidedMakeups().catch(err =>
                console.error('[Makeup] Expiry sweep failed:', err.message));
            const dean = buildInstructorUser(req.session);
            const requests = await MakeupRequestModel.getByDepartment(req.session.userId);
            const pending = requests.filter(r => r.status === 'pending');

            const flash = req.session.flash || null;
            delete req.session.flash;

            res.render('pages/dean/makeup-requests', {
                title: 'FaciTrack - Make-Up Requests',
                dean,
                notifications: await NotificationModel.getForUser(req.session.userId),
                pending,
                approved: requests.filter(r => r.status === 'approved'),
                declined: requests.filter(r => r.status === 'declined'),
                expired: requests.filter(r => r.status === 'expired'),
                pendingMakeupCount: pending.length,
                flash,
            });
        } catch (err) {
            console.error('[MakeupController.renderDeanQueue]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async decide(req, res) {
        try {
            const approve = req.body.decision === 'approve';
            const declineReason = String(req.body.declineReason || '').trim();
            const statement = String(req.body.statement || '').trim();

            if (!approve && !declineReason) {
                return res.status(422).json({ success: false, error: 'A reason is required when declining.' });
            }
            if (approve && req.body.confirmed !== true && req.body.confirmed !== 'true') {
                return res.status(422).json({ success: false, error: 'Please confirm the approval.' });
            }

            const result = await MakeupRequestModel.decide(req.params.id, req.session.userId, {
                approve, statement, declineReason,
            });

            if (!result.success) {
                return res.status(result.reason === 'CONFLICT' ? 409 : 400).json({
                    success: false,
                    error: decisionError(result),
                });
            }

            await MakeupController.notifyDecision(req.params.id, result.instructorInternalId,
                { approve, statement, declineReason });
            await MakeupController.logDecision(req, approve);

            res.json({ success: true });
        } catch (err) {
            console.error('[MakeupController.decide]', err);
            res.status(500).json({ success: false, error: 'Failed to record the decision.' });
        }
    },

    /**
     * Approve everything still pending in the dean's department.
     *
     * Each request goes through the same decide() path as a single approval, so
     * the paperwork check and the conflict re-check both run again. Approvals
     * commit one at a time, which means a later request in the batch sees the
     * rooms the earlier ones just took. Anything that fails is skipped and
     * reported rather than aborting the run.
     */
    async approveAll(req, res) {
        try {
            const statement = String(req.body.statement || '').trim();
            const pending = await MakeupRequestModel.getByDepartment(req.session.userId,
                { status: 'pending' });

            if (!pending.length) {
                return res.json({ success: true, approved: 0, skipped: [], total: 0 });
            }

            const skipped = [];
            let approved = 0;

            for (const request of pending) {
                const who = `${request.first_name} ${request.last_name}`;

                // Cheaper than a transaction, and catches a file deleted off disk
                const missing = request.supportDocuments.length === 0;
                if (missing) {
                    skipped.push({ id: request.id, instructor: who, reason: 'No supporting document attached.' });
                    continue;
                }

                const result = await MakeupRequestModel.decide(request.id, req.session.userId,
                    { approve: true, statement });

                if (!result.success) {
                    skipped.push({ id: request.id, instructor: who, reason: decisionError(result) });
                    continue;
                }

                approved++;
                await MakeupController.notifyDecision(request.id, result.instructorInternalId,
                    { approve: true, statement });
            }

            if (approved) await MakeupController.logDecision(req, true, approved);

            res.json({ success: true, total: pending.length, approved, skipped });
        } catch (err) {
            console.error('[MakeupController.approveAll]', err);
            res.status(500).json({ success: false, error: 'Failed to approve the queue.' });
        }
    },

    /** Tell the instructor what the dean decided, in-app, on their device and by email. */
    async notifyDecision(requestId, instructorInternalId, { approve, statement, declineReason }) {
        try {
            const request = await MakeupRequestModel.getById(requestId);
            if (!request) return;

            const subjects = request.sessions.map(s => s.subject_code).join(', ');
            await notifyUser(
                instructorInternalId,
                'makeup',
                approve
                    ? `Your make-up class request for ${subjects} was approved.`
                    : `Your make-up class request for ${subjects} was declined.`,
                null,
                {
                    pushTitle: approve ? 'Make-up approved' : 'Make-up declined',
                    email: {
                        heading: approve ? 'Make-up class approved' : 'Make-up class declined',
                        status: approve ? 'approved' : 'declined',
                        details: request.sessions.map(s => ({
                            label: `${s.subject_code} · ${s.section_name}`,
                            value: `${String(s.class_date).slice(0, 10)} · ${s.timeLabel}` +
                                   (s.room_number ? ` · ${s.room_number}` : ' · Online'),
                        })).concat(approve
                            ? (statement ? [{ label: 'Dean', value: statement }] : [])
                            : [{ label: 'Reason', value: declineReason }]),
                    },
                }
            );
        } catch (err) {
            console.error('[Makeup] Could not notify the instructor:', err.message);
        }
    },

    async logDecision(req, approve, count = 1) {
        try {
            const me = await UserModel.getUserByPublicId(req.session.userId);
            const what = approve ? 'Approved' : 'Declined';
            await AuditLogModel.log(me.internal_id, me.role,
                `${what} ${count > 1 ? count + ' make-up requests' : 'make-up request'}`, 'makeup');
        } catch (err) {
            console.error('[AuditLog] Failed to log decision:', err);
        }
    },
};

/** Turn a model refusal into something the dean can act on. */
function decisionError(result) {
    const messages = {
        NOT_FOUND: 'That request no longer exists.',
        ALREADY_DECIDED: 'This request has already been actioned.',
        OTHER_DEPARTMENT: 'That request belongs to another department.',
        NO_DOCUMENT: 'The instructor has not attached a supporting document.',
        DEAN_NOT_FOUND: 'Your account could not be found.',
    };
    if (result.reason === 'CONFLICT') {
        return conflictMessage(result) + ' The schedule changed since this was filed.';
    }
    return messages[result.reason] || 'Could not record the decision.';
}

/**
 * Which existing documents an edit drops. A replacement polling sheet also
 * retires the old one — the request only ever carries a single poll.
 */
async function removalList(req, uploads) {
    const raw = req.body.removeDocuments;
    const ids = (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map(String).filter(Boolean);

    if (uploads.some(d => d.kind === 'polling')) {
        const existing = await MakeupRequestModel.getById(req.params.id);
        if (existing && existing.pollingDocument) ids.push(String(existing.pollingDocument.id));
    }
    return Array.from(new Set(ids));
}

/** Send the instructor back to the form with a message rather than a stack trace. */
function fail(req, res, message) {
    req.session.flash = { type: 'error', message };
    res.redirect(req.params.id
        ? `/instructor/makeup/request/${req.params.id}/edit`
        : '/instructor/makeup/request');
}

module.exports = MakeupController;

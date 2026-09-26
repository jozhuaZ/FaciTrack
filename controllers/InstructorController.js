const pool = require('../configs/db');
const ConsultationModel = require('../models/ConsultationModel');
const AppointmentModel = require('../models/AppointmentModel');
const UserModel = require('../models/UserModel');
const AuditLogModel = require('../models/AuditLogModel');
const NotificationModel = require('../models/NotificationModel');
const InstructorSettingsModel = require('../models/InstructorSettingsModel');
const GoogleAccountModel = require('../models/GoogleAccountModel');
const CalendarModel = require('../models/CalendarModel');
const bcrypt = require('bcryptjs');
const { to12Hour, formatFullDate } = require('../utils/timeFormat');
const { buildInstructorUser } = require('../utils/sessionUser');

// Must mirror the users.availability_status enum
const AVAILABILITY_STATUSES = ['available', 'dnd', 'travel', 'leave', 'meeting'];

/**
 * How far ahead an appointment may be rescheduled: from today to the end of
 * the week two weeks after the current one. Anything further out is almost
 * certainly a mistake, and it keeps the picker to three readable weeks.
 */
const RESCHEDULE_WEEKS_AHEAD = 2;

function getRescheduleWindow() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());

    const end = new Date(weekStart);
    end.setDate(weekStart.getDate() + 6 + RESCHEDULE_WEEKS_AHEAD * 7);

    const toKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { minDate: toKey(today), maxDate: toKey(end) };
}

/** Sunday-start week containing today, as 'YYYY-MM-DD' date keys (inclusive). */
function getCurrentWeekRange() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - today.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);

    const toKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { startKey: toKey(start), endKey: toKey(end) };
}

/**
 * One slot, four states: closed by the instructor, booked-and-awaiting
 * approval, booked-and-confirmed, or open. Distinct from the raw
 * consultation_hours.status column, which doesn't know about the appointment.
 */
function computeSlotDisplayStatus(sub) {
    if (sub.status === 'closed') return 'closed';
    if (sub.appointmentStatus === 'pending') return 'pending';
    if (sub.appointmentStatus === 'confirmed') return 'confirmed';
    return 'available';
}

function computeDuration(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return `${mins} min`;
}

function computeDurationMinutes(startTime, endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
}

/** Shape an appointment row for the dashboard and appointments views. */
function mapAppointmentRow(row) {
    return {
        id: row.id,
        status: row.status,
        firstName: row.student_first_name,
        lastName: row.student_last_name,
        studentName: `${row.student_last_name}, ${row.student_first_name}`,
        studentId: row.student_number,
        topic: row.topic,
        mode: row.mode,
        meetingLink: row.meeting_link || null,
        date: row.consultation_date,
        dayOfWeek: row.day_of_the_week,
        time: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
        // Local wall-clock end, so the page can tell which consultations have
        // finished without re-deriving it from the formatted time string
        endsAt: `${row.consultation_date}T${row.end_time}`,
        duration: computeDuration(row.start_time, row.end_time),
        roomNumber: row.room_number,
        buildingName: row.building_name,
        notes: row.notes,
        sectionGroupName: row.section_group_name,
        courseSubject: row.course_subject,
        email: row.email,
        createdAt: row.created_at,
    };
}

const InstructorController = {

    async renderConsultationPage(req, res) {
        try {
            const instructorId = req.session.userId;

            const instructor = buildInstructorUser(req.session);

            const grouped = await ConsultationModel.getSlotsByInstructorGrouped(instructorId);

            const consultationSlots = [];
            grouped.forEach(group => {
                group.subSlots.forEach(sub => {
                    consultationSlots.push({
                        id: sub.id,
                        day: group.day,
                        date: group.date,
                        timeStart: sub.timeStart,
                        timeEnd: sub.timeEnd,
                        status: sub.status,
                        isBooked: sub.isBooked,
                        // The schedule page opens this booking directly rather
                        // than dropping the instructor on the appointments list
                        // to hunt for it.
                        appointmentId: sub.appointmentId,
                        maxCapacity: group.subSlots.length,
                        bookedCount: group.subSlots.filter(s => s.isBooked).length,
                    });
                });
            });

            const scheduleSettings = await InstructorSettingsModel.getByPublicId(instructorId);

            res.render('pages/instructor/schedule', {
                title: 'FaciTrack - Consultation Schedule',
                instructor: instructor,
                consultationSlots: consultationSlots,
                scheduleSettings,
            });
        } catch (err) {
            console.error('[InstructorController.renderConsultationPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async saveSlotBlock(req, res) {
        try {
            const { date, day, timeStart, timeEnd, maxCapacity, repeat, replaceSlotId } = req.body;

            // The Add Slot modal no longer asks how many weeks — the instructor's
            // saved default decides. Editing an existing slot never repeats.
            const settings = await InstructorSettingsModel.getByPublicId(req.session.userId);
            const editing = Boolean(replaceSlotId);
            const repeatWeeks = (!editing && repeat && settings.repeatWeekly) ? settings.repeatWeeks : 1;

            const result = await ConsultationModel.saveSlotBlock(req.session.userId, {
                date, day, timeStart, timeEnd,
                maxCapacity: parseInt(maxCapacity, 10) || 1,
                repeatWeeks,
                replaceSlotId: editing ? parseInt(replaceSlotId, 10) : null,
            });

            // Refusals keep the { error: { message } } shape the page already reads.
            if (result.conflict) {
                const { date: on, start, end } = result.conflict;
                return res.status(409).json({ success: false, error: {
                    message: `That time overlaps your existing ${to12Hour(start)}–${to12Hour(end)} slot on ${formatFullDate(on)}. `
                        + 'Pick a time that starts when that one ends, or edit that slot instead.',
                } });
            }
            if (result.error === 'ACTIVE_APPOINTMENT') {
                return res.status(409).json({ success: false, error: {
                    message: 'This slot has an active appointment, so it can\'t be changed. '
                        + 'Complete or cancel the appointment first.',
                } });
            }
            if (result.error === 'NOT_FOUND') {
                return res.status(404).json({ success: false, error: { message: 'That slot no longer exists. Reload and try again.' } });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Saved consultation slot', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log consultation slot:', err);
            }

            let message = `Saved ${result.count} slot(s) across ${repeatWeeks - result.skipped.length} week(s).`;
            if (result.skipped.length) {
                message += ` Skipped ${result.skipped.length} week(s) that overlapped an existing slot: `
                    + result.skipped.map(formatFullDate).join(', ') + '.';
            }
            res.json({ success: true, message, skipped: result.skipped });
        } catch (err) {
            console.error('[InstructorController.saveSlotBlock]', err);
            res.status(500).json({ success: false, error: { message: err.message } });
        }
    },

    async deleteSlot(req, res) {
        try {
            const slotId = parseInt(req.params.slotId, 10);
            const result = await ConsultationModel.deleteSlot(req.session.userId, slotId);

            if (!result.success) {
                const message = result.reason === 'ACTIVE_APPOINTMENT'
                    ? 'This slot has an active appointment and cannot be deleted.'
                    : 'Slot not found or could not be deleted.';
                return res.status(409).json({ success: false, error: message });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Deleted consultation slot', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log consultation slot:', err);
            }

            res.json({
                success: true,
                softClosed: result.softClosed,
                message: result.softClosed
                    ? 'Slot closed (kept for appointment history).'
                    : 'Slot deleted.',
            });
        } catch (err) {
            console.error('[InstructorController.deleteSlot]', err);
            res.status(500).json({ success: false, error: 'Failed to delete slot.' });
        }
    },

    async getUnavailability(req, res) {
        try {
            const dates = await ConsultationModel.getUnavailability(req.session.userId);
            res.json({ success: true, unavailableDates: dates });
        } catch (err) {
            console.error('[InstructorController.getUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to load unavailability.' });
        }
    },

    /**
     * Block a full day or an inclusive date range.
     * Affected appointments are returned rather than cancelled outright — the
     * instructor decides per appointment whether to reschedule or cancel.
     */
    async setUnavailability(req, res) {
        try {
            const { reason } = req.body;
            // `date` is the legacy single-day field; startDate/endDate supersede it
            const startDate = req.body.startDate || req.body.date;
            const endDate = req.body.endDate || startDate;

            if (!startDate) {
                return res.status(400).json({ success: false, error: 'A start date is required.' });
            }

            const today = new Date(); today.setHours(0, 0, 0, 0);
            if (new Date(startDate + 'T00:00:00') <= today) {
                return res.status(422).json({
                    success: false,
                    error: 'Cannot mark today or a past date as unavailable.'
                });
            }
            if (endDate < startDate) {
                return res.status(422).json({
                    success: false,
                    error: 'The end date cannot be earlier than the start date.'
                });
            }

            const affected = await ConsultationModel.getAffectedAppointments(
                req.session.userId, startDate, endDate
            );

            const blockedDates = await ConsultationModel.setUnavailabilityRange(
                req.session.userId, startDate, endDate, reason
            );

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Set unavailable date', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log unavailability:', err);
            }

            res.json({
                success: true,
                startDate,
                endDate,
                blockedDates,
                reason: reason || null,
                affected,
                affectedCount: affected.length,
            });
        } catch (err) {
            console.error('[InstructorController.setUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to set unavailability.' });
        }
    },

    /**
     * Cancel every appointment left over in a blocked range, notifying students.
     * Used by the "Cancel all remaining" action in the unavailability modal.
     */
    async cancelAffectedAppointments(req, res) {
        try {
            const { startDate, endDate, reason } = req.body;
            if (!startDate) {
                return res.status(400).json({ success: false, error: 'A start date is required.' });
            }

            const cancelled = await ConsultationModel.cancelAppointmentsInRange(
                req.session.userId,
                startDate,
                endDate || startDate,
                reason || 'Instructor unavailable on this date'
            );

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Cancelled appointments on blocked date', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log cancellation:', err);
            }

            res.json({ success: true, cancelledCount: cancelled.length });
        } catch (err) {
            console.error('[InstructorController.cancelAffectedAppointments]', err);
            res.status(500).json({ success: false, error: 'Failed to cancel appointments.' });
        }
    },

    async checkUnavailability(req, res) {
        try {
            const { date } = req.params;
            const count = await ConsultationModel.checkAppointmentsOnDate(req.session.userId, date);
            res.json({ success: true, count });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to check.' });
        }
    },

    /**
     * Undo a block that was just made. Blocking only writes rows to
     * instructor_unavailability, so removing them restores the range exactly.
     */
    async removeUnavailabilityRange(req, res) {
        try {
            const { startDate, endDate } = req.body;
            if (!startDate) {
                return res.status(400).json({ success: false, error: 'A start date is required.' });
            }

            await ConsultationModel.removeUnavailability(
                req.session.userId, startDate, endDate || startDate
            );

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    'Undid unavailable dates', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log unavailability undo:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.removeUnavailabilityRange]', err);
            res.status(500).json({ success: false, error: 'Failed to undo the block.' });
        }
    },

    async removeUnavailability(req, res) {
        try {
            const { date } = req.params;
            await ConsultationModel.removeUnavailability(req.session.userId, date);
            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Removed unavailable date', 'consultation slot');
            } catch (err) {
                console.error('[AuditLog] Failed to log unavailability:', err);
            }
            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.removeUnavailability]', err);
            res.status(500).json({ success: false, error: 'Failed to remove block.' });
        }
    },

    /**
     * Instructor sets their own availability. Booking is gated on this value
     * in StudentController, so it must stay within the column's enum.
     */
    async updateAvailabilityStatus(req, res) {
        try {
            const { status } = req.body;

            if (!AVAILABILITY_STATUSES.includes(status)) {
                return res.status(422).json({
                    success: false,
                    error: `Status must be one of: ${AVAILABILITY_STATUSES.join(', ')}.`,
                });
            }

            const updated = await UserModel.updateAvailabilityStatus(req.session.userId, status);
            if (!updated) {
                return res.status(404).json({ success: false, error: 'Instructor not found.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(
                    instructor.internal_id, instructor.role,
                    `Set availability to ${status}`, 'status'
                );
            } catch (err) {
                console.error('[AuditLog] Failed to log status change:', err);
            }

            res.json({ success: true, status });
        } catch (err) {
            console.error('[InstructorController.updateAvailabilityStatus]', err);
            res.status(500).json({ success: false, error: 'Failed to update status.' });
        }
    },

    /**
     * Instructor landing page: today's consultations, pending requests,
     * and the upcoming slot list — all from the database.
     */
    async renderSettingsPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);
            const me = await UserModel.getUserByPublicId(req.session.userId);

            // The sidebar badge needs the live pending count
            const appts = await AppointmentModel.getAppointmentsByInstructor(req.session.userId);
            const pendingCount = appts.filter(a => a.status === 'pending').length;

            instructor.availabilityStatus = me?.availability_status || 'available';
            instructor.defaultMeetingLink = me?.default_meeting_link || '';
            instructor.middleName = me?.middle_name || '';
            // Prefer the stored photo over the session copy: the row is already
            // loaded here, and an admin changing it should not wait for a
            // re-login to become visible.
            if (me) instructor.profilePhoto = me.profile_picture || null;

            const settings = await InstructorSettingsModel.getByPublicId(req.session.userId);
            const googleCalendar = await GoogleAccountModel.statusForPublicId(req.session.userId);
            // The same connection also reads the instructor's own events back,
            // so the card shows one state for both halves.
            googleCalendar.sync = googleCalendar.connected
                ? await CalendarModel.getGoogleConnection(req.session.userId)
                : null;

            res.render('pages/instructor/settings', {
                title: 'FaciTrack - Settings',
                instructor,
                pendingCount,
                settings,
                googleCalendar,
                // Result of a round-trip to Google's consent screen, so the
                // page can say what happened instead of silently reloading.
                googleNotice: req.query.googleConnected ? 'connected' : (req.query.googleError || null),
            });
        } catch (err) {
            console.error('[InstructorController.renderSettingsPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    /**
     * Instructor edits their own name. Email is deliberately not accepted —
     * it is the sign-in identity Google OAuth matches on, so only an admin
     * may change it.
     */
    async updateOwnProfile(req, res) {
        try {
            const firstName  = String(req.body.firstName  || '').trim();
            const middleName = String(req.body.middleName || '').trim();
            const lastName   = String(req.body.lastName   || '').trim();

            if (!firstName || !lastName) {
                return res.status(422).json({
                    success: false,
                    error: 'First name and last name are required.',
                });
            }

            const updated = await UserModel.updateOwnProfile(req.session.userId, {
                firstName, middleName, lastName,
            });
            if (!updated) {
                return res.status(404).json({ success: false, error: 'Instructor not found.' });
            }

            // Keep the session in step so the sidebar updates without a re-login
            req.session.firstName  = firstName;
            req.session.middleName = middleName;
            req.session.lastName   = lastName;
            req.session.name       = `${firstName} ${lastName}`;

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    'Updated own profile', 'settings');
            } catch (err) {
                console.error('[AuditLog] Failed to log profile update:', err);
            }

            res.json({ success: true, name: req.session.name });
        } catch (err) {
            console.error('[InstructorController.updateOwnProfile]', err);
            res.status(500).json({ success: false, error: 'Failed to update profile.' });
        }
    },

    /**
     * Which updates reach the instructor by email and on their devices.
     * The in-app bell is intentionally not gated — an unanswered appointment
     * still needs a decision even when its alerts are muted.
     */
    async updateNotificationPrefs(req, res) {
        try {
            const saved = await InstructorSettingsModel.saveNotificationPrefs(req.session.userId, {
                notifyNewRequests:   Boolean(req.body.notifyNewRequests),
                notifyCancellations: Boolean(req.body.notifyCancellations),
                notifyReminders:     Boolean(req.body.notifyReminders),
                notifyBleAbsence:    Boolean(req.body.notifyBleAbsence),
                notifyAnnouncements: Boolean(req.body.notifyAnnouncements),
            });
            if (!saved) {
                return res.status(404).json({ success: false, error: 'Instructor not found.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    'Updated notification preferences', 'settings');
            } catch (err) {
                console.error('[AuditLog] Failed to log notification prefs:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.updateNotificationPrefs]', err);
            res.status(500).json({ success: false, error: 'Failed to save preferences.' });
        }
    },

    /**
     * Defaults applied when a new consultation slot is created. Holding them
     * here is what lets the Add Slot modal drop its own repeat controls.
     */
    async updateScheduleSettings(req, res) {
        try {
            const repeatWeekly = Boolean(req.body.repeatWeekly);
            const repeatWeeks  = parseInt(req.body.repeatWeeks, 10);

            if (repeatWeekly && (!Number.isFinite(repeatWeeks) || repeatWeeks < 2 || repeatWeeks > 52)) {
                return res.status(422).json({
                    success: false,
                    error: 'Repeat between 2 and 52 weeks.',
                });
            }

            const saved = await InstructorSettingsModel.saveScheduleSettings(req.session.userId, {
                repeatWeekly, repeatWeeks,
            });
            if (!saved) {
                return res.status(404).json({ success: false, error: 'Instructor not found.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    repeatWeekly
                        ? `Set new slots to repeat for ${repeatWeeks} week(s)`
                        : 'Turned off weekly repeat for new slots',
                    'settings');
            } catch (err) {
                console.error('[AuditLog] Failed to log schedule settings:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.updateScheduleSettings]', err);
            res.status(500).json({ success: false, error: 'Failed to save schedule settings.' });
        }
    },

    /** Password change from Settings — requires the current password. */
    async changePassword(req, res) {
        try {
            const { currentPassword, newPassword } = req.body;

            if (!currentPassword || !newPassword) {
                return res.status(422).json({ success: false, error: 'All password fields are required.' });
            }
            if (String(newPassword).length < 8) {
                return res.status(422).json({ success: false, error: 'New password must be at least 8 characters.' });
            }

            const hash = await UserModel.getPasswordHash(req.session.userId);
            if (!hash) {
                // Google-provisioned accounts have no password to compare against
                return res.status(409).json({
                    success: false,
                    error: 'This account signs in with Google and has no password to change.',
                });
            }

            const match = await bcrypt.compare(currentPassword, hash);
            if (!match) {
                return res.status(401).json({ success: false, error: 'Your current password is incorrect.' });
            }

            await UserModel.updatePassword(req.session.userId, newPassword);

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    'Changed password', 'security');
            } catch (err) {
                console.error('[AuditLog] Failed to log password change:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.changePassword]', err);
            res.status(500).json({ success: false, error: 'Failed to change password.' });
        }
    },

    /** Instructor saves the personal meeting room reused for online consultations. */
    async updateDefaultMeetingLink(req, res) {
        try {
            const link = String(req.body.meetingLink || '').trim();

            if (link && !/^https:\/\/\S+$/i.test(link)) {
                return res.status(422).json({
                    success: false,
                    error: 'Enter a full https:// link, e.g. https://meet.google.com/abc-defg-hij',
                });
            }

            await UserModel.updateDefaultMeetingLink(req.session.userId, link);

            // Online consultations already booked have been waiting for this —
            // attach it now and tell each student it is ready.
            let backfilled = 0;
            if (link) {
                const affected = await AppointmentModel.attachMeetingLinkToPending(req.session.userId, link);
                backfilled = affected.length;
                for (const apt of affected) {
                    await NotificationModel.create(
                        apt.student_id,
                        'approved',
                        `Your instructor added the meeting link for your online consultation.`,
                        apt.id
                    );
                }
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    link ? 'Updated meeting link' : 'Cleared meeting link', 'settings');
            } catch (err) {
                console.error('[AuditLog] Failed to log meeting link:', err);
            }

            res.json({ success: true, meetingLink: link || null, backfilled });
        } catch (err) {
            console.error('[InstructorController.updateDefaultMeetingLink]', err);
            res.status(500).json({ success: false, error: 'Failed to save the meeting link.' });
        }
    },

    /** Instructor overrides the consultation mode the student chose. */
    async updateAppointmentMode(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const { mode } = req.body;

            if (!['Face-to-Face', 'Online'].includes(mode)) {
                return res.status(422).json({ success: false, error: 'Mode must be Face-to-Face or Online.' });
            }

            let meetingLink = String(req.body.meetingLink || '').trim();

            // Fall back to the instructor's saved room when none was supplied
            if (mode === 'Online' && !meetingLink) {
                const me = await UserModel.getUserByPublicId(req.session.userId);
                meetingLink = me?.default_meeting_link || '';
            }

            const result = await AppointmentModel.updateMode(
                appointmentId, req.session.userId, mode, meetingLink
            );

            if (!result.success) {
                const messages = {
                    NOT_FOUND_OR_RESOLVED: 'Appointment not found or already resolved.',
                    NO_ROOM_AVAILABLE: 'All consultation rooms are full for that time.',
                    MEETING_LINK_REQUIRED: 'Add a meeting link, or save a default one in Settings.',
                };
                return res.status(409).json({ success: false, reason: result.reason, error: messages[result.reason] || 'Failed to update the mode.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role,
                    `Set consultation mode to ${mode}`, 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log mode change:', err);
            }

            res.json(result);
        } catch (err) {
            console.error('[InstructorController.updateAppointmentMode]', err);
            res.status(500).json({ success: false, error: 'Failed to update the consultation mode.' });
        }
    },

    /** Close out a consultation. Refused until the slot has actually ended. */
    async completeAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const result = await AppointmentModel.completeAppointment(appointmentId, req.session.userId);

            if (!result.success) {
                const messages = {
                    NOT_FOUND: 'Appointment not found.',
                    ALREADY_COMPLETED: 'This consultation is already marked complete.',
                    NOT_CONFIRMED: 'Only confirmed consultations can be completed.',
                    NOT_YET_ENDED: 'You can mark this complete once the consultation has ended.',
                };
                const code = result.reason === 'NOT_FOUND' ? 404 : 409;
                return res.status(code).json({ success: false, reason: result.reason, error: messages[result.reason] || 'Failed to complete.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(req.session.userId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Completed consultation', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log completion:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.completeAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to complete the consultation.' });
        }
    },

    async renderDashboardPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);
            const instructorPublicId = req.session.userId;

            const [rawAppointments, grouped, me] = await Promise.all([
                AppointmentModel.getAppointmentsByInstructor(instructorPublicId),
                ConsultationModel.getSlotsByInstructorGrouped(instructorPublicId),
                UserModel.getUserByPublicId(instructorPublicId),
            ]);

            // Reflect the stored status so the selector isn't reset on every load
            instructor.availabilityStatus = me?.availability_status || 'available';

            const appointments = rawAppointments.map(mapAppointmentRow);

            // The dashboard renders one row per sub-slot, flattened out of the day
            // groups, capped to the current week — next week's slots belong on the
            // consultation schedule page, not the "what's happening now" dashboard.
            const { startKey, endKey } = getCurrentWeekRange();
            const consultationSlots = grouped
                .filter(g => g.date >= startKey && g.date <= endKey)
                .flatMap(g =>
                    g.subSlots.map(s => ({
                        id: s.id,
                        day: g.day,
                        date: g.date,
                        time: `${s.timeStart} - ${s.timeEnd}`,
                        timeStart: s.timeStart,
                        timeEnd: s.timeEnd,
                        status: s.status,
                        isBooked: s.isBooked,
                        displayStatus: computeSlotDisplayStatus(s),
                    }))
                );

            res.render('pages/instructor/dashboard', {
                title: 'FaciTrack - Dashboard',
                instructor,
                appointments,
                consultationSlots,
                pendingCount: appointments.filter(a => a.status === 'pending').length,
            });
        } catch (err) {
            console.error('[InstructorController.renderDashboardPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async renderAppointmentsPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);

            const instructorPublicId = req.session.userId;
            const rawAppointments = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);

            const appointments = rawAppointments.map(mapAppointmentRow);

            res.render('pages/instructor/appointments', {
                title: 'FaciTrack - Appointments',
                instructor,
                appointments,
            });
        } catch (err) {
            console.error('[InstructorController.renderAppointmentsPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },

    async getRescheduleOptions(req, res) {
        try {
            const instructorPublicId = req.session.userId;
            const { minDate, maxDate } = getRescheduleWindow();

            const grouped = await ConsultationModel.getBookableSlotsByInstructor(instructorPublicId);
            const slots = grouped
                .filter(g => g.date >= minDate && g.date <= maxDate)
                .map(g => ({
                    day: g.day,
                    date: g.date,
                    subSlots: g.subSlots.map(s => ({ id: s.id, timeStart: s.timeStart, timeEnd: s.timeEnd })),
                }));

            res.json({ success: true, slots, minDate, maxDate });
        } catch (err) {
            console.error('[InstructorController.getRescheduleOptions]', err);
            res.status(500).json({ success: false, error: 'Failed to load available slots.' });
        }
    },

    async rescheduleAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const { newSlotId, reason, mode } = req.body;
            const instructorPublicId = req.session.userId;

            if (!newSlotId) {
                return res.status(400).json({ success: false, error: 'Please select a new slot.' });
            }
            if (mode && !['Face-to-Face', 'Online'].includes(mode)) {
                return res.status(422).json({ success: false, error: 'Unknown consultation mode.' });
            }

            // The slot must still be inside the window the picker offered
            const { minDate, maxDate } = getRescheduleWindow();
            const slotDate = await ConsultationModel.getSlotDate(parseInt(newSlotId, 10));
            if (slotDate && (slotDate < minDate || slotDate > maxDate)) {
                return res.status(422).json({
                    success: false,
                    error: 'Pick a slot within the next three weeks.',
                });
            }

            const result = await AppointmentModel.rescheduleAppointment(
                appointmentId, parseInt(newSlotId, 10), instructorPublicId, reason, mode
            );

            if (!result.success) {
                const messages = {
                    SLOT_UNAVAILABLE: 'That slot is no longer available.',
                    NO_ROOM_AVAILABLE: 'All consultation rooms are full for that time.',
                    NOT_FOUND_OR_RESOLVED: 'Appointment not found or already resolved.',
                    MEETING_LINK_REQUIRED: 'Add your online consultation link in Settings before switching this to Online.',
                };
                return res.status(409).json({ success: false, error: messages[result.reason] || 'Failed to reschedule.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(instructorPublicId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Rescheduled appointment', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log appointment:', err);
            }

            res.json({ success: true, newAppointmentId: result.newAppointmentId });
        } catch (err) {
            console.error('[InstructorController.rescheduleAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to reschedule appointment.' });
        }
    },

    async approveAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const instructorPublicId = req.session.userId;

            const result = await AppointmentModel.approveAppointment(appointmentId, instructorPublicId);
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Appointment not found or already resolved.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(instructorPublicId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Approved appointment', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log appointment:', err);
            }

            // The Meet is minted by the approval itself, so hand it back: the
            // page updates the appointment in place and would otherwise keep
            // showing no link until the next full load.
            res.json({ success: true, meetingLink: result.meetingLink || null });
        } catch (err) {
            console.error('[InstructorController.approveAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to approve appointment.' });
        }
    },

    /**
     * Approve every pending request in one go.
     *
     * Each one goes through the same approveAppointment path as a single
     * approval, so its transaction and its student notification both still
     * run. They commit one at a time; anything that was cancelled or resolved
     * in the meantime is skipped and reported rather than aborting the run.
     */
    async approveAllAppointments(req, res) {
        try {
            const instructorPublicId = req.session.userId;
            const all = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);
            const pending = all.filter(a => a.status === 'pending');

            if (!pending.length) {
                return res.json({ success: true, total: 0, approved: 0, skipped: [] });
            }

            const skipped = [];
            let approved = 0;

            for (const appointment of pending) {
                const student = `${appointment.student_first_name} ${appointment.student_last_name}`;
                try {
                    const result = await AppointmentModel.approveAppointment(
                        appointment.id, instructorPublicId);
                    if (result.success) approved++;
                    else skipped.push({ id: appointment.id, student, reason: 'No longer pending — it was cancelled or already resolved.' });
                } catch (err) {
                    console.error('[InstructorController.approveAllAppointments] one failed:', err);
                    skipped.push({ id: appointment.id, student, reason: 'Could not be approved. Please try it on its own.' });
                }
            }

            if (approved) {
                try {
                    const instructor = await UserModel.getUserByPublicId(instructorPublicId);
                    await AuditLogModel.log(instructor.internal_id, instructor.role,
                        `Approved ${approved} pending appointment${approved === 1 ? '' : 's'}`, 'appointment');
                } catch (err) {
                    console.error('[AuditLog] Failed to log bulk approval:', err);
                }
            }

            res.json({ success: true, total: pending.length, approved, skipped });
        } catch (err) {
            console.error('[InstructorController.approveAllAppointments]', err);
            res.status(500).json({ success: false, error: 'Failed to approve the pending requests.' });
        }
    },

    /**
     * Close out every confirmed consultation whose slot has already ended.
     *
     * Each one still goes through completeAppointment(), so the "has it
     * actually finished yet" rule is enforced per appointment rather than
     * being re-implemented here. Anything refused is reported instead of
     * aborting the batch.
     */
    async completeAllAppointments(req, res) {
        try {
            const instructorPublicId = req.session.userId;
            const all = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);
            const confirmed = all.filter(a => a.status === 'confirmed');

            if (!confirmed.length) {
                return res.json({ success: true, total: 0, completed: 0, skipped: [] });
            }

            const skipped = [];
            let completed = 0;

            for (const appointment of confirmed) {
                const student = `${appointment.student_first_name} ${appointment.student_last_name}`;
                try {
                    const result = await AppointmentModel.completeAppointment(
                        appointment.id, instructorPublicId);
                    if (result.success) {
                        completed++;
                    } else if (result.reason === 'NOT_YET_ENDED') {
                        // Not an error — it simply has not happened yet
                        skipped.push({ id: appointment.id, student, reason: 'Has not ended yet.' });
                    } else {
                        skipped.push({ id: appointment.id, student, reason: 'No longer confirmed — it was cancelled or already resolved.' });
                    }
                } catch (err) {
                    console.error('[InstructorController.completeAllAppointments] one failed:', err);
                    skipped.push({ id: appointment.id, student, reason: 'Could not be completed. Please try it on its own.' });
                }
            }

            if (completed) {
                try {
                    const instructor = await UserModel.getUserByPublicId(instructorPublicId);
                    await AuditLogModel.log(instructor.internal_id, instructor.role,
                        `Completed ${completed} consultation${completed === 1 ? '' : 's'}`, 'appointment');
                } catch (err) {
                    console.error('[AuditLog] Failed to log bulk completion:', err);
                }
            }

            res.json({ success: true, total: confirmed.length, completed, skipped });
        } catch (err) {
            console.error('[InstructorController.completeAllAppointments]', err);
            res.status(500).json({ success: false, error: 'Failed to complete the consultations.' });
        }
    },

    async declineAppointment(req, res) {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const instructorPublicId = req.session.userId;
            const { reason } = req.body;

            if (!reason || !reason.trim()) {
                return res.status(400).json({ success: false, error: 'A reason is required to decline.' });
            }

            const result = await AppointmentModel.declineAppointment(appointmentId, instructorPublicId, reason.trim());
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Appointment not found or already resolved.' });
            }

            try {
                const instructor = await UserModel.getUserByPublicId(instructorPublicId);
                await AuditLogModel.log(instructor.internal_id, instructor.role, 'Declined appointment', 'appointment');
            } catch (err) {
                console.error('[AuditLog] Failed to log appointment:', err);
            }

            res.json({ success: true });
        } catch (err) {
            console.error('[InstructorController.declineAppointment]', err);
            res.status(500).json({ success: false, error: 'Failed to decline appointment.' });
        }
    },

    async renderReportsPage(req, res) {
        try {
            const instructor = buildInstructorUser(req.session);

            const instructorPublicId = req.session.userId;
            const rawAppointments = await AppointmentModel.getAppointmentsByInstructor(instructorPublicId);

            const appointments = rawAppointments.map(row => ({
                id: row.id,
                status: row.status,
                studentName: `${row.student_last_name}, ${row.student_first_name}`,
                studentId: row.student_number,
                topic: row.topic,
                date: row.consultation_date,
                dayOfWeek: row.day_of_the_week,
                time: `${to12Hour(row.start_time)} – ${to12Hour(row.end_time)}`,
                duration: computeDuration(row.start_time, row.end_time),
                durationMinutes: computeDurationMinutes(row.start_time, row.end_time),
                buildingName: row.building_name,
                notes: row.notes,
                sectionGroupName: row.section_group_name,
                courseSubject: row.course_subject,
                createdAt: row.created_at,
            }));

            const averageDurationMinutes = appointments.length
                ? Math.round(appointments.reduce((sum, a) => sum + a.durationMinutes, 0) / appointments.length)
                : 0;

            const averageDuration = `${averageDurationMinutes} min`;

            res.render('pages/instructor/reports', {
                title: 'FaciTrack - Reports',
                instructor,
                averageDuration,
                appointments,
            });
        } catch (err) {
            console.error('[InstructorController.renderReportsPage]', err);
            // Rendered by the error page rather than written as bare text.
            throw err;
        }
    },
};

module.exports = InstructorController;
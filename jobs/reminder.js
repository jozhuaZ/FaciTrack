const cron = require('node-cron');
const PresenceModel = require('../models/PresenceModel');
const AppointmentModel = require('../models/AppointmentModel');
const NotificationModel = require('../models/NotificationModel');
const { formatFullDate, to12Hour } = require('../utils/timeFormat');
const { notifyUser } = require('../services/notify');
const MakeupRequestModel = require('../models/MakeupRequestModel');
const { toWallClock } = require('../utils/wallClock');

// How long to wait before chasing the same unclosed consultation again
const COMPLETION_NUDGE_EVERY_HOURS = Number(process.env.COMPLETION_NUDGE_EVERY_HOURS) || 24;

// Unanswered booking requests are chased more often — a student is waiting,
// and an unanswered request goes stale once the consultation date passes.
// The interval is an administrator setting; .env supplies the default.
const appSettings = require('../services/app-settings');

/** Remind both parties shortly before a consultation starts. */
async function sendUpcomingReminders() {
    const upcoming = await AppointmentModel.getAppointmentsNeedingReminder();

    for (const apt of upcoming) {
        const dateLabel = formatFullDate(apt.consultation_date);
        const timeLabel = to12Hour(apt.start_time);

        await NotificationModel.create(
            apt.student_id,
            'reminder',
            `Reminder: your consultation with ${apt.instructor_first_name} ${apt.instructor_last_name} is at ${timeLabel} today, ${dateLabel}.`,
            apt.id
        );
        await NotificationModel.create(
            apt.instructor_id,
            'reminder',
            `Reminder: you have a consultation at ${timeLabel} today, ${dateLabel}.`,
            apt.id
        );

        await AppointmentModel.markReminderSent(apt.id);
    }
}

/**
 * Chase instructors whose consultation has finished but is still sitting at
 * 'confirmed'. Repeats every COMPLETION_NUDGE_EVERY_HOURS until they act,
 * so a forgotten consultation does not stay open indefinitely.
 */
async function sendCompletionNudges() {
    const pending = await AppointmentModel.getAppointmentsAwaitingCompletion(COMPLETION_NUDGE_EVERY_HOURS);

    for (const apt of pending) {
        const dateLabel = formatFullDate(apt.consultation_date);
        const timeLabel = to12Hour(apt.start_time);

        await NotificationModel.create(
            apt.instructor_id,
            'alert',
            `Your consultation with ${apt.student_first_name} ${apt.student_last_name} on ${dateLabel} at ${timeLabel} has ended. Mark it complete to close it out.`,
            apt.id
        );

        await AppointmentModel.markCompletionNudged(apt.id);
    }
}

/**
 * Chase instructors sitting on unanswered booking requests. Repeats every
 * the configured interval until they approve or decline, so a student is
 * never left waiting indefinitely on a request that was simply missed.
 */
/**
 * Close off requests whose consultation has been and gone unanswered.
 *
 * Until this existed, 'pending' covered two unrelated situations: a request an
 * instructor has yet to answer, and one they never answered at all. Both sat in
 * the same queue offering Approve and Decline, on a consultation whose time had
 * already passed — buttons that cannot mean anything once the slot is behind
 * you. Separating them is what lets every page stop offering the impossible.
 *
 * The student is told, because they are the one who was waiting and the one who
 * has to book again. The instructor is not sent a separate notice: they were
 * already nudged while it was pending, and another message after the fact
 * would be noise rather than news. It still shows as expired in their own
 * list and in the dean's report.
 */
async function expireUnansweredRequests() {
    const expired = await AppointmentModel.expireUnansweredRequests();
    if (!expired.length) return;

    for (const apt of expired) {
        const dateLabel = formatFullDate(apt.consultation_date);
        const timeLabel = `${to12Hour(apt.start_time)} – ${to12Hour(apt.end_time)}`;

        try {
            await notifyUser(
                apt.student_id,
                'expired',
                `Your consultation request with ${apt.instructor_name} on ${dateLabel} at ${timeLabel} was not answered in time. Book another slot if you still need it.`,
                apt.id,
                {
                    pushTitle: 'Request expired',
                    email: {
                        heading: 'Consultation request expired',
                        status: 'declined',
                        message: `Your request was not answered before the consultation time passed. Nothing was booked — you can request another slot whenever you are ready.`,
                        details: [
                            { label: 'Instructor', value: apt.instructor_name },
                            { label: 'Date', value: dateLabel },
                            { label: 'Time', value: timeLabel },
                            { label: 'Topic', value: apt.topic },
                        ],
                    },
                }
            );
        } catch (err) {
            // One student's notification failing must not strand the rest;
            // the appointment is already expired either way.
            console.error('[ReminderJob] Could not notify about expiry:', err.message);
        }
    }

    console.log('[ReminderJob] Expired ' + expired.length + ' unanswered request(s).');
}

/**
 * Close off make-up requests the dean never decided before the class was due.
 *
 * The make-up counterpart of expireUnansweredRequests(): once the earliest
 * session has started, Approve and Decline cannot mean anything. The
 * instructor is told, since the request was theirs and they may need to file
 * a new one. Also called before the make-up pages load, so they are accurate
 * even where nothing runs this on a timer (a serverless host with no pinger).
 */
async function expireUndecidedMakeups() {
    const now = toWallClock(new Date());
    const pad = (n) => String(n).padStart(2, '0');
    const nowWallClock = now.date + ' ' + pad(now.hour) + ':' + pad(now.minute) + ':00';

    const expired = await MakeupRequestModel.expireUndecided(nowWallClock);
    for (const req of expired) {
        try {
            await notifyUser(
                req.instructor_id,
                'makeup',
                'Your make-up class request' + (req.subjects ? ' for ' + req.subjects : '') + ' was not decided before the class was due, so it has expired. File a new request if you still need the make-up class.',
                null,
                { pushTitle: 'Make-up request expired' }
            );
        } catch (err) {
            // One notice failing must not strand the rest; the request is
            // already expired either way.
            console.error('[ReminderJob] Could not notify about make-up expiry:', err.message);
        }
    }
    if (expired.length) console.log('[ReminderJob] Expired ' + expired.length + ' undecided make-up request(s).');
    return expired;
}

async function sendPendingRequestNudges() {
    const everyHours = await appSettings.get('pending_nudge_every_hours');
    const waiting = await AppointmentModel.getPendingAppointmentsAwaitingAction(everyHours);

    for (const apt of waiting) {
        const dateLabel = formatFullDate(apt.consultation_date);
        const timeLabel = to12Hour(apt.start_time);

        await NotificationModel.create(
            apt.instructor_id,
            'new-request',
            `${apt.student_first_name} ${apt.student_last_name} is still waiting for a response to their consultation request on ${dateLabel} at ${timeLabel}.`,
            apt.id
        );

        await AppointmentModel.markPendingNudged(apt.id);
    }
}

/**
 * Chase instructors whose upcoming online consultations still have no meeting
 * link. The student sees "link coming soon" until this is resolved.
 */
async function sendMissingLinkNudges() {
    const missing = await AppointmentModel.getOnlineAppointmentsMissingLink(COMPLETION_NUDGE_EVERY_HOURS);

    for (const apt of missing) {
        const dateLabel = formatFullDate(apt.consultation_date);
        const timeLabel = to12Hour(apt.start_time);

        await NotificationModel.create(
            apt.instructor_id,
            'alert',
            `Your online consultation with ${apt.student_first_name} ${apt.student_last_name} on ${dateLabel} at ${timeLabel} has no meeting link. Add one in Settings so the student can join.`,
            apt.id
        );

        await AppointmentModel.markCompletionNudged(apt.id);
    }
}

function startReminderJob() {
    // Upcoming-consultation reminders — needs minute precision
    cron.schedule('* * * * *', async () => {
        try {
            await sendUpcomingReminders();
        } catch (err) {
            console.error('[ReminderJob] Upcoming reminders failed:', err);
        }
        try {
            // Every minute rather than hourly: a request expires at a definite
            // moment, and leaving Approve live for up to an hour past it is
            // exactly the thing being fixed.
            await expireUnansweredRequests();
        } catch (err) {
            console.error('[ReminderJob] Expiring unanswered requests failed:', err);
        }
        try {
            await expireUndecidedMakeups();
        } catch (err) {
            console.error('[ReminderJob] Expiring make-up requests failed:', err);
        }
    });

    // Anything that went stale while the server was down is closed off at
    // startup rather than waiting for the first tick.
    expireUnansweredRequests().catch(err =>
        console.error('[ReminderJob] Startup expiry sweep failed:', err.message));
    expireUndecidedMakeups().catch(err =>
        console.error('[ReminderJob] Startup make-up expiry sweep failed:', err.message));

    // Follow-up nudges — hourly; each one's own throttle decides who is due.
    // Kept in separate try blocks so one failing query cannot stop the others.
    cron.schedule('0 * * * *', async () => {
        try {
            await sendPendingRequestNudges();
        } catch (err) {
            console.error('[ReminderJob] Pending-request nudges failed:', err);
        }
        try {
            await sendCompletionNudges();
        } catch (err) {
            console.error('[ReminderJob] Completion nudges failed:', err);
        }
        try {
            await sendMissingLinkNudges();
        } catch (err) {
            console.error('[ReminderJob] Missing-link nudges failed:', err);
        }
        try {
            // Tags a discovery window let in that nobody went on to assign.
            // Assigned tags are never touched, however long they have been
            // silent: a flat battery must not unbind an instructor.
            const removed = await PresenceModel.pruneUnassigned({ olderThanDays: 7 });
            if (removed) console.log('[ReminderJob] Pruned ' + removed + ' unclaimed BLE tag(s).');
        } catch (err) {
            console.error('[ReminderJob] Beacon prune failed:', err);
        }
        try {
            // Signal history is a rolling window for tuning a threshold, not a
            // record worth keeping — a week is more than any calibration needs.
            const dropped = await PresenceModel.pruneSamples({ olderThanDays: 7 });
            if (dropped) console.log('[ReminderJob] Pruned ' + dropped + ' signal sample(s).');
        } catch (err) {
            console.error('[ReminderJob] Signal sample prune failed:', err);
        }
    });
}

module.exports = startReminderJob;
module.exports.sendUpcomingReminders = sendUpcomingReminders;
module.exports.sendCompletionNudges = sendCompletionNudges;
module.exports.sendMissingLinkNudges = sendMissingLinkNudges;
module.exports.sendPendingRequestNudges = sendPendingRequestNudges;
module.exports.expireUnansweredRequests = expireUnansweredRequests;
module.exports.expireUndecidedMakeups = expireUndecidedMakeups;

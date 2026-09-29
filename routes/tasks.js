const express = require('express');
const reminders = require('../jobs/reminder');
const { syncDueConnections } = require('../jobs/calendar-sync');
const PresenceModel = require('../models/PresenceModel');

const router = express.Router();

/**
 * Scheduled work, driven over HTTP.
 *
 * On a server, jobs/reminder.js holds its own cron timers. A serverless host
 * has no process to hold them: the instance is torn down as soon as it goes
 * idle, so a timer set during a request never fires. The same functions are
 * exposed here instead and called by the platform's scheduler, which is the
 * only thing on such a host that survives between requests.
 *
 * The work is unchanged — these call straight into the job module, so there
 * is one implementation and the two hosts cannot drift apart.
 */

/**
 * Only the scheduler may run these.
 *
 * Each of these endpoints sends email and writes notifications, so an open URL
 * would let anyone who found it spam every user in the system. Vercel Cron
 * sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set, which is
 * what this checks.
 *
 * A missing CRON_SECRET refuses the request rather than waving it through:
 * defaulting to open is how an endpoint like this ends up public by accident.
 */
function requireScheduler(req, res, next) {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        console.error('[Tasks] CRON_SECRET is not set — refusing to run scheduled work.');
        return res.status(503).json({ status: 'error', message: 'Scheduler is not configured.' });
    }

    const header = req.get('Authorization') || '';
    const offered = header.startsWith('Bearer ') ? header.slice(7) : req.get('X-Cron-Secret');
    if (offered !== secret) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized.' });
    }
    next();
}

/**
 * Run each task, and let the others run even when one fails.
 *
 * This mirrors the separate try blocks in startReminderJob(): one failing
 * query must not stop the rest of the batch, and the caller should be able to
 * see which part failed rather than getting a single opaque 500.
 */
async function runBatch(tasks) {
    const results = {};
    for (const [name, fn] of Object.entries(tasks)) {
        const startedAt = Date.now();
        try {
            const value = await fn();
            results[name] = { ok: true, ms: Date.now() - startedAt, ...(value !== undefined && { value }) };
        } catch (err) {
            console.error(`[Tasks] ${name} failed:`, err);
            results[name] = { ok: false, ms: Date.now() - startedAt, error: err.message };
        }
    }
    return results;
}

// Vercel Cron issues GET, so these answer GET as well as POST.
function schedule(path, tasks) {
    const handler = async (req, res) => {
        const results = await runBatch(tasks);
        const failed = Object.values(results).some(r => !r.ok);
        // 200 even when a task failed: a non-2xx makes the scheduler retry the
        // whole batch, re-running the tasks that already succeeded. The body
        // carries what went wrong.
        res.status(200).json({ status: failed ? 'partial' : 'ok', ran: results });
    };
    router.get(path, requireScheduler, handler);
    router.post(path, requireScheduler, handler);
}

/**
 * Minute work.
 *
 * Expiry is the reason this one is not folded into the hourly batch: a pending
 * request expires at a definite moment, and leaving Approve live for up to an
 * hour past it is the exact thing the expired status was added to fix.
 */
schedule('/minute', {
    upcomingReminders: reminders.sendUpcomingReminders,
    expireUnanswered: reminders.expireUnansweredRequests,
    expireMakeups: reminders.expireUndecidedMakeups,
    // On Vercel the 15-second sweep timer never runs (no long-lived process),
    // so this is what flags people held by a silent scanner as "no signal".
    presenceSweep: () => require('../jobs/presence-sweep').sweepOnce(),
});

/** Follow-ups and housekeeping. Each has its own throttle deciding who is due. */
schedule('/hourly', {
    pendingRequestNudges: reminders.sendPendingRequestNudges,
    deanEscalation: reminders.escalateUnansweredToDean,
    completionNudges: reminders.sendCompletionNudges,
    missingLinkNudges: reminders.sendMissingLinkNudges,
    // Unclaimed tags only. An assigned tag is never pruned however long it has
    // been silent: a flat battery must not unbind an instructor.
    pruneUnassignedTags: () => PresenceModel.pruneUnassigned({ olderThanDays: 7 }),
    pruneSignalSamples: () => PresenceModel.pruneSamples({ olderThanDays: 7 }),
});

/** Calendar feeds. Separate because it is the slowest and the least urgent. */
schedule('/calendar-sync', {
    calendarSync: syncDueConnections,
});

module.exports = router;

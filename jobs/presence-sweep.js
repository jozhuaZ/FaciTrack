const PresenceModel = require('../models/PresenceModel');
const appSettings = require('../services/app-settings');
const { broadcast } = require('../realtime/sseRegistry');

/**
 * Mark people absent when nothing has heard them for a while.
 *
 * Nobody announces a departure — a tag going out of range sends nothing at
 * all — so absence has only ever been a timeout. That timeout used to be swept
 * inside the ingest handler, which worked exactly as long as some scanner was
 * still posting. Switch every scanner off, and nothing ran the sweep: the last
 * reading stood forever, and the dean's page showed somebody in a room hours
 * after the room stopped being watched.
 *
 * A scanner being unplugged is the normal case, not the edge case — it is what
 * happens when a board is moved to the ceiling, loses power, or drops off the
 * Wi-Fi. So the sweep runs on its own clock and does not depend on anything
 * reporting in.
 *
 * The ingest still sweeps too. That is not redundant: it clears somebody the
 * instant a scanner notices the room is empty, rather than up to one tick
 * later, and expireStale takes a row lock so the two cannot both announce the
 * same departure.
 */

// Short relative to the shortest sensible absence timeout, so the lag this
// adds is small next to the timeout itself rather than doubling it.
const SWEEP_EVERY_MS = 15000;

let running = false;

async function sweepOnce() {
    // A slow sweep must not stack up behind itself.
    if (running) return 0;
    running = true;

    try {
        const [absentAfter, logging, scannerOfflineAfter] = await Promise.all([
            appSettings.get('presence_absent_after_sec'),
            appSettings.get('presence_logging_enabled'),
            appSettings.get('presence_scanner_offline_after_sec'),
        ]);

        // A scanner that has stopped reporting (Wi-Fi drop, power cut) is not
        // evidence that anybody left. expireStale only times people out in a
        // room whose scanner is alive; the people a silent scanner holds are
        // flagged signal_lost instead, which every page shows as unknown.
        const departed = await PresenceModel.expireStale(absentAfter, scannerOfflineAfter);
        const signal = await PresenceModel.syncSignal(scannerOfflineAfter);

        if (signal.lost.length || signal.restored.length) {
            if (signal.lost.length) {
                console.log('[PresenceSweep] Scanner silent: holding ' + signal.lost.length
                    + ' as "no signal" instead of marking them out.');
            }
            try {
                broadcast('presence:changed', {
                    room: null,
                    roomId: null,
                    scannerId: null,
                    at: new Date().toISOString(),
                    // Not presence_logs events: nobody moved, the room just
                    // stopped (or started) being watched.
                    events: [
                        ...signal.lost.map(r => ({ instructorId: r.instructor_id, event: 'signal-lost' })),
                        ...signal.restored.map(r => ({ instructorId: r.instructor_id, event: 'signal-restored' })),
                    ],
                });
            } catch (err) {
                console.error('[PresenceSweep] Broadcast failed:', err.message);
            }
        }

        if (!departed.length) return 0;

        const events = departed.map(row => ({
            instructorId: row.instructor_id,
            roomId: row.room_id,
            event: 'exited',
            // No reading: nothing was heard, which is the whole reason this ran.
            rssi: null,
            scannerId: null,
        }));

        if (logging) {
            try {
                await PresenceModel.log(events);
            } catch (err) {
                // A history write must not cost somebody their departure —
                // they are already marked absent and that is the part that
                // matters to every page showing presence.
                console.error('[PresenceSweep] Could not log departures:', err.message);
            }
        }

        // Same event the ingest broadcasts, so every open page treats a
        // timed-out departure exactly like a detected one.
        try {
            broadcast('presence:changed', {
                room: null,
                roomId: null,
                scannerId: null,
                at: new Date().toISOString(),
                events: events.map(e => ({ instructorId: e.instructorId, event: e.event })),
            });
        } catch (err) {
            console.error('[PresenceSweep] Broadcast failed:', err.message);
        }

        console.log('[PresenceSweep] Marked ' + departed.length + ' absent after ' + absentAfter
            + 's (rooms with a live scanner only).');
        return departed.length;
    } catch (err) {
        // Never let a failed sweep take the process down; the next tick retries.
        console.error('[PresenceSweep] Sweep failed:', err.message);
        return 0;
    } finally {
        running = false;
    }
}

function startPresenceSweepJob() {
    const timer = setInterval(sweepOnce, SWEEP_EVERY_MS);
    // Nothing here should hold the process open on its own.
    if (timer.unref) timer.unref();

    // Clear anything that went stale while the server was down, rather than
    // waiting a tick to notice a restart left somebody parked in a room.
    sweepOnce();

    console.log('[PresenceSweep] Absence sweep running every ' + (SWEEP_EVERY_MS / 1000) + 's.');
    return timer;
}

module.exports = startPresenceSweepJob;
module.exports.sweepOnce = sweepOnce;
module.exports.SWEEP_EVERY_MS = SWEEP_EVERY_MS;

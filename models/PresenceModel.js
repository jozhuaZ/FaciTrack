const pool = require('../configs/db');
const { FACULTY_LOUNGE_ROOM_TYPE } = require('../utils/availability');

/**
 * BLE presence: the scanners, the tags, where they were last heard, and the
 * history.
 *
 * The scanners are dumb on purpose — they report every beacon they heard and
 * how strongly. Everything that decides what a sighting *means* lives here and
 * in PresenceController, so retuning never means re-flashing a board.
 */
const PresenceModel = {

    /**
     * The room a scanner claims to be in. Unknown room codes are rejected.
     * rssi_threshold is NULL unless this room has been tuned individually.
     */
    async getRoomByNumber(roomNumber) {
        const [rows] = await pool.execute(
            'SELECT id, room_number, room_type, rssi_threshold FROM rooms WHERE room_number = ? LIMIT 1',
            [roomNumber]
        );
        return rows[0] || null;
    },

    /** Tune one room, or pass null to put it back on the system-wide default. */
    async setRoomThreshold(roomId, threshold) {
        const [result] = await pool.execute(
            'UPDATE rooms SET rssi_threshold = ? WHERE id = ?', [threshold, roomId]
        );
        return result.affectedRows > 0;
    },

    /** Known tags for the MACs a scanner just reported, with their owner. */
    async getBeaconsByMac(macs) {
        if (!macs.length) return [];
        const [rows] = await pool.query(
            `SELECT b.id, b.mac_address, b.instructor_id, b.label, b.is_active,
                    u.public_id AS instructor_public_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS instructor_name
               FROM ble_beacons b
               LEFT JOIN users u ON u.id = b.instructor_id
              WHERE b.mac_address IN (?)`,
            [macs]
        );
        return rows;
    },

    /**
     * Record every MAC a scanner heard, whether or not it is a known tag.
     *
     * An unrecognised tag is inserted unassigned rather than dropped: that is
     * how a new Minew E8 announces itself, so switching it on is all it takes
     * for it to appear in Admin waiting to be handed to someone.
     */
    /**
     * Write down what a scanner heard.
     *
     * @param {boolean} opts.acceptUnknown  whether tags this system has never
     *   seen are inserted. False everywhere except inside a discovery window:
     *   a scanner hears every phone that walks past, most of those addresses
     *   rotate every few minutes, and inserting them made the table grow
     *   without bound while telling us nothing. Known tags are still updated
     *   either way, which is all presence actually needs.
     *
     * @returns {Promise<{updated: number, discovered: number}>}
     */
    async recordSightings(sightings, roomId, { acceptUnknown = false } = {}) {
        if (!sightings.length) return { updated: 0, discovered: 0 };

        let toWrite = sightings;
        let discovered = 0;

        if (!acceptUnknown) {
            const macs = sightings.map(s => s.mac);
            const [known] = await pool.query(
                'SELECT mac_address FROM ble_beacons WHERE mac_address IN (?)', [macs]
            );
            const seen = new Set(known.map(k => k.mac_address));
            toWrite = sightings.filter(s => seen.has(s.mac));
            if (!toWrite.length) return { updated: 0, discovered: 0 };
        } else {
            const macs = sightings.map(s => s.mac);
            const [known] = await pool.query(
                'SELECT mac_address FROM ble_beacons WHERE mac_address IN (?)', [macs]
            );
            discovered = sightings.length - known.length;
        }

        const values = toWrite.map(s => [s.mac, roomId, s.rssi, s.major ?? null, s.minor ?? null]);
        await pool.query(
            `INSERT INTO ble_beacons
                 (mac_address, last_room_id, last_rssi, ibeacon_major, ibeacon_minor, last_seen_at)
             VALUES ${values.map(() => '(?, ?, ?, ?, ?, NOW())').join(', ')}
             ON DUPLICATE KEY UPDATE
                 last_room_id  = VALUES(last_room_id),
                 last_rssi     = VALUES(last_rssi),
                 last_seen_at  = VALUES(last_seen_at),
                 ibeacon_major = COALESCE(VALUES(ibeacon_major), ibeacon_major),
                 ibeacon_minor = COALESCE(VALUES(ibeacon_minor), ibeacon_minor)`,
            values.flat()
        );

        return { updated: toWrite.length, discovered };
    },

    /**
     * Drop tags nobody claimed.
     *
     * An assigned tag is never touched however long it has been silent — a
     * flat battery must not quietly unbind an instructor. This only clears
     * what a discovery window let in and nobody went on to use.
     */
    async pruneUnassigned({ olderThanDays = 7, includeRecent = false } = {}) {
        const [result] = await pool.execute(
            `DELETE FROM ble_beacons
              WHERE instructor_id IS NULL
                AND (? OR last_seen_at IS NULL
                       OR last_seen_at < DATE_SUB(NOW(), INTERVAL ? DAY))`,
            [includeRecent ? 1 : 0, olderThanDays]
        );
        return result.affectedRows;
    },

    /** How much of the table is worth keeping — for the admin page. */
    async beaconCounts() {
        const [[row]] = await pool.query(
            `SELECT COUNT(*) AS total,
                    SUM(instructor_id IS NOT NULL) AS assigned,
                    SUM(instructor_id IS NULL)     AS unassigned
               FROM ble_beacons`
        );
        return {
            total: Number(row.total) || 0,
            assigned: Number(row.assigned) || 0,
            unassigned: Number(row.unassigned) || 0,
        };
    },

    /* ── Signal history ───────────────────────────────────────────────────
       A threshold has to sit below every reading taken from where somebody
       actually sits, and nothing in this system used to record those readings:
       presence_logs only holds the RSSI at the instant of a crossing. These
       three keep a rolling window of raw signal so a threshold can be measured.
       ─────────────────────────────────────────────────────────────────────── */

    /**
     * Write a signal sample for each tag heard, throttled per tag per room.
     *
     * Scanners report every ten seconds, which is far more resolution than a
     * background record needs, so normally one row a minute is kept. Two things
     * bend that rule, and both exist because the throttle would otherwise throw
     * away the readings this table is for:
     *
     *  - A reading weaker than anything already kept in the window is always
     *    written. Keeping whichever sample happened to arrive first would
     *    record a tag's best minute and hide its worst, and the weak end is the
     *    whole point — a threshold has to clear the reading taken when somebody
     *    turns their back on the scanner, not the one taken facing it.
     *  - During a discovery window the throttle comes off entirely, because
     *    that is somebody walking the room with a tag in their hand.
     *
     * @param {Array<{beaconId: number, rssi: number}>} readings
     * @returns {Promise<number>} rows written
     */
    async recordSamples(readings, roomId, scannerId, { throttleSeconds = 60 } = {}) {
        if (!readings.length) return 0;

        let due = readings;
        if (throttleSeconds > 0) {
            const [recent] = await pool.query(
                `SELECT beacon_id, MIN(rssi) AS weakest
                   FROM ble_rssi_samples
                  WHERE beacon_id IN (?)
                    AND room_id <=> ?
                    AND sampled_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
                  GROUP BY beacon_id`,
                [readings.map(r => r.beaconId), roomId, throttleSeconds]
            );
            const weakestSoFar = new Map(recent.map(r => [r.beacon_id, r.weakest]));
            due = readings.filter(r => {
                const kept = weakestSoFar.get(r.beaconId);
                return kept === undefined || r.rssi < kept;
            });
        }
        if (!due.length) return 0;

        const values = due.map(r => [r.beaconId, roomId, scannerId ?? null, Math.round(r.rssi)]);
        await pool.query(
            `INSERT INTO ble_rssi_samples (beacon_id, room_id, scanner_id, rssi)
             VALUES ${values.map(() => '(?, ?, ?, ?)').join(', ')}`,
            values.flat()
        );
        return due.length;
    },

    /**
     * Every sample for one tag over a window, newest first, grouped by room.
     *
     * Raw rows rather than SQL aggregates: percentiles are what calibration
     * actually needs and MariaDB makes them awkward, while the volume here is
     * a few hundred rows at most.
     */
    async signalHistory(beaconId, { minutes = 15, limit = 2000 } = {}) {
        const [rows] = await pool.query(
            `SELECT s.rssi, s.scanner_id, s.sampled_at, s.room_id, r.room_number
               FROM ble_rssi_samples s
               LEFT JOIN rooms r ON r.id = s.room_id
              WHERE s.beacon_id = ?
                AND s.sampled_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
              ORDER BY s.sampled_at DESC
              LIMIT ?`,
            [beaconId, minutes, limit]
        );
        return rows;
    },

    /**
     * Is anything actually watching a Faculty Lounge right now?
     *
     * The lounge board and the student page answer "is this person at the
     * lounge". That question needs a scanner in a lounge reporting; without
     * one, the honest answer for everybody is "no data", not "out". This is
     * what tells those pages which of the two they are entitled to say.
     *
     * @returns {Promise<{covered: boolean, rooms: Array, installed: number}>}
     */
    async loungeCoverage(staleAfterSeconds = 60) {
        const [rooms] = await pool.execute(
            `SELECT r.id, r.room_number,
                    s.scanner_id,
                    s.last_seen_at,
                    TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW()) AS secs_since
               FROM rooms r
               LEFT JOIN ble_scanners s ON s.room_id = r.id
              WHERE r.room_type = ?
                AND r.status <> 'Inactive'
              ORDER BY r.room_number`,
            [FACULTY_LOUNGE_ROOM_TYPE]
        );

        const withScanner = rooms.map(r => ({
            roomId: r.id,
            room: r.room_number,
            scannerId: r.scanner_id || null,
            // A scanner that stopped reporting is not watching anything, so it
            // does not count as coverage however recently it was installed.
            online: !!r.scanner_id && r.secs_since !== null && r.secs_since <= staleAfterSeconds,
        }));

        return {
            covered: withScanner.some(r => r.online),
            installed: withScanner.filter(r => r.scannerId).length,
            rooms: withScanner,
        };
    },

    /** Each room's own threshold, so a reading can be judged against the line
     *  that was actually applied to it. NULL means the room is on the default. */
    async getRoomThresholds(roomIds) {
        if (!roomIds.length) return new Map();
        const [rows] = await pool.query(
            'SELECT id, rssi_threshold FROM rooms WHERE id IN (?)',
            [roomIds]
        );
        return new Map(rows.map(r => [r.id, r.rssi_threshold]));
    },

    /** Keep the window rolling. Called from the hourly job. */
    async pruneSamples({ olderThanDays = 7 } = {}) {
        const [result] = await pool.execute(
            'DELETE FROM ble_rssi_samples WHERE sampled_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
            [olderThanDays]
        );
        return result.affectedRows;
    },

    /**
     * Remember that a scanner reported. Called on every ingest, so a scanner
     * that goes quiet shows up as a stale row rather than as an absence — which
     * is what makes a silent tag distinguishable from a dead room.
     */
    async recordScanner(scannerId, roomId, { uptimeSec, beaconCount, ip, staleAfterSeconds = 60 } = {}) {
        if (!scannerId) return { wasStale: false, isNew: false };

        // Read the previous state before overwriting it: a scanner that has
        // been silent and is now reporting again is a health change worth
        // announcing, and after the upsert that fact is gone.
        const [[before]] = await pool.execute(
            `SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS secs_since
               FROM ble_scanners WHERE scanner_id = ?`,
            [scannerId]
        );
        const isNew = !before;
        const wasStale = isNew || before.secs_since === null || before.secs_since > staleAfterSeconds;

        await pool.execute(
            `INSERT INTO ble_scanners
                 (scanner_id, room_id, last_seen_at, last_uptime_sec, last_beacon_count, last_ip, report_count)
             VALUES (?, ?, NOW(), ?, ?, ?, 1)
             ON DUPLICATE KEY UPDATE
                 room_id           = VALUES(room_id),
                 last_seen_at      = NOW(),
                 last_uptime_sec   = VALUES(last_uptime_sec),
                 last_beacon_count = VALUES(last_beacon_count),
                 last_ip           = VALUES(last_ip),
                 report_count      = report_count + 1`,
            [scannerId, roomId, uptimeSec ?? null, beaconCount ?? null, ip ?? null]
        );

        // Online history, for the Class Attendance report: extend this
        // scanner's current run if the last report was under 90s ago (reports
        // come every 5s), otherwise start a new run. Never fatal — a failed
        // history write must not cost the room its presence update.
        try {
            const [ext] = await pool.execute(
                `UPDATE scanner_online_runs
                    SET last_seen_at = NOW(), room_id = ?
                  WHERE scanner_id = ?
                    AND last_seen_at >= DATE_SUB(NOW(), INTERVAL 90 SECOND)
                  ORDER BY id DESC LIMIT 1`,
                [roomId, scannerId]
            );
            if (!ext.affectedRows) {
                await pool.execute(
                    `INSERT INTO scanner_online_runs (scanner_id, room_id, started_at, last_seen_at)
                     VALUES (?, ?, NOW(), NOW())`,
                    [scannerId, roomId]
                );
            }
        } catch (err) {
            console.error('[Presence] Could not record scanner online run:', err.message);
        }

        return { wasStale, isNew };
    },

    /**
     * One instructor's own presence and the room it places them in, by public
     * id. For the instructor's sidebar; is_present is null when no scanner has
     * ever reported on them.
     */
    async getOwn(publicId) {
        const [[row]] = await pool.execute(
            `SELECT fp.is_present, fp.signal_lost, r.room_number
               FROM users u
               LEFT JOIN faculty_presence fp ON fp.instructor_id = u.id
               LEFT JOIN rooms r             ON fp.room_id       = r.id
              WHERE u.public_id = ?`,
            [publicId]
        );
        return row || null;
    },

    /** Where an instructor is currently recorded, so a change can be detected. */
    async getCurrent(instructorIds) {
        if (!instructorIds.length) return new Map();
        const [rows] = await pool.query(
            `SELECT instructor_id, room_id, is_present, last_rssi,
                    TIMESTAMPDIFF(SECOND, last_updated, NOW()) AS secs_since_update
               FROM faculty_presence
              WHERE instructor_id IN (?)`,
            [instructorIds]
        );
        return new Map(rows.map(r => [r.instructor_id, r]));
    },

    /** Mark an instructor present in a room. One row per instructor, updated in place. */
    async markPresent(instructorId, roomId, rssi = null) {
        await pool.execute(
            `INSERT INTO faculty_presence (instructor_id, room_id, is_present, signal_lost, last_rssi, detected_at)
             VALUES (?, ?, 1, 0, ?, NOW())
             ON DUPLICATE KEY UPDATE
                 room_id     = VALUES(room_id),
                 is_present  = 1,
                 signal_lost = 0,
                 last_rssi   = VALUES(last_rssi),
                 detected_at = NOW()`,
            [instructorId, roomId, rssi === undefined ? null : rssi]
        );
    },

    /**
     * Anyone whose last sighting is older than the cutoff has left.
     *
     * A scanner can only report what it hears, so nothing announces a
     * departure — absence is a timeout. Returns the rows that changed, so the
     * caller can log the exits.
     */
    /** Everyone a room is currently credited with holding. */
    async getPresentInRoom(roomId) {
        const [rows] = await pool.execute(
            'SELECT instructor_id, last_rssi FROM faculty_presence WHERE room_id = ? AND is_present = 1',
            [roomId]
        );
        return rows;
    },

    /**
     * Clear people a live scanner can no longer hear.
     *
     * Separate from expireStale because the evidence is different. That one
     * acts on silence and has to wait, in case the silence is a dead scanner.
     * This one acts on a report from the room itself: the scanner is alive, it
     * is listening, and this person is not there. Nothing is worth waiting for.
     *
     * Only rows still marked present are touched, so a scanner repeating the
     * same empty report cannot announce the same departure twice.
     */
    async markAbsent(instructorIds, roomId) {
        if (!instructorIds.length) return [];

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [gone] = await conn.query(
                `SELECT instructor_id, room_id
                   FROM faculty_presence
                  WHERE instructor_id IN (?)
                    AND room_id = ?
                    AND is_present = 1
                  FOR UPDATE`,
                [instructorIds, roomId]
            );

            if (!gone.length) {
                await conn.commit();
                return [];
            }

            await conn.query(
                'UPDATE faculty_presence SET is_present = 0, signal_lost = 0 WHERE instructor_id IN (?)',
                [gone.map(r => r.instructor_id)]
            );
            await conn.commit();
            return gone;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Anyone not heard for absentAfterSeconds has left — but only in a room
     * whose scanner is still reporting.
     *
     * Silence has two causes that look identical from here: the person walked
     * out of range, or the scanner stopped (Wi-Fi dropped, power cut). Only the
     * first is evidence of leaving. A room whose scanner has been quiet longer
     * than scannerOfflineAfterSeconds is not watching anybody, so the people it
     * holds are left as they are — syncSignal() marks them signal_lost, pages
     * show them as unknown, and the scanner's first report after it comes back
     * settles it either way.
     */
    async expireStale(absentAfterSeconds, scannerOfflineAfterSeconds = 60) {
        // Two callers now run this — every ingest, and the sweep timer that
        // covers the case where no scanner is reporting at all. Selecting the
        // stale rows and then clearing them in separate statements would let
        // both read the same rows before either wrote, and each would announce
        // the same departure. The row lock makes one of them wait and find
        // nothing left to do.
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [stale] = await conn.execute(
                `SELECT fp.instructor_id, fp.room_id
                   FROM faculty_presence fp
                  WHERE fp.is_present = 1
                    AND fp.last_updated < DATE_SUB(NOW(), INTERVAL ? SECOND)
                    AND EXISTS (SELECT 1 FROM ble_scanners s
                                 WHERE s.room_id = fp.room_id
                                   AND s.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND))
                  FOR UPDATE`,
                [absentAfterSeconds, scannerOfflineAfterSeconds]
            );

            if (!stale.length) {
                await conn.commit();
                return [];
            }

            await conn.query(
                'UPDATE faculty_presence SET is_present = 0, signal_lost = 0 WHERE instructor_id IN (?)',
                [stale.map(r => r.instructor_id)]
            );
            await conn.commit();
            return stale;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    },

    /**
     * Keep signal_lost in step with whether each held person's room still has
     * a live scanner. Returns who changed, so the caller can tell open pages.
     *
     * last_updated is written back to itself on purpose: it carries ON UPDATE
     * CURRENT_TIMESTAMP, and letting this bump it would restart the absence
     * timer every time a scanner's health changed.
     */
    async syncSignal(scannerOfflineAfterSeconds = 60) {
        const liveRoom = `EXISTS (SELECT 1 FROM ble_scanners s
                                   WHERE s.room_id = fp.room_id
                                     AND s.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND))`;

        const [rows] = await pool.execute(
            `SELECT fp.instructor_id, fp.room_id, fp.signal_lost, ${liveRoom} AS room_live
               FROM faculty_presence fp
              WHERE fp.is_present = 1`,
            [scannerOfflineAfterSeconds]
        );

        const lost = rows.filter(r => !r.room_live && !r.signal_lost);
        const restored = rows.filter(r => r.room_live && r.signal_lost);

        if (lost.length) {
            await pool.query(
                'UPDATE faculty_presence SET signal_lost = 1, last_updated = last_updated WHERE instructor_id IN (?)',
                [lost.map(r => r.instructor_id)]
            );
        }
        if (restored.length) {
            await pool.query(
                'UPDATE faculty_presence SET signal_lost = 0, last_updated = last_updated WHERE instructor_id IN (?)',
                [restored.map(r => r.instructor_id)]
            );
        }
        return { lost, restored };
    },

    /**
     * Append-only history. Nothing else writes to this table.
     *
     * An entry with ageSec is written that many seconds in the past — the
     * scanner backlog replaying what it heard while it could not reach the
     * server. Measured against the database's own clock, like every other
     * timestamp here, so the scanner never needs to know the time.
     */
    async log(entries) {
        if (!entries.length) return;
        const values = entries.map(e => [
            e.instructorId, e.roomId, e.event, e.rssi ?? null, e.scannerId ?? null,
            Math.max(0, Math.round(Number(e.ageSec) || 0)),
        ]);
        await pool.query(
            `INSERT INTO presence_logs (instructor_id, room_id, event, rssi, scanner_id, occurred_at)
             VALUES ${values.map(() => '(?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? SECOND))').join(', ')}`,
            values.flat()
        );
    },

    /**
     * A stretch the scanner was listening while offline (its backlog covered
     * it), recorded as an online run from startAgeSec to endAgeSec ago. A
     * resent backlog adds a duplicate run, which only overlaps an existing one
     * — the attendance report merges overlapping runs, so it counts once.
     */
    async recordOfflineRun(scannerId, roomId, startAgeSec, endAgeSec) {
        await pool.execute(
            `INSERT INTO scanner_online_runs (scanner_id, room_id, started_at, last_seen_at)
             VALUES (?, ?, DATE_SUB(NOW(), INTERVAL ? SECOND), DATE_SUB(NOW(), INTERVAL ? SECOND))`,
            [scannerId, roomId, Math.round(startAgeSec), Math.round(endAgeSec)]
        );
    },

    /* ── Scanner backlog (store-and-forward) ── */

    /**
     * Where each instructor stood just before a point in the past, from the
     * history: the last event older than ageSec. Used as the starting state
     * when replaying a scanner's backlog. Instructors with no history before
     * then are absent from the map (treated as not in the room).
     */
    async lastEventsBefore(instructorIds, ageSec) {
        if (!instructorIds.length) return new Map();
        const [rows] = await pool.query(
            `SELECT pl.instructor_id, pl.room_id, pl.event
               FROM presence_logs pl
               JOIN (SELECT instructor_id, MAX(id) AS id
                       FROM presence_logs
                      WHERE instructor_id IN (?)
                        AND occurred_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
                      GROUP BY instructor_id) last ON last.id = pl.id`,
            [instructorIds, ageSec]
        );
        return new Map(rows.map(r => [r.instructor_id, r]));
    },

    /**
     * Whether this event is already on record within windowSec of when it
     * happened — a scanner re-sending a backlog whose first POST did land but
     * whose reply was lost.
     */
    async hasNearbyEvent(e, windowSec = 45) {
        const age = Math.max(0, Math.round(Number(e.ageSec) || 0));
        const [[row]] = await pool.execute(
            `SELECT 1 AS found FROM presence_logs
              WHERE instructor_id = ? AND room_id <=> ? AND event = ?
                AND occurred_at BETWEEN DATE_SUB(NOW(), INTERVAL ? SECOND)
                                    AND DATE_SUB(NOW(), INTERVAL ? SECOND)
              LIMIT 1`,
            [e.instructorId, e.roomId ?? null, e.event, age + windowSec, Math.max(0, age - windowSec)]
        );
        return !!row;
    },

    /**
     * Instructors another room logged within the last ageSec seconds. Their
     * whereabouts during the gap are already on record from a scanner that
     * was online, and that account wins over a replay.
     */
    async loggedElsewhereSince(instructorIds, roomId, ageSec) {
        if (!instructorIds.length) return new Set();
        const [rows] = await pool.query(
            `SELECT DISTINCT instructor_id
               FROM presence_logs
              WHERE instructor_id IN (?)
                AND (room_id IS NULL OR room_id <> ?)
                AND occurred_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
                AND scanner_id IS NOT NULL`,
            [instructorIds, roomId, ageSec]
        );
        return new Set(rows.map(r => r.instructor_id));
    },

    /* ── Admin: fleet health ── */

    /**
     * Every scanner, most recently heard first, with the room it claims.
     *
     * Each row carries the room's own threshold and the range of signals it is
     * currently hearing, because a threshold chosen without knowing what the
     * room actually sees is a guess.
     */
    async getScanners(recentSeconds = 300) {
        const [rows] = await pool.query(
            `SELECT s.id, s.scanner_id, s.last_seen_at, s.last_uptime_sec,
                    s.last_beacon_count, s.last_ip, s.report_count, s.first_seen_at,
                    r.id AS room_id, r.room_number, r.room_type, r.rssi_threshold,
                    TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW()) AS secs_since_report,
                    heard.strongest, heard.weakest, heard.tags_heard
               FROM ble_scanners s
               LEFT JOIN rooms r ON r.id = s.room_id
               LEFT JOIN (
                    SELECT last_room_id,
                           MAX(last_rssi) AS strongest,
                           MIN(last_rssi) AS weakest,
                           COUNT(*)       AS tags_heard
                      FROM ble_beacons
                     WHERE last_seen_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
                       -- Assigned tags only. This range is what a threshold is
                       -- chosen against, and an unclaimed address that a
                       -- discovery window let in would drag the weak end down
                       -- to whatever a phone in the corridor happened to read.
                       AND instructor_id IS NOT NULL
                     GROUP BY last_room_id
               ) heard ON heard.last_room_id = r.id
              ORDER BY s.last_seen_at DESC`,
            [recentSeconds]
        );
        return rows;
    },

    /**
     * Rooms marked in Admin as having a scanner that have never reported — the
     * quickest way to spot one never plugged in, or pointed at the wrong room.
     */
    async getRoomsAwaitingScanner() {
        const [rows] = await pool.query(
            `SELECT r.id, r.room_number, r.room_type
               FROM rooms r
              WHERE r.is_ble_scanner_installed = 1
                AND r.status = 'Active'
                AND NOT EXISTS (SELECT 1 FROM ble_scanners s WHERE s.room_id = r.id)
              ORDER BY r.room_number`
        );
        return rows;
    },

    /* ── Admin: the tags ── */

    async getBeacons() {
        const [rows] = await pool.query(
            `SELECT b.id, b.mac_address, b.label, b.is_active, b.battery_pct,
                    b.last_seen_at, b.last_rssi, b.ibeacon_major, b.ibeacon_minor,
                    TIMESTAMPDIFF(SECOND, b.last_seen_at, NOW()) AS secs_since_seen,
                    r.room_number AS last_room,
                    -- The threshold of the room the reading was taken in. The
                    -- page used to judge every signal against the system-wide
                    -- default, so a reading between a tuned room's cutoff and
                    -- the default showed as strong while presence correctly
                    -- treated it as below the line.
                    r.rssi_threshold AS last_room_threshold,
                    u.public_id   AS instructor_id,
                    CONCAT(u.first_name, ' ', u.last_name) AS instructor_name,
                    fp.is_present,
                    present_room.room_number AS present_room,
                    present_room.rssi_threshold AS present_room_threshold
               FROM ble_beacons b
               LEFT JOIN rooms r ON r.id = b.last_room_id
               LEFT JOIN users u ON u.id = b.instructor_id
               LEFT JOIN faculty_presence fp ON fp.instructor_id = b.instructor_id
               LEFT JOIN rooms present_room ON present_room.id = fp.room_id
              ORDER BY b.instructor_id IS NULL DESC, b.last_seen_at DESC`
        );
        return rows;
    },

    /** Assign a tag to an instructor, or pass null to unassign it. */
    async assignBeacon(beaconId, instructorPublicId, label) {
        let instructorId = null;
        if (instructorPublicId) {
            const [[user]] = await pool.execute(
                "SELECT id FROM users WHERE public_id = ? AND role = 'Instructor'",
                [instructorPublicId]
            );
            if (!user) return { ok: false, error: 'That instructor could not be found.' };
            instructorId = user.id;
        }

        try {
            const [result] = await pool.execute(
                'UPDATE ble_beacons SET instructor_id = ?, label = ? WHERE id = ?',
                [instructorId, label || null, beaconId]
            );
            return { ok: result.affectedRows > 0, error: result.affectedRows ? null : 'Tag not found.' };
        } catch (err) {
            // uq_beacon_instructor — one tag per person
            if (err.code === 'ER_DUP_ENTRY') {
                return { ok: false, error: 'That instructor already has a tag assigned.' };
            }
            throw err;
        }
    },

    async setBeaconActive(beaconId, active) {
        const [result] = await pool.execute(
            'UPDATE ble_beacons SET is_active = ? WHERE id = ?', [active ? 1 : 0, beaconId]
        );
        return result.affectedRows > 0;
    },

    async removeBeacon(beaconId) {
        const [result] = await pool.execute('DELETE FROM ble_beacons WHERE id = ?', [beaconId]);
        return result.affectedRows > 0;
    },
};

module.exports = PresenceModel;
